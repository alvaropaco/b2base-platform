'use strict';

/**
 * studio/certificate.js — Certificado de Segurança: checklist determinístico
 * de PRONTIDÃO (onda "criação de campanha sem bloqueios", epics 2026-09-29;
 * antes: specs/011, AD-7; FR-27, FR-35/36 do PRD).
 *
 * Dois modos de avaliação (mesma lista de itens):
 *  - CRIAÇÃO (default): NENHUM item bloqueia — pendências viram
 *    `pending`/`warning` com `howToFix` (o que fazer) e `whenUnblocks`
 *    (quando libera) em tom mordomo. O avanço da criação NUNCA é
 *    desabilitado por pendência (FR1 da onda; UX-DR1).
 *  - DISPARO (`forDispatch: true`, consumido só pelo `reputation-gate`
 *    precheck): o que impede o disparo volta a 'block' — o gate continua
 *    fail-closed (AD-4 intocado; NFR1 da onda). A UI nunca vê 'block' na
 *    criação.
 *
 * Níveis dos itens: `ok | warning | pending | block`.
 *  - `pending`: ambiente ainda não pronto, destrava por ação externa/tempo
 *    (saldo pela reposição, canal ao conectar, consentimento ao registrar).
 *  - `warning`: atenção/orientação sem prazo (domínio, Teste da Maria).
 *
 * Avaliação PURA do estado (nenhuma mutação de recurso). Resultado pode ser
 * persistido na campanha (`approval.certificate`) para exibição no Cockpit.
 */

const reputation = require('./reputation');
const bridge = require('./channel-bridge');

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

function item(key, label, level, detail, extra = {}) {
  return {
    key,
    label,
    level,
    detail,
    ...(extra.howToFix ? { howToFix: extra.howToFix } : {}),
    ...(extra.whenUnblocks ? { whenUnblocks: extra.whenUnblocks } : {}),
  };
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
  const consented = await whatsappConsentedSet(prisma, campaign.orgId, members.map((m) => m.prospectId));
  const sample = [];
  for (const member of members) {
    if (consented.has(member.prospectId)) continue;
    if (sample.length < 5) sample.push(member.prospectId); // amostra p/ exibição
  }
  // sample é a AMOSTRA (≤5); o total real é a contagem completa.
  const gaps = members.filter((m) => !consented.has(m.prospectId)).length;
  return { gaps, sample };
}

/**
 * Conjunto de prospectIds COM consentimento WhatsApp (registro persistido ou
 * resposta prévia a e-mail). Fonte única da regra — usada pelo certificado e
 * pela matrícula do bridge (leads sem consentimento ficam fora do WhatsApp).
 * B11/E19: DUAS queries no total (`findMany in`), nunca uma por lead.
 */
async function whatsappConsentedSet(prisma, orgId, prospectIds) {
  const ids = [...new Set(prospectIds || [])];
  const consentRows = await prisma.studioLeadConsent.findMany({
    where: { orgId, channel: 'whatsapp', prospectId: { in: ids } },
  });
  const consented = new Set(consentRows.map((c) => c.prospectId));
  const missing = ids.filter((id) => !consented.has(id));
  if (missing.length > 0) {
    const replied = await prisma.outreachContact.findMany({
      where: { prospectId: { in: missing }, status: 'REPLIED' },
      select: { prospectId: true },
    });
    for (const row of replied) consented.add(row.prospectId);
  }
  return consented;
}

/**
 * Avalia o certificado da campanha. `skipPersist` usado pelo gate no disparo
 * (re-avaliação sem escrita). Persistência: `approval.certificate`.
 *
 * Modos (onda "criação de campanha sem bloqueios"):
 *  - CRIAÇÃO (default): pendências são `pending`/`warning` com caminho em tom
 *    mordomo — nenhum item bloqueia o avanço; nível final 'green' | 'amber'.
 *  - DISPARO (`forDispatch: true`): o que impede o disparo é 'block' — nível
 *    final 'green' | 'amber' | 'blocked' (o gate bloqueia só em 'block').
 */
async function evaluate(prisma, campaign, { now = new Date(), skipPersist = false, skipMetrics = false, forDispatch = false } = {}) {
  const channels = campaign.channels || [];
  const { snapshot, units } = await requiredUnits(prisma, campaign);
  const contents = await baseContents(prisma, campaign);
  const items = [];
  // Nível de uma pendência no modo corrente: 'block' só existe no disparo.
  const dispatchLevel = (base) => (forDispatch ? 'block' : base);

  const sendable = channels.filter((c) => c === 'email' || c === 'whatsapp');

  // 1) Canal de envio conectado (Story 1.5/UX-DR5) — na criação é pendência
  //    explicável ("pendente de envio"); no disparo o gate bloqueia.
  if (sendable.length > 0) {
    const connected = await bridge.connectedSendChannels(prisma, campaign.orgId);
    const anyConnected = sendable.some((c) => connected[c]);
    if (!anyConnected) {
      items.push(item(
        'canal',
        'Canal de envio',
        dispatchLevel('pending'),
        'A campanha está pronta, mas nenhum canal de envio está conectado ainda — ela fica "pendente de envio" e suas peças permanecem salvas.',
        {
          howToFix: 'conectar um canal de envio (e-mail ou WhatsApp)',
          whenUnblocks: 'assim que você conectar, o disparo destrava na hora — sem refazer a criação',
        }
      ));
    }
  }

  // 2) Saldo ≥ necessário (FR-14/FR-27) — para o canal principal da campanha.
  //    Criação: `pending` com o caminho ("faltam X — a reposição diária libera
  //    às HH:MM" em pt-BR local, B15); disparo: 'block' (anti-spam físico
  //    permanece no gate, AD-4).
  const primaryChannel = channels.includes('email') ? 'email' : channels.includes('whatsapp') ? 'whatsapp' : null;
  if (primaryChannel) {
    const account = await reputation.getAccount(prisma, campaign.orgId, primaryChannel);
    const available = account ? reputation.effectiveBalance(account) : 0;
    // Horário pt-BR local (B15); quando o fuso não formata, a copy OMITE o
    // horário em vez de inventar "00:00".
    const replenishAt = reputation.nextReplenishLabel(now);
    const replenishPhrase = replenishAt ? ` às ${replenishAt}` : '';
    if (!account || available < Math.max(1, units)) {
      items.push(item(
        'saldo',
        primaryChannel === 'email' ? 'Envio por e-mail' : 'Envio por WhatsApp',
        dispatchLevel('pending'),
        account
          ? `Faltam ${Math.max(1, units) - available} envio(s) para esta campanha — você tem ${available} disponíveis hoje. ` +
            `A reposição diária libera mais unidades${replenishPhrase}. ` +
            `Você pode seguir criando — ou me pedir para reduzir a audiência.`
          : `Você ainda não configurou um mecanismo de ${primaryChannel === 'email' ? 'e-mail' : 'WhatsApp'} para enviar campanhas. Quer que eu te ajude a configurar? É só me pedir aqui no chat.`,
        account
          ? {
              howToFix: 'recarregar o saldo ou me pedir para reduzir a audiência',
              whenUnblocks: `reposição diária${replenishPhrase}${replenishAt ? ' (horário local)' : ''}`,
            }
          : { howToFix: 'conectar o canal de envio (me peça ajuda aqui no chat)' }
      ));
    } else {
      items.push(item('saldo', 'Saldo de reputação', 'ok', `${available} unidades disponíveis para ${units} envio(s).`));
    }
  }

  // 3) Autenticação de domínio verificada (FR-16/AD-8) — canal e-mail.
  //    `warning` nos dois modos (2026-09-27, feedback do dono: orienta passo a
  //    passo em linguagem leiga — o cliente não conhece SPF/DKIM/DNS).
  if (channels.includes('email')) {
    const account = await reputation.getAccount(prisma, campaign.orgId, 'email');
    if (!account || account.domainAuthStatus !== 'verified') {
      items.push(item(
        'domain_auth',
        'Proteção anti-spam do seu e-mail (SPF/DKIM)',
        'warning',
        'Para seus e-mails não caírem em spam, o seu domínio precisa de uma "assinatura de segurança" (os registros SPF e DKIM). Falta pouco:\n' +
        '1. Entre no painel onde seu site/domínio está hospedado (ex.: Registro.br, GoDaddy, Hostinger, Cloudflare).\n' +
        '2. Procure a seção "Registros DNS" (ou "Zona de DNS").\n' +
        '3. Me peça "listar os registros DNS" e eu mostro cada registro para você copiar e colar lá.\n' +
        '4. Depois de salvar, a verificação é automática e libera o envio por e-mail.',
        { howToFix: 'publicar os registros SPF/DKIM no DNS — eu listo cada um para você copiar' }
      ));
    } else {
      items.push(item('domain_auth', 'Proteção anti-spam do seu e-mail (SPF/DKIM)', 'ok', 'Seu domínio já está assinado (SPF e DKIM verificados).'));
    }
  }

  // 4) Opt-outs honrados (FR-27): exclusões por opt-out são mantidas fora.
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

  // 5) Consentimento WhatsApp por lead (FR-35/AD-11; Story 1.3/FR5) —
  //    INFORMATIVO na criação: leads sem consentimento ficam fora do canal
  //    WhatsApp na matrícula (bridge) e seguem recebendo e-mail. No DISPARO
  //    o item volta a 'block' (gate AD-4 — task 1.3 do plano). A copy é
  //    condicionada à existência do canal e-mail (E12).
  if (channels.includes('whatsapp')) {
    const { gaps, sample } = await whatsappConsentGaps(prisma, campaign, snapshot);
    if (gaps > 0) {
      // gaps é a contagem REAL; quando maior que a amostra, exibe "5+".
      const gapLabel = gaps > sample.length ? `${sample.length}+` : String(gaps);
      const detail = channels.includes('email')
        ? `${gapLabel} lead(s) recebem só e-mail — sem consentimento WhatsApp registrado. ` +
          `Eles continuam na campanha; para incluí-los no WhatsApp, registre o consentimento de cada um (me peça que eu registro).`
        : `${gapLabel} lead(s) ficam fora do WhatsApp — sem consentimento registrado. ` +
          `Registre o consentimento de cada um (me peça que eu registro)` +
          `${channels.includes('email') ? '' : ' — ou inclua o canal e-mail para alcançá-los também'}.`;
      items.push(item(
        'consent_whatsapp',
        'Consentimento WhatsApp',
        dispatchLevel('pending'),
        detail,
        { howToFix: 'registrar o consentimento de cada lead (me peça que eu registro)' }
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
        `Conteúdo "${content.channel}" pode estar longo ou com CTAs demais (${words} palavras, ${ctas} CTA). Uma pessoa ocupada tem que entender em 5 segundos.`,
        { howToFix: 'encurtar o texto e deixar um único CTA — posso reescrever para você' }
      ));
      break;
    }
  }

  // Níveis (UX-DR1): 'blocked' só existe em forDispatch (o gate consome); na
  // criação o teto é 'amber' — pendência informa, nunca interdita.
  const level = items.some((i) => i.level === 'block')
    ? 'blocked'
    : items.some((i) => i.level === 'pending' || i.level === 'warning')
      ? 'amber'
      : 'green';
  const result = {
    level,
    items,
    requiredUnits: units,
    evaluatedAt: now.toISOString(),
    mode: forDispatch ? 'dispatch' : 'creation',
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
      metrics.incStudioComplianceReview(level === 'green' ? 'ok' : level === 'amber' ? 'warning' : 'block');
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

module.exports = { evaluate, grantConsent, requiredUnits, whatsappConsentedSet };
