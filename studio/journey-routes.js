'use strict';

/**
 * studio/journey-routes.js — rotas de journeys (US8, T083–T086): validação e
 * controle, webhook autenticado (token opaco, 202 sempre, rate limit),
 * sync-delta de audiência para recorrentes e stats por bloco.
 */

const crypto = require('crypto');
const { httpError } = require('./errors');
const journeyEngine = require('./journey-engine');

/** Rate limit simples em memória por token (v1; Redis na onda de polish). */
const rateBucket = new Map();
function rateLimited(token, limitPerMin = 60) {
  const now = Date.now();
  const bucket = rateBucket.get(token) || [];
  const recent = bucket.filter((t) => now - t < 60_000);
  recent.push(now);
  rateBucket.set(token, recent);
  return recent.length > limitPerMin;
}

async function loadJourney(prisma, orgId, id) {
  const journey = await prisma.studioJourney.findUnique({ where: { id } });
  if (!journey || journey.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Journey não encontrado');
  return journey;
}

function registerJourneyRoutes(router, context) {
  const { prisma } = context;

  // GET /campaigns/:id/journey — devolve a jornada salva (P0 pente-fino
  // 2026-10-09: só existia PUT — o canvas carregava sempre vazio com
  // fallback silencioso, sem erro na UI).
  router.get('/campaigns/:id/journey', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
      const journey = await prisma.studioJourney.findFirst({
        where: { campaignId: campaign.id },
        orderBy: { updatedAt: 'desc' },
      });
      res.json({
        success: true,
        data: journey
          ? { id: journey.id, campaignId: journey.campaignId, definition: journey.definition, triggers: journey.triggers, stopConditions: journey.stopConditions, status: journey.status, updatedAt: journey.updatedAt }
          : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // PUT /campaigns/:id/journey — salva definição + gatilhos + paradas.
  router.put('/campaigns/:id/journey', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
      const body = req.body || {};
      const errors = journeyEngine.validateDefinition(body.definition || {});
      if (errors.length > 0) {
        throw httpError('INVALID_JOURNEY', 400, errors.join(' '));
      }
      const existing = await prisma.studioJourney.findMany({ where: { campaignId: campaign.id } });
      let journey;
      if (existing[0]) {
        journey = await prisma.studioJourney.update({
          where: { id: existing[0].id },
          data: {
            definition: body.definition,
            triggers: body.triggers || [],
            stopConditions: body.stopConditions || ['reply', 'opt_out', 'converted'],
          },
        });
      } else {
        journey = await prisma.studioJourney.create({
          data: {
            orgId,
            campaignId: campaign.id,
            definition: body.definition,
            triggers: body.triggers || [],
            stopConditions: body.stopConditions || ['reply', 'opt_out', 'converted'],
            status: 'draft',
          },
        });
      }
      res.json({ success: true, data: journey });
    } catch (err) {
      next(err);
    }
  });

  // POST /journeys/:id/control — activate | pause.
  router.post('/journeys/:id/control', async (req, res, next) => {
    try {
      const journey = await loadJourney(prisma, req.studio.orgId, req.params.id);
      const action = (req.body || {}).action;
      if (action === 'activate') {
        // Ativar exige campanha aprovada (nada corre sem aprovação — FR-003).
        const campaign = await prisma.studioCampaign.findUnique({ where: { id: journey.campaignId } });
        if (!campaign || !['approved', 'scheduled', 'running'].includes(campaign.status)) {
          throw httpError('CAMPAIGN_NOT_APPROVED', 409, 'Aprove a campanha antes de ativar o journey.');
        }
      }
      if (!['activate', 'pause'].includes(action)) {
        throw httpError('INVALID_ACTION', 400, `Ação inválida: ${action}`);
      }
      const updated = await prisma.studioJourney.update({
        where: { id: journey.id },
        data: { status: action === 'activate' ? 'active' : 'paused' },
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // POST /journeys/:id/webhook/:token — gatilho externo autenticado (FR-054).
  router.post('/journeys/:id/webhook/:token', async (req, res, next) => {
    try {
      const journey = await prisma.studioJourney.findUnique({ where: { id: req.params.id } });
      // 202 sempre: webhook não revela existência de journey/lead (D15).
      if (!journey || !journey.webhookToken || journey.status !== 'active') {
        return res.status(202).json({ success: true });
      }
      const supplied = String(req.params.token || '');
      const hashed = crypto.createHash('sha256').update(supplied).digest('hex');
      const a = Buffer.from(hashed);
      const b = Buffer.from(journey.webhookToken);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(202).json({ success: true });
      }
      if (rateLimited(supplied)) {
        return res.status(202).json({ success: true });
      }
      const prospectRef = String((req.body || {}).prospectRef || '');
      if (!prospectRef) return res.status(202).json({ success: true });
      // Lead precisa pertencer À MESMA org do journey (constituição IV).
      const prospect = await prisma.prospect.findFirst({
        where: { orgId: journey.orgId, OR: [{ id: prospectRef }, { cnpj: prospectRef.replace(/\D/g, '') }, { cnpjEmail: prospectRef.toLowerCase() }] },
      });
      if (prospect) {
        await journeyEngine.enrollLead(prisma, journey, prospect.id);
      }
      res.status(202).json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /journeys/:id/stats — leads por bloco (FR-056).
  router.get('/journeys/:id/stats', async (req, res, next) => {
    try {
      const journey = await loadJourney(prisma, req.studio.orgId, req.params.id);
      const leads = await prisma.studioJourneyLead.findMany({
        where: { journeyId: journey.id },
      });
      const byBlock = {};
      for (const lead of leads) {
        const key = lead.currentBlockId || 'none';
        byBlock[key] = byBlock[key] || { entered: 0, waiting: 0, done: 0, stopped: 0 };
        byBlock[key].entered += 1;
        if (lead.status === 'waiting') byBlock[key].waiting += 1;
        if (lead.status === 'done') byBlock[key].done += 1;
        if (lead.status === 'stopped') byBlock[key].stopped += 1;
      }
      res.json({ success: true, data: byBlock });
    } catch (err) {
      next(err);
    }
  });
// POST /campaigns/:id/audience/sync-delta [premium] — recorrentes (FR-055):
// recalcula o segmento, cria NOVO snapshot (anterior → superseded) e inscreve
// somente leads novos no journey; salvaguardas completas de exclusão.
router.post('/campaigns/:id/audience/sync-delta', async (req, res, next) => {
  try {
    await context.requirePremiumOrg(req.studio.orgId);
    const { orgId } = req.studio;
    const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
    if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
    const body = req.body || {};
    if (!body.segmentId) throw httpError('INVALID_AUDIENCE', 400, 'Informe segmentId para sincronizar.');
    const segment = await prisma.studioSegment.findUnique({ where: { id: String(body.segmentId) } });
    if (!segment || segment.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Segmento não encontrado');

    const compliance = require('./compliance-service');
    const where = require('./segment-service').buildWhere(orgId, segment.criteria);
    const prospects = await prisma.prospect.findMany({ where });
    const members = await compliance.classifyAudience(prisma, {
      orgId,
      prospectIds: prospects.map((p) => p.id),
      channels: campaign.channels || [],
    });

    const previous = await prisma.studioAudienceSnapshot.findMany({
      where: { campaignId: campaign.id, status: 'active' },
    });
    await prisma.studioAudienceSnapshot.updateMany({
      where: { campaignId: campaign.id, status: 'active' },
      data: { status: 'superseded' },
    });
    const snapshot = await prisma.studioAudienceSnapshot.create({
      data: {
        orgId,
        campaignId: campaign.id,
        segmentId: segment.id,
        criteriaVersion: segment.criteria,
        totalCount: members.length,
        includedCount: members.filter((m) => m.included).length,
        excludedCount: members.filter((m) => !m.included).length,
        status: 'active',
      },
    });
    const newMembers = [];
    for (const member of members) {
      await prisma.studioAudienceMember.create({
        data: {
          snapshotId: snapshot.id,
          prospectId: member.prospectId,
          included: member.included,
          excludeReason: member.excludeReason || null,
        },
      });
      if (member.included) newMembers.push(member.prospectId);
    }

    // Journeys ativos da campanha: inscreve somente os NOVOS incluídos.
    const journeys = await prisma.studioJourney.findMany({
      where: { campaignId: campaign.id, status: 'active' },
    });
    let enrolled = 0;
    for (const journey of journeys) {
      for (const prospectId of newMembers) {
        const before = await prisma.studioJourneyLead.findMany({
          where: { journeyId: journey.id, prospectId },
        });
        if (before.length === 0) {
          await journeyEngine.enrollLead(prisma, journey, prospectId);
          enrolled += 1;
        }
      }
    }
    res.json({
      success: true,
      data: {
        snapshotId: snapshot.id,
        includedCount: snapshot.includedCount,
        excludedCount: snapshot.excludedCount,
        journeysEnrolled: enrolled,
      },
    });
  } catch (err) {
    next(err);
  }
});


}
module.exports = { registerJourneyRoutes };
