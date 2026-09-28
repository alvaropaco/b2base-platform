'use strict';

/**
 * studio/audience-routes.js — declaração de audiência da campanha (T015/US1;
 * US2 estende com segmentId e importação de lista).
 *
 * A audiência é materializada em snapshot imediatamente (membros + motivos
 * de exclusão); a aprovação revalida e congela (FR-013). Lead protegido
 * (supressão/opt-out) NUNCA pode ser incluído — nem manualmente (FR-012).
 */

const campaignService = require('./campaign-service');
const segmentService = require('./segment-service');
const { httpError } = require('./router');

function registerAudienceRoutes(router, context) {
  const { prisma } = context;

  // GET /api/studio/campaigns/:id/audience/leads — leads incluídos no snapshot
  // ativo, agrupados hierarquicamente (indústria › cidade/UF › porte) para
  // revisão e seleção no Cockpit (2026-09-27, feedback do dono do produto).
  router.get('/campaigns/:id/audience/leads', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');

      const snapshot = (
        await prisma.studioAudienceSnapshot.findMany({
          where: { campaignId: campaign.id, status: 'active' },
          orderBy: { createdAt: 'desc' },
          take: 1,
        })
      )[0] || null;
      if (!snapshot) {
        return res.json({ success: true, data: { total: 0, leads: [], groups: [] } });
      }

      const members = await prisma.studioAudienceMember.findMany({
        where: { snapshotId: snapshot.id, included: true },
        take: 5000,
      });
      const ids = members.map((m) => m.prospectId);
      const prospects = ids.length
        ? await prisma.prospect.findMany({
            where: { id: { in: ids } },
            select: {
              id: true, companyName: true, contactName: true, tradeName: true,
              industry: true, city: true, state: true, employees: true,
              cnpj: true, opportunityScore: true,
            },
          })
        : [];
      const byId = new Map(prospects.map((p) => [p.id, p]));
      const leads = ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((p) => ({
          id: p.id,
          name: p.contactName || p.tradeName || p.companyName,
          company: p.companyName,
          industry: p.industry || null,
          city: p.city || null,
          state: p.state || null,
          employees: p.employees ?? null,
          cnpj: p.cnpj || null,
          score: p.opportunityScore ?? 0,
        }))
        .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.company).localeCompare(String(b.company)));

      // Hierarquia: indústria › cidade/UF › porte (employees em faixas).
      const sizeBand = (e) =>
        e == null ? 'Porte não informado'
          : e <= 10 ? 'Micro (1–10)'
          : e <= 50 ? 'Pequena (11–50)'
          : e <= 200 ? 'Média (51–200)'
          : 'Grande (200+)';
      const industryMap = new Map();
      for (const lead of leads) {
        const industry = lead.industry || 'Sem categoria';
        const locality = `${lead.city || 'Cidade não informada'}${lead.state ? ` — ${lead.state}` : ''}`;
        const band = sizeBand(lead.employees);
        if (!industryMap.has(industry)) industryMap.set(industry, { key: industry, count: 0, subs: new Map() });
        const g = industryMap.get(industry);
        g.count += 1;
        if (!g.subs.has(locality)) g.subs.set(locality, { key: locality, count: 0, subs: new Map() });
        const sub = g.subs.get(locality);
        sub.count += 1;
        if (!sub.subs.has(band)) sub.subs.set(band, { key: band, count: 0, leadIds: [] });
        const leaf = sub.subs.get(band);
        leaf.count += 1;
        leaf.leadIds.push(lead.id);
      }
      const groups = [...industryMap.values()].map((g) => ({
        key: g.key,
        count: g.count,
        subs: [...g.subs.values()].map((sub) => ({
          key: sub.key,
          count: sub.count,
          subs: [...sub.subs.values()],
        })),
      }));

      res.json({ success: true, data: { total: leads.length, leads, groups } });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/studio/campaigns/:id/audience — define a audiência.
  router.post('/campaigns/:id/audience', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== orgId) {
        const err = new Error('Campanha não encontrada');
        err.code = 'NOT_FOUND';
        err.status = 404;
        throw err;
      }

      const body = req.body || {};
      let prospectIds = [];
      let listReport = null;
      if (body.manual && Array.isArray(body.manual.prospectIds)) {
        prospectIds = body.manual.prospectIds.map(String);
      } else if (Array.isArray(body.prospectIds)) {
        // Forma simples aceita para compatibilidade de clientes.
        prospectIds = body.prospectIds.map(String);
      } else if (body.segmentId) {
        // Segmento salvo (US2): critérios resolvidos AGORA — a audiência
        // materializada congela; novos leads não entram sem re-sync (FR-013).
        const segment = await prisma.studioSegment.findUnique({
          where: { id: String(body.segmentId) },
        });
        if (!segment || segment.orgId !== orgId) {
          throw httpError('NOT_FOUND', 404, 'Segmento não encontrado');
        }
        const where = segmentService.buildWhere(orgId, segment.criteria);
        const rows = await prisma.prospect.findMany({ where });
        prospectIds = rows.map((p) => p.id);
      } else if (body.list && Array.isArray(body.list)) {
        // Importação de lista (FR-010): CNPJs/e-mails resolvidos contra a org.
        const resolved = await segmentService.resolveList(prisma, orgId, body.list);
        prospectIds = resolved.matched;
        listReport = { matched: resolved.matched, unmatched: resolved.unmatched };
      } else {
        const err = new Error('Informe manual.prospectIds com os leads da audiência.');
        err.code = 'INVALID_AUDIENCE';
        err.status = 400;
        throw err;
      }

      if (prospectIds.length === 0) {
        const err = new Error('Audiência vazia: informe ao menos um lead.');
        err.code = 'INVALID_AUDIENCE';
        err.status = 400;
        throw err;
      }

      const { snapshot, members } = await campaignService.flow.materializeAudience(prisma, {
        campaign,
        prospectIds,
      });

      const withNames = [];
      for (const member of members) {
        const prospect = await prisma.prospect.findUnique({ where: { id: member.prospectId } });
        withNames.push({
          prospectId: member.prospectId,
          companyName: prospect?.companyName || null,
          included: member.included,
          excludeReason: member.excludeReason || null,
        });
      }

      res.json({
        success: true,
        data: {
          snapshotId: snapshot.id,
          totalCount: snapshot.totalCount,
          includedCount: snapshot.includedCount,
          excludedCount: snapshot.excludedCount,
          members: withNames,
          ...(listReport ? listReport : {}),
        },
      });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerAudienceRoutes };
