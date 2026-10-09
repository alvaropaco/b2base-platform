// =============================================================================
// enrichment-manager.js — ciclo de vida do job de enriquecimento (spec US1+).
//
// Responsabilidades (único escritor do estado de job/task):
//   1. createJob: cria o job com snapshot do plano e planeja as tasks
//      (entidade × capability elegível) — gating por plano via catálogo.
//   2. publish: despacha tasks QUEUED no barramento (contratos v1, headers de
//      correlação, Nats-Msg-Id por tentativa).
//   3. handleResult: consome enrichment.result.v1 — atualiza task, aplica fatos
//      no Prospect (merge idempotente por capability) e conclui o job
//      (COMPLETED | PARTIAL | FAILED) publicando enrichment.job.completed.v1.
//   4. Retry: falha transiente → task RETRY → re-publicação com attempt+1 e
//      `notBefore` (backoff crescente — FR-010); permanente → FAILED.
//
// Workers NUNCA chamam o manager: toda a comunicação é pelo barramento.
// Todos os métodos recebem deps injetáveis (prisma/js fake nos testes).
// =============================================================================

const { randomUUID } = require('crypto');
const contracts = require('./enrichment-contracts');
const idempotency = require('./workers/sdk/idempotency');
const defaultConfig = require('./enrichment-config');
const defaultCapabilities = require('./enrichment-capabilities');

// Status em que a task ainda pode receber eventos (não-terminal).
const ACTIVE_STATUSES = ['PENDING', 'QUEUED', 'RUNNING', 'RETRY', 'TIMEOUT', 'BLOCKED'];

function nowIso() {
  return new Date().toISOString();
}

/** Input base da task por capability, derivado do prospect (v1: entidade raiz). */
function buildCapabilityInput(capability, prospect) {
  const domain = prospect.domain || null;
  const cnpj = prospect.cnpj || null;
  switch (capability) {
    case 'identity.cnpj.basic':
    case 'company.deepgraph':
      return cnpj ? { cnpj } : null;
    case 'identity.cnpj.resolve':
      return prospect.companyName
        ? { companyName: prospect.companyName, city: prospect.city || undefined, state: prospect.state || undefined }
        : null;
    case 'identity.domain.verify':
    case 'company.logo':
      return domain ? { domain } : null;
    case 'company.digital_presence':
      // Sem domínio no cadastro, o worker DESCOBRE pelo nome (searxng) — e
      // desde 2026-10-09 a descoberta multi-fonte usa fantasia + UF para
      // buscar o WhatsApp de quem não tem site (catálogo digital, snippets).
      return domain
        ? { domain, tradeName: prospect.tradeName || undefined, state: prospect.state || undefined }
        : (prospect.companyName
          ? { companyName: prospect.companyName, tradeName: prospect.tradeName || undefined, state: prospect.state || undefined }
          : null);
    case 'company.profile.deep':
      return prospect.companyName
        ? { companyName: prospect.companyName, domain: domain || undefined }
        : null;
    case 'search.news':
    case 'search.legal':
      return prospect.companyName ? { companyName: prospect.companyName } : null;
    default:
      return null;
  }
}

function createEnrichmentManager(deps = {}) {
  const {
    prisma,
    js = null, // adapter de publicação: publish(subject, dataBuffer, {headers planos})
    getOrgPlan,
    capabilities = defaultCapabilities,
    contracts: c = contracts,
    config = defaultConfig,
    logger = console,
    now = () => new Date(),
    onEvent = () => {}, // gancho de métricas (US8)
    assertQuota = null, // guard de cota mensal (US3) — injetável
    onFailureReal = null, // feature 006: falha REAL (não-transiente) para notificação
  } = deps;

  // ── Publicação ────────────────────────────────────────────────────────────
  async function publishTaskMessage(task, { attempt, notBefore = null } = {}) {
    if (!js) return false;
    const def = capabilities.getCapability(task.capability);
    const message = {
      version: c.VERSION,
      taskId: task.id,
      taskKey: task.taskKey,
      jobId: task.jobId,
      orgId: task.orgId,
      prospectId: task.prospectId,
      entityKey: task.entityKey,
      entityType: task.entityType,
      capability: task.capability,
      provider: task.provider || null,
      input: task.input,
      priority: task.priority,
      attempt,
      maxAttempts: task.maxAttempts,
      timeoutMs: task.timeoutMs,
      depth: task.depth,
      spawnedByTaskId: task.spawnedByTaskId || null,
      notBefore,
      createdAt: nowIso(),
      traceparent: c.makeTraceparent(),
    };
    c.validateTaskPayload(message);
    await js.publish(c.taskSubject(task.capability), c.serializePayload(message), {
      headers: c.buildTaskHeaders({ ...message }),
      timeout: 5000,
    });
    onEvent('task.published', { capability: task.capability, attempt });
    return true;
  }

  /** Publica todas as tasks QUEUED do job (ordem de prioridade — planejamento em lote). */
  async function publishQueuedTasks(jobId) {
    const tasks = await prisma.enrichmentTask.findMany({ where: { jobId, status: 'QUEUED' } });
    tasks.sort((a, b) => a.priority - b.priority || a.capability.localeCompare(b.capability));
    for (const task of tasks) {
      const attempt = (task.attempt || 0) + 1;
      await publishTaskMessage(task, { attempt });
      await prisma.enrichmentTask.update({ where: { id: task.id }, data: { attempt } });
    }
    return tasks.length;
  }

  // ── Planejamento ──────────────────────────────────────────────────────────
  async function planTasks(job, prospect) {
    const eligible = capabilities.eligibleCapabilities({ plan: job.plan });
    // v1: entidade raiz única (prospect). Entidades derivadas (pessoas,
    // domínios) nascem da expansão dinâmica (US5) via suggestedTasks.
    const entities = [{ entityKey: `prospect:${prospect.id}`, entityType: 'prospect' }];
    const created = [];
    for (const entity of entities) {
      for (const capabilityName of eligible) {
        const def = capabilities.getCapability(capabilityName);
        const input = buildCapabilityInput(capabilityName, prospect);
        // Sem input mínimo viável, a capability não é planejada para este lead
        // (ex.: sem CNPJ → identity.cnpj.basic não nasce).
        if (!input || !def.validateInput(input).ok) continue;
        const taskKey = idempotency.computeTaskKey({
          orgId: job.orgId,
          jobId: job.id,
          entityKey: entity.entityKey,
          capability: capabilityName,
          provider: null,
          input,
        });
        const task = await prisma.enrichmentTask.upsert({
          where: { taskKey },
          create: {
            orgId: job.orgId,
            jobId: job.id,
            prospectId: job.prospectId,
            taskKey,
            entityKey: entity.entityKey,
            entityType: entity.entityType,
            capability: capabilityName,
            provider: null,
            input,
            inputHash: idempotency.hashInput(input),
            status: 'QUEUED',
            priority: def.priority,
            maxAttempts: def.maxAttempts,
            timeoutMs: def.timeoutMs,
            attempt: 0,
            depth: 0,
            dependsOn: [],
          },
          update: {}, // idempotente: replanejar não duplica nem reseta (FR-008)
        });
        created.push(task);
      }
    }
    created.sort((a, b) => a.priority - b.priority || a.capability.localeCompare(b.capability));
    return created;
  }

  // ── Conclusão do job ──────────────────────────────────────────────────────
  async function computeCounts(jobId) {
    const tasks = await prisma.enrichmentTask.findMany({ where: { jobId } });
    const counts = {
      total: tasks.length, completed: 0, failed: 0, cancelled: 0,
      pending: 0, queued: 0, running: 0, retry: 0, timeout: 0, blocked: 0, skipped: 0,
    };
    for (const t of tasks) {
      const key = t.status.toLowerCase();
      if (counts[key] === undefined) counts.pending += 1;
      else counts[key] += 1;
    }
    return { tasks, counts };
  }

  async function maybeFinalizeJob(jobId) {
    const { tasks, counts } = await computeCounts(jobId);
    const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));
    if (active.length > 0) return null;

    // Feature 006 (FR-009): só tasks PARKED restantes → job DEGRADED
    // (aguardando provedor) — NÃO-terminal: refinaliza quando concluírem.
    const parked = tasks.filter((t) => t.status === 'PARKED');
    if (parked.length > 0) {
      const current = await prisma.enrichmentJob.findUnique({ where: { id: jobId } });
      if (current && current.status === 'DEGRADED') return null; // já refletido
      const job = await prisma.enrichmentJob.update({
        where: { id: jobId },
        data: { status: 'DEGRADED', completedAt: null },
      });
      onEvent('job.degraded', { capability: '*', status: 'DEGRADED', parked: parked.length });
      return { ...job, degraded: true };
    }

    const completed = counts.completed;
    const failed = counts.failed;
    let status;
    if (completed > 0 && failed === 0) status = 'COMPLETED';
    else if (completed === 0 && failed > 0) status = 'FAILED';
    else status = 'PARTIAL'; // sucessos + falhas, ou só canceladas/skipped
    const completionPct = counts.total ? Math.round((completed / counts.total) * 1000) / 10 : 0;

    const job = await prisma.enrichmentJob.update({
      where: { id: jobId },
      data: {
        status,
        completedAt: now(),
        lastError: status === 'FAILED' ? { type: 'JOB_FAILED', message: 'todas as tasks falharam' } : null,
      },
    });
    if (js) {
      await js.publish(
        c.JOB_COMPLETED_SUBJECT,
        c.serializePayload({
          version: c.VERSION,
          jobId: job.id,
          orgId: job.orgId,
          prospectId: job.prospectId,
          status,
          counts,
          completionPct,
          completedAt: nowIso(),
        }),
        { headers: { 'X-Org-Id': job.orgId, 'X-Job-Id': job.id }, timeout: 5000 }
      );
    }
    onEvent('job.completed', { capability: '*', status });
    return job;
  }

  // ── Criação do job ────────────────────────────────────────────────────────
  async function createJob({ orgId, prospectId, trigger = 'api' }) {
    const plan = await getOrgPlan(prisma, orgId);
    const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });
    if (!prospect || prospect.orgId !== orgId) {
      const err = new Error('prospect não encontrado nesta organização');
      err.code = 'PROSPECT_NOT_FOUND';
      throw err;
    }
    // Cota mensal por organização (FR-031): guard injetável; o singleton
    // instala o guard default (contagem de jobs no mês).
    if (assertQuota) await assertQuota({ orgId, plan });

    const job = await prisma.enrichmentJob.create({
      data: { orgId, prospectId, status: 'PENDING', trigger, plan, engine: 'v2' },
    });
    const tasks = await planTasks(job, prospect);

    if (tasks.length === 0) {
      // Edge case da spec: nada aplicável → concluído-sem-resultados, nunca pendente.
      const emptyJob = await prisma.enrichmentJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          startedAt: now(),
          completedAt: now(),
          lastError: { type: 'NO_TASKS', message: 'nenhuma capability elegível com os dados do lead' },
        },
      });
      if (js) {
        await js.publish(
          c.JOB_COMPLETED_SUBJECT,
          c.serializePayload({
            version: c.VERSION, jobId: emptyJob.id, orgId, prospectId,
            status: 'COMPLETED', counts: { total: 0, completed: 0, failed: 0 },
            completionPct: 0, completedAt: nowIso(),
          }),
          { headers: { 'X-Org-Id': orgId, 'X-Job-Id': emptyJob.id }, timeout: 5000 }
        );
      }
      return { job: emptyJob, tasks: [] };
    }

    const runningJob = await prisma.enrichmentJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', startedAt: now() },
    });
    await publishQueuedTasks(job.id);
    return { job: runningJob, tasks };
  }

  // ── Criação de tasks (planejamento, expansão e suggestedTasks) ───────────
  // Upsert idempotente por taskKey; publicação é responsabilidade do caller.
  async function createTask({ job, capability, entityKey, entityType, input, dependsOn = [], depth = 0, spawnedByTaskId = null, priority } = {}) {
    const def = capabilities.getCapability(capability);
    if (!def) return { created: false, reason: 'CAPABILITY_UNKNOWN' };
    if (!def.enabled) return { created: false, reason: 'CAPABILITY_DISABLED' };
    const inputCheck = def.validateInput(input);
    if (!inputCheck.ok) return { created: false, reason: 'INVALID_INPUT', message: inputCheck.message };
    const taskKey = idempotency.computeTaskKey({
      orgId: job.orgId, jobId: job.id, entityKey, capability, provider: null, input,
    });
    const existing = await prisma.enrichmentTask.findUnique({ where: { taskKey } });
    if (existing) return { created: false, task: existing, reason: 'DUPLICATE' };
    const task = await prisma.enrichmentTask.create({
      data: {
        orgId: job.orgId,
        jobId: job.id,
        prospectId: job.prospectId,
        taskKey,
        entityKey,
        entityType: entityType || def.entityType[0],
        capability,
        provider: null,
        input,
        inputHash: idempotency.hashInput(input),
        status: dependsOn.length ? 'BLOCKED' : 'QUEUED',
        priority: priority != null ? priority : def.priority,
        maxAttempts: def.maxAttempts,
        timeoutMs: def.timeoutMs,
        depth,
        spawnedByTaskId,
        dependsOn,
      },
    });
    return { created: true, task };
  }

  /** Input da task expandida derivado do fato que a disparou. */
  function spawnInput(capability, originTask, factValue) {
    switch (capability) {
      case 'identity.domain.verify':
      case 'company.logo':
        return { domain: String(factValue) };
      case 'identity.cnpj.basic':
        return { cnpj: String(factValue) };
      case 'search.news':
      case 'search.legal':
        return { companyName: originTask.input.companyName || originTask.input.domain || String(factValue) };
      default:
        return { value: factValue };
    }
  }

  function factValueFrom(result, attributeName) {
    const fact = (result.facts || []).find((f) => f.attribute === attributeName);
    if (fact) return fact.value;
    if (result.data && attributeName in result.data) return result.data[attributeName];
    return undefined;
  }

  async function jobTaskCount(jobId) {
    return (await prisma.enrichmentTask.findMany({ where: { jobId } })).length;
  }

  async function refuse(reason, detail) {
    onEvent('task.expansion_refused', { reason, ...detail });
    logger.warn(`[enrichment-manager] expansão recusada (${reason}): ${JSON.stringify(detail)}`);
  }

  // ── Desbloqueio de dependentes (DAG mínimo — FR-012) ──────────────────────
  async function unblockDependents(task, result) {
    const blocked = await prisma.enrichmentTask.findMany({ where: { jobId: task.jobId, status: 'BLOCKED' } });
    const dependents = blocked.filter((t) => (t.dependsOn || []).includes(task.id));
    for (const dependent of dependents) {
      const depTasks = await Promise.all(dependent.dependsOn.map((id) => prisma.enrichmentTask.findUnique({ where: { id } })));
      const failedDep = depTasks.find((d) => d && ['FAILED', 'CANCELLED'].includes(d.status));
      if (failedDep) {
        await prisma.enrichmentTask.update({
          where: { id: dependent.id },
          data: { status: 'CANCELLED', completedAt: now(), lastError: { type: 'DEPENDENCY_FAILED', message: `dependência ${failedDep.id} terminou em ${failedDep.status}` } },
        });
        onEvent('task.cancelled', { capability: dependent.capability });
        continue;
      }
      const allDone = depTasks.every((d) => d && d.status === 'COMPLETED');
      if (!allDone) continue; // aguardando demais dependências

      // Enriquece o input com os dados das dependências (input original vence).
      // Fonte primária: rows de EnrichmentResult (persistidas pelo worker);
      // fallback: o data do evento corrente (mesmo conteúdo, sem ir ao banco).
      const depResults = await Promise.all(dependent.dependsOn.map((id) => prisma.enrichmentResult.findUnique({ where: { taskId: id } })));
      const depData = Object.assign(
        {},
        ...depResults.map((r, i) => {
          if (r && r.data) return r.data;
          if (depTasks[i] && depTasks[i].id === result.taskId && result.data) return result.data;
          return {};
        })
      );
      const mergedInput = { ...depData, ...(dependent.input || {}) };
      const attempt = (dependent.attempt || 0) + 1;
      await prisma.enrichmentTask.update({
        where: { id: dependent.id },
        data: { status: 'QUEUED', input: mergedInput },
      });
      await publishTaskMessage({ ...dependent, input: mergedInput }, { attempt });
      await prisma.enrichmentTask.update({ where: { id: dependent.id }, data: { attempt } });
      onEvent('task.unblocked', { capability: dependent.capability });
    }
  }

  // ── Expansão dinâmica (regras declarativas + suggestedTasks — FR-013) ─────
  async function expandFromResult(task, result) {
    const job = await prisma.enrichmentJob.findUnique({ where: { id: task.jobId } });
    if (!job) return;

    async function trySpawn(capability, input, { entityType, entityKey, depth, spawnedByTaskId }) {
      const def = capabilities.getCapability(capability);
      if (!def || !def.enabled) {
        await refuse('CAPABILITY_UNAVAILABLE', { capability });
        return;
      }
      if (def.tier === 'premium' && job.plan !== 'premium') {
        await refuse('TIER_NOT_ALLOWED', { capability, plan: job.plan });
        return;
      }
      if (!def.validateInput(input).ok) {
        await refuse('INVALID_INPUT', { capability });
        return;
      }
      const maxTasks = config.MAX_TASKS_PER_JOB();
      if (await jobTaskCount(job.id) >= maxTasks) {
        await refuse('MAX_TASKS_PER_JOB', { capability, limit: maxTasks });
        return;
      }
      const maxDepth = config.MAX_DEPTH();
      if (depth > maxDepth) {
        await refuse('MAX_DEPTH', { capability, depth, limit: maxDepth });
        return;
      }
      const spawned = await createTask({
        job, capability, input,
        entityKey: entityKey || task.entityKey,
        entityType: entityType || task.entityType,
        depth,
        spawnedByTaskId,
      });
      if (!spawned.created) return; // duplicada — nada a publicar
      await publishTaskMessage(spawned.task, { attempt: 1 });
      await prisma.enrichmentTask.update({ where: { id: spawned.task.id }, data: { attempt: 1 } });
      onEvent('task.spawned', { capability });
    }

    // 1. Regras declarativas do catálogo (quando o result produz o fato).
    for (const rule of capabilities.expandRulesFor(task.capability)) {
      const value = factValueFrom(result, rule.whenFact);
      if (value === undefined) continue;
      await trySpawn(rule.spawn, spawnInput(rule.spawn, task, value), {
        depth: task.depth + 1,
        spawnedByTaskId: task.id,
      });
    }

    // 2. Sugestões declarativas do worker (validadas — worker nunca orquestra).
    for (const st of result.suggestedTasks || []) {
      await trySpawn(st.capability, st.input || {}, {
        entityType: st.entityType,
        entityKey: st.entityKey,
        depth: task.depth + 1,
        spawnedByTaskId: task.id,
      });
    }
  }

  // ── Consumo de resultados ─────────────────────────────────────────────────
  async function handleResult(result) {
    try {
      c.validateResultPayload(result);
    } catch (err) {
      logger.warn(`[enrichment-manager] result inválido ignorado: ${err.message}`);
      return { ignored: true };
    }
    const task = await prisma.enrichmentTask.findUnique({ where: { id: result.taskId } });
    // Guardas de integridade: task existente, mesmo org e mesmo job (cross-tenant → ignora).
    if (!task || task.orgId !== result.orgId || task.jobId !== result.jobId || task.taskKey !== result.taskKey) {
      logger.warn(`[enrichment-manager] result sem task correspondente (taskId=${result.taskId} orgId=${result.orgId})`);
      return { ignored: true };
    }
    if (!ACTIVE_STATUSES.includes(task.status)) {
      // Redelivery de result para task já terminal: idempotência — nada a fazer.
      return { duplicate: true };
    }

    if (result.status === 'COMPLETED') {
      await applyCompleted(task, result);
      // Expansão e desbloqueio ANTES de avaliar a conclusão: novas tasks
      // (QUEUED/BLOCKED) mantêm o job vivo.
      await unblockDependents(task, result);
      await expandFromResult(task, result);
    } else {
      await applyFailure(task, result);
      await unblockDependents(task, result); // falha pode cancelar dependentes
    }
    const finalized = await maybeFinalizeJob(task.jobId);
    return { ok: true, jobFinalized: finalized ? finalized.status : null };
  }

  async function applyCompleted(task, result) {
    await prisma.enrichmentTask.update({
      where: { id: task.id },
      data: {
        status: 'COMPLETED',
        completedAt: now(),
        provider: result.provider || task.provider,
        lastError: null,
      },
    });
    // Merge idempotente no perfil: mesma task já aplicada → não reaplica.
    const prospect = await prisma.prospect.findUnique({ where: { id: task.prospectId } });
    if (!prospect || prospect.orgId !== task.orgId) return;
    // Contatos do SITE (QA 2026-10-07: o dono reclamou que o enriquecimento
    // puxava só o fixo da Receita e ignorava o WhatsApp do site da empresa).
    // O WhatsApp extraído (wa.me/api.whatsapp.com) é o MELHOR número para
    // disparo → entra na FRENTE de cnpjPhones (o motor WA usa [0]); o
    // e-mail corporativo do site preenche a lacuna quando o CNPJ não traz.
    try {
      const dp = (result.data && result.data.digital_presence) || null;
      const waFromDp = dp && dp.whatsapp ? String(dp.whatsapp) : null;
      const waFromContacts = ((result.data && result.data.contacts) || [])
        .filter((c) => c && c.type === 'whatsapp' && c.value)
        .map((c) => String(c.value))[0] || null;
      const whatsappValue = waFromDp || waFromContacts;
      const updates = {};
      if (whatsappValue) {
        const digits = whatsappValue.replace(/\D/g, '');
        const current = Array.isArray(prospect.cnpjPhones) ? prospect.cnpjPhones.filter(Boolean) : [];
        const already = current.some((p) => String(p).replace(/\D/g, '') === digits);
        if (digits.length >= 10 && digits.length <= 13 && !already) {
          updates.cnpjPhones = [whatsappValue, ...current];
        }
      }
      const corpEmail = dp && dp.corporate_email ? String(dp.corporate_email) : null;
      if (corpEmail && !prospect.cnpjEmail) updates.cnpjEmail = corpEmail;
      if (Object.keys(updates).length > 0) {
        await prisma.prospect.update({ where: { id: prospect.id }, data: updates });
        Object.assign(prospect, updates);
        logger.info(`[enrichment-manager] contatos do site aplicados ao prospect ${prospect.id}: ${Object.keys(updates).join(', ')}`);
      }
    } catch (err) {
      logger.warn(`[enrichment-manager] contatos do site não aplicados ao prospect ${prospect.id}: ${err.message}`);
    }
    const summary = prospect.enrichmentSummary || {};
    const v2 = summary.v2 || {};
    const previous = v2[result.capability];
    if (previous && previous.taskId === result.taskId && previous.status === 'COMPLETED') return;

    v2[result.capability] = {
      entityKey: task.entityKey,
      status: 'COMPLETED',
      provider: result.provider || null,
      taskId: result.taskId,
      attempt: result.attempt || task.attempt,
      data: result.data || {},
      facts: (result.facts || []).map((f) => ({
        attribute: f.attribute,
        value: f.value,
        confidence: f.confidence ?? null,
        sourceType: f.evidence ? f.evidence.sourceType : null,
      })),
      appliedCount: (previous && previous.appliedCount ? previous.appliedCount : 0) + 1,
      updatedAt: nowIso(),
    };
    await prisma.prospect.update({
      where: { id: prospect.id },
      data: { enrichmentSummary: { ...summary, v2 } },
    });
    onEvent('task.completed', { capability: result.capability });
  }

  async function applyFailure(task, result) {
    const error = result.error || {};
    const type = error.type || 'INTERNAL';
    const retryable = error.retryable !== undefined
      ? Boolean(error.retryable)
      : c.isTransientError(type);

    if (retryable && task.attempt < task.maxAttempts) {
      const status = type === 'TIMEOUT' ? 'TIMEOUT' : 'RETRY';
      await prisma.enrichmentTask.update({
        where: { id: task.id },
        data: { status, lastError: { type, message: error.message || '', provider: result.provider || null, attempt: task.attempt } },
      });
      // Re-publicação com attempt+1 e notBefore (backoff crescente — FR-010).
      // Provider SEM pin: a próxima tentativa reavalia o failover do catálogo
      // inteiro (ex.: BrasilAPI 403 → espelho), em vez de re-escolher o
      // provider que acabou de falhar.
      const nextAttempt = task.attempt + 1;
      const delay = config.backoffDelayMs(task.attempt);
      await publishTaskMessage({ ...task, provider: null }, { attempt: nextAttempt, notBefore: new Date(now().getTime() + delay).toISOString() });
      await prisma.enrichmentTask.update({
        where: { id: task.id },
        data: { status: 'QUEUED', attempt: nextAttempt },
      });
      onEvent('task.retry', { capability: task.capability });
      return;
    }

    // Feature 006 (FR-001/FR-006): erro TRANSIENTE esgotado NUNCA termina
    // FAILED — entra em PARKED com agendamento para o sweeper re-publicar
    // (retryAfterMs do provedor ou plateau do backoff, o que for maior).
    if (retryable) {
      const retryAfterMs = Number(error.retryAfterMs) || 0;
      const plateau = config.backoffDelayMs(task.maxAttempts);
      const nextAttemptAt = new Date(now().getTime() + Math.max(retryAfterMs, plateau));
      const parkCycles = (task.parkCycles || 0) + 1;
      await prisma.enrichmentTask.update({
        where: { id: task.id },
        data: {
          status: 'PARKED',
          parkedAt: now(),
          parkCycles,
          nextAttemptAt,
          lastError: { type, message: error.message || '', provider: result.provider || null, attempt: task.attempt },
        },
      });
      await prisma.enrichmentTaskRetryEvent.create({
        data: {
          taskId: task.id,
          orgId: task.orgId,
          cycle: parkCycles,
          errorType: type,
          provider: result.provider || null,
          message: String(error.message || '').slice(0, 300),
          scheduledFor: nextAttemptAt,
        },
      });
      onEvent('task.parked', { capability: task.capability, provider: result.provider || null });
      return;
    }

    // Falha REAL: não-transiente (entrada inválida, recurso inexistente etc.)
    await prisma.enrichmentTask.update({
      where: { id: task.id },
      data: {
        status: 'FAILED',
        completedAt: now(),
        lastError: { type, message: error.message || '', provider: result.provider || null, attempt: task.attempt },
      },
    });
    if (typeof onFailureReal === 'function') {
      try {
        onFailureReal({
          taskId: task.id, orgId: task.orgId, jobId: task.jobId, prospectId: task.prospectId,
          capability: task.capability, errorType: type, message: error.message || '', provider: result.provider || null,
        });
      } catch (_e) { /* notificação nunca afeta o enriquecimento (FR-017) */ }
    }
    onEvent('task.failed', { capability: task.capability });
  }

  // ── Consultas (endpoints) ─────────────────────────────────────────────────
  async function getJobStatus(jobId, orgId) {
    const job = await prisma.enrichmentJob.findFirst({ where: { id: jobId, orgId } });
    if (!job) return null;
    const { counts } = await computeCounts(jobId);
    const tasks = await prisma.enrichmentTask.findMany({ where: { jobId } });
    const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status)).length;
    const completionPct = counts.total ? Math.round((counts.completed / counts.total) * 1000) / 10 : 0;
    return {
      jobId: job.id,
      status: job.status,
      trigger: job.trigger,
      plan: job.plan,
      counts,
      completionPct,
      activeTasks: active,
      tasks: tasks.map((t) => ({
        taskId: t.id,
        capability: t.capability,
        entityType: t.entityType,
        entityKey: t.entityKey,
        status: t.status,
        attempt: t.attempt,
        provider: t.provider,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        error: t.lastError,
      })),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

  async function getProspectFacts(prospectId, orgId) {
    const prospect = await prisma.prospect.findFirst({ where: { id: prospectId, orgId } });
    if (!prospect) return null;
    const v2 = (prospect.enrichmentSummary || {}).v2 || {};
    const entities = new Map();
    for (const [capability, entry] of Object.entries(v2)) {
      if (!entities.has(entry.entityKey)) {
        entities.set(entry.entityKey, { entityKey: entry.entityKey, entityType: entry.entityKey.split(':')[0], capabilities: {} });
      }
      entities.get(entry.entityKey).capabilities[capability] = entry;
    }
    return { prospectId, entities: [...entities.values()] };
  }

  // ── Fachada para o server-prod ────────────────────────────────────────────
  async function dispatchForProspect(prospect, { trigger = 'api' } = {}) {
    const { job } = await createJob({ orgId: prospect.orgId, prospectId: prospect.id, trigger });
    return job.id;
  }

  // ── Consumidor durável de resultados (T061 — boot real) ────────────────────
  // Sem isto, nada aplica os resultados publicados pelos workers em produção.
  // ack somente após handleResult; poison (ilegível) → term; erro → nak.
  let consumerRunning = false;

  async function processDelivery(msg) {
    let result;
    try {
      result = c.parsePayload(msg.data);
    } catch (_e) {
      await msg.term(); // payload ilegível = poison
      return;
    }
    try {
      await handleResult(result);
      await msg.ack();
    } catch (err) {
      logger.error(`[enrichment-manager] erro ao aplicar resultado ${result.taskId}: ${err.message}`);
      try { await msg.nak(); } catch (_e) { /* broker reentrega pelo ack_wait */ }
    }
  }

  async function startResultConsumer(options = {}) {
    const {
      consumer = null, // injetável (testes); produção conecta sozinha
      stream,
      durable = 'enrichment-manager',
      batch = 20,
      expiresMs = 4000,
    } = options;
    if (consumerRunning) return;
    consumerRunning = true;

    let target = consumer;
    if (!target) {
      const natsStream = require('./nats-stream');
      const nc = await natsStream.connectNats({ name: 'b2base-enrichment-manager-consumer' });
      const jsm = await nc.jetstreamManager();
      await natsStream.ensurePullConsumer(jsm, {
        stream: stream || natsStream.NATS_STREAM,
        durable,
        filterSubject: c.RESULT_SUBJECT,
        ackWaitMs: 30000,
        maxDeliver: 5,
      });
      target = await nc.jetstream().consumers.get(stream || natsStream.NATS_STREAM, durable);
    }
    logger.info(`[enrichment-manager] consumindo ${c.RESULT_SUBJECT} (durable=${durable})`);

    (async function loop() {
      while (consumerRunning) {
        try {
          const msgs = await target.fetch({ max_messages: batch, expires: expiresMs });
          for await (const m of msgs) {
            if (!consumerRunning) break;
            await processDelivery(m);
          }
        } catch (err) {
          if (consumerRunning && !String(err.message).match(/timeout|nothing/i)) {
            logger.error(`[enrichment-manager] erro no loop do consumer: ${err.message}`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
    })();
  }

  async function stopResultConsumer() {
    consumerRunning = false;
  }

  // ── Resincronização de tasks órfãs (recuperação de incidentes) ────────────
  // Dois modos de estrago cobertos (ambos observados em produção):
  //   a) worker morre entre marcar RUNNING e publicar o result (deploy/OOM)
  //      → task RUNNING eterna, job nunca conclui;
  //   b) js.publish falha no meio do lote (createJob/unblockDependents)
  //      → task QUEUED nunca publicada, job nunca conclui.
  //   c) result que desbloquearia dependência BLOCKED se perdeu → task
  //      BLOCKED eterna.
  //   d) watchdog de terminação: job RUNNING sem progresso além do limiar é
  //      finalizado à força — garantia de que NENHUM job trava para sempre.
  // Publicar antes de atualizar o banco: se o processo morrer entre os dois,
  // o sweep seguinte re-publica — inofensivo (Nats-Msg-Id dedup + handling
  // idempotente no worker/manager). taskKey/attempt idempotem o resto.
  async function resyncStalledTasks({ staleMs = config.STALE_TASK_MS() } = {}) {
    const cutoff = new Date(now().getTime() - staleMs);
    let reclaimed = 0;
    let failed = 0;
    let parked = 0;
    const affectedJobs = new Set();

    async function reclaim(task, { republishAttempt }) {
      if ((task.attempt || 0) >= task.maxAttempts) {
        // Feature 006 (FR-001): órfã com tentativas esgotadas NUNCA falha —
        // vai para PARKED e o sweeper re-publica após a janela.
        const parkedAt = now();
        const nextAttemptAt = new Date(parkedAt.getTime() + config.backoffDelayMs(task.maxAttempts));
        const parkCycles = (task.parkCycles || 0) + 1;
        await prisma.enrichmentTask.update({
          where: { id: task.id },
          data: {
            status: 'PARKED',
            parkedAt,
            parkCycles,
            nextAttemptAt,
            lastError: { type: 'ORPHANED', message: 'sem resultado após esgotar tentativas; PARKED pelo resync (006)', attempt: task.attempt },
          },
        });
        await prisma.enrichmentTaskRetryEvent.create({
          data: {
            taskId: task.id,
            orgId: task.orgId,
            cycle: parkCycles,
            errorType: 'ORPHANED',
            provider: task.provider || null,
            message: 'sem resultado após esgotar tentativas; PARKED pelo resync (006)',
            scheduledFor: nextAttemptAt,
          },
        });
        parked += 1;
      } else {
        await publishTaskMessage(task, { attempt: republishAttempt });
        await prisma.enrichmentTask.update({
          where: { id: task.id },
          data: {
            status: 'QUEUED',
            attempt: republishAttempt,
            ...(task.status === 'RUNNING'
              ? { lastError: { type: 'ORPHANED', message: 'worker morreu antes de publicar o resultado; task recuperada', attempt: task.attempt } }
              : {}),
          },
        });
        reclaimed += 1;
      }
      affectedJobs.add(task.jobId);
      onEvent('task.reclaimed', { capability: task.capability });
    }

    // a) RUNNING órfãs (worker sumiu) + RETRY/TIMEOUT presos (publish do
    //    retry falhou antes do segundo update em applyFailure).
    const staleActive = [
      ...(await prisma.enrichmentTask.findMany({ where: { status: 'RUNNING', startedAt: { lt: cutoff } } })),
      ...(await prisma.enrichmentTask.findMany({ where: { status: 'RETRY', updatedAt: { lt: cutoff } } })),
      ...(await prisma.enrichmentTask.findMany({ where: { status: 'TIMEOUT', updatedAt: { lt: cutoff } } })),
    ];
    for (const task of staleActive) {
      try {
        await reclaim(task, { republishAttempt: (task.attempt || 0) + 1 });
      } catch (err) {
        logger.warn(`[enrichment-manager] resync: falha ao recuperar task ${task.id}: ${err.message}`);
      }
    }

    // b) QUEUED publicada e perdida (attempt>0, sem result) ou nunca
    //    publicada (attempt=0 — publish falhou logo após a criação).
    const staleQueued = await prisma.enrichmentTask.findMany({ where: { status: 'QUEUED', updatedAt: { lt: cutoff } } });
    for (const task of staleQueued) {
      try {
        await reclaim(task, { republishAttempt: (task.attempt || 0) + 1 });
      } catch (err) {
        logger.warn(`[enrichment-manager] resync: falha ao re-publicar task ${task.id}: ${err.message}`);
      }
    }

    // c) BLOCKED órfãs: o result que dispararia unblockDependents se perdeu
    //    (worker ackou sem entregar o evento). Dependência falhou → cancela;
    //    todas concluídas → desbloqueia com input mesclado e publica.
    const staleBlocked = await prisma.enrichmentTask.findMany({ where: { status: 'BLOCKED', updatedAt: { lt: cutoff } } });
    for (const dependent of staleBlocked) {
      try {
        const depTasks = await Promise.all((dependent.dependsOn || []).map((id) => prisma.enrichmentTask.findUnique({ where: { id } })));
        const failedDep = depTasks.find((d) => d && ['FAILED', 'CANCELLED'].includes(d.status));
        if (failedDep) {
          await prisma.enrichmentTask.update({
            where: { id: dependent.id },
            data: { status: 'CANCELLED', completedAt: now(), lastError: { type: 'DEPENDENCY_FAILED', message: `dependência ${failedDep.id} terminou em ${failedDep.status}` } },
          });
          affectedJobs.add(dependent.jobId);
          continue;
        }
        if (depTasks.length && depTasks.every((d) => d && d.status === 'COMPLETED')) {
          const depResults = await Promise.all(dependent.dependsOn.map((id) => prisma.enrichmentResult.findUnique({ where: { taskId: id } })));
          const depData = Object.assign({}, ...depResults.filter(Boolean).map((r) => r.data || {}));
          const mergedInput = { ...depData, ...(dependent.input || {}) };
          const attempt = (dependent.attempt || 0) + 1;
          await publishTaskMessage({ ...dependent, input: mergedInput, provider: null }, { attempt });
          await prisma.enrichmentTask.update({ where: { id: dependent.id }, data: { status: 'QUEUED', input: mergedInput, attempt } });
          reclaimed += 1;
          affectedJobs.add(dependent.jobId);
          onEvent('task.unblocked', { capability: dependent.capability });
        }
      } catch (err) {
        logger.warn(`[enrichment-manager] resync: falha ao recuperar BLOCKED ${dependent.id}: ${err.message}`);
      }
    }

    // d) Reavalia conclusão dos jobs afetados e de qualquer job RUNNING sem
    //    task ativa (último result perdido → job sem ninguém para concluí-lo).
    //    Watchdog de terminação: job RUNNING sem NENHUM progresso de task por
    //    WATCHDOG_STALE_MS → cancela as tasks ativas restantes e finaliza.
    //    Última linha de defesa — nenhum job fica preso para sempre, seja qual
    //    for o modo de falha que o resync não antecipe.
    const watchdogCutoff = new Date(now().getTime() - config.WATCHDOG_STALE_MS());
    const runningJobs = await prisma.enrichmentJob.findMany({ where: { status: 'RUNNING' } });
    let watchdogJobs = 0;
    for (const job of runningJobs) {
      try {
        if (await maybeFinalizeJob(job.id)) continue;
        const { tasks } = await computeCounts(job.id);
        const lastProgress = tasks.reduce(
          (acc, t) => Math.max(acc, new Date(t.updatedAt || t.createdAt || 0).getTime()), 0
        );
        if (!lastProgress || lastProgress >= watchdogCutoff.getTime()) continue;
        for (const t of tasks) {
          if (!ACTIVE_STATUSES.includes(t.status)) continue;
          await prisma.enrichmentTask.update({
            where: { id: t.id },
            data: {
              status: 'CANCELLED',
              completedAt: now(),
              lastError: { type: 'WATCHDOG', message: 'job sem progresso; task cancelada pelo watchdog de terminação', attempt: t.attempt },
            },
          });
        }
        await maybeFinalizeJob(job.id);
        watchdogJobs += 1;
        onEvent('job.watchdog', { capability: '*' });
      } catch (err) {
        logger.warn(`[enrichment-manager] resync: falha ao reavaliar job ${job.id}: ${err.message}`);
      }
    }

    return { reclaimed, failed, parked, watchdogJobs, jobsReevaluated: runningJobs.length, affectedJobs: [...affectedJobs] };
  }

  // Feature 006: re-publicação de task PARKED pelo sweeper (mesmo subject/
  // payload do retry normal — nenhum contrato novo, R1).
  async function republishParkedTask(task, { attempt } = {}) {
    return publishTaskMessage(task, { attempt: attempt ?? (task.attempt || 0) + 1 });
  }

  return {
    createJob,
    planTasks,
    createTask,
    publishQueuedTasks,
    handleResult,
    resyncStalledTasks,
    republishParkedTask,
    maybeFinalizeJob,
    getJobStatus,
    getProspectFacts,
    dispatchForProspect,
    startResultConsumer,
    stopResultConsumer,
  };
}

// ── Singleton para o server-prod (lazy — não conecta no require) ───────────
let _default = null;

/** Adapter de publicação: converte headers planos para MsgHdrs do nats. */
function makeRealJsAdapter() {
  const natsStream = require('./nats-stream');
  return {
    async publish(subject, data, opts = {}) {
      const nc = await natsStream.connectNats({ name: 'b2base-enrichment-manager' });
      const js = nc.jetstream();
      const hdr = natsStream.headers();
      for (const [k, v] of Object.entries(opts.headers || {})) hdr.set(k, v);
      await js.publish(subject, data, { headers: hdr, timeout: opts.timeout || 5000 });
      return { seq: 0 };
    },
  };
}

/** Guard default de cota: nº de jobs da org no mês corrente × plano. */
async function defaultQuotaGuard(prisma, orgId, plan, config) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const used = await prisma.enrichmentJob.count({
    where: { orgId, createdAt: { gte: startOfMonth } },
  });
  if (used >= config.monthlyQuota(plan)) {
    const err = new Error(`Cota mensal de enriquecimento do plano ${plan} atingida (${used})`);
    err.code = 'ENRICHMENT_QUOTA_EXCEEDED';
    throw err;
  }
}

function getManager({ prisma, onFailureReal } = {}) {
  if (!_default) {
    const { getOrgPlan } = require('./plan');
    const { createLogger } = require('./logger');
    const config = require('./enrichment-config');
    _default = createEnrichmentManager({
      prisma,
      js: natsStream_enabled() ? makeRealJsAdapter() : null,
      getOrgPlan,
      logger: createLogger({ component: 'enrichment-manager' }),
      assertQuota: ({ orgId, plan }) => defaultQuotaGuard(prisma, orgId, plan, config),
      onFailureReal,
    });
    scheduleRawPrune(prisma, config);
    schedulePendingGauge(prisma);
    scheduleResync(prisma, config);
  }
  return _default;
}

/** Sweep periódico de tasks órfãs (worker morto / publish perdido) — resync. */
let _resyncScheduled = false;
function scheduleResync(prisma, config) {
  if (_resyncScheduled || !prisma) return;
  _resyncScheduled = true;
  const run = () => _default.resyncStalledTasks()
    .then((r) => {
      if (r.reclaimed || r.failed || r.watchdogJobs) {
        console.log(`[enrichment] resync: ${r.reclaimed} tasks re-publicadas, ${r.failed} encerradas, ${r.watchdogJobs} jobs finalizados pelo watchdog (${r.affectedJobs.length} jobs afetados)`);
      }
    })
    .catch((err) => console.error(`[enrichment] resync falhou: ${err.message}`));
  setInterval(run, config.RESYNC_INTERVAL_MS()).unref();
  setTimeout(run, 30 * 1000).unref();
}

/** Gauge de pendência por capability (US8/FR-034) — base p/ autoscaling futuro. */
let _pendingScheduled = false;
function schedulePendingGauge(prisma) {
  if (_pendingScheduled || !prisma) return;
  _pendingScheduled = true;
  const metrics = require('./metrics');
  if (!metrics.isEnabled()) return;
  const run = () => metrics.refreshEnrichmentPendingMetrics(prisma)
    .catch((err) => console.error(`[enrichment] pending gauge falhou: ${err.message}`));
  setInterval(run, 30 * 1000).unref();
  setTimeout(run, 5 * 1000).unref();
}

/** Retenção de brutos (FR-027): limpeza diária dos RawRecords vencidos. */
let _pruneScheduled = false;
function scheduleRawPrune(prisma, config) {
  if (_pruneScheduled || !prisma) return;
  _pruneScheduled = true;
  const { createRawStore } = require('./raw-store');
  const rawStore = createRawStore({ prisma, config });
  const run = () => rawStore.prune(config.RAW_RETENTION_DAYS())
    .then((n) => { if (n) console.log(`[enrichment] raw-store: ${n} brutos expirados removidos`); })
    .catch((err) => console.error(`[enrichment] raw-store prune falhou: ${err.message}`));
  setInterval(run, 24 * 3600 * 1000).unref();
  setTimeout(run, 60 * 1000).unref();
}

function natsStream_enabled() {
  try {
    return require('./nats-stream').isNatsEnabled();
  } catch (_e) {
    return false;
  }
}

module.exports = { createEnrichmentManager, getManager, buildCapabilityInput, ACTIVE_STATUSES, randomUUID };
