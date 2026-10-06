'use strict';

/**
 * studio/guardrails.js — salvaguardas da automação opt-in (specs/010, T036).
 *
 * Decisão de clarify (Q1): suítes automáticas pós-enriquecimento geridas
 * pelo Studio exigem aprovação do PRIMEIRO lote (amostra real de mensagens);
 * os disparos seguintes correm sozinhos sob salvaguardas, com pausa
 * automática ao detectar anomalia (pico de bounce/opt-out) e retomada
 * apenas por ação humana (FR-003 — a única exceção à aprovação total).
 */

const { httpError } = require('./errors');

const BOUNCE_RATE_THRESHOLD = Number(process.env.STUDIO_GUARDRAIL_BOUNCE_RATE || 0.2);
const MIN_SAMPLE_FOR_ANOMALY = Number(process.env.STUDIO_GUARDRAIL_MIN_SAMPLE || 10);
const OPTOUT_COUNT_THRESHOLD = Number(process.env.STUDIO_GUARDRAIL_OPTOUT_COUNT || 3);
const ANOMALY_WINDOW_HOURS = Number(process.env.STUDIO_GUARDRAIL_WINDOW_HOURS || 24);

/** A campanha é automação opt-in gerida pelo Studio? */
function isAutomation(campaign) {
  return campaign.approval?.automation === true;
}

/** Execuções de canal da campanha (com guardrails próprios). */
async function channelExecutions(prisma, campaign) {
  const execs = [];
  if (campaign.emailExecutionId) {
    const e = await prisma.outreachCampaign.findUnique({ where: { id: campaign.emailExecutionId } });
    if (e) execs.push({ kind: 'email', row: e });
  }
  if (campaign.whatsappExecutionId) {
    const w = await prisma.whatsAppCampaign.findUnique({ where: { id: campaign.whatsappExecutionId } });
    if (w) execs.push({ kind: 'whatsapp', row: w });
  }
  return execs;
}

/** true enquanto o 1º lote não foi aprovado (fila retida — FR-003/guard-rails). */
async function hasPendingFirstBatch(prisma, campaign) {
  if (!isAutomation(campaign)) return false;
  const execs = await channelExecutions(prisma, campaign);
  if (execs.length === 0) return false;
  return execs.some((e) => !e.row.guardrails?.firstBatchApprovedAt);
}

/**
 * Aprova o primeiro lote: grava `firstBatchApprovedAt` nas execuções e
 * devolve a amostra real (leads do lote) para revisão do usuário.
 */
async function approveFirstBatch(prisma, campaign) {
  if (!isAutomation(campaign)) {
    throw httpError('NOT_AUTOMATION', 400, 'Campanha não é automação opt-in.');
  }
  // Despertar do 1º lote (lista fechada FR-31) — aditivo, à prova de falha.
  try {
    const autonomy = require('./autonomy');
    await autonomy.report(prisma, {
      orgId: campaign.orgId,
      type: 'studio.campaign.first_batch',
      campaignId: campaign.id,
      details: { reason: 'primeiro lote aguardando aprovação humana' },
    });
  } catch (_) { /* despertar nunca quebra o guard-rail */ }
  const execs = await channelExecutions(prisma, campaign);
  const approvedAt = new Date();
  const sample = [];
  for (const { kind, row } of execs) {
    const guardrailsData = { ...(row.guardrails || {}), firstBatchApprovedAt: approvedAt };
    await (kind === 'email'
      ? prisma.outreachCampaign.update({ where: { id: row.id }, data: { guardrails: guardrailsData } })
      : prisma.whatsAppCampaign.update({ where: { id: row.id }, data: { guardrails: guardrailsData } }));
    row.guardrails = guardrailsData;

    const contacts = kind === 'email'
      ? await prisma.outreachContact.findMany({ where: { campaignId: row.id } })
      : await prisma.whatsAppCampaignContact.findMany({ where: { campaignId: row.id } });
    for (const contact of contacts.slice(0, 10)) {
      const prospect = await prisma.prospect.findUnique({ where: { id: contact.prospectId } });
      sample.push({ prospectId: contact.prospectId, companyName: prospect?.companyName || null, channel: kind });
    }
  }
  return { approvedAt: approvedAt.toISOString(), sample };
}

/**
 * Avalia anomalias após um lote: taxa de bounce e opt-outs na janela de
 * tempo configurável. Acima do limiar → pausa a campanha com motivo e
 * registra `anomalyPausedAt` na execução. Retomada exige ação humana.
 */
async function evaluateAnomaly(prisma, campaign) {
  if (!isAutomation(campaign)) return { paused: false };
  const since = new Date(Date.now() - ANOMALY_WINDOW_HOURS * 3600_000);
  const reasons = [];

  if (campaign.emailExecutionId) {
    const recent = await prisma.outreachContact.findMany({
      where: { campaignId: campaign.emailExecutionId, sentAt: { gte: since } },
    });
    const sent = recent.filter((c) => ['SENT', 'BOUNCED', 'UNSUBSCRIBED'].includes(c.status));
    const bounced = recent.filter((c) => c.status === 'BOUNCED');
    const optouts = recent.filter((c) => c.status === 'UNSUBSCRIBED');
    if (sent.length >= MIN_SAMPLE_FOR_ANOMALY) {
      const bounceRate = bounced.length / sent.length;
      if (bounceRate > BOUNCE_RATE_THRESHOLD) {
        reasons.push(`bounce ${(bounceRate * 100).toFixed(0)}% (limiar ${(BOUNCE_RATE_THRESHOLD * 100).toFixed(0)}%)`);
      }
    }
    if (optouts.length >= OPTOUT_COUNT_THRESHOLD) {
      reasons.push(`${optouts.length} opt-outs na janela`);
    }
  }

  if (reasons.length === 0) return { paused: false };

  const reason = `anomalia detectada: ${reasons.join('; ')}`;
  // Despertar do Contrato de Autonomia (FR-31) — aditivo, nunca quebra.
  try {
    const autonomy = require('./autonomy');
    await autonomy.report(prisma, {
      orgId: campaign.orgId,
      type: 'studio.anomaly.detected',
      campaignId: campaign.id,
      details: { reason },
    });
  } catch (_) { /* despertar nunca quebra o guard-rail */ }
  for (const { kind, row } of await channelExecutions(prisma, campaign)) {
    const guardrailsData = {
      ...(row.guardrails || {}),
      anomalyPausedAt: new Date(),
      anomalyReason: reason,
    };
    await (kind === 'email'
      ? prisma.outreachCampaign.update({ where: { id: row.id }, data: { guardrails: guardrailsData } })
      : prisma.whatsAppCampaign.update({ where: { id: row.id }, data: { guardrails: guardrailsData } }));
  }
  await prisma.studioCampaign.update({
    where: { id: campaign.id },
    data: { status: 'paused', statusReason: reason },
  });
  campaign.status = 'paused';
  campaign.statusReason = reason;
  try {
    const { notify } = require('./notify');
    await notify(prisma, {
      orgId: campaign.orgId,
      type: 'studio.campaign.paused_anomaly',
      campaignId: campaign.id,
      severity: 'critical',
      details: { reason },
    });
  } catch (_) { /* notificação nunca quebra */ }
  return { paused: true, reason };
}

module.exports = {
  BOUNCE_RATE_THRESHOLD,
  MIN_SAMPLE_FOR_ANOMALY,
  OPTOUT_COUNT_THRESHOLD,
  isAutomation,
  hasPendingFirstBatch,
  approveFirstBatch,
  evaluateAnomaly,
};
