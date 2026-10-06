/**
 * EmailProvider — abstração isolada do envio de emails de outreach.
 *
 * Todo envio passa por `sendEmailForAccount`, que roteia pelo campo
 * `EmailAccount.provider`. Nenhum worker deve chamar Gmail API, SMTP ou
 * Resend diretamente — os campos `gmailMessageId`/`gmailThreadId` do
 * `OutreachMessage` são históricos e guardam o message/thread id do
 * provider que enviou.
 *
 * Providers:
 *   gmail  — Gmail API OAuth (gmail-api.js). Único com reply-sync
 *            (History API), usado pelo worker outreach:gmail-sync.
 *   smtp   — SMTP genérico com App Password. Default smtp.gmail.com:587,
 *            mas aceita qualquer host (útil para Workspace/Mailcow futuro).
 *            Send-only: detecção automática de replies não disponível.
 *   resend — Resend HTTP API (https://resend.com). Send-only. O "from"
 *            precisa pertencer a um domínio verificado na conta Resend.
 *
 * Segredos (app password / api key) são criptografados com o mesmo
 * AES-256-GCM do gmail-auth (TOKEN_ENCRYPTION_KEY) e nunca logados.
 */
const nodemailer = require('nodemailer');
const { encrypt, decrypt } = require('./gmail-auth');
const gmailApi = require('./gmail-api');
const reputation = require('./studio/reputation');

const PROVIDERS = ['gmail', 'smtp', 'resend'];

// Teto diário hard por provider (cap acima do limite de produto,
// que continua sendo OUTREACH_DAILY_LIMIT, default 30).
const PROVIDER_DAILY_CAPS = {
  gmail: 5000, // Gmail API (Workspace)
  smtp: 500,   // Gmail SMTP conta gratuita; Workspace aguenta 2000
  resend: 100, // Resend free tier (100/dia)
};

/**
 * Formata o endereço From com nome amigável quando existir.
 */
function _formatFrom(email, fromName) {
  // CR/LF em valor de header é injeção de header: corrompe a mensagem dali
  // em diante e o Gmail pode rejeitar por RFC 5322 com headers "perdidos"
  // (incluindo Message-ID). No nome, troca por espaço para não colar palavras.
  const addr = String(email || '').replace(/["<>\r\n]/g, '').trim();
  const name = String(fromName || '').replace(/["<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? `"${name}" <${addr}>` : addr;
}

/**
 * Valida um endereço email simples.
 */
function _isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

/**
 * Message-ID RFC 5322 no formato <local@dominio>. Os ids gerados internamente
 * (UUID do worker, "teste-<uuid>") não têm domínio — encapsular como <uuid>
 * produz um header INVÁLIDO, e o Gmail rejeita com 550 5.7.1 "Messages
 * missing a valid Message-ID header" (um header malformado conta como
 * ausente; o Postfix/Mailcow de camada intermediária não regenera porque o
 * header existe). Completa com o domínio da conta de envio.
 *
 * msg-id = <dot-atom@dot-atom>: cada lado só aceita [A-Za-z0-9] e
 * !#$%&'*+-/=?^_`{|}~. — qualquer coisa fora disso (espaço, CR/LF, não-ASCII,
 * caracteres de sintaxe como parênteses ou vírgula) também torna o header
 * inválido. Os dois lados são sanitizados; se não sobrar id utilizável,
 * retorna undefined e o provider gera um id válido por conta própria.
 */
function formatMessageId(messageId, fromEmail) {
  const atext = (s) => s.replace(/[^A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]/g, '');
  const id = String(messageId || '').trim().replace(/^<+|>+$/g, '');
  if (!id) return undefined;
  const [rawLocal, ...rawDomain] = id.split('@');
  const local = atext(rawLocal);
  if (!local) return undefined;
  const fallbackDomain =
    atext(String(fromEmail || '').split('@')[1] || '').toLowerCase() || 'b2base.local';
  const domain = rawDomain.length ? atext(rawDomain.join('@')) || fallbackDomain : fallbackDomain;
  return `<${local}@${domain}>`;
}

// ─── Provider: Gmail (OAuth API) ────────────────────────────────────
// Adapter fino sobre o gmail-api.js existente, para o dispatcher ter
// um contrato uniforme. Reply-sync continua lá.

function GmailApiProvider(prisma, account) {
  return {
    provider: 'gmail',
    // Onda 2026-09-29 (Story 2.2): gmail-api não monta MIME multipart —
    // sem suporte a anexo; a degradação é EXPLICÁVEL (mensagem sai sem o
    // anexo e o fato é registrado — nunca falha o lote).
    capabilities: { replySync: true, attachments: false },

    async send({ to, subject, body, htmlBody, messageId }) {
      const result = await gmailApi.sendEmail(prisma, account.id, {
        to,
        subject,
        body,
        htmlBody,
        messageId,
      });
      return { messageId: result.gmailMessageId, threadId: result.gmailThreadId };
    },
  };
}

// ─── Provider: SMTP (Nodemailer) ────────────────────────────────────

function SMTPEmailProvider(account) {
  const password = account.encryptedSecret ? decrypt(account.encryptedSecret) : null;

  if (!password) {
    throw new Error('Conta SMTP sem credencial armazenada — reconecte a conta.');
  }

  const transporter = nodemailer.createTransport({
    host: account.smtpHost || 'smtp.gmail.com',
    port: account.smtpPort || 587,
    secure: Boolean(account.smtpSecure) || account.smtpPort === 465,
    auth: { user: account.email, pass: password },
  });

  return {
    provider: 'smtp',
    // Nodemailer monta MIME multipart nativamente — anexos suportados
    // ({fileName, content: Buffer, contentType}).
    capabilities: { replySync: false, attachments: true },

    async send({ to, subject, body, htmlBody, messageId, attachments }) {
      const info = await transporter.sendMail({
        from: _formatFrom(account.email, account.fromName),
        to,
        subject,
        text: body,
        html: htmlBody || undefined,
        // Fixa o Message-ID header para permitir casar replies por
        // In-Reply-To quando houver leitura de caixa (IMAP) no futuro.
        // Sem id, o próprio nodemailer gera um válido.
        messageId: formatMessageId(messageId, account.email),
        ...(Array.isArray(attachments) && attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                filename: a.fileName,
                content: Buffer.from(a.content, 'base64'),
                contentType: a.contentType || 'application/octet-stream',
              })),
            }
          : {}),
      });

      return { messageId: info.messageId, threadId: null };
    },
  };
}

/**
 * Verifica credenciais SMTP sem enviar email (conecta + autentica).
 */
async function verifySMTPCredentials({ host, port, secure, user, password }) {
  const transporter = nodemailer.createTransport({
    host: host || 'smtp.gmail.com',
    port: port || 587,
    secure: Boolean(secure) || port === 465,
    auth: { user, pass: password },
  });

  try {
    await transporter.verify();
    return true;
  } catch (err) {
    const message = _friendlySMTPError(err, host || 'smtp.gmail.com');
    const error = new Error(message);
    error.cause = err;
    throw error;
  }
}

function _friendlySMTPError(err, host) {
  const raw = String(err?.message || '');
  if (err?.code === 'EAUTH' || /535|authentication|credencia/i.test(raw)) {
    return `Autenticação rejeitada pelo servidor ${host}. Verifique usuário e senha (Gmail exige App Password com 2FA ativado, não a senha normal da conta).`;
  }
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNECTION' || /timeout/i.test(raw)) {
    return `Não foi possível conectar em ${host} (timeout/conexão). Confira host e porta (587 STARTTLS ou 465 TLS).`;
  }
  return `Falha SMTP ao validar ${host}: ${raw}`;
}

// ─── Provider: Resend (HTTP API) ────────────────────────────────────

const RESEND_API_BASE = process.env.RESEND_API_BASE || 'https://api.resend.com';

function ResendEmailProvider(account) {
  const apiKey = account.encryptedSecret
    ? decrypt(account.encryptedSecret)
    : process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error('Conta Resend sem API key armazenada (nem RESEND_API_KEY no ambiente).');
  }

  return {
    provider: 'resend',
    // Resend aceita anexos base64 no payload da API — suportado (Story 2.2).
    capabilities: { replySync: false, attachments: true },

    async send({ to, subject, body, htmlBody, messageId, attachments }) {
      const mid = formatMessageId(messageId, account.email);
      const res = await fetch(`${RESEND_API_BASE}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: _formatFrom(account.email, account.fromName),
          to: [to],
          subject,
          text: body,
          html: htmlBody || undefined,
          headers: mid ? { 'Message-ID': mid } : undefined,
          ...(Array.isArray(attachments) && attachments.length > 0
            ? {
                attachments: attachments.map((a) => ({
                  filename: a.fileName,
                  content: a.content, // base64 (D8: bytes lidos do storage no send)
                  content_type: a.contentType || 'application/octet-stream',
                })),
              }
            : {}),
        }),
      });

      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const message = json?.message || json?.error?.message || `Resend HTTP ${res.status}`;
        const error = new Error(message);
        error.status = res.status;
        throw error;
      }

      return { messageId: json?.id || null, threadId: null };
    },
  };
}

/**
 * Verifica uma API key do Resend listando domínios (não envia email).
 */
async function verifyResendApiKey(apiKey) {
  const res = await fetch(`${RESEND_API_BASE}/domains`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error('API key do Resend inválida ou sem permissão.');
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new Error(json?.message || `Resend HTTP ${res.status} ao validar a API key.`);
  }

  const json = await res.json().catch(() => null);
  const domains = Array.isArray(json?.data) ? json.data : [];
  return { domains: domains.map((d) => ({ name: d.name, status: d.status })) };
}

// ─── Dispatcher ─────────────────────────────────────────────────────

/**
 * Constrói o provider concreto para uma EmailAccount já carregada.
 */
function buildProviderForAccount(prisma, account) {
  switch (account.provider) {
    case 'gmail':
      return GmailApiProvider(prisma, account);
    case 'smtp':
      return SMTPEmailProvider(account);
    case 'resend':
      return ResendEmailProvider(account);
    default:
      throw new Error(`Provider de email desconhecido: ${account.provider}`);
  }
}

/**
 * Envia um email pela conta indicada, roteando pelo provider.
 *
 * @param {object} prisma - Prisma client
 * @param {string} emailAccount_id - EmailAccount.id que envia
 * @param {object} params - { to, subject, body, htmlBody, messageId, attachments? }
 *   `attachments`: [{fileName, content(base64), contentType}] — Story 2.2.
 *   Provider sem `capabilities.attachments` → degrada EXPLICÁVEL: a mensagem
 *   sai SEM os anexos e o resultado traz `attachmentsSkipped` (fato
 *   registrado; nunca falha o envio por causa de anexo).
 * @returns {object} { messageId, threadId, attachmentsSkipped? } — ids no
 *   formato do provider
 */
async function sendEmailForAccount(prisma, emailAccount_id, params) {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccount_id },
  });

  if (!account) {
    throw new Error(`Email account ${emailAccount_id} not found`);
  }
  if (account.status !== 'connected') {
    throw new Error(`Email account status is ${account.status} — reconecte a conta`);
  }
  if (!_isValidEmail(params.to)) {
    throw new Error(`Destinatário inválido: ${params.to}`);
  }

  const provider = buildProviderForAccount(prisma, account);
  try {
    const wantsAttachments = Array.isArray(params.attachments) && params.attachments.length > 0;
    if (wantsAttachments && provider.capabilities?.attachments !== true) {
      console.warn(
        `[email-provider] provider "${provider.provider}" sem suporte a anexos — a mensagem sai sem eles (degradação explicável).`
      );
      const result = await provider.send({ ...params, attachments: undefined });
      result.attachmentsSkipped = params.attachments.map((a) => ({
        fileName: a.fileName,
        reason: 'provider_sem_suporte',
      }));
      return result;
    }
    return await provider.send(params);
  } catch (err) {
    // Credencial rejeitada → marca a conta para forçar reconexão.
    if (err?.code === 'EAUTH' || err?.status === 401 || err?.status === 403) {
      await prisma.emailAccount
        .update({ where: { id: account.id }, data: { status: 'error' } })
        .catch(() => {});
    }
    throw err;
  }
}

/**
 * Cria/atualiza uma EmailAccount SMTP ou Resend com o segredo criptografado.
 * Retorna a conta persistida.
 */
async function connectEmailAccount(
  prisma,
  { provider, email, secret, smtpHost, smtpPort, smtpSecure, fromName, userId }
) {
  if (!PROVIDERS.slice(1).includes(provider)) {
    throw new Error(`Provider não suportado neste endpoint: ${provider}`);
  }
  if (!_isValidEmail(email)) {
    throw new Error('Endereço de email inválido.');
  }
  if (!secret || typeof secret !== 'string') {
    throw new Error(provider === 'smtp' ? 'Senha/App Password obrigatória.' : 'API key obrigatória.');
  }

  let resendDomain = null;
  if (provider === 'smtp') {
    await verifySMTPCredentials({ host: smtpHost, port: smtpPort, secure: smtpSecure, user: email, password: secret });
  } else {
    const { domains } = await verifyResendApiKey(secret);
    // O Resend só entrega "from" de domínios verificados — falha cedo,
    // na conexão, em vez de falhar silenciosamente em cada envio.
    const verified = domains.filter((d) => d.status === 'verified').map((d) => d.name.toLowerCase());
    resendDomain = email.split('@')[1]?.toLowerCase();
    if (!verified.includes(resendDomain)) {
      // QA 2026-10-06: "verificados: resend.0xcloud.net" não dizia se o
      // domínio pedido estava CADASTRADO e pendente ou nem existia — o dono
      // ficou sem próximo passo. O diagnóstico separa os dois casos e dá o
      // caminho curto (endereço no domínio que JÁ está verificado).
      const registered = domains.find((d) => String(d.name).toLowerCase() === resendDomain);
      let why;
      if (registered) {
        why =
          `O domínio "${resendDomain}" está cadastrado na conta dessa API key, mas ainda não está verificado no Resend ` +
          `(status: ${registered.status || 'pending'}). No painel do Resend → Domains, confira se os registros ` +
          `DKIM/SPF de "${resendDomain}" estão publicados e peça a reverificação; quando ficar "Verified", me peça para conectar de novo.`;
      } else {
        const options = verified.length ? `verificados nesta conta: ${verified.join(', ')}` : 'a conta ainda não tem nenhum domínio verificado';
        why =
          `O domínio "${resendDomain}" não está verificado no Resend — nem cadastrado nesta conta da API key (${options}). ` +
          `No painel do Resend → Domains, adicione "${resendDomain}" e publique os registros DKIM/SPF que ele sugerir; ` +
          'quando ficar "Verified", me peça para conectar de novo.';
      }
      if (verified.length) {
        why += ` Enquanto isso, já dá para conectar um endereço do domínio já verificado — por exemplo, voce@${verified[0]}.`;
      }
      throw new Error(why);
    }
  }

  const data = {
    provider,
    email,
    encryptedSecret: encrypt(secret),
    encryptedRefreshToken: null,
    scopes: [],
    status: 'connected',
    ...(provider === 'smtp'
      ? {
          smtpHost: smtpHost || 'smtp.gmail.com',
          smtpPort: smtpPort || 587,
          smtpSecure: Boolean(smtpSecure) || smtpPort === 465,
        }
      : {}),
    // Domínio verificado NO PROVEDOR: o Resend só ativa um domínio depois de
    // SPF/DKIM confirmados no DNS dele. Registrar na conexão evita o falso
    // "0 envios disponíveis" (piso efetivo engolindo o saldo inteiro) para
    // quem conecta via Resend; a revalidação de fundo segue no job diário.
    ...(provider === 'resend' && resendDomain
      ? {
          sendingDomain: resendDomain,
          domainAuthStatus: 'verified',
          domainAuthDetail: {
            domain: resendDomain,
            spf: true,
            dkim: true,
            dmarc: false,
            verified: true,
            source: 'resend-connect',
          },
          domainAuthVerifiedAt: new Date(),
        }
      : {}),
    ...(fromName ? { fromName } : {}),
  };

  const existing = await prisma.emailAccount.findFirst({
    where: { userId, email },
    select: { id: true },
  });

  // tenantId deve ser o org do dono (o schema documenta organization.id).
  // Resolvemos aqui para não depender de cada caller passar o valor certo.
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { orgId: true },
  });
  const tenantId = owner?.orgId || userId; // fallback defensivo

  const account = existing
    ? await prisma.emailAccount.update({
        where: { id: existing.id },
        data: { ...data, tenantId },
      })
    : await prisma.emailAccount.create({
        data: { ...data, userId, tenantId },
      });

  // Espelha na conta de reputação do Studio (writer único do saldo) para o
  // piso efetivo voltar a valer sem esperar o job diário de DNS. Falha aqui
  // não desfaz a conexão — o job diário reconcilia; a causa fica logada.
  if (provider === 'resend' && resendDomain) {
    try {
      await reputation.recordDomainAuth(prisma, tenantId, {
        status: 'verified',
        checkedAt: account.domainAuthVerifiedAt,
        detail: account.domainAuthDetail,
      });
    } catch (_err) {
      console.error(
        '[email-provider] conta conectada, mas falhou ao registrar domínio autenticado na conta de reputação',
        _err
      );
    }
  }

  return account;
}

module.exports = {
  PROVIDERS,
  PROVIDER_DAILY_CAPS,
  buildProviderForAccount,
  sendEmailForAccount,
  connectEmailAccount,
  verifySMTPCredentials,
  verifyResendApiKey,
  formatMessageId,
};
