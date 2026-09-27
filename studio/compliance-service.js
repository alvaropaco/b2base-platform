'use strict';

/**
 * studio/compliance-service.js — salvaguardas de audiência e de conteúdo
 * (specs/010, T016+T017; US12 adiciona LGPD/LLM).
 *
 * Parte 1 (exclusões obrigatórias, FR-011/FR-012): supressão, opt-out por
 * canal e contato recente. Um lead excluído NUNCA pode ser re-incluído.
 *
 * Parte 2 (checks pré-aprovação, FR-073 mínimo): conteúdo por canal
 * declarado, placeholders só do catálogo (SC-011) e mecanismo de descadastro
 * no e-mail. Parecer em níveis: ok | attention | block (block impede approve).
 */

const { validatePlaceholders } = require('./variables');
const { emailDocToText } = require('./channel-bridge');

const RECENT_CONTACT_DAYS = Number(process.env.STUDIO_RECENT_CONTACT_DAYS || 3);

const UNSUBSCRIBE_KEYWORDS = [
  'descadastro',
  'unsubscribe',
  'cancelar inscrição',
  'cancelamento de inscrição',
  'deixar de receber',
];

function exclusionError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  err.status = 400;
  return err;
}

/**
 * Classifica um lead para a audiência de uma campanha.
 * Retorna `{ included, excludeReason? }`.
 */
async function classifyLead(prisma, { orgId, prospectId, channels }) {
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });
  if (!prospect || prospect.orgId !== orgId) {
    return { included: false, excludeReason: 'not_found' };
  }

  // 1) Supressão (opt-out histórico/bounce) por e-mail do lead.
  if (prospect.cnpjEmail) {
    const suppressed = await prisma.suppressionList.findMany({
      where: { tenantId: orgId, email: prospect.cnpjEmail },
    });
    if (suppressed.length > 0) return { included: false, excludeReason: 'suppressed' };
  }

  // 2) Opt-out / do-not-contact no canal da campanha (LeadChannelState).
  const channelStates = await prisma.leadChannelState.findMany({
    where: { orgId, prospectId },
  });
  const blocked = channelStates.some(
    (s) => channels.includes(s.channel) && (s.status === 'opted_out' || s.status === 'do_not_contact')
  );
  if (blocked) return { included: false, excludeReason: 'opt_out' };

  // 3) Contato recente no canal (janela configurável, default 3 dias).
  if (prospect.lastContact) {
    const days = (Date.now() - new Date(prospect.lastContact).getTime()) / 86400000;
    if (days < RECENT_CONTACT_DAYS) return { included: false, excludeReason: 'recent_contact' };
  }

  return { included: true };
}

/**
 * Classifica uma lista de prospectIds para a campanha, retornando os membros
 * prontos para o snapshot (FR-011: motivo de cada exclusão).
 */
async function classifyAudience(prisma, { orgId, prospectIds, channels }) {
  const members = [];
  for (const prospectId of prospectIds) {
    const verdict = await classifyLead(prisma, { orgId, prospectId, channels });
    members.push({
      prospectId,
      included: verdict.included,
      excludeReason: verdict.included ? null : verdict.excludeReason,
    });
  }
  return members;
}

/** Verifica se o conteúdo de e-mail menciona mecanismo de descadastro. */
function hasUnsubscribeHint(content) {
  const haystacks = [
    content?.emailDoc ? emailDocToText(content.emailDoc) : '',
    content?.whatsappMeta?.footer || '',
  ];
  const text = haystacks.join(' ').toLowerCase();
  return UNSUBSCRIBE_KEYWORDS.some((kw) => text.includes(kw));
}

/** Texto pesquisável de um conteúdo (para validação de placeholders). */
function contentTexts(content) {
  return [
    content?.subject,
    content?.preheader,
    content?.whatsappText,
    content?.linkedinText,
    content?.emailDoc ? emailDocToText(content.emailDoc) : '',
  ].filter(Boolean);
}

/**
 * Checks pré-aprovação (parte determinística; US12 acrescenta LGPD/LLM).
 * Retorna `{ level, items: [{check, level, detail}] }`.
 */
async function runPreApprovalChecks(prisma, campaign) {
  const items = [];
  const contents = await prisma.studioContent.findMany({
    where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
  });
  const channels = campaign.channels || [];
  let level = 'ok';
  const raise = (l) => {
    if (l === 'block' || level === 'block') level = 'block';
    else if (l === 'attention') level = 'attention';
  };

  // 1) Conteúdo base para cada canal declarado.
  for (const channel of channels) {
    if (channel === 'linkedin_text') continue; // geração de texto p/ uso manual
    const content = contents.find((c) => c.channel === channel);
    if (!content) {
      items.push({ check: `conteudo_${channel}`, level: 'block', detail: `Campanha declara canal "${channel}" sem conteúdo base.` });
      raise('block');
    }
  }
  if (contents.length === 0) {
    items.push({ check: 'conteudo', level: 'block', detail: 'Campanha sem nenhum conteúdo.' });
    raise('block');
  }

  for (const content of contents) {
    // 2) Placeholders: somente o catálogo — variável desconhecida bloqueia
    // (nunca envia "{{...}}" ao lead, SC-011).
    for (const text of contentTexts(content)) {
      const { ok, unknown } = validatePlaceholders(text);
      if (!ok) {
        items.push({
          check: `variaveis_${content.channel}`,
          level: 'block',
          detail: `Variáveis fora do catálogo: ${unknown.join(', ')}`,
        });
        raise('block');
      }
    }

    // 3) Mecanismo de descadastro (FR-073) — a garantia vive no COMPILE
    //    (FR-37/AD-2): o bridge injeta headers List-Unsubscribe one-click +
    //    rodapé em TODO e-mail. Menção no conteúdo é sinal positivo; ausência
    //    não bloqueia (seria condição impossível pós-FR-37).
    const mencionaDescadastro = hasUnsubscribeHint(content);
    items.push({
      check: 'descadastro_email',
      level: 'ok',
      detail: mencionaDescadastro
        ? 'Descadastro mencionado no conteúdo + headers List-Unsubscribe garantidos no compile (FR-37).'
        : 'Descadastro garantido no compile: headers List-Unsubscribe one-click + rodapé injetados em todo e-mail (FR-37).',
    });
  }

  return { level, items };
}

module.exports = {
  RECENT_CONTACT_DAYS,
  UNSUBSCRIBE_KEYWORDS,
  classifyLead,
  classifyAudience,
  hasUnsubscribeHint,
  runPreApprovalChecks,
  exclusionError,
};

// ── Parte 3 (T058): checks de qualidade do e-mail — spam, links, a11y ─────

const SPAM_TRIGGER_WORDS = [
  'grátis', 'grátis!', 'garantido', 'ganhe dinheiro', 'clique aqui!!!',
  'oferta imperdível', 'última chance', 'sem compromisso!!!',
];

/**
 * Verificações de qualidade do conteúdo (FR-036): score de spam com
 * motivos, verificação de links (quebrados) e acessibilidade mínima
 * (imagem sem alt, botão sem label). `fetchImpl` injetável para testes.
 */
async function runQualityChecks(prisma, campaign, { fetchImpl } = {}) {
  const doFetch = fetchImpl || fetch;
  const contents = await prisma.studioContent.findMany({
    where: { campaignId: campaign.id, kind: 'base', stepIndex: 1 },
  });
  const items = [];
  let spamScore = 0;

  for (const content of contents) {
    const texts = contentTexts(content);
    const fullText = texts.join(' ');

    // Spam: palavras-gatilho, caixa alta, excesso de exclamações.
    const lower = fullText.toLowerCase();
    for (const word of SPAM_TRIGGER_WORDS) {
      if (lower.includes(word)) {
        spamScore += 15;
        items.push({ check: `spam:${content.channel}`, level: 'attention', detail: `Termo comum em spam: "${word}"` });
      }
    }
    const capsWords = (fullText.match(/\b[A-ZÁÉÍÓÚÃÕÇ]{5,}\b/g) || []).length;
    if (capsWords >= 3) {
      spamScore += 10;
      items.push({ check: `spam:${content.channel}`, level: 'attention', detail: `${capsWords} palavras em MAIÚSCULAS` });
    }
    const exclamations = (fullText.match(/!/g) || []).length;
    if (exclamations > 3) {
      spamScore += 10;
      items.push({ check: `spam:${content.channel}`, level: 'attention', detail: `${exclamations} exclamações` });
    }

    // Links: validar cada URL do conteúdo.
    const urls = [];
    for (const block of content.emailDoc?.blocks || []) {
      if (block.url) urls.push(block.url);
    }
    for (const url of urls) {
      try {
        const res = await doFetch(url, { method: 'HEAD' });
        if (!res.ok) {
          items.push({ check: `links:${content.channel}`, level: 'attention', detail: `Link respondeu HTTP ${res.status}: ${url}` });
        }
      } catch (err) {
        items.push({ check: `links:${content.channel}`, level: 'block', detail: `Link inacessível: ${url} (${err.message})` });
      }
    }

    // Acessibilidade mínima.
    for (const block of content.emailDoc?.blocks || []) {
      if (block.type === 'image' && !block.alt) {
        items.push({ check: `a11y:${content.channel}`, level: 'attention', detail: 'Imagem sem texto alternativo (alt)' });
      }
      if (block.type === 'button' && !block.label) {
        items.push({ check: `a11y:${content.channel}`, level: 'attention', detail: 'Botão sem rótulo' });
      }
    }
  }

  spamScore = Math.min(100, spamScore);
  const level = items.some((i) => i.level === 'block') ? 'block' : items.length > 0 ? 'attention' : 'ok';
  return { spamScore, level, items };
}

module.exports.runQualityChecks = runQualityChecks;

// ── Compliance Guard completo (US12, T117 — FR-073) ────────────────────────

/**
 * Parecer completo pré-aprovação: conteúdo/descadastro/spam (partes 1-3),
 * consentimento/base legal por lead (LGPD — comunicação comercial B2B) e
 * dados sensíveis no conteúdo. Persiste em StudioComplianceReview.
 */
async function runFullCompliance(prisma, campaign) {
  const checks = await runPreApprovalChecks(prisma, campaign);
  const items = [...checks.items];

  // Base legal dos leads: contato com e-mail/telefone identificado na base
  // e sem opt-out já é coberto pelas exclusões; aqui quantificamos leads
  // incluídos sem NENHUM dado de contato (sem base verificável).
  const snapshotRows = await prisma.studioAudienceSnapshot.findMany({
    where: { campaignId: campaign.id, status: 'active' },
  });
  const snapshot = snapshotRows[0];
  if (snapshot) {
    const members = await prisma.studioAudienceMember.findMany({
      where: { snapshotId: snapshot.id, included: true },
    });
    let semBase = 0;
    for (const member of members) {
      const prospect = await prisma.prospect.findUnique({ where: { id: member.prospectId } });
      if (!prospect?.cnpjEmail && !(prospect?.cnpjPhones || []).length) semBase += 1;
    }
    if (semBase > 0) {
      items.push({
        check: 'lgpd_base_legal',
        level: 'attention',
        detail: `${semBase} lead(s) incluído(s) sem contato identificável na base — revise o consentimento.`,
        affectedLeads: semBase,
      });
    }
  }

  // Dados sensíveis no conteúdo (LGPD art. 5º): CPF, saúde, religião…
  for (const content of await prisma.studioContent.findMany({ where: { campaignId: campaign.id } })) {
    const texts = contentTexts(content);
    const sensitive = /(cpf|doença|religi|orientação sexual|biometria)/i;
    for (const text of texts) {
      if (sensitive.test(text)) {
        items.push({
          check: `dados_sensiveis:${content.channel}`,
          level: 'block',
          detail: 'Conteúdo menciona dados sensíveis (LGPD art. 5º, II). Remova.',
        });
      }
    }
  }

  const level = items.some((i) => i.level === 'block') ? 'block' : items.some((i) => i.level === 'attention') ? 'attention' : 'ok';
  const review = await prisma.studioComplianceReview.create({
    data: { orgId: campaign.orgId, campaignId: campaign.id, level, items },
  });
  const metrics = require('../metrics');
  if (metrics.incStudioComplianceReview) metrics.incStudioComplianceReview(level);
  return { level, items, reviewId: review.id };
}

module.exports.runFullCompliance = runFullCompliance;
