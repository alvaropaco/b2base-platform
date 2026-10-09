'use strict';

/**
 * studio/analytics-service.js — rollups, funil, cortes e ROI (US11, T107).
 * Idempotência por @@unique([campaignId, day, channel, variantLabel,
 * stepIndex]) — reprocessar nunca duplica (constituição II, research D11).
 * Métricas inferidas (abertura/entrega de e-mail) carregam flags
 * `estimated` (FR-067).
 */

const dayKey = (date) => new Date(new Date(date).toISOString().slice(0, 10));

/**
 * Rollup incremental de uma campanha: lê contatos/eventos dos motores e
 * faz upsert na StudioMetricDaily do dia de cada evento.
 */
async function rollupDaily(prisma, campaignId) {
  const campaign = await prisma.studioCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return [];

  const newBucket = () => ({
    sent: 0, bounces: 0, unsubs: 0, opens: 0, clicks: 0, replies: 0,
    delivered: 0, deliveredEstimated: 0, opensEstimated: 0, conversions: 0,
    whatsappReads: 0,
  });

  // ── Canal E-MAIL ──────────────────────────────────────────────────────────
  if (campaign.emailExecutionId) {
    const contacts = await prisma.outreachContact.findMany({
      where: { campaignId: campaign.emailExecutionId },
    });
    const byDay = new Map();
    const bucketFor = (key) => {
      if (!byDay.has(key)) byDay.set(key, newBucket());
      return byDay.get(key);
    };

    // CONTATO (fonte primária — status é terminal, conta 1× por contato):
    // enviados/entregues no dia do envio; aberturas/respostas contadas via
    // STATUS. Eventos complementares só valem quando o status NÃO registrou
    // (contar status E evento duplicava cada abertura/resposta ~2×).
    const openedViaStatus = new Set();
    const repliedViaStatus = new Set();
    for (const contact of contacts) {
      if (!contact.sentAt) continue;
      const key = dayKey(contact.sentAt).toISOString();
      const bucket = bucketFor(key);
      bucket.sent += 1;
      if (['SENT', 'DELIVERED_INFERRED', 'OPENED_INFERRED', 'REPLIED'].includes(contact.status)) bucket.delivered += 1;
      if (contact.status === 'DELIVERED_INFERRED') { bucket.deliveredEstimated += 1; bucket.opensEstimated += 1; }
      if (contact.status === 'BOUNCED') bucket.bounces += 1;
      if (contact.status === 'UNSUBSCRIBED') bucket.unsubs += 1;
      if (contact.status === 'OPENED_INFERRED' || contact.status === 'REPLIED') {
        bucket.opens += 1;
        openedViaStatus.add(contact.id);
      }
      if (contact.status === 'REPLIED') {
        bucket.replies += 1;
        repliedViaStatus.add(contact.id);
      }
    }

    // EVENTOS: só cobram o que o status NÃO registrou (clique não tem status;
    // abertura/resposta de writers que só gravam evento). Dias sem envio
    // agora criam bucket (cauda de engajamento pós-envio não se perde).
    const contactIds = contacts.map((c) => c.id);
    if (contactIds.length > 0) {
      const events = await prisma.outreachEvent.findMany({
        where: { contactId: { in: contactIds } },
        select: { type: true, contactId: true, createdAt: true },
      });
      for (const event of events) {
        if (!event.createdAt) continue;
        if (event.type === 'email_clicked') {
          bucketFor(dayKey(event.createdAt).toISOString()).clicks += 1;
          continue;
        }
        if (event.type === 'email_opened_inferred' && !openedViaStatus.has(event.contactId)) {
          const bucket = bucketFor(dayKey(event.createdAt).toISOString());
          bucket.opens += 1;
          bucket.opensEstimated += 1;
          openedViaStatus.add(event.contactId);
        }
        if (event.type === 'email_replied' && !repliedViaStatus.has(event.contactId)) {
          bucketFor(dayKey(event.createdAt).toISOString()).replies += 1;
          repliedViaStatus.add(event.contactId);
        }
      }
    }

    for (const [key, bucket] of byDay) {
      const day = new Date(key);
      const existing = await prisma.studioMetricDaily.findMany({
        where: { campaignId, day, channel: 'email', variantLabel: 'A', stepIndex: 1 },
      });
      if (existing[0]) {
        await prisma.studioMetricDaily.update({ where: { id: existing[0].id }, data: bucket });
      } else {
        await prisma.studioMetricDaily.create({
          data: {
            orgId: campaign.orgId, campaignId, day, channel: 'email',
            variantLabel: 'A', stepIndex: 1, ...bucket,
          },
        });
      }
    }
  }

  // ── Canal WHATSAPP (2026-10-09 — o Monitor não contava WA nenhum): ────────
  // envio = contato com lastSentAt (contado 1×, dia do 1º envio); entrega =
  // mensagens DELIVERED/READ (dia de cada mensagem); leitura = READ;
  // respostas = contato REPLIED; bounce = mensagem FAILED; descadastro =
  // contato OPTED_OUT / cancelado por do_not_contact.
  if (campaign.whatsappExecutionId) {
    const waContacts = await prisma.whatsAppCampaignContact.findMany({
      where: { campaignId: campaign.whatsappExecutionId },
    });
    const byDay = new Map();
    const bucketFor = (key) => {
      if (!byDay.has(key)) byDay.set(key, newBucket());
      return byDay.get(key);
    };
    const contactIds = [];
    for (const c of waContacts) {
      contactIds.push(c.id);
      if (c.lastSentAt) {
        bucketFor(dayKey(c.lastSentAt).toISOString()).sent += 1;
      }
      if (c.status === 'REPLIED') bucketFor(dayKey(c.lastSentAt || c.updatedAt).toISOString()).replies += 1;
      if (c.status === 'OPTED_OUT' || (c.status === 'CANCELLED' && c.cancelReason === 'do_not_contact')) {
        bucketFor(dayKey(c.updatedAt || c.createdAt).toISOString()).unsubs += 1;
      }
    }
    if (contactIds.length > 0) {
      const messages = await prisma.whatsAppMessage.findMany({
        where: { campaignContactId: { in: contactIds } },
        select: { status: true, createdAt: true },
      });
      for (const m of messages) {
        const bucket = bucketFor(dayKey(m.createdAt).toISOString());
        if (m.status === 'DELIVERED' || m.status === 'READ') bucket.delivered += 1;
        if (m.status === 'READ') bucket.whatsappReads += 1;
        if (m.status === 'FAILED') bucket.bounces += 1;
      }
    }
    for (const [key, bucket] of byDay) {
      const day = new Date(key);
      const existing = await prisma.studioMetricDaily.findMany({
        where: { campaignId, day, channel: 'whatsapp', variantLabel: 'A', stepIndex: 1 },
      });
      if (existing[0]) {
        await prisma.studioMetricDaily.update({ where: { id: existing[0].id }, data: bucket });
      } else {
        await prisma.studioMetricDaily.create({
          data: {
            orgId: campaign.orgId, campaignId, day, channel: 'whatsapp',
            variantLabel: 'A', stepIndex: 1, ...bucket,
          },
        });
      }
    }
  }

  return prisma.studioMetricDaily.findMany({ where: { campaignId } });
}

/** Funil agregado a partir das linhas de rollup (FR-064/067). */
function buildFunnel(metricRows) {
  const totals = {
    sent: 0, delivered: 0, deliveredEstimated: 0, opens: 0, opensEstimated: 0,
    clicks: 0, replies: 0, conversions: 0, bounces: 0, unsubs: 0,
  };
  for (const row of metricRows || []) {
    for (const key of Object.keys(totals)) totals[key] += row[key] || 0;
  }
  const rate = (num, den) => (den ? Number((num / den).toFixed(4)) : 0);
  return {
    ...totals,
    estimated: totals.opensEstimated > 0 || totals.deliveredEstimated > 0,
    rates: {
      deliveredRate: rate(totals.delivered, totals.sent),
      openRate: rate(totals.opens, totals.delivered),
      clickRate: rate(totals.clicks, totals.delivered),
      replyRate: rate(totals.replies, totals.delivered),
      bounceRate: rate(totals.bounces, totals.sent),
    },
  };
}

/** ROI: receita declarada (conversões × valor informado) vs métrica medida. */
function computeRoi(metrics, funnel) {
  const convertedValue = metrics.convertedValue || 0;
  const declaredRevenue = (metrics.conversions || 0) * convertedValue;
  return {
    declaredRevenue, // valor DECLARADO pelo usuário (FR-068)
    measured: { conversions: metrics.conversions || 0, sent: funnel?.sent || 0 },
    revenuePerSend: funnel?.sent ? Math.round(declaredRevenue / funnel.sent) : 0,
  };
}

module.exports = { rollupDaily, buildFunnel, computeRoi, dayKey };

/** Registro do repeat job de 5min (produção) — T107. */
function registerStudioMetrics(prisma) {
  try {
    const { createQueue } = require('../outreach-queues');
    const queue = createQueue('studio:metrics');
    // P0 2026-10-09 (raiz real no stack do Bull 4.16.5): job COM NOME
    // ('rollup') exige processador NOMEADO — queue.process(fn) anônimo nunca
    // casava ("Missing process handler for job type rollup": 3.509 falhas,
    // 0 concluídos). Além disso: incluir pausadas/canceladas (o funil de
    // campanha pausada também precisa continuar contando).
    queue.process('rollup', 1, async () => {
      const campaigns = await prisma.studioCampaign.findMany({
        where: { status: { in: ['running', 'scheduled', 'completed', 'paused', 'cancelled'] } },
      });
      for (const campaign of campaigns) {
        await rollupDaily(prisma, campaign.id).catch((err) =>
          console.error('[studio:metrics] rollup falhou', campaign.id, err.message)
        );
      }
    });
    queue
      .add('rollup', {}, { repeat: { every: 300_000 }, jobId: 'studio-metrics-rollup' })
      .then(() => console.log('[studio:metrics] ✓ repeat job registrado (5min)'))
      .catch((err) => console.error('[studio:metrics] repeat job:', err.message));
    return queue;
  } catch (err) {
    console.error('[studio:metrics] registro indisponível:', err.message);
    return null;
  }
}

module.exports.registerStudioMetrics = registerStudioMetrics;

/** Purga de snapshots superseded >90 dias (T138 — data-model, índices/volume). */
async function purgeOldSnapshots(prisma) {
  const cutoff = new Date(Date.now() - 90 * 86_400_000);
  const old = await prisma.studioAudienceSnapshot.findMany({
    where: { status: 'superseded', createdAt: { lt: cutoff } },
  });
  for (const snapshot of old) {
    await prisma.studioAudienceMember.deleteMany({ where: { snapshotId: snapshot.id } });
    await prisma.studioAudienceSnapshot.deleteMany({ where: { id: snapshot.id } });
  }
  return { purged: old.length };
}

function registerSnapshotPurge(prisma) {
  try {
    const { createQueue } = require('../outreach-queues');
    const queue = createQueue('studio:purge');
    queue
      .add('purge', {}, { repeat: { cron: '0 4 * * *' }, jobId: 'studio-snapshot-purge' })
      .catch((err) => console.error('[studio:purge] agendamento:', err.message));
    queue.process(async () => purgeOldSnapshots(prisma));
    return queue;
  } catch (err) {
    console.error('[studio:purge] registro indisponível:', err.message);
    return null;
  }
}
module.exports.registerSnapshotPurge = registerSnapshotPurge;
module.exports.purgeOldSnapshots = purgeOldSnapshots;
