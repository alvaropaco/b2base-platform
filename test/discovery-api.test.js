const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createDiscoveryEngine } = require('../discovery');
const { createDiscoveryApi } = require('../discovery/api');

const COMPANY_CNPJ = '11222333000181';

// Express real em porta efêmera — sem supertest, sem rede externa.
async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  const published = [];
  const engine = createDiscoveryEngine({
    prisma,
    publish: (m) => published.push(m),
    logger: { info() {}, warn() {}, error() {} },
    providerMap: {
      'cnpj-mcp': {
        name: 'cnpj-mcp', isConfigured: () => true,
        execute: async () => ({
          items: [{
            entityType: 'company', value: COMPANY_CNPJ, displayName: 'Empresa Exemplo Ltda',
            attributes: { legalName: 'Empresa Exemplo Ltda', city: 'São Paulo', state: 'SP', cnpjDigits: COMPANY_CNPJ },
            evidenceType: 'official_registry', confidence: 0.98,
            sourceProvider: 'cnpj-mcp', sourceUrl: null, sourceRef: `cnpj:${COMPANY_CNPJ}`,
            observedAt: null, related: [],
          }],
          requests: 1, estimatedCost: 0,
        }),
      },
    },
  });

  createDiscoveryApi({
    app,
    prisma,
    engine,
    // Isolamento por org: header ausente → 401 (constituição IV).
    requireRequestOrgId: async (req) => {
      const orgId = req.headers['x-test-org'];
      if (!orgId) {
        const err = new Error('Não autenticado');
        err.status = 401;
        throw err;
      }
      return orgId;
    },
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, prisma, published, engine };
}

test('POST /api/discovery/jobs responde 202 e executa em background', async (t) => {
  const { server, base, prisma, published } = await startServer();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/discovery/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-org': 'org-1' },
    body: JSON.stringify({ seed: { cnpj: COMPANY_CNPJ }, providers: ['cnpj-mcp'] }),
  });
  assert.strictEqual(res.status, 202);
  const body = await res.json();
  assert.ok(body.data.jobId);
  assert.strictEqual(body.data.status, 'queued');

  // Execução é assíncrona — aguarda estabilizar e verifica resultado.
  await new Promise((r) => setTimeout(r, 30));
  const statusRes = await fetch(`${base}/api/discovery/jobs/${body.data.jobId}`, { headers: { 'x-test-org': 'org-1' } });
  const status = await statusRes.json();
  assert.strictEqual(status.success, true);
  assert.strictEqual(status.data.job.status, 'completed');
  assert.strictEqual(status.data.providers.length, 1);
  assert.strictEqual(status.data.providers[0].provider, 'cnpj-mcp');
  assert.ok(published.some((m) => m.subject === 'discovery.candidate.upserted.v1'));
  assert.ok(prisma.discoveryCandidate.rows.length >= 1);
});

test('GET status/candidates sem autenticação de org → 401', async (t) => {
  const { server, base } = await startServer();
  t.after(() => server.close());
  const res = await fetch(`${base}/api/discovery/jobs/qualquer`, { headers: { 'x-test-org': '' } });
  assert.strictEqual(res.status, 401);
});

test('candidates: filtro de org e paginação no endpoint', async (t) => {
  const { server, base, prisma, engine } = await startServer();
  t.after(() => server.close());
  const job = await engine.persistence.createJob({ orgId: 'org-1', trigger: 'api', criteria: {}, providerConfig: {} });
  for (let i = 0; i < 3; i++) {
    await engine.persistence.upsertCandidate({
      orgId: 'org-1', jobId: job.id, name: `Cand ${i}`, confidence: 0.5 + i / 10, dedupeKey: `k-${i}`,
    });
  }
  const res = await fetch(`${base}/api/discovery/jobs/${job.id}/candidates?pageSize=2&minConfidence=0.55`, { headers: { 'x-test-org': 'org-1' } });
  const body = await res.json();
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.data.total, 2);
  assert.strictEqual(body.data.candidates.length, 2);
});

test('import de candidato é idempotente e cria Prospect uma única vez', async (t) => {
  const { server, base, prisma, engine } = await startServer();
  t.after(() => server.close());
  const job = await engine.persistence.createJob({ orgId: 'org-1', trigger: 'api', criteria: {}, providerConfig: {} });
  const candidate = await engine.persistence.upsertCandidate({
    orgId: 'org-1', jobId: job.id, cnpj: COMPANY_CNPJ, name: 'Empresa Exemplo Ltda',
    confidence: 0.9, dedupeKey: `cnpj:${COMPANY_CNPJ}`,
  });

  const call = () => fetch(`${base}/api/discovery/jobs/${job.id}/candidates/${candidate.id}/import`, { method: 'POST', headers: { 'x-test-org': 'org-1' } });
  const first = await call();
  const second = await call();
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.strictEqual(firstBody.data.prospectId, secondBody.data.prospectId);
  assert.strictEqual(prisma.prospect.rows.length, 1);
  assert.strictEqual(prisma.prospect.rows[0].cnpj, COMPANY_CNPJ);
  // Epic 1 (FR4): prospect importado do discovery já nasce com searchText
  // normalizado (matching de segmento tolerante a acento desde o 1º dia).
  assert.ok(prisma.prospect.rows[0].searchText, 'prospect importado nasce com searchText');
});

test('POST /api/prospects/:id/discovery cria job com seed do prospect', async (t) => {
  const { server, base, prisma } = await startServer();
  t.after(() => server.close());
  const prospect = await prisma.prospect.create({
    data: { orgId: 'org-1', companyName: 'Prospect Alvo', cnpj: COMPANY_CNPJ },
  });
  const res = await fetch(`${base}/api/prospects/${prospect.id}/discovery`, { method: 'POST', headers: { 'x-test-org': 'org-1' } });
  assert.strictEqual(res.status, 202);
  const body = await res.json();
  assert.ok(body.data.jobId);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(prisma.discoveryCandidate.rows.length >= 1);
});

test('org isolada não vê job de outra org (404)', async (t) => {
  const { server, base, engine } = await startServer();
  t.after(() => server.close());
  const job = await engine.persistence.createJob({ orgId: 'org-a', trigger: 'api', criteria: {}, providerConfig: {} });
  const res = await fetch(`${base}/api/discovery/jobs/${job.id}`, { headers: { 'x-test-org': 'org-b' } });
  assert.strictEqual(res.status, 404);
  const body = await res.json();
  assert.strictEqual(body.error.code, 'DISCOVERY_NOT_FOUND');
});

// ── Gating por plano (Constituição IV / T057) ───────────────────────────────

test('gating: trial NÃO acessa providers pagos nem via providerOverrides', async (t) => {
  const { server, base, prisma } = await startServer();
  t.after(() => server.close());
  // Org inexistente → getOrgPlan retorna 'trial' (default).

  const res = await fetch(`${base}/api/discovery/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-org': 'org-trial' },
    body: JSON.stringify({ criteria: { legalNameContains: 'X', state: 'SP' }, providers: ['serper', 'searxng'] }),
  });
  const { data } = await res.json();
  assert.strictEqual(data.providersTotal, 1); // serper filtrado; resta searxng

  const status = await (await fetch(`${base}/api/discovery/jobs/${data.jobId}`, { headers: { 'x-test-org': 'org-trial' } })).json();
  assert.ok(!status.data.providers.some((p) => p.provider === 'serper'));

  // providerOverrides NÃO re-habilita pago em trial.
  const res2 = await fetch(`${base}/api/discovery/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-org': 'org-trial' },
    body: JSON.stringify({
      criteria: { legalNameContains: 'X', state: 'SP' },
      providers: ['searxng'],
      providerConfig: { serper: { enabled: true, maxRequests: 999 } },
    }),
  });
  const body2 = await res2.json();
  const job = await prisma.discoveryJob.findFirst({ where: { id: body2.data.jobId } });
  assert.strictEqual(job.providerConfig.serper.enabled, false);
});

test('gating: premium acessa catálogo completo', async (t) => {
  const { server, base, prisma } = await startServer();
  t.after(() => server.close());
  await prisma.organization.create({ data: { id: 'org-premium', name: 'Premium', plan: 'premium' } });

  const res = await fetch(`${base}/api/discovery/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-org': 'org-premium' },
    body: JSON.stringify({ criteria: { legalNameContains: 'X', state: 'SP' }, providers: ['serper', 'searxng'] }),
  });
  const { data } = await res.json();
  assert.strictEqual(data.providersTotal, 2);
  const status = await (await fetch(`${base}/api/discovery/jobs/${data.jobId}`, { headers: { 'x-test-org': 'org-premium' } })).json();
  assert.ok(status.data.providers.some((p) => p.provider === 'serper'));
});
