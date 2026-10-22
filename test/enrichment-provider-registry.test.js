const test = require('node:test');
const assert = require('node:assert');
const { createFakeRedis, createFakeClock } = require('./helpers/fake-redis');
const { createProviderRegistry } = require('../enrichment-provider-registry');

const LIMITS = { default: { rpm: 5, concurrency: 2 }, byName: { 'searxng': { rpm: 2, concurrency: 1 } } };

function makeRegistry(over = {}) {
  const clock = over.clock || createFakeClock();
  const redis = over.redis || createFakeRedis({ clock });
  const registry = createProviderRegistry({
    redis,
    clock,
    limits: over.limits || LIMITS,
    openMs: 30000,
    errorRateThreshold: 0.5,
    minSample: 3,
    ...over.opts,
  });
  return { registry, redis, clock };
}

// ── Rate limit (janela fixa por minuto) ─────────────────────────────────────

test('US4 rate limit: bloqueia acima do rpm da janela e libera na janela seguinte', async () => {
  const { registry, clock } = makeRegistry();
  for (let i = 0; i < 2; i += 1) {
    const acq = await registry.acquire('searxng');
    assert.ok(acq.ok, `ticket ${i} deveria passar`);
    await acq.ticket.release();
  }
  const blocked = await registry.acquire('searxng');
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'RATE_LIMIT');
  assert.ok(blocked.retryAfterMs > 0);

  clock.advance(60 * 1000 + 1); // janela nova
  const next = await registry.acquire('searxng');
  assert.ok(next.ok);
  await next.ticket.release();
});

test('US4 rate limit: limite específico por provider (searxng 2/min no stub)', async () => {
  const { registry } = makeRegistry();
  for (let i = 0; i < 2; i += 1) {
    const acq = await registry.acquire('searxng');
    assert.ok(acq.ok);
    await acq.ticket.release();
  }
  const blocked = await registry.acquire('searxng');
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'RATE_LIMIT');
});

// ── Concorrência com lease ──────────────────────────────────────────────────

test('US4 concorrência: acquire além do limite recusa; release devolve o slot', async () => {
  const { registry } = makeRegistry();
  const t1 = await registry.acquire('brasilapi.cnpj');
  const t2 = await registry.acquire('brasilapi.cnpj');
  assert.ok(t1.ok && t2.ok);
  const t3 = await registry.acquire('brasilapi.cnpj'); // concorrência 2 esgotada
  assert.strictEqual(t3.ok, false);
  assert.strictEqual(t3.reason, 'CONCURRENCY');
  await t1.ticket.release();
  const t4 = await registry.acquire('brasilapi.cnpj');
  assert.ok(t4.ok);
});

test('US4 concorrência: lease vencido é reclamado (auto-cura após morte do worker)', async () => {
  const { registry, clock } = makeRegistry();
  const leaked = await registry.acquire('brasilapi.cnpj');
  const held = await registry.acquire('brasilapi.cnpj');
  assert.ok(leaked.ok && held.ok);
  // concorrência 2 esgotada e o worker do `leaked` "morre" sem release().
  const blocked = await registry.acquire('brasilapi.cnpj');
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.reason, 'CONCURRENCY');

  clock.advance(120001); // > leaseMs (120s)
  const recovered = await registry.acquire('brasilapi.cnpj');
  assert.ok(recovered.ok, 'lease vencido deve ser purgado no acquire');
  assert.strictEqual((await registry.getState('brasilapi.cnpj')).concurrency.used, 1);
  await recovered.ticket.release();
});

// ── Circuit breaker: HEALTHY → DEGRADED → OPEN → HALF-OPEN → recuperação ───

test('US4 circuit breaker: erros consecutivos abrem o circuito e pausam o despacho', async () => {
  const { registry } = makeRegistry();
  // 3 falhas na janela (minSample=3, threshold 0.5) → DEGRADED; com tudo falhando → OPEN.
  for (let i = 0; i < 3; i += 1) {
    await registry.recordOutcome('searxng', { ok: false, latencyMs: 100 });
  }
  const state = await registry.getState('searxng');
  assert.ok(['DEGRADED', 'OPEN'].includes(state.state), `estado=${state.state}`);

  // Força abertura por erro contínuo.
  for (let i = 0; i < 3; i += 1) await registry.recordOutcome('searxng', { ok: false, latencyMs: 100 });
  const after = await registry.getState('searxng');
  assert.strictEqual(after.state, 'OPEN');

  const acq = await registry.acquire('searxng');
  assert.strictEqual(acq.ok, false);
  assert.strictEqual(acq.reason, 'PROVIDER_CIRCUIT_OPEN');
  assert.ok(acq.retryAfterMs > 0);
});

test('US4 circuit breaker: OPEN expira → HALF-OPEN → sucesso fecha (HEALTHY)', async () => {
  const { registry, clock } = makeRegistry();
  for (let i = 0; i < 8; i += 1) await registry.recordOutcome('searxng', { ok: false, latencyMs: 10 });
  assert.strictEqual((await registry.getState('searxng')).state, 'OPEN');

  clock.advance(31000); // TTL do circuito aberto expira
  const probe = await registry.acquire('searxng');
  assert.ok(probe.ok, 'half-open: sonda permitida');
  assert.strictEqual((await registry.getState('searxng')).state, 'HALF-OPEN');
  await probe.ticket.release();
  await registry.recordOutcome('searxng', { ok: true, latencyMs: 20 });
  assert.strictEqual((await registry.getState('searxng')).state, 'HEALTHY');
});

test('US4 circuit breaker: sonda HALF-OPEN que falha reabre o circuito', async () => {
  const { registry, clock } = makeRegistry();
  for (let i = 0; i < 8; i += 1) await registry.recordOutcome('searxng', { ok: false, latencyMs: 10 });
  clock.advance(31000);
  const probe = await registry.acquire('searxng');
  assert.ok(probe.ok);
  await probe.ticket.release();
  await registry.recordOutcome('searxng', { ok: false, latencyMs: 10 });
  assert.strictEqual((await registry.getState('searxng')).state, 'OPEN');
});

test('US4 circuit breaker: provider saudável segue HEALTHY sob sucesso', async () => {
  const { registry } = makeRegistry();
  for (let i = 0; i < 10; i += 1) await registry.recordOutcome('brasilapi.cnpj', { ok: true, latencyMs: 50 });
  assert.strictEqual((await registry.getState('brasilapi.cnpj')).state, 'HEALTHY');
});

// ── Disable manual ──────────────────────────────────────────────────────────

test('US4 disabled: provider desabilitado nunca acquire', async () => {
  const { registry } = makeRegistry();
  await registry.disable('searxng');
  const acq = await registry.acquire('searxng');
  assert.strictEqual(acq.ok, false);
  assert.strictEqual(acq.reason, 'DISABLED');
  await registry.enable('searxng');
  const again = await registry.acquire('searxng');
  assert.ok(again.ok);
});
