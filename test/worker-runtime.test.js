const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma, createFakeMessage } = require('./helpers/fake-prisma');
const contracts = require('../enrichment-contracts');
const capabilities = require('../enrichment-capabilities');
const { createWorkerRuntime } = require('../workers/sdk/runtime');

const WORKER_VERSION = 'test-worker-1';

function makeTask(over = {}) {
  return {
    version: '1',
    taskId: 't-1', taskKey: 'key-1', jobId: 'job-1', orgId: 'org-1', prospectId: 'p-1',
    entityKey: 'prospect:p-1', entityType: 'prospect',
    capability: 'identity.domain.verify', provider: null,
    input: { domain: 'exemplo.com.br' },
    priority: 1, attempt: 1, maxAttempts: 3, timeoutMs: 500,
    depth: 0, spawnedByTaskId: null, notBefore: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

/** Runtime com fakes; executores de teste retornam resultado fixo ou lançam. */
function makeRuntime({ executors = {}, prismaOver = {}, jsOver = {}, ...over } = {}) {
  const prisma = Object.assign(createFakePrisma(), prismaOver);
  const js = Object.assign({ publish: async () => ({ seq: 1 }) }, jsOver);
  const trace = [];
  const published = [];
  // Instrumenta a persistência para asserir a ordem persist→publish→ack.
  const origUpsert = prisma.enrichmentResult.upsert.bind(prisma.enrichmentResult);
  prisma.enrichmentResult.upsert = async (args) => {
    trace.push('persist');
    return origUpsert(args);
  };
  const runtime = createWorkerRuntime({
    name: 'identity',
    capabilities,
    workerVersion: WORKER_VERSION,
    deps: {
      prisma,
      js,
      registerExecutors: (map) => Object.assign(trace, [], map), // noop
      publisher: async (result) => { trace.push('publish'); published.push(result); },
      logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
    },
    ...over,
  });
  runtime.registerExecutorsForTest(executors);
  return { runtime, prisma, js, trace, published };
}

const OK_EXECUTOR = async () => ({
  status: 'COMPLETED',
  data: { domain_active: true },
  facts: [{ attribute: 'company.domain_active', value: true, confidence: 0.9,
    evidence: { sourceType: 'dns', retrievedAt: new Date().toISOString() } }],
});

// ── Caminho feliz ───────────────────────────────────────────────────────────

test('US1 runtime caminho feliz: RUNNING → executa → persiste → publica → ack (ordem)', async () => {
  const { runtime, prisma, trace, published } = makeRuntime({
    executors: { 'identity.domain.verify': OK_EXECUTOR },
  });
  const msg = createFakeMessage(makeTask(), { trace });

  await runtime.processMessage(msg);

  assert.deepStrictEqual(trace, ['persist', 'publish', 'ack']); // ack SOMENTE após persist+publish
  const taskRow = await prisma.enrichmentTask.findUnique({ where: { id: 't-1' } });
  assert.strictEqual(taskRow.status, 'RUNNING'); // runtime marca início (startedAt)
  assert.ok(taskRow.startedAt);
  const resultRow = await prisma.enrichmentResult.findUnique({ where: { taskId: 't-1' } });
  assert.strictEqual(resultRow.status, 'COMPLETED');
  assert.strictEqual(resultRow.workerVersion, WORKER_VERSION);
  assert.strictEqual(published[0].status, 'COMPLETED');
  assert.strictEqual(published[0].facts.length, 1);
});

test('US1 runtime: capability desconhecida → FAILED permanente INVALID_INPUT com ack imediato', async () => {
  const { runtime, trace, published } = makeRuntime({});
  const msg = createFakeMessage(makeTask({ capability: 'capability.fantasma' }), { trace });
  await runtime.processMessage(msg);
  assert.deepStrictEqual(trace, ['publish', 'ack']);
  assert.strictEqual(published[0].status, 'FAILED');
  assert.strictEqual(published[0].error.type, 'INVALID_INPUT');
  assert.strictEqual(published[0].error.retryable, false);
});

test('US1 runtime: input inválido pelo catálogo → FAILED permanente, executor nunca chamado', async () => {
  let called = 0;
  const { runtime, trace, published } = makeRuntime({
    executors: { 'identity.domain.verify': async () => { called += 1; return OK_EXECUTOR(); } },
  });
  const msg = createFakeMessage(makeTask({ input: {} }), { trace }); // domain ausente
  await runtime.processMessage(msg);
  assert.strictEqual(called, 0);
  assert.deepStrictEqual(trace, ['publish', 'ack']);
  assert.strictEqual(published[0].error.type, 'INVALID_INPUT');
});

test('US1 runtime: concorrência respeitada (semáforo do processo)', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const slowExecutor = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight -= 1;
    return OK_EXECUTOR();
  };
  const { runtime } = makeRuntime({ executors: { 'identity.domain.verify': slowExecutor }, concurrency: 2 });

  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      runtime.processMessage(createFakeMessage(makeTask({ taskId: `t-${i}` })))
    )
  );
  assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight} deve ser <= 2`);
});

test('US1 runtime: payload ilegível → poison (term), sem publish', async () => {
  const { runtime, trace, published } = makeRuntime({});
  const msg = { data: Buffer.from('isto não é json'), ack: async () => trace.push('ack'), nak: async () => trace.push('nak'), term: async () => trace.push('term') };
  await runtime.processMessage(msg);
  assert.deepStrictEqual(trace, ['term']);
  assert.strictEqual(published.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// US2 — resiliência: timeout, retry, permanente × transiente, redelivery, nak
// ════════════════════════════════════════════════════════════════════════════

test('US2 timeout: executor além do timeoutMs → TIMEOUT transiente (retryable)', async () => {
  const { runtime, published, trace } = makeRuntime({
    executors: {
      'identity.domain.verify': async (task, { signal }) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('abortado'); e.name = 'AbortError'; reject(e); });
        });
        return OK_EXECUTOR();
      },
    },
  });
  const msg = createFakeMessage(makeTask({ timeoutMs: 80 }), { trace });
  const out = await runtime.processMessage(msg);
  assert.strictEqual(out.status, 'FAILED');
  assert.strictEqual(published[0].error.type, 'TIMEOUT');
  assert.strictEqual(published[0].error.retryable, true); // manager re-publica com attempt+1
  assert.deepStrictEqual(trace, ['persist', 'publish', 'ack']);
});

test('US2 erro transiente do executor (RATE_LIMIT) → retryable true', async () => {
  const { runtime, published } = makeRuntime({
    executors: {
      'identity.domain.verify': async () => {
        const e = new Error('429 do provider');
        e.code = 'RATE_LIMIT';
        throw e;
      },
    },
  });
  await runtime.processMessage(createFakeMessage(makeTask()));
  assert.strictEqual(published[0].error.type, 'RATE_LIMIT');
  assert.strictEqual(published[0].error.retryable, true);
});

test('US2 falha permanente do executor → retryable false, persiste e ack', async () => {
  const { runtime, published, trace } = makeRuntime({
    executors: {
      'identity.domain.verify': async () => ({
        status: 'FAILED',
        error: { type: 'INVALID_DATA', message: 'domínio malformado', retryable: false },
      }),
    },
  });
  await runtime.processMessage(createFakeMessage(makeTask(), { trace }));
  assert.strictEqual(published[0].status, 'FAILED');
  assert.strictEqual(published[0].error.retryable, false);
  assert.deepStrictEqual(trace, ['persist', 'publish', 'ack']);
});

test('US2 redelivery: resultado já persistido → NÃO reexecuta provider, republisha e ack', async () => {
  let calls = 0;
  const { runtime, prisma, trace, published } = makeRuntime({
    executors: { 'identity.domain.verify': async () => { calls += 1; return OK_EXECUTOR(); } },
  });
  // Primeira execução normal.
  await runtime.processMessage(createFakeMessage(makeTask(), { trace }));
  assert.strictEqual(calls, 1);
  // Redelivery da mesma mensagem (broker reentrega após ack perdido, p. ex.).
  const trace2 = [];
  await runtime.processMessage(createFakeMessage(makeTask(), { trace: trace2 }));
  assert.strictEqual(calls, 1); // atalho idempotente: provider NÃO foi reexecutado
  assert.strictEqual(trace2[trace2.length - 1], 'ack');
  assert.strictEqual(published.length, 2);
  assert.strictEqual(published[1].status, 'COMPLETED');
});

test('US2 publish falha → nak(delay) sem ack (broker reentrega a mesma mensagem)', async () => {
  const { runtime, trace } = makeRuntime({
    executors: { 'identity.domain.verify': OK_EXECUTOR },
    jsOver: {},
  });
  // Publisher que falha sempre (JetStream fora do ar, p. ex.).
  const { createWorkerRuntime: _c } = require('../workers/sdk/runtime');
  const failRuntime = runtime;
  failRuntime.setPublisherForTest(async () => { throw new Error('jetstream indisponível'); });
  const msg = createFakeMessage(makeTask(), { trace });
  const out = await failRuntime.processMessage(msg);
  assert.strictEqual(out.status, 'NAK');
  const nak = trace.find((t) => Array.isArray(t) && t[0] === 'nak');
  assert.ok(nak, 'esperado nak com delay');
  assert.ok(nak[1] >= 5000, `delay ${nak[1]} deve respeitar o 1º degrau de backoff`);
  assert.ok(!trace.includes('ack'), 'não deve ackar quando o publish falha');
});

// ════════════════════════════════════════════════════════════════════════════
// US4 — proteção de providers no runtime: acquire/release, circuito, injeção
// ════════════════════════════════════════════════════════════════════════════

function makeRegistryStub() {
  const calls = { acquire: 0, release: 0, outcomes: [] };
  return {
    calls,
    acquire: async (provider) => {
      calls.acquire += 1;
      if (registryBehavior.rejectReason) {
        return { ok: false, reason: registryBehavior.rejectReason, retryAfterMs: 1000 };
      }
      return { ok: true, ticket: { provider, release: async () => { calls.release += 1; } } };
    },
    recordOutcome: async (provider, o) => { calls.outcomes.push({ provider, ...o }); },
    getState: async (p) => ({ provider: p, state: 'HEALTHY' }),
  };
}
const registryBehavior = { rejectReason: null };

test('US4 runtime: circuito aberto → FAILED PROVIDER_CIRCUIT_OPEN sem chamar o executor', async () => {
  registryBehavior.rejectReason = 'PROVIDER_CIRCUIT_OPEN';
  let calls = 0;
  const { runtime, published, trace } = makeRuntime({
    executors: { 'identity.domain.verify': async () => { calls += 1; return OK_EXECUTOR(); } },
  });
  runtime.setRegistryForTest(makeRegistryStub());
  await runtime.processMessage(createFakeMessage(makeTask(), { trace }));
  assert.strictEqual(calls, 0); // executor NUNCA roda com o circuito aberto
  assert.strictEqual(published[0].error.type, 'PROVIDER_CIRCUIT_OPEN');
  assert.strictEqual(published[0].error.retryable, true);
  assert.deepStrictEqual(trace, ['publish', 'ack']); // nada a persistir (não executou)
  registryBehavior.rejectReason = null;
});

test('US4 runtime: ticket liberado e outcome registrado em sucesso e falha', async () => {
  registryBehavior.rejectReason = null;
  const stub = makeRegistryStub();
  const { runtime } = makeRuntime({
    executors: {
      'identity.domain.verify': async (task, ctx) => {
        if (task.input.domain === 'quebrado.com') {
          return { status: 'FAILED', error: { type: 'INVALID_DATA', message: 'x', retryable: false } };
        }
        return OK_EXECUTOR();
      },
    },
  });
  runtime.setRegistryForTest(stub);
  await runtime.processMessage(createFakeMessage(makeTask()));
  await runtime.processMessage(createFakeMessage(makeTask({ taskId: 't-2', input: { domain: 'quebrado.com' } })));
  assert.strictEqual(stub.calls.release, 2); // release em AMBOS os caminhos
  assert.deepStrictEqual(stub.calls.outcomes.map((o) => o.ok), [true, false]);
});

test('US4 runtime: injeção de falha por env (PROVIDER_FORCE_ERROR) não chama o provider', async () => {
  process.env.PROVIDER_FORCE_ERROR = 'dns.direct';
  let calls = 0;
  try {
    const { runtime, published } = makeRuntime({
      executors: { 'identity.domain.verify': async () => { calls += 1; return OK_EXECUTOR(); } },
    });
    runtime.setRegistryForTest(makeRegistryStub());
    await runtime.processMessage(createFakeMessage(makeTask()));
    assert.strictEqual(calls, 0);
    assert.strictEqual(published[0].error.type, 'PROVIDER_UNAVAILABLE');
    assert.strictEqual(published[0].error.retryable, true);
  } finally {
    delete process.env.PROVIDER_FORCE_ERROR;
  }
});

// ════════════════════════════════════════════════════════════════════════════
// US6 — evidência por fato + dado bruto via rawStore
// ════════════════════════════════════════════════════════════════════════════

function makeRawStoreStub() {
  const calls = { put: 0 };
  let seq = 0;
  return {
    calls,
    put: async (record) => {
      calls.put += 1;
      seq += 1;
      return { rawRecordId: `raw-${seq}`, truncated: false };
    },
    get: async () => null,
  };
}

test('US6 runtime: fatos viram EnrichmentEvidence; bruto vai ao rawStore com referência no result', async () => {
  const rawStore = makeRawStoreStub();
  const { runtime, prisma, published } = makeRuntime({
    executors: {
      'identity.domain.verify': async () => ({
        status: 'COMPLETED',
        data: { domain_active: true },
        facts: [{ attribute: 'company.domain_active', value: true, confidence: 0.9,
          evidence: { sourceType: 'dns', url: 'https://exemplo.com', retrievedAt: new Date().toISOString() } }],
        raw: { contentType: 'application/json', body: { lookup: 'exemplo.com', addresses: ['1.2.3.4'] } },
      }),
    },
  });
  runtime.setRawStoreForTest(rawStore);

  await runtime.processMessage(createFakeMessage(makeTask()));
  assert.strictEqual(rawStore.calls.put, 1);
  const resultRow = await prisma.enrichmentResult.findUnique({ where: { taskId: 't-1' } });
  assert.strictEqual(resultRow.rawRecordId, 'raw-1'); // referência, não payload
  const evidence = await prisma.enrichmentEvidence.findMany({ where: { orgId: 'org-1' } });
  assert.strictEqual(evidence.length, 1);
  assert.strictEqual(evidence[0].attribute, 'company.domain_active');
  assert.strictEqual(evidence[0].sourceType, 'dns');
  assert.strictEqual(evidence[0].resultId, resultRow.id);
  // O evento publicado carrega a referência, nunca o corpo bruto.
  assert.strictEqual(published[0].rawRecordId, 'raw-1');
  assert.strictEqual(published[0].raw, undefined);
});

test('US6 conflito de fontes: dois results do mesmo atributo COEXISTEM sem merge', async () => {
  const { runtime, prisma } = makeRuntime({
    executors: {
      'identity.domain.verify': async (task) => ({
        status: 'COMPLETED',
        data: { employee_count: task.taskId === 't-1' ? 350 : 500 },
        facts: [{ attribute: 'company.employeeCount',
          value: task.taskId === 't-1' ? 350 : 500,
          confidence: 0.8, evidence: { sourceType: task.taskId === 't-1' ? 'pdl' : 'searxng', retrievedAt: new Date().toISOString() } }],
      }),
    },
  });
  await runtime.processMessage(createFakeMessage(makeTask()));
  await runtime.processMessage(createFakeMessage(makeTask({ taskId: 't-2', taskKey: 'key-2' })));
  const rows = await prisma.enrichmentResult.findMany({ where: { orgId: 'org-1' } });
  assert.strictEqual(rows.length, 2); // coexistem
  assert.deepStrictEqual(rows.map((r) => r.data.employee_count).sort(), [350, 500]);
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 12 — T063 (DLQ) · T065 (failover de provider) · T066 (state metric)
// ════════════════════════════════════════════════════════════════════════════

test('T063 payload inválido com taskId → DLQ publicada + term (poison)', async () => {
  const dlqPublished = [];
  const { runtime, trace } = makeRuntime({
    jsOver: {
      publish: async (subject, data) => {
        if (subject === require('../enrichment-contracts').DLQ_SUBJECT) {
          dlqPublished.push(require('../enrichment-contracts').parsePayload(data));
        }
        return { seq: 1 };
      },
    },
  });
  const msg = createFakeMessage(makeTask({ orgId: undefined }), { trace }); // campo obrigatório ausente
  await runtime.processMessage(msg);
  assert.strictEqual(dlqPublished.length, 1);
  assert.strictEqual(dlqPublished[0].reason, 'POISON_MESSAGE');
  assert.strictEqual(dlqPublished[0].taskId, 't-1');
  assert.deepStrictEqual(trace, ['term']); // nada de result/ack para payload inválido
});

test('T063 payload totalmente ilegível → term sem DLQ (sem contexto para publicar)', async () => {
  const dlqPublished = [];
  const { runtime, trace } = makeRuntime({
    jsOver: {
      publish: async (subject, data) => {
        if (subject === require('../enrichment-contracts').DLQ_SUBJECT) dlqPublished.push(data);
        return { seq: 1 };
      },
    },
  });
  await runtime.processMessage({ data: Buffer.from('lixo'), ack: async () => trace.push('ack'), nak: async () => {}, term: async () => trace.push('term') });
  assert.strictEqual(dlqPublished.length, 0);
  assert.deepStrictEqual(trace, ['term']);
});

// Capabilities stub multi-provider para failover (T065)
const multiProviderCaps = {
  eligibleCapabilities: () => ['identity.domain.verify'],
  getCapability: (name) => ({
    capability: name, family: 'identity', tier: 'basic', enabled: true,
    entityType: ['prospect'], timeoutMs: 500, maxAttempts: 2, priority: 1,
    providers: ['p1', 'p2'],
    inputSchema: { domain: 'string' },
    validateInput: () => ({ ok: true }),
    expand: [],
  }),
};

test('T065 failover: provider preferido rejeitado → executa pelo próximo do catálogo', async () => {
  registryBehavior.rejectReason = null;
  const acqLog = [];
  const registryStub = {
    acquire: async (provider) => {
      acqLog.push(provider);
      if (provider === 'p1') return { ok: false, reason: 'RATE_LIMIT', retryAfterMs: 1000 };
      return { ok: true, ticket: { provider, release: async () => {} } };
    },
    recordOutcome: async () => {},
    getState: async (p) => ({ provider: p, state: 'HEALTHY' }),
  };
  let called = 0;
  const rt = makeRuntime({ capabilities: multiProviderCaps });
  const runtime = rt.runtime;
  const runtime_deps_prisma = rt.prisma;
  const published = rt.published;
  runtime.setRegistryForTest(registryStub);
  runtime.registerExecutors({
    'identity.domain.verify': async (task, ctx) => { called += 1; void ctx; return { status: 'COMPLETED', data: { ok: 1 } }; },
  });
  await runtime.processMessage(createFakeMessage(makeTask()));
  assert.deepStrictEqual(acqLog, ['p1', 'p2']); // tentou o preferido, caiu para o próximo
  assert.strictEqual(called, 1);
  assert.strictEqual(published[0].status, 'COMPLETED');
  // T069: a task fica rotulada com o provider REAL escolhido (p2), não o preferido.
  const row = await runtime_deps_prisma.enrichmentTask.findUnique({ where: { id: 't-1' } });
  assert.strictEqual(row.provider, 'p2');
});

test('T069 sem failover: task rotulada com o primeiro provider do catálogo', async () => {
  const registryStub = {
    acquire: async (provider) => ({ ok: true, ticket: { provider, release: async () => {} } }),
    recordOutcome: async () => {},
    getState: async (p) => ({ provider: p, state: 'HEALTHY' }),
  };
  const { runtime, prisma } = makeRuntime({
    executors: { 'identity.domain.verify': OK_EXECUTOR },
  });
  runtime.setRegistryForTest(registryStub);
  await runtime.processMessage(createFakeMessage(makeTask()));
  const row = await prisma.enrichmentTask.findUnique({ where: { id: 't-1' } });
  assert.strictEqual(row.provider, 'dns.direct');
});

test('T065 failover: todos os providers indisponíveis → FAILED com o último motivo', async () => {
  const acqLog = [];
  const registryStub = {
    acquire: async (provider) => {
      acqLog.push(provider);
      return { ok: false, reason: 'PROVIDER_CIRCUIT_OPEN', retryAfterMs: 1000 };
    },
    recordOutcome: async () => {},
    getState: async (p) => ({ provider: p, state: 'OPEN' }),
  };
  let called = 0;
  const { runtime, published } = makeRuntime({ capabilities: multiProviderCaps });
  runtime.setRegistryForTest(registryStub);
  runtime.registerExecutors({
    'identity.domain.verify': async () => { called += 1; return { status: 'COMPLETED', data: {} }; },
  });
  await runtime.processMessage(createFakeMessage(makeTask()));
  assert.deepStrictEqual(acqLog, ['p1', 'p2']);
  assert.strictEqual(called, 0);
  assert.strictEqual(published[0].error.type, 'PROVIDER_CIRCUIT_OPEN');
  assert.strictEqual(published[0].error.retryable, true);
});

test('T066 estado do provider alimenta métrica via onMetric', async () => {
  const metricEvents = [];
  const registryStub = {
    acquire: async (provider) => ({ ok: true, ticket: { provider, release: async () => {} } }),
    recordOutcome: async () => {},
    getState: async (provider) => ({ provider, state: 'OPEN' }),
  };
  const { runtime } = makeRuntime({
    executors: { 'identity.domain.verify': OK_EXECUTOR },
  });
  runtime.setRegistryForTest(registryStub);
  // Injeta onMetric via deps (setPublisherForTest não cobre onMetric — recria runtime).
  const runtime2 = createWorkerRuntime({
    name: 'identity',
    capabilities,
    workerVersion: 'test',
    deps: {
      prisma: require('./helpers/fake-prisma').createFakePrisma(),
      publisher: async () => {},
      logger: { info() {}, warn() {}, error() {}, child() { return this; } },
      onMetric: (event, data) => metricEvents.push({ event, data }),
    },
  });
  runtime2.setRegistryForTest(registryStub);
  runtime2.registerExecutors({ 'identity.domain.verify': OK_EXECUTOR });
  await runtime2.processMessage(createFakeMessage(makeTask()));
  const evt = metricEvents.find((e) => e.event === 'provider_state');
  assert.ok(evt, 'esperado evento provider_state');
  assert.strictEqual(evt.data.provider, 'dns.direct');
  assert.strictEqual(evt.data.state, 'OPEN');
  void runtime;
});

test('US2 erro PERMANENTE lançado pelo executor (NOT_FOUND) → retryable false', async () => {
  const { runtime, published, trace } = makeRuntime({
    executors: {
      'identity.domain.verify': async () => {
        const err = new Error('CNPJ não encontrado na base oficial');
        err.code = 'NOT_FOUND';
        throw err;
      },
    },
  });
  runtime.setRegistryForTest(makeRegistryStub());
  await runtime.processMessage(createFakeMessage(makeTask(), { trace }));
  assert.strictEqual(published[0].error.type, 'NOT_FOUND');
  assert.strictEqual(published[0].error.retryable, false); // sem desperdício de retry
  assert.deepStrictEqual(trace, ['persist', 'publish', 'ack']);
});

// ════════════════════════════════════════════════════════════════════════════
// Claim de execução única (2026-10-15): durables com subject sobreposto
// (company.> × company.digital_presence.>) entregam a MESMA task a dois
// workers — sem claim, o enriquecimento de WhatsApp executava 2× (crawl +
// lookup Twilio pagos em dobro) e corria "primeiro-resultado-vence".
// ════════════════════════════════════════════════════════════════════════════

function makeRuntimeOn(prisma, { executorCalls } = {}) {
  const trace = [];
  const runtime = createWorkerRuntime({
    name: 'identity',
    capabilities,
    workerVersion: WORKER_VERSION,
    deps: {
      prisma,
      js: { publish: async () => ({ seq: 1 }) },
      publisher: async () => {},
      logger: { info() {}, warn() {}, error() {}, child() { return this; } },
    },
  });
  runtime.setRegistryForTest(makeRegistryStub());
  runtime.registerExecutorsForTest({
    'identity.domain.verify': async () => {
      if (executorCalls) executorCalls.calls += 1;
      return OK_EXECUTOR();
    },
  });
  return { runtime, trace };
}

function seedTaskRow(prisma, over = {}) {
  return prisma.enrichmentTask.create({
    data: {
      id: 't-1', orgId: 'org-1', jobId: 'job-1', prospectId: 'p-1', taskKey: 'key-1',
      entityKey: 'prospect:p-1', entityType: 'prospect', capability: 'identity.domain.verify',
      input: { domain: 'exemplo.com.br' }, inputHash: '', status: 'RUNNING',
      attempt: 1, maxAttempts: 3, timeoutMs: 500, startedAt: new Date(),
      ...over,
    },
  });
}

test('claim: row RUNNING FRESCA (outro worker executando agora) → ack SEM executar e SEM publish', async () => {
  const calls = { calls: 0 };
  const prisma = createFakePrisma();
  const { runtime, trace } = makeRuntimeOn(prisma, { executorCalls: calls });
  await seedTaskRow(prisma, { startedAt: new Date() }); // claim fresca de outrem
  const out = await runtime.processMessage(createFakeMessage(makeTask(), { trace }));
  assert.strictEqual(calls.calls, 0, 'o executor NUNCA roda com claim fresca de outrem');
  assert.strictEqual(out.status, 'CLAIMED_ELSEWHERE');
  assert.deepStrictEqual(trace, ['ack'], 'ack silencioso — o result do dono resolve a task');
});

test('claim: row RUNNING VENCIDA (dono sumiu) → roubo atômico da claim e execução normal', async () => {
  const calls = { calls: 0 };
  const prisma = createFakePrisma();
  const { runtime, trace } = makeRuntimeOn(prisma, { executorCalls: calls });
  // timeoutMs 500 + folga 60s: claim vence após ~60.5s — startedAt há 120s.
  await seedTaskRow(prisma, { startedAt: new Date(Date.now() - 120 * 1000) });
  await runtime.processMessage(createFakeMessage(makeTask(), { trace }));
  assert.strictEqual(calls.calls, 1, 'claim vencida é roubada e a task executa');
  assert.ok(trace.includes('ack'), 'entrega encerra em ack');
  assert.ok(!trace.some((t) => Array.isArray(t) && t[0] === 'nak'), 'roubo não gera nak');
  const row = await prisma.enrichmentTask.findUnique({ where: { id: 't-1' } });
  assert.strictEqual(row.status, 'RUNNING');
  assert.ok(new Date(row.startedAt) > new Date(Date.now() - 30 * 1000), 'startedAt renovado pelo ladrão');
});

test('claim: task QUEUED do manager (re-publicada pelo resync) → retoma e executa', async () => {
  const calls = { calls: 0 };
  const prisma = createFakePrisma();
  const { runtime } = makeRuntimeOn(prisma, { executorCalls: calls });
  await seedTaskRow(prisma, { status: 'QUEUED', startedAt: new Date(Date.now() - 120 * 1000) });
  await runtime.processMessage(createFakeMessage(makeTask({ attempt: 2 })));
  assert.strictEqual(calls.calls, 1);
  const row = await prisma.enrichmentTask.findUnique({ where: { id: 't-1' } });
  assert.strictEqual(row.status, 'RUNNING');
  assert.strictEqual(row.attempt, 2, 'claim atualiza o attempt da retomada');
});

test('consumo duplo (company-deep × digital-presence): a MESMA task em dois runtimes executa 1× só', async () => {
  const calls = { calls: 0 };
  // Dois runtimes = dois durables; o prisma COMPARTILHADO é o que torna a
  // claim visível para ambos (mesmo Postgres em produção).
  const shared = createFakePrisma();
  const w1 = makeRuntimeOn(shared, { executorCalls: calls });
  const w2 = makeRuntimeOn(shared, { executorCalls: calls });

  await Promise.all([
    w1.runtime.processMessage(createFakeMessage(makeTask(), { trace: w1.trace })),
    w2.runtime.processMessage(createFakeMessage(makeTask(), { trace: w2.trace })),
  ]);

  assert.strictEqual(calls.calls, 1, 'dois durables, UMA execução — a claim decide o vencedor');
  const acked = [w1, w2].filter((w) => w.trace.includes('ack')).length;
  assert.strictEqual(acked, 2, 'ambas as entregas terminam em ack (vencedor após publicar)');
});
