'use strict';

/**
 * studio/certificate.js — Certificado de Segurança: checklist determinístico
 * pré-disparo que BLOQUEIA enquanto houver item reprovado (specs/011, AD-7;
 * FR-27, FR-35/36 do PRD).
 *
 * Avaliação PURA do estado (nenhuma mutação de recurso) — o gate re-avalia
 * no momento do release (selo vencido/reprovado bloqueia). Resultado pode ser
 * persistido na campanha (`approval.certificate`) para exibição no Cockpit.
 *
 * Itens (fecha com FR-26…FR-30, FR-37): saldo, autenticação de domínio,
 * opt-outs/descadastro, janela, consentimento WhatsApp por lead e heurísticas
 * do Teste da Maria (aviso, não bloqueio).
 */

const reputation = require('./reputation');

// Heurísticas do Teste da Maria (FR-30) — limites objetivos.
const MARIA_MAX_WORDS = 150;
const MARIA_MAX_CTAS = 1;

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function countCtas(emailDoc) {
  const blocks = (emailDoc && Array.isArray(emailDoc.blocks)) ? emailDoc.blocks : [];
  return blocks.filter((b) => b && (b.type === 'button' || (typeof b === 'object' && b.cta))).length;
}

function item(key, label, level, detail) {
  return { key, label, level, detail };
}

/** Unidades necessárias para o disparo = leads incluídos no snapshot ativo. */
async function requiredUnits(prisma, campaign) {
  const snapshots = await prisma.studioAudienceSnapshot.findMany({
    where: { campaignId: campaign.id, status: 'active' },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  const snapshot = snapshots[0] || null;
  return { snapshot, units: snapshot ? snapshot.includedCount : 0 };
}

/** Conteúdo base vigente (primeiro toque) por canal. */
async function baseContents(prisma, campaign) {
  return prisma.studioContent.findMany({
    where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
  });
}

/**
 * Leads incluídos sem consentimento WhatsApp registrados (FR-35): consentimento
 * é registro persistido (StudioLeadConsent) ou resposta prévia a e-mail
 * (OutreachContact REPLIED) — nunca inferido em memória (AD-11).
 */
async function whatsappConsentGaps(prisma, campaign, snapshot) {
  if (!snapshot) return { gaps: 0, sample: [] };
  const members = await prisma.studioAudienceMember.findMany({
    where: { snapshotId: snapshot.id, included: true },
  });
  const consentRows = await prisma.studioLeadConsent.findMany({
    where: { orgId: campaign.orgId, channel: 'whatsapp' },
  });
  const consented = new Set(consentRows.map((c) => c.prospectId));
  const gaps = [];
  let total = 0;
  for (const member of members) {
    if (consented.has(member.prospectId)) continue;
    const replied = await prisma.outreachContact.findFirst({
      where: { prospectId: member.prospectId, status: 'REPLIED' },
    });
    if (!replied) {
      total += 1;
      if (gaps.length < 5) gaps.push(member.prospectId); // amostra p/ exibição
    }
  }
  return { gaps: total, sample: gaps };
}

/**
 * Avalia o certificado da campanha. `skipPersist` usado pelo gate no release
 * (re-avaliação sem escrita). Persistência: `approval.certificate`.
 */
async function evaluate(prisma, campaign, { now = new Date(), skipPersist = false, skipMetrics = false } = {}) {
  const channels = campaign.channels || [];
  const { snapshot, units } = await requiredUnits(prisma, campaign);
  const contents = await baseContents(prisma, campaign);
  const items = [];

  // 1) Saldo ≥ necessário (FR-14/FR-27) — para o canal principal da campanha.
  const primaryChannel = channels.includes('email') ? 'email' : channels.includes('whatsapp') ? 'whatsapp' : null;
  if (primaryChannel) {
    const account = await reputation.getAccount(prisma, campaign.orgId, primaryChannel);
    const available = account ? reputation.effectiveBalance(account) : 0;
    if (!account || available < Math.max(1, units)) {
      items.push(item(
        'saldo',
        primaryChannel === 'email' ? 'Envio por e-mail' : 'Envio por WhatsApp',
        'block',
        account
          ? `Esta campanha precisa de ${units} envio(s) e você tem ${available} disponíveis hoje. A reposição diária libera mais unidades — ou me peça para reduzir a audiência.`
          : `Você ainda não configurou um mecanismo de ${primaryChannel === 'email' ? 'e-mail' : 'WhatsApp'} para enviar campanhas. Quer que eu te ajude a configurar? É só me pedir aqui no chat.`
      ));
    } else {
      items.push(item('saldo', 'Saldo de reputação', 'ok', `${available} unidades disponíveis para ${units} envio(s).`));
    }
  }

  // 2) Autenticação de domínio verificada (FR-16/AD-8) — canal e-mail.
  if (channels.includes('email')) {
    const account = await reputation.getAccount(prisma, campaign.orgId, 'email');
    if (!account || account.domainAuthStatus !== 'verified') {
      // Não bloqueia (2026-09-27, feedback do dono): orienta passo a passo em
      // linguagem leiga — o cliente não conhece SPF/DKIM/DNS.
      items.push(item(
        'domain_auth',
        'Proteção anti-spam do seu e-mail (SPF/DKIM)',
        'warning',
        'Para seus e-mails não caírem em spam, o seu domínio precisa de uma "assinatura de segurança" (os registros SPF e DKIM). Falta pouco:\n' +
        '1. Entre no painel onde seu site/domínio está hospedado (ex.: Registro.br, GoDaddy, Hostinger, Cloudflare).\n' +
        '2. Procure a seção "Registros DNS" (ou "Zona de DNS").\n' +
        '3. Me peça "listar os registros DNS" e eu mostro cada registro para você copiar e colar lá.\n' +
        '4. Depois de salvar, a verificação é automática e libera o envio por e-mail.'
      ));
    } else {
      items.push(item('domain_auth', 'Proteção anti-spam do seu e-mail (SPF/DKIM)', 'ok', 'Seu domínio já está assinado (SPF e DKIM verificados).'));
    }

    // 3b) Descadastro (FR-37): a garantia vive no COMPILE (AD-2) — o bridge
    // injeta headers List-Unsubscribe + rodapé em TODOS os e-mails. Item
    // removido do certificado (2026-09-27): só notificaríamos se houvesse
    // problema, e hoje a injeção automática não falha silenciosamente.
  }

  // 3) Opt-outs honrados (FR-27): exclusões por opt-out são mantidas fora.
  if (snapshot) {
    const excluded = await prisma.studioAudienceMember.findMany({
      where: { snapshotId: snapshot.id, included: false, excludeReason: 'opt_out' },
    });
    if (excluded.length > 0) {
      items.push(item(
        'opt_out',
        'Opt-outs honrados',
        'ok',
        `${excluded.length} lead(s) com opt-out ficam de fora deste disparo — pedidos de saída são respeitados.`
      ));
    }
  }

  // 5) Consentimento WhatsApp por lead (FR-35/AD-11).
  if (channels.includes('whatsapp')) {
    const { gaps, sample } = await whatsappConsentGaps(prisma, campaign, snapshot);
    if (gaps > 0) {
      // gaps é a contagem REAL; quando maior que a amostra, exibe "5+".
      const gapLabel = gaps > sample.length ? `${sample.length}+` : String(gaps);
      items.push(item(
        'consent_whatsapp',
        'Consentimento WhatsApp',
        'block',
        `${gapLabel} lead(s) sem consentimento registrado para WhatsApp. O canal só é usado para quem respondeu e-mail ou deu opt-in — registre o consentimento antes de incluir.`
      ));
    }
  }

  // 6) Teste da Maria — heurísticas com limites objetivos (FR-30, aviso).
  // Avalia o CORPO que o lead lê (emailDoc/texto), não o subject.
  for (const content of contents) {
    let text = content.whatsappText || '';
    if (content.channel === 'email' && content.emailDoc) {
      const blocks = Array.isArray(content.emailDoc.blocks) ? content.emailDoc.blocks : [];
      text = blocks
        .map((b) => (typeof b === 'string' ? b : b.text || (b.html ? String(b.html).replace(/<[^>]+>/g, ' ') : '')))
        .filter(Boolean)
        .join(' ');
    }
    const words = countWords(text);
    const ctas = content.channel === 'email' ? countCtas(content.emailDoc) : 0;
    if (words > MARIA_MAX_WORDS || ctas > MARIA_MAX_CTAS) {
      items.push(item(
        'maria_test',
        'Teste da Maria (clareza)',
        'warning',
        `Conteúdo "${content.channel}" pode estar longo ou com CTAs demais (${words} palavras, ${ctas} CTA). Uma pessoa ocupada tem que entender em 5 segundos.`
      ));
      break;
    }
  }

  const level = items.some((i) => i.level === 'block') ? 'blocked' : 'green';
  const result = {
    level,
    items,
    requiredUnits: units,
    evaluatedAt: now.toISOString(),
  };

  if (!skipPersist) {
    const approval = { ...(campaign.approval || {}), certificate: result };
    await prisma.studioCampaign.update({
      where: { id: campaign.id },
      data: { approval },
    });
    campaign.approval = approval;
    if (!skipMetrics) {
      const metrics = require('../metrics');
      metrics.incStudioComplianceReview(level === 'green' ? 'ok' : 'block');
    }
  }
  return result;
}

/**
 * Registra consentimento WhatsApp de um lead (caminho para consentir — FR-35).
 * Idempotente por (orgId, prospectId, channel).
 */
async function grantConsent(prisma, { orgId, prospectId, source = 'manual', grantedById = null, evidence = {} }) {
  const existing = await prisma.studioLeadConsent.findFirst({
    where: { orgId, prospectId, channel: 'whatsapp' },
  });
  if (existing) return { consent: existing, replayed: true };
  try {
    const consent = await prisma.studioLeadConsent.create({
      data: { orgId, prospectId, channel: 'whatsapp', source, grantedById, evidence },
    });
    return { consent, replayed: false };
  } catch (err) {
    // Corrida entre dois pedidos simultâneos: o vencedor existe → replay.
    if (err && err.code === 'P2002') {
      const winner = await prisma.studioLeadConsent.findFirst({
        where: { orgId, prospectId, channel: 'whatsapp' },
      });
      if (winner) return { consent: winner, replayed: true };
    }
    throw err;
  }
}

module.exports = { evaluate, grantConsent, requiredUnits };
