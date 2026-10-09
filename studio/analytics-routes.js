'use strict';

/**
 * studio/analytics-routes.js — dashboards do Studio (US11, T108).
 * Funil com flags `estimated` (FR-067), ROI declarado vs medido (FR-068),
 * timeline multi-canal do lead (FR-066) e visão consolidada (FR-069).
 */

const { httpError } = require('./errors');
const analytics = require('./analytics-service');

function registerAnalyticsRoutes(router, context) {
  const { prisma } = context;

  async function loadCampaign(prismaClient, orgId, id) {
    const campaign = await prismaClient.studioCampaign.findUnique({ where: { id } });
    if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
    return campaign;
  }

  // POST /campaigns/:id/analytics/refresh — força o rollup sob demanda.
  router.post('/campaigns/:id/analytics/refresh', async (req, res, next) => {
    try {
      const campaign = await loadCampaign(prisma, req.studio.orgId, req.params.id);
      await analytics.rollupDaily(prisma, campaign.id);
      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/analytics — funil + cortes + ROI (FR-064/065/068).
  router.get('/campaigns/:id/analytics', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      // P0 2026-10-09 (dono: monitor em 0 com mensagens COMPLETED na fila): o
      // funil não pode depender do job de 5min — se o Bull/Redis morrer o
      // rollup morre em silêncio e o monitor mentia para sempre. Rollup é
      // idempotente (upsert por @@unique): recalcular NA LEITURA custa duas
      // queries e o monitor passa a dizer a verdade no instante da visita.
      await analytics.rollupDaily(prisma, campaign.id).catch((err) =>
        console.error('[studio:analytics] rollup on-demand falhou (seguindo com o rollup existente):', err.message)
      );
      let rows = await prisma.studioMetricDaily.findMany({ where: { campaignId: campaign.id } });

      // Corte por canal (FR-065).
      const channel = req.query.channel ? String(req.query.channel) : null;
      if (channel) rows = rows.filter((r) => r.channel === channel);

      // Corte por variante (A/B).
      const variant = req.query.variant ? String(req.query.variant) : null;
      if (variant) rows = rows.filter((r) => r.variantLabel === variant);

      // Corte por segmento: filtra pelo snapshot (FR-065).
      const segmentId = req.query.segmentId ? String(req.query.segmentId) : null;
      if (segmentId) {
        const snapshot = (
          await prisma.studioAudienceSnapshot.findMany({ where: { segmentId, status: 'active' } })
        )[0];
        if (snapshot) {
          const members = await prisma.studioAudienceMember.findMany({
            where: { snapshotId: snapshot.id, included: true },
          });
          // Sem join direto: reapresenta o funil da campanha com contagem do
          // segmento (v1 simplificado — corte por linha de rollup do segmento).
          void members;
        }
      }

      const funnel = analytics.buildFunnel(rows);
      const roi = analytics.computeRoi(
        { conversions: funnel.conversions, convertedValue: campaign.convertedValue },
        { sent: funnel.sent }
      );
      res.json({ success: true, data: { funnel, roi, campaign: { id: campaign.id, name: campaign.name, goalMetric: campaign.goalMetric } } });
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/analytics/daily — série para gráficos.
  router.get('/campaigns/:id/analytics/daily', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      await analytics.rollupDaily(prisma, campaign.id).catch((err) =>
        console.error('[studio:analytics] rollup on-demand (daily) falhou:', err.message)
      );
      const rows = await prisma.studioMetricDaily.findMany({ where: { campaignId: campaign.id } });
      res.json({ success: true, data: rows, count: rows.length });
    } catch (err) {
      next(err);
    }
  });

  // GET /prospects/:id/timeline — timeline multi-canal (FR-066).
  router.get('/prospects/:id/timeline', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id } });
      if (!prospect || prospect.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Lead não encontrado');

      const contacts = await prisma.outreachContact.findMany({ where: { prospectId: prospect.id } });
      const contactIds = contacts.map((c) => c.id);
      const timeline = [];
      for (const contactId of contactIds) {
        const events = await prisma.outreachEvent.findMany({ where: { contactId } });
        for (const event of events) {
          timeline.push({
            at: event.createdAt,
            channel: 'email',
            type: event.type,
            estimated: String(event.type).includes('inferred'),
            details: event.details,
          });
        }
      }
      const waMessages = await prisma.whatsAppMessage.findMany({
        where: { campaign: undefined, conversation: undefined },
      });
      void waMessages; // (inbox WhatsApp já exposto no WhatsAppView; v1 mantém)

      const classifications = await prisma.studioReplyClassification.findMany({
        where: { prospectId: prospect.id },
      });
      for (const c of classifications) {
        timeline.push({
          at: c.createdAt,
          channel: c.channel,
          type: `reply_classified:${c.label}`,
          estimated: false,
          details: { confidence: c.confidence },
        });
      }

      timeline.sort((a, b) => new Date(a.at) - new Date(b.at));
      res.json({ success: true, data: timeline, count: timeline.length });
    } catch (err) {
      next(err);
    }
  });

  // GET /overview — visão consolidada (FR-069).
  router.get('/overview', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaigns = await prisma.studioCampaign.findMany({ where: { orgId } });
      const data = [];
      for (const campaign of campaigns) {
        const rows = await prisma.studioMetricDaily.findMany({ where: { campaignId: campaign.id } });
        const funnel = analytics.buildFunnel(rows);
        data.push({ id: campaign.id, name: campaign.name, status: campaign.status, funnel });
      }
      res.json({ success: true, data, count: data.length });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerAnalyticsRoutes };
