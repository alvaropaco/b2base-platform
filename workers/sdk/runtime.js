// =============================================================================
// workers/sdk/runtime.js — runtime compartilhado dos workers de enrichment
// (spec FR-019). O worker novo contém APENAS executores de capability; toda
// preocupação de infraestrutura vive aqui:
//   parse/validate (contratos v1) → marca RUNNING → execute (timeout/abort)
//   → persist (EnrichmentResult) → publish (enrichment.result.v1) → ack.
//
// Garantias: ack SOMENTE após persist+publish; payload ilegível → poison
// (term); erro permanente → FAILED sem retry; transiente → FAILED retryable
// (o manager re-publica com attempt+1 e notBefore — backoff no nak, US2).
// Stateless: nada de estado em memória entre tasks além do semáforo local.
// =============================================================================

const contracts = require('../../enrichment-contracts');
const defaultConfig = require('../../enrichment-config');

// Janela de frescor da claim de execução: startedAt mais velho que
// timeoutMs + folga = dono morto/travado → a claim pode ser roubada. A folga
// cobre o tempo de persist+publish do resultado após o executor terminar.
const CLAIM_STALE_MARGIN_MS = 60_000;

/**
 * Claim de execução ÚNICA por task (workers/sdk, spec gate-twilio deferred):
 * durables com subject sobreposto (`enrichment.task.company.>` e
 * `enrichment.task.company.digital_presence.>`) entregam a MESMA task a dois
 * workers — sem claim, execução dobrada (crawl + lookup Twilio pagos 2×) e
 * corrida "primeiro-resultado-vence" no manager. A transição ATÔMICA da linha
 * EnrichmentTask para RUNNING vale a execução:
 *   - row inexistente (1ª entrega) → cria RUNNING = claim;
 *   - row RUNNING com startedAt fresco → outro processo está executando AGORA
 *     → caller acka sem executar (o result do dono resolve a task);
 *   - row RUNNING vencida → roubo atômico (updateMany com startedAt <= cutoff);
 *   - row não-RUNNING (QUEUED/RETRY/… do manager) → retoma.
 * Crash do dono com claim fresco: o ack_wait do broker reentrega (ainda
 * fresca → ack) e o resync do manager (006) re-publica com attempt+1 —
 * a task nunca morre; no pior caso atrasa até o ciclo do resync.
 */
async function claimExecution(prisma, task, { now, log }) {
  const staleCutoff = new Date(now().getTime() - (task.timeoutMs + CLAIM_STALE_MARGIN_MS));
  try {
    await prisma.enrichmentTask.create({
      data: {
        id: task.taskId,
        orgId: task.orgId,
        jobId: task.jobId,
        prospectId: task.prospectId,
        taskKey: task.taskKey,
        entityKey: task.entityKey,
        entityType: task.entityType,
        capability: task.capability,
        input: task.input,
        inputHash: '',
        status: 'RUNNING',
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        timeoutMs: task.timeoutMs,
        startedAt: now(),
      },
    });
    return true;
  } catch (err) {
    if (err.code !== 'P2002') {
      // Falha de claim (DB instável) NUNCA bloqueia a execução — comportamento
      // antigo (o manager deduplica results e o resync cobre órfãs).
      log.warn(`runtime: claim da task ${task.taskId} falhou (${err.message}) — executando sem claim`);
      return true;
    }
  }
  const row = await prisma.enrichmentTask.findUnique({ where: { id: task.taskId } });
  if (row && row.status === 'RUNNING' && new Date(row.startedAt) > staleCutoff) {
    return false; // claim fresco de OUTRO processo — não é o meu turno
  }
  const guard = row && row.status === 'RUNNING'
    ? { startedAt: { lte: staleCutoff } } // roubo de claim vencida (dono sumiu)
    : { status: { not: 'RUNNING' } }; // retoma de QUEUED/RETRY/TIMEOUT/PARKED…
  const upd = await prisma.enrichmentTask.updateMany({
    where: { id: task.taskId, ...guard },
    data: { status: 'RUNNING', startedAt: now(), attempt: task.attempt },
  });
  return upd.count === 1;
}

function createWorkerRuntime({
  name,
  filterSubject = null,
  capabilities,
  deps,
  concurrency = defaultConfig.WORKER_CONCURRENCY(),
  fetchBatch = defaultConfig.WORKER_FETCH_BATCH(),
  fetchExpiresMs = defaultConfig.WORKER_FETCH_EXPIRES_MS(),
  drainTimeoutMs = 30000,
  stream = null,
  durable = null,
  workerVersion = process.env.GIT_SHA || 'dev',
  now = () => new Date(),
  publishResultTimeoutMs = 5000,
  config = defaultConfig,
} = {}) {
  const {
    prisma,
    js = null, // JetStream real (start/stop); processMessage não depende dele
    publisher: injectedPublisher = null, // async (resultEvent) — injetável
    logger: baseLogger = console,
    jsm = null, // jetstream manager para garantir o consumer durável
  } = deps;

  let publisher = injectedPublisher;
  let rawStore = deps.rawStore || null;

  const executors = new Map(); // capability → async (task, ctx) => outcome
  let registry = deps.registry || require('../../enrichment-provider-registry').createNoopRegistry();
  const effectiveFilter = filterSubject || `enrichment.task.${name}.>`;
  const effectiveDurable = durable || `enrichment-engine-${name}`;
  const effectiveStream = stream || require('../../nats-stream').NATS_STREAM;

  let running = false;
  let inFlight = new Set();

  /** Registra executores de capability (usado pelos workers/*.js e testes). */
  function registerExecutors(map) {
    for (const [capability, fn] of Object.entries(map)) executors.set(capability, fn);
  }

  // ── Result events ─────────────────────────────────────────────────────────
  function buildResultEvent(task, { status, data, facts, error, durationMs, suggestedTasks, provider }) {
    return {
      version: contracts.VERSION,
      taskId: task.taskId,
      taskKey: task.taskKey,
      jobId: task.jobId,
      orgId: task.orgId,
      prospectId: task.prospectId,
      entityKey: task.entityKey,
      entityType: task.entityType,
      capability: task.capability,
      provider: provider || task.provider || null,
      attempt: task.attempt,
      status,
      data: data || {},
      facts: facts || [],
      error: error || null,
      durationMs,
      workerVersion,
      suggestedTasks: suggestedTasks || [],
      completedAt: now().toISOString(),
    };
  }

  async function defaultPublish(result) {
    if (!js) throw new Error('runtime sem js e sem publisher injetado');
    const hdr = require('../../nats-stream').headers();
    for (const [k, v] of Object.entries(contracts.buildResultHeaders(result))) hdr.set(k, v);
    await js.publish(contracts.RESULT_SUBJECT, contracts.serializePayload(result), {
      headers: hdr,
      timeout: publishResultTimeoutMs,
    });
  }

  async function publishResult(result) {
    const publish = publisher || defaultPublish;
    await publish(result);
  }

  /** Substitui o publisher em runtime (testes de infra-falha de publicação). */
  function setPublisherForTest(fn) {
    publisher = fn;
  }

  /** Substitui o registry em runtime (testes US4). */
  function setRegistryForTest(fn) {
    registry = fn;
  }

  /** Injeta o raw-store em runtime (produção e testes US6). */
  function setRawStoreForTest(fn) {
    rawStore = fn;
  }

  // ── Injeção de falha/latência por env (quickstart C4) ─────────────────────
  function forceErrorFor(provider) {
    return String(process.env.PROVIDER_FORCE_ERROR || '')
      .split(',')
      .map((s) => s.trim())
      .includes(provider);
  }
  function forceLatencyMsFor(provider) {
    const list = String(process.env.PROVIDER_FORCE_LATENCY || '')
      .split(',')
      .map((s) => s.trim());
    if (list.length && !list.includes(provider)) return 0;
    return parseInt(process.env.PROVIDER_FORCE_LATENCY_MS || '0', 10) || 0;
  }

  /** Publica enrichment.task.dlq.v1 (contrato §6) — melhor esforço. */
  async function publishDlq(task, reason, attempts, lastErrorMessage) {
    try {
      if (!js) return;
      const event = {
        version: contracts.VERSION,
        taskId: task.taskId,
        jobId: task.jobId,
        orgId: task.orgId,
        capability: task.capability,
        reason,
        lastError: { type: 'INVALID_CONTRACT', message: String(lastErrorMessage || '') },
        attempts,
      };
      const hdr = require('../../nats-stream').headers();
      for (const [k, v] of Object.entries(contracts.correlationHeaders(task))) hdr.set(k, v);
      await js.publish(contracts.DLQ_SUBJECT, contracts.serializePayload(event), { headers: hdr, timeout: publishResultTimeoutMs });
    } catch (err) {
      baseLogger.warn(`runtime: falha ao publicar DLQ de ${task.taskId}: ${err.message}`);
    }
  }

  function buildFailureEvent(task, { type, message, retryable, durationMs, provider, retryAfterMs }) {
    return buildResultEvent(task, {
      status: 'FAILED',
      error: {
        type,
        message: String(message || ''),
        retryable,
        // Feature 006 (R3): janela recomendada pelo circuito do provedor —
        // o manager a usa como nextAttemptAt de PARKED.
        ...(retryAfterMs != null ? { retryAfterMs: Number(retryAfterMs) } : {}),
      },
      durationMs,
      provider,
    });
  }

  /**
   * Entrega o evento: [persist] → publish → ack. Qualquer falha de
   * persistência/publicação → nak(delay) — o broker reentrega a MESMA
   * mensagem (persistência idempotente por taskId torna o reprocesso seguro).
   */
  async function deliver(msg, event, { persist = true } = {}) {
    try {
      if (persist) await persistResult(event);
      await publishResult(event);
      await msg.ack();
      return true;
    } catch (err) {
      const delay = config.backoffDelayMs(event.attempt || 1);
      baseLogger.warn(`runtime: falha ao entregar result de ${event.taskId} (${err.message}); nak(${delay}ms)`);
      try {
        await msg.nak(delay);
      } catch (_e) { /* msg será reentregue pelo ack_wait do broker */ }
      return false;
    }
  }

  async function publishFailureAndAck(msg, task, opts) {
    const delivered = await deliver(msg, buildFailureEvent(task, opts), { persist: opts.persist !== false });
    return { status: delivered ? 'FAILED' : 'NAK', type: opts.type };
  }

  async function persistResult(event) {
    const row = await prisma.enrichmentResult.upsert({
      where: { taskId: event.taskId },
      create: {
        orgId: event.orgId,
        taskId: event.taskId,
        jobId: event.jobId,
        prospectId: event.prospectId,
        entityKey: event.entityKey,
        entityType: event.entityType,
        capability: event.capability,
        provider: event.provider,
        status: event.status,
        data: event.data,
        confidence: (event.facts && event.facts[0] && event.facts[0].confidence) || null,
        durationMs: event.durationMs,
        workerVersion: event.workerVersion,
        rawRecordId: event.rawRecordId || null,
      },
      update: {
        status: event.status,
        data: event.data,
        durationMs: event.durationMs,
        provider: event.provider,
        rawRecordId: event.rawRecordId || null,
      },
    });
    // Evidência por fato (FR-026): prova de origem persistida junto ao result.
    const facts = event.facts || [];
    if (facts.length && prisma.enrichmentEvidence) {
      await prisma.enrichmentEvidence.createMany({
        data: facts.map((f) => ({
          orgId: event.orgId,
          resultId: row.id,
          attribute: f.attribute,
          value: f.value,
          sourceType: (f.evidence && f.evidence.sourceType) || null,
          provider: (f.evidence && f.evidence.provider) || event.provider || null,
          url: (f.evidence && f.evidence.url) || null,
          retrievedAt: (f.evidence && f.evidence.retrievedAt && new Date(f.evidence.retrievedAt)) || now(),
          confidence: (f.evidence && f.evidence.confidence) != null ? f.evidence.confidence : (f.confidence ?? null),
          rawRecordId: (f.evidence && f.evidence.rawRecordId) || event.rawRecordId || null,
        })),
      });
    }
    return row;
  }

  // ── Núcleo de processamento (unit-testável; msg = {data, ack, nak, term}) ──
  // O semáforo de concorrência vive AQUI (não no loop): qualquer caminho que
  // processe mensagens respeita o limite do processo.
  async function processMessage(msg) {
    await acquireSlot();
    try {
      return await _processMessageInner(msg);
    } finally {
      releaseSlot();
    }
  }

  async function _processMessageInner(msg) {
    let task;
    try {
      task = contracts.parsePayload(msg.data);
    } catch (_e) {
      await msg.term(); // payload ilegível/versão errada = poison
      return { status: 'POISON' };
    }

    let validationError = null;
    try {
      contracts.validateTaskPayload(task);
    } catch (err) {
      validationError = err;
    }
    if (validationError) {
      if (validationError.code === 'VERSION_MISMATCH' || !task.taskId) {
        await msg.term();
        return { status: 'POISON' };
      }
      // Payload com taskId mas inválido = poison com contexto (contrato §6):
      // publica DLQ e encerra com term — nunca vai gerar result processável.
      await publishDlq(task, 'POISON_MESSAGE', task.attempt, validationError.message);
      await msg.term();
      return { status: 'POISON' };
    }

    const def = capabilities.getCapability(task.capability);
    const executor = executors.get(task.capability);
    if (!def || !executor) {
      return publishFailureAndAck(msg, task, {
        type: 'INVALID_INPUT',
        message: `capability sem executor neste worker: ${task.capability}`,
        retryable: false,
        durationMs: 0,
        persist: false,
      });
    }
    const inputCheck = def.validateInput(task.input);
    if (!inputCheck.ok) {
      return publishFailureAndAck(msg, task, {
        type: 'INVALID_INPUT', message: inputCheck.message, retryable: false, durationMs: 0, persist: false,
      });
    }

    // Idempotência sob redelivery (FR-008): resultado já persistido → não
    // reexecuta o provider; republisha o estado e ack.
    const existing = await prisma.enrichmentResult.findUnique({ where: { taskId: task.taskId } });
    if (existing && existing.status === 'COMPLETED') {
      await publishResult(buildResultEvent(task, {
        status: 'COMPLETED', data: existing.data || {}, facts: [],
        durationMs: existing.durationMs || 0, provider: existing.provider,
      }));
      await msg.ack();
      return { status: 'DUPLICATE' };
    }

    const log = baseLogger.child ? baseLogger.child({
      orgId: task.orgId, jobId: task.jobId, taskId: task.taskId, capability: task.capability,
    }) : baseLogger;

    // Marca início da execução COM claim de exclusividade (consumo redundante
    // de durables): quem não conquista a claim ACKA sem executar — o result
    // do dono resolve a task. Write não-crítico: falha aqui não pode derrubar
    // a execução da task.
    const claimed = await claimExecution(prisma, task, { now, log });
    if (!claimed) {
      await msg.ack();
      return { status: 'CLAIMED_ELSEWHERE' };
    }

    // ── Proteção de provider (US4/T065): acquire ANTES de executar, com
    // FAILOVER pela ordem de preferência do catálogo (task.provider primeiro).
    const candidates = task.provider
      ? [task.provider, ...def.providers.filter((x) => x !== task.provider)]
      : [...def.providers];
    const typeMap = {
      RATE_LIMIT: 'RATE_LIMIT',
      PROVIDER_CIRCUIT_OPEN: 'PROVIDER_CIRCUIT_OPEN',
      CONCURRENCY: 'RATE_LIMIT',
      DISABLED: 'CAPABILITY_DISABLED',
    };
    let provider = null;
    let acq = null;
    let lastReject = null;
    for (const candidate of candidates) {
      const attempt = await registry.acquire(candidate);
      if (attempt.ok) {
        provider = candidate;
        acq = attempt;
        break;
      }
      lastReject = { provider: candidate, reason: attempt.reason, retryAfterMs: attempt.retryAfterMs };
    }
    if (!acq) {
      const type = typeMap[lastReject.reason] || 'PROVIDER_UNAVAILABLE';
      return publishFailureAndAck(msg, task, {
        type,
        message: `todos os providers indisponíveis (último: ${lastReject.provider} — ${lastReject.reason})`,
        retryable: type !== 'CAPABILITY_DISABLED',
        durationMs: 0,
        provider: lastReject.provider,
        // Feature 006 (R3): o manager agenda PARKED/nextAttemptAt respeitando
        // o retryAfterMs recomendado pelo circuito do provedor.
        retryAfterMs: lastReject.retryAfterMs,
        persist: false,
      });
    }
    // T069: rotula a task com o provider REAL escolhido (pós-failover) — o
    // rótulo de observabilidade precisa refletir quem executou, não quem foi
    // preferido no planejamento. Write best-effort.
    try {
      await prisma.enrichmentTask.update({ where: { id: task.taskId }, data: { provider } });
    } catch (err) {
      log.warn(`runtime: falha ao rotular provider da task ${task.taskId}: ${err.message}`);
    }

    // Injeção de falha/latência por env (testes C4 do quickstart).
    const forcedError = forceErrorFor(provider);
    if (forcedError) {
      await acq.ticket.release();
      return publishFailureAndAck(msg, task, {
        type: 'PROVIDER_UNAVAILABLE',
        message: `falha injetada por PROVIDER_FORCE_ERROR (${provider})`,
        retryable: true,
        durationMs: 0,
        provider,
        persist: false,
      });
    }
    const forcedLatencyMs = forceLatencyMsFor(provider);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), task.timeoutMs);
    let outcome = null;
    let execErr = null;
    try {
      if (forcedLatencyMs > 0) {
        await new Promise((r) => setTimeout(r, Math.min(forcedLatencyMs, task.timeoutMs)));
      }
      outcome = await executor(task, {
        signal: controller.signal,
        logger: log,
        deps: runtimeDeps,
        rawStore,
      });
    } catch (err) {
      execErr = err;
    }
    clearTimeout(timer);

    const durationMs = Date.now() - startedAt;
    await acq.ticket.release(); // liberado em TODOS os caminhos
    const aborted = controller.signal.aborted;
    if (execErr || aborted) {
      // Erro lançado pelo executor: PERMANENTE (NOT_FOUND, INVALID_INPUT…)
      // falha sem retry; TRANSIENTE mantém o código; desconhecido → INTERNAL.
      const permanent = !aborted && contracts.isPermanentError(execErr.code);
      const type = aborted
        ? 'TIMEOUT'
        : contracts.isTransientError(execErr.code)
          ? execErr.code
          : permanent ? execErr.code : 'INTERNAL';
      await registry.recordOutcome(provider, { ok: false, latencyMs: durationMs });
      return publishFailureAndAck(msg, task, {
        type,
        message: aborted ? `timeout após ${task.timeoutMs}ms` : (execErr && execErr.message) || String(execErr),
        retryable: aborted || !permanent,
        durationMs,
        provider,
      });
    }

    const status = outcome && outcome.status === 'FAILED' ? 'FAILED' : 'COMPLETED';
    await registry.recordOutcome(provider, { ok: status === 'COMPLETED', latencyMs: durationMs });
    if (typeof deps.onMetric === 'function') {
      deps.onMetric('task_duration', { capability: task.capability, durationMs });
      try {
        const st = await registry.getState(provider);
        if (st && st.state) deps.onMetric('provider_state', { provider, state: st.state });
      } catch (_e) { /* métrica é best-effort */ }
    }

    // Dado bruto → raw-store ANTES do persist (result carrega só a referência).
    let rawRecordId = null;
    if (outcome && outcome.raw && rawStore) {
      try {
        const ref = await rawStore.put({
          orgId: task.orgId,
          capability: task.capability,
          provider: (outcome && outcome.provider) || provider,
          contentType: outcome.raw.contentType || 'application/json',
          body: outcome.raw.body,
        });
        rawRecordId = ref.rawRecordId;
      } catch (err) {
        log.warn(`runtime: raw-store indisponível (${err.message}); seguindo sem bruto`);
      }
    }

    const event = buildResultEvent(task, {
      status,
      data: outcome ? outcome.data : {},
      facts: outcome ? outcome.facts : [],
      error: status === 'FAILED' ? {
        type: (outcome.error && outcome.error.type) || 'INTERNAL',
        message: (outcome.error && outcome.error.message) || '',
        retryable: outcome.error ? outcome.error.retryable !== false : false,
      } : null,
      durationMs,
      suggestedTasks: outcome ? outcome.suggestedTasks : [],
      provider: outcome ? outcome.provider : undefined,
    });
    event.rawRecordId = rawRecordId;
    const delivered = await deliver(msg, event); // persist(+evidência) → publish → ack (FR-018)
    return { status: delivered ? status : 'NAK' };
  }

  // Deps expostas aos executores (ctx.deps) — o worker injeta as suas.
  const runtimeDeps = { ...(deps.execDeps || {}), prisma };

  // ── Semáforo de concorrência ──────────────────────────────────────────────
  let active = 0;
  const waiters = [];
  async function acquireSlot() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiters.push(resolve));
    active += 1;
  }
  function releaseSlot() {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  // ── Loop de consumo (produção) ────────────────────────────────────────────
  async function start() {
    if (!js) throw new Error(`worker ${name}: js é obrigatório para start()`);
    running = true;
    if (jsm) {
      const natsStream = require('../../nats-stream');
      await natsStream.ensureStream(jsm);
      const def = [...executors.keys()].map((k) => capabilities.getCapability(k)).filter(Boolean);
      const maxTimeout = def.reduce((acc, d) => Math.max(acc, d.timeoutMs), 30000);
      await natsStream.ensurePullConsumer(jsm, {
        stream: effectiveStream,
        durable: effectiveDurable,
        filterSubject: effectiveFilter,
        ackWaitMs: Math.round(maxTimeout * 1.3) + 5000,
        maxDeliver: 10,
      });
    }
    // API posicional (nats 2.x): get(stream, durableName) → PullConsumer
    const consumer = await js.consumers.get(effectiveStream, effectiveDurable);
    baseLogger.info(`[worker:${name}] consumindo ${effectiveFilter} (durable=${effectiveDurable})`);

    (async function loop() {
      while (running) {
        try {
          const msgs = await consumer.fetch({ max_messages: fetchBatch, expires: fetchExpiresMs });
          for await (const m of msgs) {
            if (!running) break;
            const p = processMessage(m)
              .catch((err) => baseLogger.error(`[worker:${name}] erro no processamento: ${err.message}`));
            inFlight.add(p);
            p.finally(() => inFlight.delete(p));
          }
        } catch (err) {
          if (running && !(String(err.message).match(/timeout|nothing/i))) {
            baseLogger.error(`[worker:${name}] erro no loop: ${err.message}`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    })();
  }

  /** Graceful drain: para o fetch, espera tasks em voo (até drainTimeoutMs). */
  async function stop() {
    running = false;
    const deadline = Date.now() + drainTimeoutMs;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.all([...inFlight]), new Promise((r) => setTimeout(r, 100))]);
    }
  }

  return {
    start,
    stop,
    processMessage,
    registerExecutors,
    registerExecutorsForTest: registerExecutors,
    setPublisherForTest,
    setRegistryForTest,
    setRawStoreForTest,
    get isRunning() {
      return running;
    },
  };
}

module.exports = { createWorkerRuntime };
