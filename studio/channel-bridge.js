'use strict';

/**
 * studio/channel-bridge.js — compila uma StudioCampaign em execuções de
 * canal nos motores existentes (specs/010, T011; pesquisa D1).
 *
 * O Studio NÃO envia: cria/atualiza `OutreachCampaign` (e-mail) e/ou
 * `WhatsAppCampaign` (WhatsApp) apontadas por `studioCampaignId`, inscreve a
 * audiência congelada nos motores e deixa o envio/tracking/reply para os
 * workers atuais (outreach-workers.js / whatsapp-workers.js).
 *
 * specs/011 (AD-14): `enqueueBatch` é a PRIMITIVA ÚNICA de fila do Studio —
 * filtra inscritos, passa pelo gate de reputação (débito → messageIds) e
 * enfileira. Scheduler, dispatch imediato e Cockpit usam APENAS esta
 * primitiva; nenhuma rota nova fala com os workers diretamente.
 */

const crypto = require('crypto');
const reputationGate = require('./reputation-gate');

/**
 * fake-prisma expõe `whatsappCampaignContact`; o client real Prisma expõe
 * `whatsAppCampaignContact`. Resolver mantém o bridge compatível com ambos.
 */
function waContactModel(prisma) {
  return prisma.whatsAppCampaignContact || prisma.whatsappCampaignContact;
}

/**
 * Extrai texto plano de um documento de blocos do editor (naive).
 * US5 substitui pelo renderer MJML — aqui só precisamos de insumo de texto
 * para o template do motor de e-mail.
 */
function emailDocToText(emailDoc) {
  if (!emailDoc) return '';
  const blocks = Array.isArray(emailDoc.blocks) ? emailDoc.blocks : [];
  const out = [];
  for (const block of blocks) {
    if (typeof block === 'string') {
      out.push(block);
      continue;
    }
    if (block.text) out.push(block.text);
    else if (block.html) out.push(String(block.html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    else if (block.type === 'button' && block.label) out.push(block.label + (block.url ? `: ${block.url}` : ''));
  }
  return out.filter(Boolean).join('\n\n');
}

function contentOriginToEngineSource(contentOrigin) {
  return contentOrigin && String(contentOrigin).startsWith('ai') ? 'ai' : 'manual';
}

/**
 * FR-37 (RFC 8058) — headers de descadastro do canal e-mail, definidos no
 * compile (AD-2: nunca nascem nos workers). Sem URL pública de opt-out na
 * v1, o mecanismo existente da plataforma é o mailto de resposta; quando
 * houver URL, ela entra junto com o one-click (List-Unsubscribe-Post).
 */
function unsubscribeHeaders({ unsubscribeUrl = null, unsubscribeMailto = null } = {}) {
  const mailto = unsubscribeMailto || process.env.STUDIO_UNSUBSCRIBE_MAILTO || 'mailto:unsubscribe@b2base.net?subject=unsubscribe';
  const headers = { 'List-Unsubscribe': unsubscribeUrl ? `<${unsubscribeUrl}>, <${mailto}>` : `<${mailto}>` };
  if (unsubscribeUrl) {
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  return headers;
}

function unsubscribeFooter({ unsubscribeMailto = null } = {}) {
  const mailto = unsubscribeMailto || process.env.STUDIO_UNSUBSCRIBE_MAILTO || 'mailto:unsubscribe@b2base.net?subject=unsubscribe';
  return [
    '—',
    `Não quer mais receber? Responda "sair" ou use o link: ${mailto}`,
  ].join('\n');
}

/**
 * Cria (ou reusa) a execução de e-mail da campanha Studio.
 * Idempotente por studioCampaignId: aprovar 2× não duplica execuções.
 */
async function ensureEmailExecution(prisma, campaign, content) {
  const existing = campaign.emailExecutionId
    ? await prisma.outreachCampaign.findUnique({ where: { id: campaign.emailExecutionId } })
    : null;
  if (existing) return existing;

  const subject = content?.subject || campaign.name;
  const rawBody = content?.emailDoc
    ? emailDocToText(content.emailDoc)
    : content?.whatsappText || campaign.offer || campaign.objective || '';
  // FR-37: TODO e-mail compilado carrega rodapé de descadastro acessível e
  // os headers List-Unsubscribe/List-Unsubscribe-Post na execução (AD-2).
  const bodyText = `${rawBody}\n\n${unsubscribeFooter({ unsubscribeMailto: content?.unsubscribeMailto })}`;

  return prisma.outreachCampaign.create({
    data: {
      tenantId: campaign.orgId,
      name: `[Studio] ${campaign.name}`,
      description: campaign.description || null,
      objective: campaign.objective || null,
      offer: campaign.offer || null,
      status: 'draft',
      source: contentOriginToEngineSource(content?.origin),
      channels: ['email'],
      autoActive: false,
      emailTemplateSubject: subject,
      emailTemplateBody: bodyText,
      emailHeaders: unsubscribeHeaders({ unsubscribeUrl: content?.unsubscribeUrl, unsubscribeMailto: content?.unsubscribeMailto }),
      studioCampaignId: campaign.id,
    },
  });
}

/**
 * Sequência completa do Studio → steps do motor (T067, FR-043/FR-079):
 * toque 1 (base) + followups ordenados por stepIndex, delayDays → minutos.
 */
function compileSteps(baseContent, followupContents = []) {
  const steps = [];
  if (baseContent?.whatsappText) {
    steps.push({
      orderIndex: 1,
      messageTemplate: baseContent.whatsappText,
      aiPersonalized: false,
      delayMinutes: 0,
    });
  }
  const ordered = [...followupContents]
    .filter((c) => c.channel === 'whatsapp' && c.kind === 'followup' && c.whatsappText)
    .sort((a, b) => a.stepIndex - b.stepIndex);
  for (const followup of ordered) {
    steps.push({
      orderIndex: followup.stepIndex,
      messageTemplate: followup.whatsappText,
      aiPersonalized: false,
      delayMinutes: (followup.delayDays ?? 3) * 1440,
    });
  }
  return steps;
}

/**
 * Cria (ou reusa) a execução de WhatsApp da campanha Studio, compilando o
 * toque principal + followups configurados como steps do motor.
 */
async function ensureWhatsAppExecution(prisma, campaign, content, followupContents = []) {
  const existing = campaign.whatsappExecutionId
    ? await prisma.whatsappCampaign.findUnique({ where: { id: campaign.whatsappExecutionId } })
    : null;
  if (existing) return existing;

  const created = await prisma.whatsappCampaign.create({
    data: {
      orgId: campaign.orgId,
      name: `[Studio] ${campaign.name}`,
      objective: campaign.objective || null,
      offer: campaign.offer || null,
      ctaUrl: content?.ctaUrl || null,
      status: 'DRAFT',
      source: contentOriginToEngineSource(content?.origin),
      studioCampaignId: campaign.id,
    },
  });

  for (const step of compileSteps(content, followupContents)) {
    await prisma.whatsappSequenceStep.create({
      data: { campaignId: created.id, ...step },
    });
  }
  return created;
}

/**
 * Inscreve a audiência congelada (membros `included`) nas execuções de canal.
 * Idempotente: re-inscrever o mesmo lead na mesma execução é no-op.
 */
async function enrollAudience(prisma, { snapshot, emailExecution, whatsappExecution }) {
  const members = await prisma.studioAudienceMember.findMany({
    where: { snapshotId: snapshot.id, included: true },
  });
  let enrolled = 0;
  for (const member of members) {
    if (emailExecution) {
      const exists = await prisma.outreachContact.findFirst({
        where: { campaignId: emailExecution.id, prospectId: member.prospectId },
      });
      if (!exists) {
        await prisma.outreachContact.create({
          data: { campaignId: emailExecution.id, prospectId: member.prospectId, status: 'QUEUED' },
        });
        enrolled += 1;
      }
    }
    if (whatsappExecution) {
      const exists = await prisma.whatsappCampaignContact.findFirst({
        where: { campaignId: whatsappExecution.id, prospectId: member.prospectId },
      });
      if (!exists) {
        await prisma.whatsappCampaignContact.create({
          data: { campaignId: whatsappExecution.id, prospectId: member.prospectId, status: 'QUEUED' },
        });
        enrolled += 1;
      }
    }
  }
  return { members: members.length, enrolled };
}

/**
 * Compila a campanha Studio completa em execuções de canal e inscreve a
 * audiência. Usado pelo fluxo de aprovação (US1).
 */
async function compile(prisma, { campaign, contents, snapshot, channels }) {
  const byChannel = new Map((contents || []).map((c) => [c.channel, c]));
  const result = { emailExecution: null, whatsappExecution: null, enrollment: null };

  if (channels.includes('email')) {
    result.emailExecution = await ensureEmailExecution(prisma, campaign, byChannel.get('email'));
  }
  if (channels.includes('whatsapp')) {
    result.whatsappExecution = await ensureWhatsAppExecution(prisma, campaign, byChannel.get('whatsapp'));
  }
  result.enrollment = await enrollAudience(prisma, {
    snapshot,
    emailExecution: result.emailExecution,
    whatsappExecution: result.whatsappExecution,
  });
  return result;
}

/**
 * Primitiva ÚNICA de fila do Studio (specs/011, AD-14):
 *   1. filtra só leads INSCRITOS na execução de canal e ainda não liberados
 *      (preserva o filtro first-touch do motor);
 *   2. passa pelo gate de reputação (`consume` — débito materializa a fatia);
 *   3. marca a alocação (`scheduledAt`/`nextSendAt`) e enfileira com os ids;
 *   4. devolve o que entrou em voo e o que ficou bloqueado (explicável).
 *
 * `enqueue(channel, prospectIds)` é injetável (prod: motores; testes: captura).
 */
async function enqueueBatch(prisma, { campaign, channel, prospectIds, now = new Date(), enqueue }) {
  const requestedIds = [...new Set(prospectIds || [])];
  const emailExecutionId = campaign.emailExecutionId;
  const whatsappExecutionId = campaign.whatsappExecutionId;

  // 1) Filtro first-touch: só inscritos, ainda QUEUED e não liberados.
  let enrolled = [];
  if (channel === 'email' && emailExecutionId) {
    enrolled = await prisma.outreachContact.findMany({
      where: { campaignId: emailExecutionId, prospectId: { in: requestedIds }, status: 'QUEUED', scheduledAt: null },
    });
  } else if (channel === 'whatsapp' && whatsappExecutionId) {
    enrolled = await waContactModel(prisma).findMany({
      where: { campaignId: whatsappExecutionId, prospectId: { in: requestedIds }, status: 'QUEUED', nextSendAt: null },
    });
  } else {
    return {
      enqueued: [],
      blocked: { code: 'CANAL_NAO_CONFIGURADO', reason: 'A campanha não tem execução deste canal compilada.' },
    };
  }
  if (enrolled.length === 0) return { enqueued: [], blocked: null };

  // 2) Gate: pausa → canal → certificado → débito (fatia concedida).
  const batchId = `batch-${crypto.randomUUID()}`;
  const { granted, blocked, deficit } = await reputationGate.consume(prisma, {
    orgId: campaign.orgId,
    channel,
    units: enrolled.length,
    campaign,
    refType: 'batch',
    refId: batchId,
    reason: `lote da campanha "${campaign.name}"`,
    metadata: { campaignId: campaign.id, channel, requested: enrolled.length },
    now,
  });
  if (granted <= 0) {
    return { enqueued: [], granted: 0, batchId, blocked: blocked || { code: 'SALDO_INSUFICIENTE', reason: 'Gate não concedeu unidades.' } };
  }

  // 3) Fatia concedida: marca a alocação e enfileira nos motores.
  const slice = enrolled.slice(0, granted);
  const contacts = waContactModel(prisma);
  for (const contact of slice) {
    if (channel === 'email') {
      await prisma.outreachContact.update({ where: { id: contact.id }, data: { scheduledAt: now } });
    } else {
      await contacts.update({ where: { id: contact.id }, data: { nextSendAt: now } });
    }
  }
  const ids = slice.map((c) => c.prospectId);
  if (typeof enqueue === 'function') {
    await enqueue(channel, ids, batchId);
  } else {
    throw new Error('enqueueBatch requer enqueue de produção (makeProdEnqueue) ou injetado.');
  }

  const metrics = require('../metrics');
  metrics.incStudioSendsEnqueued(channel, ids.length);
  return {
    enqueued: ids,
    granted,
    requested: enrolled.length,
    deficit: deficit || 0,
    batchId,
    blocked: blocked || (granted < enrolled.length
      ? { code: 'SALDO_INSUFICIENTE', reason: `Saldo cobriu ${granted} de ${enrolled.length} unidades do lote.` }
      : null),
  };
}

module.exports = {
  compile,
  ensureEmailExecution,
  ensureWhatsAppExecution,
  enrollAudience,
  emailDocToText,
  compileSteps,
  enqueueBatch,
  waContactModel,
  unsubscribeHeaders,
};
