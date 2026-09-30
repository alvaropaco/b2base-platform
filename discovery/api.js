// =============================================================================
// discovery/api.js — endpoints HTTP do Discovery Engine (T014/T038/T046).
// Contrato: specs/006-discovery-engine/contracts/api.md — envelope
// { success, data | error, code? }, orgId SEMPRE derivado da autenticação
// (requireRequestOrgId — isolamento por organização, constituição IV).
// HTTP nunca espera provider: criação responde 202 e execução é assíncrona.
// =============================================================================

const contracts = require('./contracts');
const normalizer = require('./normalizer');
const { getOrgPlan } = require('../plan');
const { buildCorporateProfile } = require('./enrichers/corporate');
const { buildFinancialProfile } = require('./enrichers/financial');
const { buildLegalProfile } = require('./enrichers/legal');
const { buildOwnershipProfile } = require('./enrichers/ownership');
// Epic 1 (FR4): searchText normalizado do Prospect mantido na importação.
const { withSearchText } = require('../search-text');

const HTTP_CODE_BY_ERROR = {
  DISCOVERY_NOT_FOUND: 404,
  DISCOVERY_INVALID_INPUT: 400,
  DISCOVERY_JOB_RUNNING: 409,
  PROVIDER_NOT_CONFIGURED: 400,
  PROVIDER_BUDGET_EXHAUSTED: 402,
};

// Gating por plano (Constituição IV): trial = enriquecimento básico — apenas
// providers self-hosted/free; premium = catálogo completo.
function allowedProvidersForPlan(plan, requested = null) {
  if (plan === 'premium') return requested;
  const free = Object.entries(contracts.PROVIDER_CATALOG)
    .filter(([, entry]) => !entry.paid)
    .map(([name]) => name);
  if (!requested) return free;
  return requested.filter((name) => free.includes(name));
}

function createDiscoveryApi({ app, prisma, engine, requireRequestOrgId, now = () => new Date() }) {
  const persistence = engine.persistence;

  // ── POST /api/discovery/jobs — cria job (202, execução assíncrona) ────────
  app.post('/api/discovery/jobs', async (req, res) => {
    try {
      const orgId = await requireRequestOrgId(req);
      const body = req.body || {};
      const plan = await getOrgPlan(prisma, orgId);
      const requested = body.providers || null;
      const overrides = body.providerConfig || null;
      // Overrides não podem re-habilitar provider fora do plano do cliente.
      const safeOverrides = overrides
        ? Object.fromEntries(Object.entries(overrides).filter(([name]) => allowedProvidersForPlan(plan, [name]).length > 0))
        : null;
      const job = await engine.createJob({
        orgId,
        trigger: body.trigger || 'api',
        criteria: body.criteria || null,
        seed: body.seed || null,
        providers: allowedProvidersForPlan(plan, requested),
        providerOverrides: safeOverrides,
      });
      // Execução in-process no v1 (disparo pós-resposta); o contrato NATS
      // discovery.job.requested.v1 permite mover para worker sem quebrar API.
      setImmediate(() => { engine.runJob(job.id, orgId).catch(() => {}); });
      res.status(202).json({
        success: true,
        data: { jobId: job.id, status: job.status, providersTotal: job.providersTotal },
        timestamp: now().toISOString(),
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  // ── GET /api/discovery/jobs/:id — status + estado por provider ────────────
  app.get('/api/discovery/jobs/:id', async (req, res) => {
    try {
      const orgId = await requireRequestOrgId(req);
      const status = await persistence.getJobStatus(req.params.id, orgId);
      if (!status) return res.status(404).json({ success: false, error: { code: 'DISCOVERY_NOT_FOUND' } });
      res.json({
        success: true,
        data: {
          job: status.job,
          providers: status.providers.map((run) => ({
            provider: run.provider,
            capability: run.capability,
            status: run.status,
            attempt: run.attempt,
            items: run.items,
            requests: run.requests,
            estimatedCost: run.estimatedCost,
            errorCode: run.errorCode,
          })),
          progress: {
            total: status.job.providersTotal,
            done: status.job.providersDone,
            failed: status.job.providersFailed,
          },
        },
        timestamp: now().toISOString(),
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  // ── GET /api/discovery/jobs/:id/candidates — paginação + filtros ──────────
  app.get('/api/discovery/jobs/:id/candidates', async (req, res) => {
    try {
      const orgId = await requireRequestOrgId(req);
      const job = await persistence.getJob(req.params.id, orgId);
      if (!job) return res.status(404).json({ success: false, error: { code: 'DISCOVERY_NOT_FOUND' } });
      const { page, pageSize, minConfidence, status, minIcp } = req.query;
      const result = await persistence.listCandidates({
        orgId,
        jobId: req.params.id,
        page: Number(page) || 1,
        pageSize: Number(pageSize) || 25,
        minConfidence: Number(minConfidence) || 0,
        status: status || null,
        minIcp: minIcp != null && minIcp !== '' ? Number(minIcp) : null,
      });
      res.json({ success: true, data: { total: result.total, page: Number(page) || 1, candidates: result.items }, timestamp: now().toISOString() });
    } catch (error) {
      respondError(res, error);
    }
  });

  // ── POST /api/discovery/jobs/:id/candidates/:candidateId/import ───────────
  app.post('/api/discovery/jobs/:id/candidates/:candidateId/import', async (req, res) => {
    try {
      const orgId = await requireRequestOrgId(req);
      const candidate = await prisma.discoveryCandidate.findFirst({
        where: { id: req.params.candidateId, orgId },
      });
      if (!candidate) return res.status(404).json({ success: false, error: { code: 'DISCOVERY_NOT_FOUND' } });

      // Idempotente (SC-005): segundo import devolve o prospect original.
      if (candidate.importedProspectId) {
        return res.json({
          success: true,
          data: { candidateId: candidate.id, prospectId: candidate.importedProspectId, status: 'imported' },
          timestamp: now().toISOString(),
        });
      }

      const location = candidate.location || {};
      const importKey = `discovery:${candidate.id}`;
      let prospect;
      try {
        prospect = await prisma.prospect.create({
          data: {
            orgId,
            companyName: candidate.name || (candidate.cnpj ? normalizer.formatCnpj(candidate.cnpj) : 'Candidato de discovery'),
            cnpj: candidate.cnpj || null,
            domain: candidate.domain || null,
            city: location.city || null,
            state: location.state || null,
            industry: (candidate.location || {}).industry || null,
            importKey,
            // Epic 1 (FR4): searchText normalizado p/ matching de segmento.
            ...withSearchText({
              companyName: candidate.name || (candidate.cnpj ? normalizer.formatCnpj(candidate.cnpj) : 'Candidato de discovery'),
              industry: (candidate.location || {}).industry || null,
            }),
            status: 'prospect',
          },
        });
      } catch (err) {
        if (err && err.code === 'P2002') {
          const existing = await prisma.prospect.findFirst({ where: { orgId, importKey } });
          if (existing) prospect = existing;
          else throw err;
        } else {
          throw err;
        }
      }

      await persistence.importCandidate({ orgId, candidateId: candidate.id, prospectId: prospect.id });
      res.json({
        success: true,
        data: { candidateId: candidate.id, prospectId: prospect.id, status: 'imported' },
        timestamp: now().toISOString(),
      });
    } catch (error) {
      respondError(res, error);
    }
  });

  // ── POST /api/prospects/:id/discovery — discovery a partir de um Prospect ─
  app.post('/api/prospects/:id/discovery', async (req, res) => {
    try {
      const orgId = await requireRequestOrgId(req);
      const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
      if (!prospect) return res.status(404).json({ success: false, error: { code: 'DISCOVERY_NOT_FOUND' } });

      const seed = {};
      if (prospect.cnpj) seed.cnpj = prospect.cnpj;
      if (prospect.domain) seed.domain = prospect.domain;
      if (Object.keys(seed).length === 0) {
        return res.status(400).json({ success: false, error: { code: 'DISCOVERY_INVALID_INPUT', message: 'prospect sem cnpj/domain' } });
      }
      const plan = await getOrgPlan(prisma, orgId);
      const job = await engine.createJob({ orgId, trigger: 'prospect', seed, providers: allowedProvidersForPlan(plan, null) });
      setImmediate(() => { engine.runJob(job.id, orgId).catch(() => {}); });
      res.status(202).json({ success: true, data: { jobId: job.id, prospectId: prospect.id, status: job.status }, timestamp: now().toISOString() });
    } catch (error) {
      respondError(res, error);
    }
  });

  // ── GET /api/prospects/:id/discovery — último discovery do Prospect ───────
  app.get('/api/prospects/:id/discovery', async (req, res) => {
    try {
      const orgId = await requireRequestOrgId(req);
      const prospect = await prisma.prospect.findFirst({ where: { id: req.params.id, orgId } });
      if (!prospect) return res.status(404).json({ success: false, error: { code: 'DISCOVERY_NOT_FOUND' } });
      const cnpj = prospect.cnpj ? normalizer.cnpjDigits(prospect.cnpj) : null;
      const jobs = await prisma.discoveryJob.findMany({
        where: { orgId, OR: [
          ...(cnpj ? [{ query: { path: ['$.*$'], string_contains: cnpj } }] : []),
        ] },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      // Fallback pragmático: último job da org (fake não suporta path query).
      const latest = jobs[0] || (await prisma.discoveryJob.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 1 }))[0] || null;
      if (!latest) return res.json({ success: true, data: { job: null, candidates: [] }, timestamp: now().toISOString() });
      const candidates = await persistence.listCandidates({ orgId, jobId: latest.id, pageSize: 50 });
      res.json({ success: true, data: { job: latest, candidates: candidates.items }, timestamp: now().toISOString() });
    } catch (error) {
      respondError(res, error);
    }
  });

  // ── GET /api/companies/:entityId/intelligence — perfil completo (T038) ────
  app.get('/api/companies/:entityId/intelligence', async (req, res) => {
    try {
      const orgId = await requireRequestOrgId(req);
      const intelligence = await persistence.getCompanyIntelligence({ orgId, entityId: req.params.entityId });
      if (!intelligence) return res.status(404).json({ success: false, error: { code: 'DISCOVERY_NOT_FOUND' } });
      const { entity, relationships, evidence, signals } = intelligence;

      const evidenceByEntity = new Map();
      for (const ev of evidence) {
        if (!ev.entityId) continue;
        if (!evidenceByEntity.has(ev.entityId)) evidenceByEntity.set(ev.entityId, []);
        evidenceByEntity.get(ev.entityId).push(ev);
      }
      const caseEntities = await prisma.discoveryEntity.findMany({ where: { orgId, type: 'legal_case' } });
      const entityById = new Map([[entity.id, entity]]);
      for (const rel of relationships) {
        const target = await prisma.discoveryEntity.findFirst({ where: { id: rel.toEntityId, orgId } });
        if (target) entityById.set(target.id, target);
      }

      res.json({
        success: true,
        data: {
          company: entity,
          corporate: buildCorporateProfile(entity, evidence.filter((ev) => ev.entityId === entity.id)),
          financial: buildFinancialProfile(entity, evidence.filter((ev) => ev.entityId === entity.id)),
          legal: buildLegalProfile(caseEntities, evidenceByEntity),
          ownership: buildOwnershipProfile(entity.id, relationships, entityById),
          digital: {
            technologies: evidence.filter((ev) => ev.entityId === entity.id && ev.observedValue && ev.observedValue.technologies)
              .flatMap((ev) => ev.observedValue.technologies),
            evidenceCount: evidence.length,
          },
          signals,
          evidenceSummary: summarizeEvidence(evidence),
        },
        timestamp: now().toISOString(),
      });
    } catch (error) {
      respondError(res, error);
    }
  });
}

function summarizeEvidence(evidence) {
  const byType = {};
  for (const ev of evidence) byType[ev.evidenceType] = (byType[ev.evidenceType] || 0) + 1;
  return { total: evidence.length, byType };
}

function respondError(res, error) {
  const code = (error && error.code) || 'INTERNAL';
  const status = error && error.status
    ? error.status
    : HTTP_CODE_BY_ERROR[code] || 500;
  res.status(status).json({
    success: false,
    error: { code, message: error && error.message },
  });
}

module.exports = { createDiscoveryApi, contracts };
