// =============================================================================
// enrichment-provider-registry.js — registro operacional de providers
// (spec US4 / FR-021..024): rate limit por janela fixa, semáforo de
// concorrência com lease e circuit breaker — tudo em chaves Redis, válido
// ENTRE instâncias de worker (research R6). Estado é runtime-only: após
// restart/deploy o circuito reabre sozinho se o provider continuar ruim.
//
// O semáforo de concorrência é um ZSET de leases (score = deadline em ms):
// leases vencidos são purgados a cada acquire, então a morte de um worker
// segurando o slot não trava o provider para sempre (auto-cura em `leaseMs`).
//
// Estados: HEALTHY → DEGRADED (taxa de erro ≥ limiar) → OPEN (tudo falhando;
// TTL) → HALF-OPEN (sonda após expiração) → HEALTHY | OPEN.
// =============================================================================

const MINUTE_MS = 60 * 1000;

function createProviderRegistry({
  redis,
  clock = { now: () => Date.now() },
  limits = { default: { rpm: 120, concurrency: 20 }, byName: {} },
  openMs = 30 * 1000,
  errorRateThreshold = 0.5,
  minSample = 3,
  leaseMs = 2 * 60 * 1000,
} = {}) {
  const stateKey = (p) => `cb:${p}:state`;
  const lastKey = (p) => `cb:${p}:last`; // memória de "estava OPEN" além do TTL
  const rateKey = (p, bucket) => `rl:${p}:${bucket}`;
  const concKey = (p) => `conc:${p}`;
  const errKey = (p, bucket) => `cb:${p}:err:${bucket}`;
  const totKey = (p, bucket) => `cb:${p}:tot:${bucket}`;

  const limitsFor = (provider) => ({
    rpm: (limits.byName[provider] && limits.byName[provider].rpm) || limits.default.rpm,
    concurrency: (limits.byName[provider] && limits.byName[provider].concurrency) || limits.default.concurrency,
  });

  async function readState(provider) {
    const v = await redis.get(stateKey(provider));
    return v || 'HEALTHY';
  }

  async function acquire(provider) {
    let state = await readState(provider);
    if (state === 'DISABLED') {
      return { ok: false, reason: 'DISABLED', retryAfterMs: null };
    }
    if (state === 'OPEN') {
      const ttl = await redis.pttl(stateKey(provider));
      return { ok: false, reason: 'PROVIDER_CIRCUIT_OPEN', retryAfterMs: ttl > 0 ? ttl : openMs };
    }
    if (state === 'HEALTHY') {
      // Circuit recém-expirado OU provider sem estado: se o último estado
      // conhecido era OPEN (TTL expirou) ou há erro na janela corrente, a
      // primeira chamada é uma SONDA (HALF-OPEN).
      const last = await redis.get(lastKey(provider));
      const bucket = Math.floor(clock.now() / MINUTE_MS);
      const errs = parseInt((await redis.get(errKey(provider, bucket))) || '0', 10);
      if (last === 'OPEN' || errs > 0) {
        state = 'HALF-OPEN';
        await redis.set(stateKey(provider), 'HALF-OPEN');
        if (last === 'OPEN') await redis.del(lastKey(provider));
      }
    }

    // ── Rate limit (janela fixa por minuto) ──────────────────────────────────
    const { rpm, concurrency } = limitsFor(provider);
    const bucket = Math.floor(clock.now() / MINUTE_MS);
    const windowKey = rateKey(provider, bucket);
    const used = await redis.incr(windowKey);
    if (used === 1) await redis.expire(windowKey, 120);
    if (used > rpm) {
      const retryAfterMs = MINUTE_MS - (clock.now() % MINUTE_MS);
      return { ok: false, reason: 'RATE_LIMIT', retryAfterMs };
    }

    // ── Concorrência (semáforo distribuído com lease por membro) ────────────
    // Cada slot ativo é um lease individual num ZSET com deadline (score =
    // instante de expiração em ms). Leases vencidos são purgados em todo
    // acquire: um worker que morre segurando o slot NÃO trava o provider para
    // sempre — o slot é reclamado automaticamente após `leaseMs`.
    const cKey = concKey(provider);
    await redis.zremrangebyscore(cKey, '-inf', clock.now());
    const active = await redis.zcard(cKey);
    if (active >= concurrency) {
      return { ok: false, reason: 'CONCURRENCY', retryAfterMs: 500 };
    }
    const member = `${process.pid}:${clock.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await redis.zadd(cKey, clock.now() + leaseMs, member);
    await redis.pexpire(cKey, leaseMs * 2); // higiene: chave ociosa expira

    return {
      ok: true,
      state,
      ticket: {
        provider,
        async release() {
          await redis.zrem(cKey, member);
        },
      },
    };
  }

  async function recordOutcome(provider, { ok, latencyMs = 0 } = {}) {
    const bucket = Math.floor(clock.now() / MINUTE_MS);
    const tot = await redis.incr(totKey(provider, bucket));
    if (tot === 1) await redis.expire(totKey(provider, bucket), 120);
    if (!ok) {
      const errs = await redis.incr(errKey(provider, bucket));
      if (errs === 1) await redis.expire(errKey(provider, bucket), 120);
    }
    const errCount = parseInt((await redis.get(errKey(provider, bucket))) || '0', 10);
    const errorRate = tot > 0 ? errCount / tot : 0;

    const state = await readState(provider);
    if (state === 'HALF-OPEN') {
      // A sonda decide: sucesso fecha (e limpa a memória de OPEN); falha reabre.
      if (ok) {
        await redis.set(stateKey(provider), 'HEALTHY');
        await redis.del(lastKey(provider));
      } else {
        await redis.set(stateKey(provider), 'OPEN', 'PX', openMs);
        await redis.set(lastKey(provider), 'OPEN');
      }
      return;
    }
    if (state === 'DISABLED' || state === 'OPEN') return;

    if (tot >= minSample && errorRate >= 0.99) {
      await redis.set(stateKey(provider), 'OPEN', 'PX', openMs);
      await redis.set(lastKey(provider), 'OPEN');
    } else if (tot >= minSample && errorRate >= errorRateThreshold) {
      await redis.set(stateKey(provider), 'DEGRADED');
    } else if (state !== 'HEALTHY') {
      await redis.set(stateKey(provider), 'HEALTHY');
    }
  }

  async function getState(provider) {
    const bucket = Math.floor(clock.now() / MINUTE_MS);
    const { rpm, concurrency } = limitsFor(provider);
    const state = await readState(provider);
    const tot = parseInt((await redis.get(totKey(provider, bucket))) || '0', 10);
    const err = parseInt((await redis.get(errKey(provider, bucket))) || '0', 10);
    return {
      provider,
      state,
      rpm: { limit: rpm, used: parseInt((await redis.get(rateKey(provider, bucket))) || '0', 10) },
      concurrency: { limit: concurrency, used: await redis.zcard(concKey(provider)) },
      errorRate: tot ? err / tot : 0,
      avgLatencyMs: null, // latência agregada vive nas métricas prom (US8)
    };
  }

  async function disable(provider) {
    await redis.set(stateKey(provider), 'DISABLED');
  }

  async function enable(provider) {
    await redis.del(stateKey(provider));
  }

  /** Lista providers conhecidos (catálogo × byName) com estado. */
  async function listProviders(catalogProviders = []) {
    const names = [...new Set([...catalogProviders, ...limits.byName ? Object.keys(limits.byName) : []])];
    return Promise.all(names.map((p) => getState(p)));
  }

  return { acquire, release: (t) => t.release(), recordOutcome, getState, listProviders, disable, enable };
}

/** Registry no-op (worker sem Redis): sempre permite, nunca bloqueia. */
function createNoopRegistry() {
  return {
    acquire: async () => ({ ok: true, ticket: { provider: null, release: async () => {} } }),
    recordOutcome: async () => {},
    getState: async (provider) => ({ provider, state: 'HEALTHY' }),
    listProviders: async () => [],
    disable: async () => {},
    enable: async () => {},
  };
}

/**
 * Registry de boot para workers de produção: com REDIS_URL usa o registry
 * compartilhado (rate limit + circuit breaker ENTRE instâncias); sem Redis,
 * cai no no-op — o worker nunca quebra por falta de Redis.
 */
function getWorkerRegistry() {
  if (!process.env.REDIS_URL) return createNoopRegistry();
  return getSharedRegistry();
}

module.exports = { createProviderRegistry, createNoopRegistry, getSharedRegistry, getWorkerRegistry };

// ── Singleton para produção (lazy — ioredis só carrega quando usado) ───────
let _shared = null;

function getSharedRegistry() {
  if (!_shared) {
    const Redis = require('ioredis');
    const redis = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 })
      : new Redis({ lazyConnect: true, maxRetriesPerRequest: 2 });
    _shared = createProviderRegistry({ redis });
  }
  return _shared;
}
