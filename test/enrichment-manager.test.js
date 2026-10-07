const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma, createFakeJs } = require('./helpers/fake-prisma');
const contracts = require('../enrichment-contracts');
const capabilities = require('../enrichment-capabilities');
const { createEnrichmentManager } = require('../enrichment-manager');

// ── Deps comuns: prisma fake + bus fake + plano premium ─────────────────────

function makeDeps({ plan = 'premium', caps = capabilities } = {}) {
  const prisma = createFakePrisma();
  const js = createFakeJs();
  const manager = createEnrichmentManager({
    prisma,
    js,
    getOrgPlan: async () => plan,
    capabilities: caps,
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } },
  });
  return { prisma, js, manager };
}

async function seedProspect(prisma, over = {}) {
  return prisma.prospect.create({
    data: {
      id: 'p-1', orgId: 'org-1', companyName: 'Marispan Ltda',
      cnpj: '45299583000131', domain: 'marispan.com.br',
      enrichmentSummary: {}, createdAt: new Date(), ...over,
    },
  });
}

function decoded(js, subjectIncludes) {
  return js.published
    .filter((m) => m.subject.includes(subjectIncludes))
    .map((m) => contracts.parsePayload(m.data));
}

// ── Planejamento (fan-out) ──────────────────────────────────────────────────

test('US1 planejamento: 1 task por entidade × capability elegível, publicadas em ordem de prioridade', async () => {
  const { prisma, js, manager } = makeDeps();
  const prospect = await seedProspect(prisma);
  const { job, tasks } = await manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });

  // Premium: 3 habilitadas (todas basic; nenhuma premium habilitada ainda).
  assert.strictEqual(tasks.length, 3);
  assert.deepStrictEqual(tasks.map((t) => t.status), ['QUEUED', 'QUEUED', 'QUEUED']);
  assert.strictEqual(job.status, 'RUNNING');

  const taskMsgs = decoded(js, 'enrichment.task.');
  assert.strictEqual(taskMsgs.length, 3);
  // Ordem de publicação segue prioridade (0 primeiro — planejamento em lote).
  assert.deepStrictEqual(taskMsgs.map((t) => t.priority), [...taskMsgs.map((t) => t.priority)].sort((a, b) => a - b));
  // Headers de correlação obrigatórios.
  const msg = js.published.find((m) => m.subject.includes('enrichment.task.'));
  assert.ok(msg.opts.headers['Nats-Msg-Id']);
  assert.strictEqual(msg.opts.headers['X-Org-Id'], 'org-1');
  assert.ok(msg.opts.headers.traceparent);
});

test('US1 planejamento: replanejar o MESMO job não duplica tasks (taskKey determinístico)', async () => {
  const { prisma, js, manager } = await makeDeps();
  const prospect = await seedProspect(prisma);
  const { job } = await manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  const before = (await prisma.enrichmentTask.findMany({ where: { jobId: job.id } })).length;
  await manager.planTasks(job, prospect);
  const after = (await prisma.enrichmentTask.findMany({ where: { jobId: job.id } })).length;
  assert.strictEqual(before, after);
  // Nenhuma publicação duplicada: Nats-Msg-Id (taskId:attempt) únicos.
  const msgIds = js.published.map((m) => m.opts.headers['Nats-Msg-Id']);
  assert.strictEqual(new Set(msgIds).size, msgIds.length);
});

test('US1 planejamento: job sem nenhuma task aplicável encerra imediatamente COMPLETED com motivo', async () => {
  const emptyCaps = { eligibleCapabilities: () => [], getCapability: () => null };
  const { prisma, js, manager } = makeDeps({ caps: emptyCaps });
  const prospect = await seedProspect(prisma);
  const { job } = await manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  assert.strictEqual(job.status, 'COMPLETED');
  assert.ok(job.lastError && job.lastError.type === 'NO_TASKS');
  assert.strictEqual(js.published.filter((m) => m.subject === contracts.JOB_COMPLETED_SUBJECT).length, 1);
});

// ── Resultados parciais aplicados de forma independente ─────────────────────

async function seedJob(deps) {
  const prospect = await seedProspect(deps.prisma);
  const { job, tasks } = await deps.manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  return { prospect, job, tasks };
}

test('US1 resultado COMPLETED: task conclui, fatos aplicados ao perfil, job segue RUNNING', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks.find((t) => t.capability === 'identity.cnpj.basic');

  await deps.manager.handleResult({
    version: '1', taskId: task.id, taskKey: task.taskKey, jobId: job.id,
    orgId: 'org-1', prospectId: job.prospectId, entityKey: task.entityKey, entityType: task.entityType,
    capability: 'identity.cnpj.basic', provider: 'brasilapi.cnpj', status: 'COMPLETED',
    data: { cnpj: '45299583000131' },
    facts: [{ attribute: 'company.cnpj', value: '45299583000131', confidence: 0.95,
      evidence: { sourceType: 'brasilapi', retrievedAt: new Date().toISOString() } }],
    error: null, durationMs: 200, workerVersion: 'test', suggestedTasks: [],
    completedAt: new Date().toISOString(),
  });

  const updatedTask = await deps.prisma.enrichmentTask.findUnique({ where: { id: task.id } });
  assert.strictEqual(updatedTask.status, 'COMPLETED');
  const prospect = await deps.prisma.prospect.findUnique({ where: { id: job.prospectId } });
  assert.strictEqual(prospect.enrichmentSummary.v2['identity.cnpj.basic'].data.cnpj, '45299583000131');
  const stillRunning = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(stillRunning.status, 'RUNNING'); // resultados parciais NÃO concluem o job
});

test('US1 resultado duplicado (redelivery) não aplica fatos duas vezes', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks[0];
  const result = {
    version: '1', taskId: task.id, taskKey: task.taskKey, jobId: job.id,
    orgId: 'org-1', prospectId: job.prospectId, entityKey: task.entityKey, entityType: task.entityType,
    capability: task.capability, provider: null, status: 'COMPLETED', data: { ok: 1 }, facts: [],
    error: null, durationMs: 5, workerVersion: 'test', suggestedTasks: [], completedAt: new Date().toISOString(),
  };
  await deps.manager.handleResult(result);
  await deps.manager.handleResult(result); // redelivery
  const updates = deps.prisma.prospect.rows[0].enrichmentSummary.v2[task.capability].appliedCount;
  assert.strictEqual(updates, 1);
});

// ── Conclusão: COMPLETED / PARTIAL / FAILED com percentuais ─────────────────

function mkResult(job, task, status, extra = {}) {
  return {
    version: '1', taskId: task.id, taskKey: task.taskKey, jobId: job.id,
    orgId: 'org-1', prospectId: job.prospectId, entityKey: task.entityKey, entityType: task.entityType,
    capability: task.capability, provider: null, status,
    data: status === 'COMPLETED' ? { ok: 1 } : null, facts: [],
    error: status === 'COMPLETED' ? null : { type: 'INVALID_INPUT', message: 'x', retryable: false },
    durationMs: 5, workerVersion: 'test', suggestedTasks: [], completedAt: new Date().toISOString(),
    ...extra,
  };
}

test('US1 conclusão: todas COMPLETED → job COMPLETED + evento job.completed.v1', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  for (const t of tasks) await deps.manager.handleResult(mkResult(job, t, 'COMPLETED'));
  const finalJob = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalJob.status, 'COMPLETED');
  const completedEvents = deps.js.published.filter((m) => m.subject === contracts.JOB_COMPLETED_SUBJECT);
  assert.strictEqual(completedEvents.length, 1);
  const payload = contracts.parsePayload(completedEvents[0].data);
  assert.strictEqual(payload.status, 'COMPLETED');
  assert.strictEqual(payload.counts.completed, 3);
  assert.strictEqual(payload.completionPct, 100);
});

test('US1 conclusão: sucessos + falhas permanentes → job PARTIAL com percentual coerente', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  await deps.manager.handleResult(mkResult(job, tasks[0], 'COMPLETED'));
  await deps.manager.handleResult(mkResult(job, tasks[1], 'FAILED'));
  await deps.manager.handleResult(mkResult(job, tasks[2], 'COMPLETED'));
  const finalJob = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalJob.status, 'PARTIAL');
  const evt = deps.js.published.find((m) => m.subject === contracts.JOB_COMPLETED_SUBJECT);
  const payload = contracts.parsePayload(evt.data);
  assert.strictEqual(payload.status, 'PARTIAL');
  assert.strictEqual(payload.completionPct, 66.7); // 2/3
});

test('US1 conclusão: todas falhadas → job FAILED', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  for (const t of tasks) await deps.manager.handleResult(mkResult(job, t, 'FAILED'));
  const finalJob = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalJob.status, 'FAILED');
});

test('US1 segurança: result de outra organização é ignorado (não aplica, não conclui)', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  await deps.manager.handleResult({ ...mkResult(job, tasks[0], 'COMPLETED'), orgId: 'org-OUTRO' });
  const untouched = await deps.prisma.enrichmentTask.findUnique({ where: { id: tasks[0].id } });
  assert.strictEqual(untouched.status, 'QUEUED');
});

// ════════════════════════════════════════════════════════════════════════════
// US2 — resiliência no manager: retry transiente, esgotamento, TIMEOUT
// ════════════════════════════════════════════════════════════════════════════

test('US2 retry transiente: re-publica attempt+1 com notBefore; task RETRY→QUEUED', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks[0];
  await deps.manager.handleResult(mkResult(job, task, 'FAILED', {
    error: { type: 'RATE_LIMIT', message: '429', retryable: true },
  }));

  // Re-publicação: mesma capability, attempt=2, Nats-Msg-Id novo (dedup-safe).
  const republished = decoded(deps.js, 'enrichment.task.').filter((m) => m.attempt === 2);
  assert.strictEqual(republished.length, 1);
  assert.strictEqual(republished[0].capability, task.capability);
  assert.ok(republished[0].notBefore, 'notBefore (backoff) deve ir no payload');
  const republishedMsg = deps.js.published.filter((m) => m.subject.includes('enrichment.task.'))[3];
  assert.strictEqual(republishedMsg.opts.headers['Nats-Msg-Id'], `${task.id}:2`);

  const row = await deps.prisma.enrichmentTask.findUnique({ where: { id: task.id } });
  assert.strictEqual(row.attempt, 2);
  assert.strictEqual(row.status, 'QUEUED'); // volta à fila (passou por RETRY)
  assert.strictEqual(row.lastError.type, 'RATE_LIMIT'); // causa retida para auditoria
  const stillRunning = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(stillRunning.status, 'RUNNING'); // retry em voo não conclui o job
});

test('US2 esgotamento (006): transiente esgotado → PARKED; job DEGRADED até a task concluir', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks[0];
  await deps.prisma.enrichmentTask.update({ where: { id: task.id }, data: { maxAttempts: 1 } });
  await deps.manager.handleResult(mkResult(job, task, 'FAILED', {
    error: { type: 'PROVIDER_UNAVAILABLE', message: 'fora do ar', retryable: true },
  }));
  const row = await deps.prisma.enrichmentTask.findUnique({ where: { id: task.id } });
  assert.strictEqual(row.status, 'PARKED'); // 006: nunca FAILED por transiente
  assert.ok(row.nextAttemptAt, 'agendamento do sweeper presente');
  const republished = decoded(deps.js, 'enrichment.task.').filter((m) => m.attempt === 2);
  assert.strictEqual(republished.length, 0); // esgotado: nenhuma re-publicação imediata
  let finalJob = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalJob.status, 'RUNNING'); // demais tasks ainda na fila
  // Concluindo as restantes, o job fica DEGRADED (task parked pendente) —
  // não PARTIAL: refinaliza quando a parked concluir (sweeper).
  for (const t of tasks.slice(1)) await deps.manager.handleResult(mkResult(job, t, 'COMPLETED'));
  finalJob = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalJob.status, 'DEGRADED');
});

test('US2 TIMEOUT: volta à fila com causa TIMEOUT registrada', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks[0];
  await deps.manager.handleResult(mkResult(job, task, 'FAILED', {
    error: { type: 'TIMEOUT', message: 'timeout após 15000ms', retryable: true },
  }));
  const row = await deps.prisma.enrichmentTask.findUnique({ where: { id: task.id } });
  assert.strictEqual(row.status, 'QUEUED');
  assert.strictEqual(row.lastError.type, 'TIMEOUT');
});

test('US2 redelivery de result após retry concluído não reaplica (task terminal)', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks[0];
  const result = mkResult(job, task, 'COMPLETED');
  await deps.manager.handleResult(result);
  const outcome = await deps.manager.handleResult({ ...result, attempt: 2 });
  assert.strictEqual(outcome.duplicate, true);
  const prospect = await deps.prisma.prospect.findUnique({ where: { id: job.prospectId } });
  assert.strictEqual(prospect.enrichmentSummary.v2[task.capability].appliedCount, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// US3 — multi-tenant: gating por plano, snapshot, cota mensal, cross-tenant
// ════════════════════════════════════════════════════════════════════════════

// Catálogo stub com capability premium HABILITADA para tornar o gating observável.
const okValidator = (schema) => (input) => {
  for (const [field, type] of Object.entries(schema)) {
    if (input && typeof input[field] === type) continue;
    return { ok: false, code: 'INVALID_INPUT', message: `${field} (${type}) obrigatório` };
  }
  return { ok: true };
};
const gatedCaps = {
  eligibleCapabilities: ({ plan = 'trial' } = {}) => (plan === 'premium' ? ['identity.cnpj.basic', 'company.profile.deep'] : ['identity.cnpj.basic']),
  getCapability: (name) => ({
    'identity.cnpj.basic': { capability: name, family: 'identity', tier: 'basic', enabled: true, entityType: ['prospect'], timeoutMs: 5000, maxAttempts: 2, priority: 1, providers: ['x'], inputSchema: { cnpj: 'string' }, validateInput: okValidator({ cnpj: 'string' }), expand: [] },
    'company.profile.deep': { capability: name, family: 'company', tier: 'premium', enabled: true, entityType: ['prospect'], timeoutMs: 5000, maxAttempts: 2, priority: 2, providers: ['x'], inputSchema: { companyName: 'string' }, validateInput: okValidator({ companyName: 'string' }), expand: [] },
  }[name]),
};

test('US3 gating: trial NÃO planeja capability premium; premium sim', async () => {
  const trial = makeDeps({ plan: 'trial', caps: gatedCaps });
  const pro = await seedProspect(trial.prisma);
  const { tasks: trialTasks } = await trial.manager.createJob({ orgId: 'org-1', prospectId: pro.id, trigger: 'manual' });
  assert.deepStrictEqual(trialTasks.map((t) => t.capability), ['identity.cnpj.basic']);

  const premium = makeDeps({ plan: 'premium', caps: gatedCaps });
  const pro2 = await seedProspect(premium.prisma);
  const { tasks: premiumTasks } = await premium.manager.createJob({ orgId: 'org-1', prospectId: pro2.id, trigger: 'manual' });
  assert.ok(premiumTasks.some((t) => t.capability === 'company.profile.deep'));
});

test('US3 snapshot: plano do job é o do momento da criação (mudança depois não altera)', async () => {
  let plan = 'trial';
  const deps = makeDeps({ caps: gatedCaps });
  deps.manager = createEnrichmentManager({
    prisma: deps.prisma, js: deps.js,
    getOrgPlan: async () => plan,
    capabilities: gatedCaps,
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
  });
  const pro = await seedProspect(deps.prisma);
  const { job } = await deps.manager.createJob({ orgId: 'org-1', prospectId: pro.id, trigger: 'manual' });
  assert.strictEqual(job.plan, 'trial');
  plan = 'premium'; // org fez upgrade no meio do job
  const still = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(still.plan, 'trial');
});

test('US3 cota: excedente lança ENRICHMENT_QUOTA_EXCEEDED e nenhuma task nasce', async () => {
  const deps = makeDeps({ caps: gatedCaps });
  const assertQuota = async () => {
    const err = new Error('cota mensal atingida');
    err.code = 'ENRICHMENT_QUOTA_EXCEEDED';
    throw err;
  };
  const manager = createEnrichmentManager({
    prisma: deps.prisma, js: deps.js, getOrgPlan: async () => 'trial',
    capabilities: gatedCaps, assertQuota,
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
  });
  const pro = await seedProspect(deps.prisma);
  await assert.rejects(
    () => manager.createJob({ orgId: 'org-1', prospectId: pro.id, trigger: 'manual' }),
    (e) => e.code === 'ENRICHMENT_QUOTA_EXCEEDED'
  );
  assert.strictEqual(deps.prisma.enrichmentTask.rows.length, 0);
});

test('US3 cross-tenant: getJobStatus/getProspectFacts de outra org retornam null', async () => {
  const deps = makeDeps();
  const { job } = await seedJob(deps);
  assert.strictEqual(await deps.manager.getJobStatus(job.id, 'org-OUTRO'), null);
  assert.strictEqual(await deps.manager.getProspectFacts(job.prospectId, 'org-OUTRO'), null);
  assert.ok(await deps.manager.getJobStatus(job.id, 'org-1'));
});

// ════════════════════════════════════════════════════════════════════════════
// Phase 12 / T061 — consumidor durável do manager (boot real)
// ════════════════════════════════════════════════════════════════════════════

test('T061 startResultConsumer: consome do barramento, aplica resultado e acka', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks[0];

  // Entrega fake no formato do JetStream (async iterable de 1 mensagem).
  const acked = [];
  const contracts2 = require('../enrichment-contracts');
  const delivery = {
    data: contracts2.serializePayload(mkResult(job, task, 'COMPLETED')),
    ack: async () => acked.push('ack'),
    nak: async () => acked.push('nak'),
    term: async () => acked.push('term'),
  };
  let fetchCalls = 0;
  const fakeConsumer = {
    async fetch() {
      fetchCalls += 1;
      if (fetchCalls === 1) return [delivery];
      return new Promise(() => {}); // loop fica esperando (comportamento do broker)
    },
  };

  await deps.manager.startResultConsumer({ consumer: fakeConsumer });
  // Aguarda o processamento assíncrono do ciclo.
  for (let i = 0; i < 50 && acked.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await deps.manager.stopResultConsumer();

  assert.deepStrictEqual(acked, ['ack']); // ack SOMENTE após aplicar
  const prospect = await deps.prisma.prospect.findUnique({ where: { id: job.prospectId } });
  assert.strictEqual(prospect.enrichmentSummary.v2[task.capability].status, 'COMPLETED');
});

test('T061 payload ilegível no consumer → term (poison), sem quebrar o loop', async () => {
  const deps = makeDeps();
  const acked = [];
  const delivery = {
    data: Buffer.from('não-json'),
    ack: async () => acked.push('ack'),
    nak: async () => acked.push('nak'),
    term: async () => acked.push('term'),
  };
  let fetchCalls = 0;
  const fakeConsumer = {
    async fetch() {
      fetchCalls += 1;
      if (fetchCalls === 1) return [delivery];
      return new Promise(() => {});
    },
  };
  await deps.manager.startResultConsumer({ consumer: fakeConsumer });
  for (let i = 0; i < 50 && acked.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await deps.manager.stopResultConsumer();
  assert.deepStrictEqual(acked, ['term']);
});

test('T061 erro de processamento → nak (reentrega), loop continua vivo', async () => {
  const deps = makeDeps();
  // handleResult que lança: prisma quebrado na hora do processamento.
  const breaking = createEnrichmentManager({
    prisma: deps.prisma,
    js: deps.js,
    getOrgPlan: async () => 'trial',
    capabilities,
    logger: { info() {}, warn() {}, error() {}, child() { return this; } },
  });
  const acked = [];
  let failFirst = true;
  const delivery = {
    data: require('../enrichment-contracts').serializePayload({
      version: '1', taskId: 'inexistente', taskKey: 'k', jobId: 'j', orgId: 'o', prospectId: 'p',
      entityKey: 'e', entityType: 'prospect', capability: 'c', provider: null, status: 'COMPLETED',
      data: {}, facts: [], error: null, durationMs: 1, workerVersion: 't', suggestedTasks: [],
      completedAt: new Date().toISOString(),
    }),
    ack: async () => acked.push('ack'),
    nak: async () => acked.push('nak'),
    term: async () => acked.push('term'),
  };
  let fetchCalls = 0;
  const fakeConsumer = {
    async fetch() {
      fetchCalls += 1;
      if (fetchCalls === 1) return [delivery];
      return new Promise(() => {});
    },
  };
  // handleResult de result com task inexistente é IGNORADO (não lança) → ack.
  await breaking.startResultConsumer({ consumer: fakeConsumer });
  for (let i = 0; i < 50 && acked.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await breaking.stopResultConsumer();
  assert.deepStrictEqual(acked, ['ack']);
});

// ── Resync de tasks órfãs (worker morreu entre RUNNING e result; publish
//    perdido no meio do lote — incidente de produção de 2026-09-17) ─────────

function backdate(prisma, taskId, fields) {
  const row = prisma.enrichmentTask.rows.find((r) => r.id === taskId);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (const [k, v] of Object.entries(fields)) row[k] = v === 'old' ? old : v;
}

test('resync: task RUNNING órfã (worker morreu) é re-publicada e volta a QUEUED com attempt+1', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  const task = tasks[0];
  const attemptBefore = task.attempt; // snapshot: fake-prisma muta a row in-place
  await deps.prisma.enrichmentTask.update({ where: { id: task.id }, data: { status: 'RUNNING', startedAt: new Date() } });
  backdate(deps.prisma, task.id, { startedAt: 'old' });

  const r = await deps.manager.resyncStalledTasks();
  assert.strictEqual(r.reclaimed, 1);
  const updated = await deps.prisma.enrichmentTask.findUnique({ where: { id: task.id } });
  assert.strictEqual(updated.status, 'QUEUED');
  assert.strictEqual(updated.attempt, attemptBefore + 1);
  assert.strictEqual(updated.lastError.type, 'ORPHANED');
  const msgs = decoded(deps.js, 'enrichment.task.');
  const forTask = msgs.filter((m) => m.taskId === task.id);
  assert.strictEqual(forTask.length, 2); // publicação original (attempt 1) + resync (attempt 2)
  assert.ok(forTask.some((m) => m.attempt === attemptBefore + 1));
  assert.ok(forTask.every((m) => m.jobId === job.id));
});

test('resync: RUNNING órfã sem tentativas restantes vira PARKED (006) e o job DEGRADED', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  // Todas RUNNING órfãs; duas sem tentativas restantes, uma com.
  for (const t of tasks) {
    await deps.prisma.enrichmentTask.update({ where: { id: t.id }, data: { status: 'RUNNING', startedAt: new Date() } });
    backdate(deps.prisma, t.id, { startedAt: 'old' });
  }
  const [recuperavel, esgotada1, esgotada2] = tasks;
  await deps.prisma.enrichmentTask.update({ where: { id: esgotada1.id }, data: { attempt: esgotada1.maxAttempts } });
  await deps.prisma.enrichmentTask.update({ where: { id: esgotada2.id }, data: { attempt: esgotada2.maxAttempts } });

  const r = await deps.manager.resyncStalledTasks();
  assert.strictEqual(r.reclaimed, 1);
  assert.strictEqual(r.parked, 2); // 006: esgotadas vão para PARKED (nunca FAILED)
  const parkedTask = await deps.prisma.enrichmentTask.findUnique({ where: { id: esgotada1.id } });
  assert.strictEqual(parkedTask.status, 'PARKED');
  // Job não conclui: a task recuperada segue ativa (QUEUED).
  const stillRunning = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(stillRunning.status, 'RUNNING');

  // Esgota a última também → job DEGRADED (todas parkadas/aguardando) —
  // refinaliza quando o sweeper drenar.
  await deps.prisma.enrichmentTask.update({ where: { id: recuperavel.id }, data: { attempt: recuperavel.maxAttempts, status: 'RUNNING' } });
  backdate(deps.prisma, recuperavel.id, { startedAt: 'old' });
  await deps.manager.resyncStalledTasks();
  const finalized = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalized.status, 'DEGRADED');
  assert.strictEqual(deps.js.published.filter((m) => m.subject === contracts.JOB_COMPLETED_SUBJECT).length, 0);
});

test('resync: QUEUED nunca publicada (attempt 0, velha) é publicada com attempt 1', async () => {
  const deps = makeDeps();
  const prospect = await seedProspect(deps.prisma);
  const { job } = await deps.manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  const spawned = await deps.manager.createTask({
    job, capability: 'search.news', entityKey: `company:subsidiaria`, entityType: 'company',
    input: { companyName: 'Marispan Ltda' },
  });
  assert.ok(spawned.created);
  // Simula publish perdido: criada há 1h, attempt 0 (nunca publicada).
  backdate(deps.prisma, spawned.task.id, { updatedAt: 'old' });

  const r = await deps.manager.resyncStalledTasks();
  assert.strictEqual(r.reclaimed, 1);
  const updated = await deps.prisma.enrichmentTask.findUnique({ where: { id: spawned.task.id } });
  assert.strictEqual(updated.status, 'QUEUED');
  assert.strictEqual(updated.attempt, 1);
  assert.ok(decoded(deps.js, 'enrichment.task.search.news').some((m) => m.taskId === spawned.task.id));
});

test('resync: tasks e QUEUED recentes não são tocadas (sem publicação duplicada)', async () => {
  const deps = makeDeps();
  const { tasks } = await seedJob(deps); // tasks QUEUED recém-publicadas
  await deps.prisma.enrichmentTask.update({ where: { id: tasks[0].id }, data: { status: 'RUNNING', startedAt: new Date() } });

  const before = deps.js.published.length;
  const r = await deps.manager.resyncStalledTasks();
  assert.strictEqual(r.reclaimed, 0);
  assert.strictEqual(r.failed, 0);
  assert.strictEqual(deps.js.published.length, before);
  const running = await deps.prisma.enrichmentTask.findUnique({ where: { id: tasks[0].id } });
  assert.strictEqual(running.status, 'RUNNING');
});

test('resync: job RUNNING com todas as tasks terminais é finalizado (result perdido)', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  for (const t of tasks) {
    await deps.prisma.enrichmentTask.update({
      where: { id: t.id },
      data: { status: 'FAILED', completedAt: new Date(), lastError: { type: 'NOT_FOUND', message: 'x', attempt: 1 } },
    });
  }
  // Simula o job órfão: todos terminais, mas o evento de conclusão se perdeu.
  await deps.prisma.enrichmentJob.update({ where: { id: job.id }, data: { status: 'RUNNING', completedAt: null } });

  const r = await deps.manager.resyncStalledTasks();
  assert.strictEqual(r.reclaimed, 0);
  const finalized = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalized.status, 'FAILED');
  assert.ok(deps.js.published.some((m) => m.subject === contracts.JOB_COMPLETED_SUBJECT));
});

// ── Retry sem pin de provider + BLOCKED órfã + watchdog de terminação ──────

test('applyFailure: retry re-publica SEM pin de provider (failover reavaliado)', async () => {
  const deps = makeDeps();
  const { tasks } = await seedJob(deps);
  const task = tasks[0];
  await deps.prisma.enrichmentTask.update({ where: { id: task.id }, data: { provider: 'brasilapi.cnpj' } });

  await deps.manager.handleResult({
    version: '1', taskId: task.id, taskKey: task.taskKey, jobId: task.jobId,
    orgId: 'org-1', prospectId: task.prospectId, entityKey: task.entityKey, entityType: task.entityType,
    capability: task.capability, provider: 'brasilapi.cnpj', status: 'FAILED',
    data: {}, facts: [], error: { type: 'PROVIDER_UNAVAILABLE', message: 'BrasilAPI HTTP 403', retryable: true },
    durationMs: 100, workerVersion: 'test', suggestedTasks: [],
    completedAt: new Date().toISOString(),
  });

  const retries = decoded(deps.js, 'enrichment.task.').filter((m) => m.taskId === task.id);
  const retryMsg = retries[retries.length - 1];
  assert.strictEqual(retryMsg.provider, null); // próxima tentativa reavalia o catálogo
  const row = await deps.prisma.enrichmentTask.findUnique({ where: { id: task.id } });
  assert.strictEqual(row.status, 'QUEUED');
});

test('resync: BLOCKED com dependência COMPLETED é desbloqueado e publicado', async () => {
  const deps = makeDeps();
  const prospect = await seedProspect(deps.prisma);
  const { job } = await deps.manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  const dep = (await deps.prisma.enrichmentTask.findMany({ where: { jobId: job.id } }))[0];
  await deps.prisma.enrichmentTask.update({ where: { id: dep.id }, data: { status: 'COMPLETED', completedAt: new Date() } });
  await deps.prisma.enrichmentResult.create({ data: { orgId: 'org-1', taskId: dep.id, jobId: job.id, prospectId: prospect.id, entityKey: dep.entityKey, entityType: dep.entityType, capability: dep.capability, provider: null, status: 'COMPLETED', data: { domain: 'marispan.com.br' }, confidence: null, durationMs: 1, workerVersion: 't', rawRecordId: null } });
  const blocked = await deps.manager.createTask({
    job, capability: 'search.news', entityKey: 'company:subsidiaria', entityType: 'company',
    input: { companyName: 'Marispan Ltda' }, dependsOn: [dep.id],
  });
  assert.ok(blocked.created);
  backdate(deps.prisma, blocked.task.id, { updatedAt: 'old' });

  const r = await deps.manager.resyncStalledTasks();
  assert.strictEqual(r.reclaimed, 1);
  const row = await deps.prisma.enrichmentTask.findUnique({ where: { id: blocked.task.id } });
  assert.strictEqual(row.status, 'QUEUED');
  const msgs = decoded(deps.js, 'enrichment.task.search.news');
  const republished = msgs.find((m) => m.taskId === blocked.task.id);
  assert.ok(republished);
  assert.strictEqual(republished.input.domain, 'marispan.com.br'); // input mesclado da dependência
  assert.strictEqual(republished.provider, null);
});

test('resync: BLOCKED com dependência FAILED é cancelado', async () => {
  const deps = makeDeps();
  const prospect = await seedProspect(deps.prisma);
  const { job } = await deps.manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  const dep = (await deps.prisma.enrichmentTask.findMany({ where: { jobId: job.id } }))[0];
  await deps.prisma.enrichmentTask.update({ where: { id: dep.id }, data: { status: 'FAILED', completedAt: new Date() } });
  const blocked = await deps.manager.createTask({
    job, capability: 'search.news', entityKey: 'company:subsidiaria', entityType: 'company',
    input: { companyName: 'Marispan Ltda' }, dependsOn: [dep.id],
  });
  backdate(deps.prisma, blocked.task.id, { updatedAt: 'old' });

  await deps.manager.resyncStalledTasks();
  const row = await deps.prisma.enrichmentTask.findUnique({ where: { id: blocked.task.id } });
  assert.strictEqual(row.status, 'CANCELLED');
  assert.strictEqual(row.lastError.type, 'DEPENDENCY_FAILED');
});

test('resync: watchdog finaliza job RUNNING sem progresso, cancelando tasks ativas', async () => {
  const deps = makeDeps();
  const { job, tasks } = await seedJob(deps);
  // 1 task ativa órfã (BLOCKED sem dependências), 2 terminais — tudo sem
  // progresso há 3h (limiar do watchdog: 1h).
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await deps.prisma.enrichmentTask.update({ where: { id: tasks[0].id }, data: { status: 'BLOCKED', dependsOn: [] } });
  backdate(deps.prisma, tasks[0].id, { updatedAt: threeHoursAgo });
  for (const t of tasks.slice(1)) {
    await deps.prisma.enrichmentTask.update({
      where: { id: t.id },
      data: { status: 'FAILED', completedAt: threeHoursAgo, lastError: { type: 'NOT_FOUND', message: 'x', attempt: 1 } },
    });
    backdate(deps.prisma, t.id, { updatedAt: threeHoursAgo });
  }

  const r = await deps.manager.resyncStalledTasks();
  assert.strictEqual(r.watchdogJobs, 1);
  const orphan = await deps.prisma.enrichmentTask.findUnique({ where: { id: tasks[0].id } });
  assert.strictEqual(orphan.status, 'CANCELLED');
  assert.strictEqual(orphan.lastError.type, 'WATCHDOG');
  const finalized = await deps.prisma.enrichmentJob.findUnique({ where: { id: job.id } });
  assert.strictEqual(finalized.status, 'FAILED'); // concluída=0, falhadas>0
  assert.ok(deps.js.published.some((m) => m.subject === contracts.JOB_COMPLETED_SUBJECT));
});

// ── QA 2026-10-07: WhatsApp do SITE vira o telefone prioritário do lead ──────

test('QA: digital_presence com WhatsApp do site entra na FRENTE de cnpjPhones (+ e-mail corporativo)', async () => {
  const caps = {
    eligibleCapabilities: ({ plan }) => (plan === 'premium'
      ? ['identity.cnpj.basic', 'company.digital_presence']
      : ['identity.cnpj.basic']),
    expandRulesFor: () => [],
    getCapability: (name) => (name === 'company.digital_presence'
      ? { name: 'company.digital_presence', enabled: true, tier: 'premium', validateInput: () => ({ ok: true }), expandRulesFor: () => [] }
      : require('../enrichment-capabilities').getCapability(name)),
  };
  const deps = makeDeps({ caps });
  const prospect = await seedProspect(deps.prisma, { cnpjPhones: ['1132995850'] });
  const { job, tasks } = await deps.manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  const task = tasks.find((t) => t.capability === 'company.digital_presence');

  await deps.manager.handleResult({
    version: '1', taskId: task.id, taskKey: task.taskKey, jobId: job.id,
    orgId: 'org-1', prospectId: job.prospectId, entityKey: task.entityKey, entityType: task.entityType,
    capability: 'company.digital_presence', provider: null, status: 'COMPLETED',
    data: {
      digital_presence: { whatsapp: '5512988739001', corporate_email: 'contato@site.com.br' },
      contacts: [{ type: 'whatsapp', value: '5512988739001', classification: 'FOUND', confidence: 0.8 }],
    },
    facts: [{ attribute: 'contact.whatsapp', value: '5512988739001', confidence: 0.8, evidence: { sourceType: 'site', retrievedAt: new Date().toISOString() } }],
    error: null, durationMs: 100, workerVersion: 'test', suggestedTasks: [], completedAt: new Date().toISOString(),
  });

  const updated = await deps.prisma.prospect.findUnique({ where: { id: prospect.id } });
  assert.deepStrictEqual(updated.cnpjPhones, ['5512988739001', '1132995850'], 'WhatsApp do site na FRENTE (motor WA usa [0])');
  assert.strictEqual(updated.cnpjEmail, 'contato@site.com.br', 'e-mail corporativo preenche lacuna');
});

test('QA: WhatsApp já presente não duplica; sem WhatsApp não mexe nos telefones', async () => {
  const caps = {
    eligibleCapabilities: ({ plan }) => (plan === 'premium'
      ? ['identity.cnpj.basic', 'company.digital_presence']
      : ['identity.cnpj.basic']),
    expandRulesFor: () => [],
    getCapability: (name) => (name === 'company.digital_presence'
      ? { name: 'company.digital_presence', enabled: true, tier: 'premium', validateInput: () => ({ ok: true }), expandRulesFor: () => [] }
      : require('../enrichment-capabilities').getCapability(name)),
  };
  const deps = makeDeps({ caps });
  const prospect = await seedProspect(deps.prisma, { cnpjPhones: ['5512988739001', '1132995850'] });
  const { job, tasks } = await deps.manager.createJob({ orgId: 'org-1', prospectId: prospect.id, trigger: 'manual' });
  const task = tasks.find((t) => t.capability === 'company.digital_presence');

  await deps.manager.handleResult({
    version: '1', taskId: task.id, taskKey: task.taskKey, jobId: job.id,
    orgId: 'org-1', prospectId: job.prospectId, entityKey: task.entityKey, entityType: task.entityType,
    capability: 'company.digital_presence', provider: null, status: 'COMPLETED',
    data: { digital_presence: { whatsapp: '5512988739001' }, contacts: [] },
    facts: [], error: null, durationMs: 100, workerVersion: 'test', suggestedTasks: [], completedAt: new Date().toISOString(),
  });

  const updated = await deps.prisma.prospect.findUnique({ where: { id: prospect.id } });
  assert.deepStrictEqual(updated.cnpjPhones, ['5512988739001', '1132995850'], 'sem duplicar');

  // digital_presence SEM whatsapp → telefones intocados.
  const prospect2 = await seedProspect(deps.prisma, { id: 'p-2', cnpjPhones: ['1132995850'] });
  const { job: job2, tasks: t2 } = await deps.manager.createJob({ orgId: 'org-1', prospectId: prospect2.id, trigger: 'manual' });
  const task2 = t2.find((t) => t.capability === 'company.digital_presence');
  await deps.manager.handleResult({
    version: '1', taskId: task2.id, taskKey: task2.taskKey, jobId: job2.id,
    orgId: 'org-1', prospectId: prospect2.id, entityKey: task2.entityKey, entityType: task2.entityType,
    capability: 'company.digital_presence', provider: null, status: 'COMPLETED',
    data: { digital_presence: { linkedin: 'linkedin.com/company/x' }, contacts: [] },
    facts: [], error: null, durationMs: 100, workerVersion: 'test', suggestedTasks: [], completedAt: new Date().toISOString(),
  });
  const p2 = await deps.prisma.prospect.findUnique({ where: { id: prospect2.id } });
  assert.deepStrictEqual(p2.cnpjPhones, ['1132995850'], 'sem WhatsApp → nada muda');
});
