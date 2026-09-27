/**
 * metrics.js — endpoint Prometheus (/metrics) para monitorar outreach e
 * disparo de campanhas.
 *
 * Expõe:
 *   - b2base_queue_jobs{queue,state}          profundidade das filas Bull
 *   - b2base_outreach_emails_sent_total       emails enviados (counter)
 *   - b2base_outreach_emails_failed_total     emails que falharam (counter)
 *   - b2base_outreach_emails_rate_limited_total  envios adiados por rate limit
 *   - b2base_whatsapp_messages_sent_total     WhatsApp enviado (counter)
 *   - b2base_whatsapp_messages_failed_total   WhatsApp falhou (counter)
 *   - b2base_outreach_messages{status}        total por status (Postgres)
 *   - b2base_whatsapp_messages{status}        total por status (Postgres)
 *   - process_* e nodejs_*                    métricas padrão do runtime
 *
 * O servidor de métricas roda em METRICS_PORT (default 9090), separado do
 * app (3001), para não expor /metrics no ingress público.
 *
 * O require do prom-client é defensivo: se a dependência não estiver
 * instalada, o módulo vira um no-op e o app continua subindo normalmente.
 */
const http = require('http');

let client = null;
try {
  client = require('prom-client');
} catch (_) {
  client = null;
}
const enabled = Boolean(client);

const registry = enabled ? new client.Registry() : null;
if (registry) registry.setDefaultLabels({ app: 'b2base' });

const QUEUE_NAMES = [
  'outreach:prepare',
  'outreach:message-send',
  'outreach:gmail-sync',
  'whatsapp:sequence',
  'whatsapp:send',
];

const queueJobsGauge = enabled
  ? new client.Gauge({
      name: 'b2base_queue_jobs',
      help: 'Número de jobs Bull por fila e estado',
      labelNames: ['queue', 'state'],
      registers: [registry],
    })
  : null;

const emailsSentTotal = enabled
  ? new client.Counter({
      name: 'b2base_outreach_emails_sent_total',
      help: 'Emails de outreach enviados com sucesso',
      registers: [registry],
    })
  : null;
const emailsFailedTotal = enabled
  ? new client.Counter({
      name: 'b2base_outreach_emails_failed_total',
      help: 'Emails de outreach que falharam',
      registers: [registry],
    })
  : null;
const emailsRateLimitedTotal = enabled
  ? new client.Counter({
      name: 'b2base_outreach_emails_rate_limited_total',
      help: 'Envios de email adiados por rate limit',
      registers: [registry],
    })
  : null;
const whatsappSentTotal = enabled
  ? new client.Counter({
      name: 'b2base_whatsapp_messages_sent_total',
      help: 'Mensagens WhatsApp enviadas com sucesso',
      registers: [registry],
    })
  : null;
const whatsappFailedTotal = enabled
  ? new client.Counter({
      name: 'b2base_whatsapp_messages_failed_total',
      help: 'Mensagens WhatsApp que falharam',
      registers: [registry],
    })
  : null;

// ── Governança de template / composição (007) ───────────────────────────────
const compositionOriginTotal = enabled
  ? new client.Counter({
      name: 'b2base_outreach_composition_origin_total',
      help: 'Mensagens de campanha por origem de composição (template do tenant, IA, fallback)',
      labelNames: ['channel', 'origin'],
      registers: [registry],
    })
  : null;
const campaignReviewTotal = enabled
  ? new client.Counter({
      name: 'b2base_whatsapp_campaign_review_total',
      help: 'Ações de saneamento/revalidação de campanhas retidas',
      labelNames: ['action'],
      registers: [registry],
    })
  : null;
const aiCampaignApprovalsTotal = enabled
  ? new client.Counter({
      name: 'b2base_ai_campaign_approvals_total',
      help: 'Aprovações da mensagem base de campanhas IA',
      labelNames: ['result'],
      registers: [registry],
    })
  : null;

const outreachMessagesGauge = enabled
  ? new client.Gauge({
      name: 'b2base_outreach_messages',
      help: 'Total de mensagens de outreach por status (Postgres)',
      labelNames: ['status'],
      registers: [registry],
    })
  : null;
const whatsappMessagesGauge = enabled
  ? new client.Gauge({
      name: 'b2base_whatsapp_messages',
      help: 'Total de mensagens WhatsApp por status (Postgres)',
      labelNames: ['status'],
      registers: [registry],
    })
  : null;

if (enabled) {
  client.collectDefaultMetrics({ register: registry });
}

function inc(counter) {
  if (counter) counter.inc();
}

/** 007: origem de composição de mensagem de campanha (canal + origem). */
function incCompositionOrigin(channel, origin) {
  if (compositionOriginTotal) compositionOriginTotal.inc({ channel, origin });
}

/** 007: ação de saneamento/revalidação (detected | rederived | edited). */
function incCampaignReview(action) {
  if (campaignReviewTotal) campaignReviewTotal.inc({ action });
}

/** 007: resultado da aprovação de campanha IA (launched | launched_with_errors). */
function incAiCampaignApproval(result) {
  if (aiCampaignApprovalsTotal) aiCampaignApprovalsTotal.inc({ result });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('metrics timeout')), ms)),
  ]);
}

/** Atualiza os gauges de profundidade de fila a partir do Redis (Bull). */
async function refreshQueueMetrics() {
  if (!queueJobsGauge) return;
  const { getQueues } = require('./outreach-queues');
  const { getWhatsAppQueues } = require('./whatsapp-queues');

  let queues = {};
  try {
    const q = getQueues();
    const wq = getWhatsAppQueues();
    queues = {
      'outreach:prepare': q.prepare,
      'outreach:message-send': q.send,
      'outreach:gmail-sync': q.gmailSync,
      'whatsapp:sequence': wq.sequence,
      'whatsapp:send': wq.send,
    };
  } catch (_) {
    return;
  }

  for (const [name, q] of Object.entries(queues)) {
    if (!q) continue;
    try {
      const counts = await withTimeout(q.getJobCounts(), 3000);
      for (const [state, n] of Object.entries(counts)) {
        queueJobsGauge.set({ queue: name, state }, Number(n) || 0);
      }
    } catch (_) {
      // Redis indisponível — mantém o último valor.
    }
  }
}

/** Atualiza os gauges de total por status a partir do Postgres. */
async function refreshDbMetrics(prisma) {
  if (!prisma || !outreachMessagesGauge) return;
  try {
    const [emailRows, waRows] = await Promise.all([
      prisma.outreachMessage.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.whatsAppMessage.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    outreachMessagesGauge.reset();
    for (const r of emailRows) {
      outreachMessagesGauge.set({ status: r.status }, r._count._all);
    }

    whatsappMessagesGauge.reset();
    for (const r of waRows) {
      whatsappMessagesGauge.set({ status: r.status }, r._count._all);
    }
  } catch (_) {
    // Postgres indisponível — mantém o último valor.
  }
}

async function renderMetrics(prisma) {
  await refreshQueueMetrics();
  await refreshDbMetrics(prisma);
  return registry.metrics();
}

/** Sobe o servidor HTTP de métricas em METRICS_PORT (default 9090). */
function startMetricsServer(prisma) {
  if (!enabled) {
    console.warn('[metrics] prom-client não instalado — /metrics desabilitado (rode `pnpm add prom-client`).');
    return null;
  }

  const port = Number(process.env.METRICS_PORT || 9090);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics' || req.url === '/') {
      try {
        const body = await renderMetrics(prisma);
        res.writeHead(200, { 'Content-Type': registry.contentType });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('metrics error');
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[metrics] /metrics em http://0.0.0.0:${port}`);
  });
  return server;
}

// ── Métricas do motor de enriquecimento distribuído (spec US8) ──────────────
const enrichmentTasksGauge = enabled
  ? new client.Gauge({
      name: 'b2base_enrichment_tasks',
      help: 'Tasks do motor de enriquecimento por capability e estado',
      labelNames: ['capability', 'state'],
      registers: [registry],
    })
  : null;
const enrichmentDurationHist = enabled
  ? new client.Histogram({
      name: 'b2base_enrichment_task_duration_seconds',
      help: 'Duração da execução de tasks por capability',
      labelNames: ['capability'],
      registers: [registry],
    })
  : null;
const providerRequestsTotal = enabled
  ? new client.Counter({
      name: 'b2base_enrichment_provider_requests_total',
      help: 'Chamadas a providers por resultado (ok/error/rejected)',
      labelNames: ['provider', 'outcome'],
      registers: [registry],
    })
  : null;
const providerStateGauge = enabled
  ? new client.Gauge({
      name: 'b2base_enrichment_provider_state',
      help: 'Estado do circuit breaker por provider (1 = estado vigente)',
      labelNames: ['provider', 'state'],
      registers: [registry],
    })
  : null;
const enrichmentPendingGauge = enabled
  ? new client.Gauge({
      name: 'b2base_enrichment_tasks_pending',
      help: 'Tasks pendentes/em voo por capability (base para autoscaling futuro)',
      labelNames: ['capability'],
      registers: [registry],
    })
  : null;
const qualificationTotal = enabled
  ? new client.Counter({
      name: 'b2base_enrichment_qualification_total',
      help: 'Recalques de score executados pelo consumidor de qualificação',
      registers: [registry],
    })
  : null;
const qualificationFailures = enabled
  ? new client.Counter({
      name: 'b2base_enrichment_qualification_failures_total',
      help: 'Falhas do consumidor de qualificação (isoladas do enriquecimento)',
      registers: [registry],
    })
  : null;

const _lastProviderState = new Map(); // provider → estado vigente (para zerar o anterior)

function setEnrichmentTaskState(capability, state, count) {
  if (enrichmentTasksGauge) enrichmentTasksGauge.set({ capability, state }, count);
}
function observeEnrichmentTaskDuration(capability, seconds) {
  if (enrichmentDurationHist) enrichmentDurationHist.observe({ capability }, seconds);
}
function incEnrichmentProviderRequest(provider, outcome) {
  if (providerRequestsTotal) providerRequestsTotal.inc({ provider, outcome });
}
function setEnrichmentProviderState(provider, state) {
  if (!providerStateGauge) return;
  const previous = _lastProviderState.get(provider);
  if (previous && previous !== state) {
    providerStateGauge.set({ provider, state: previous }, 0);
  }
  providerStateGauge.set({ provider, state }, 1);
  _lastProviderState.set(provider, state);
}
function setEnrichmentPending(capability, count) {
  if (enrichmentPendingGauge) enrichmentPendingGauge.set({ capability }, count);
}
function incQualificationTotal() {
  if (qualificationTotal) qualificationTotal.inc();
}
function incQualificationFailure() {
  if (qualificationFailures) qualificationFailures.inc();
}

/** Pendência por capability (groupby de tasks ativas) — chamada em intervalo. */
async function refreshEnrichmentPendingMetrics(prisma) {
  if (!enabled || !prisma || !prisma.enrichmentTask) return;
  const groups = await prisma.enrichmentTask.groupBy({
    by: ['capability'],
    where: { status: { in: ['PENDING', 'QUEUED', 'RUNNING', 'RETRY', 'TIMEOUT', 'BLOCKED'] } },
    _count: { _all: true },
  });
  for (const g of groups) {
    enrichmentPendingGauge.set({ capability: g.capability }, g._count._all);
  }
}

/** Renderiza apenas o registro (sem refresh de filas/DB — seguro em testes). */
async function renderEnrichmentMetrics() {
  return registry.metrics();
}

// ============================================================================
// DISCOVERY ENGINE (specs/006-discovery-engine) — T003
// ============================================================================
const discoveryJobsTotal = enabled
  ? new client.Counter({
      name: 'b2base_discovery_jobs_total',
      help: 'Jobs de discovery finalizados por status (completed/partial/failed/cancelled)',
      labelNames: ['status'],
      registers: [registry],
    })
  : null;
const discoveryProviderRunsTotal = enabled
  ? new client.Counter({
      name: 'b2base_discovery_provider_runs_total',
      help: 'Runs de provider de discovery por resultado (completed/failed/skipped)',
      labelNames: ['provider', 'outcome'],
      registers: [registry],
    })
  : null;
const discoveryProviderDuration = enabled
  ? new client.Histogram({
      name: 'b2base_discovery_provider_duration_seconds',
      help: 'Latência de execução de provider de discovery',
      labelNames: ['provider'],
      registers: [registry],
    })
  : null;
const discoveryCandidatesTotal = enabled
  ? new client.Counter({
      name: 'b2base_discovery_candidates_total',
      help: 'Candidatos de discovery upsertados (dedup por dedupeKey)',
      registers: [registry],
    })
  : null;
const discoveryEvidenceTotal = enabled
  ? new client.Counter({
      name: 'b2base_discovery_evidence_total',
      help: 'Evidências de discovery gravadas (dedup por rawHash)',
      registers: [registry],
    })
  : null;
const discoveryEstimatedCost = enabled
  ? new client.Counter({
      name: 'b2base_discovery_estimated_cost_total',
      help: 'Custo estimado acumulado de providers pagos (centavos)',
      registers: [registry],
    })
  : null;

function incDiscoveryJobFinished(status) {
  if (discoveryJobsTotal) discoveryJobsTotal.inc({ status });
}

function incDiscoveryProviderRun(provider, outcome) {
  if (discoveryProviderRunsTotal) discoveryProviderRunsTotal.inc({ provider, outcome });
}

function observeDiscoveryProviderDuration(provider, ms) {
  if (discoveryProviderDuration) discoveryProviderDuration.observe((Number(ms) || 0) / 1000);
}

function incDiscoveryCandidates(n = 1) {
  if (discoveryCandidatesTotal) discoveryCandidatesTotal.inc(Number(n) || 1);
}

function incDiscoveryEvidence(n = 1) {
  if (discoveryEvidenceTotal) discoveryEvidenceTotal.inc(Number(n) || 1);
}

function incDiscoveryEstimatedCost(centavos = 0) {
  const v = Number(centavos);
  if (discoveryEstimatedCost && v > 0) discoveryEstimatedCost.inc(v);
}

// ============================================================================
// ONBOARDING CONVERSACIONAL (Ava) — feature 004
// ============================================================================
const avaExtractDurationHist = enabled
  ? new client.Histogram({
      name: 'b2base_ava_extract_duration_seconds',
      help: 'Duração da extração de ativos da Ava (onboarding conversacional)',
      registers: [registry],
    })
  : null;
const avaExtractFilesTotal = enabled
  ? new client.Counter({
      name: 'b2base_ava_extract_files_total',
      help: 'Arquivos processados pela extração da Ava, por status (ok/failed/unsupported)',
      labelNames: ['status'],
      registers: [registry],
    })
  : null;
const avaExtractLlmFailures = enabled
  ? new client.Counter({
      name: 'b2base_ava_extract_llm_failures_total',
      help: 'Falhas de LLM na extração de ativos da Ava',
      registers: [registry],
    })
  : null;

function observeAvaExtractDuration(ms) {
  if (avaExtractDurationHist) avaExtractDurationHist.observe(ms / 1000);
}
function incAvaExtractFile(status) {
  if (avaExtractFilesTotal) avaExtractFilesTotal.inc({ status });
}
function incAvaExtractLlmFailure() {
  if (avaExtractLlmFailures) avaExtractLlmFailures.inc();
}

// ============================================================================
// ANÁLISE PROFUNDA DE LEAD POR IA — feature 005
// ============================================================================
const deepAnalysisStarted = enabled
  ? new client.Counter({
      name: 'b2base_deep_analysis_started_total',
      help: 'Análises profundas de lead iniciadas',
      registers: [registry],
    })
  : null;
const deepAnalysisCompleted = enabled
  ? new client.Counter({
      name: 'b2base_deep_analysis_completed_total',
      help: 'Análises profundas concluídas, por veredito (contact/no_contact)',
      labelNames: ['verdict'],
      registers: [registry],
    })
  : null;
const deepAnalysisFailed = enabled
  ? new client.Counter({
      name: 'b2base_deep_analysis_failed_total',
      help: 'Análises profundas que falharam, por motivo (timeout/invalid_result/llm_error/quota)',
      labelNames: ['reason'],
      registers: [registry],
    })
  : null;
const deepAnalysisDurationHist = enabled
  ? new client.Histogram({
      name: 'b2base_deep_analysis_duration_seconds',
      help: 'Duração da análise profunda (da criação da linha à aplicação do veredito)',
      registers: [registry],
    })
  : null;

// ============================================================================
// RESILIÊNCIA DO ENRIQUECIMENTO — feature 006
// ============================================================================
const enrichmentTasksParked = enabled
  ? new client.Gauge({
      name: 'b2base_enrichment_tasks_parked',
      help: 'Tasks de enriquecimento em PARKED (aguardando sweeper), por provedor e organização',
      labelNames: ['provider', 'orgId'],
      registers: [registry],
    })
  : null;
const enrichmentTasksParkedTotal = enabled
  ? new client.Counter({
      name: 'b2base_enrichment_tasks_parked_total',
      help: 'Total de entradas em PARKED, por provedor e organização',
      labelNames: ['provider', 'orgId'],
      registers: [registry],
    })
  : null;
const enrichmentTasksRepublishedTotal = enabled
  ? new client.Counter({
      name: 'b2base_enrichment_tasks_republished_total',
      help: 'Re-publicações do sweeper, por provedor',
      labelNames: ['provider'],
      registers: [registry],
    })
  : null;
const enrichmentParkExpiredTotal = enabled
  ? new client.Counter({
      name: 'b2base_enrichment_park_expired_total',
      help: 'Tasks que esgotaram a janela parked (falha real), por capability',
      labelNames: ['capability'],
      registers: [registry],
    })
  : null;
const enrichmentFailuresRealTotal = enabled
  ? new client.Counter({
      name: 'b2base_enrichment_failures_real_total',
      help: 'Falhas terminais não-transientes, por capability, tipo de erro e organização',
      labelNames: ['capability', 'error_type', 'orgId'],
      registers: [registry],
    })
  : null;
const enrichmentJobsDegraded = enabled
  ? new client.Gauge({
      name: 'b2base_enrichment_jobs_degraded',
      help: 'Jobs em estado DEGRADED (aguardando tasks parked)',
      registers: [registry],
    })
  : null;
const enrichmentProviderCircuitState = enabled
  ? new client.Gauge({
      name: 'b2base_enrichment_provider_circuit_state',
      help: 'Estado do circuito do provedor (0=HEALTHY, 1=HALF-OPEN/DEGRADED, 2=OPEN)',
      labelNames: ['provider'],
      registers: [registry],
    })
  : null;

function setEnrichmentTasksParked(provider, n, orgId) {
  const labels = orgId ? { provider: String(provider || 'unknown'), orgId } : { provider: String(provider || 'unknown') };
  if (enrichmentTasksParked) enrichmentTasksParked.set(labels, Math.max(0, n));
}
function incEnrichmentTasksParked(provider, orgId) {
  const labels = orgId ? { provider: String(provider || 'unknown'), orgId } : { provider: String(provider || 'unknown') };
  if (enrichmentTasksParkedTotal) enrichmentTasksParkedTotal.inc(labels);
}
function incEnrichmentTasksRepublished(provider) {
  if (enrichmentTasksRepublishedTotal) enrichmentTasksRepublishedTotal.inc({ provider: String(provider || 'unknown') });
}
function incEnrichmentParkExpired(capability) {
  if (enrichmentParkExpiredTotal) enrichmentParkExpiredTotal.inc({ capability: String(capability || 'unknown') });
}
function incEnrichmentFailuresReal(capability, errorType, orgId) {
  const labels = { capability: String(capability || 'unknown'), error_type: String(errorType || 'unknown') };
  if (orgId) labels.orgId = String(orgId);
  if (enrichmentFailuresRealTotal) enrichmentFailuresRealTotal.inc(labels);
}
function setEnrichmentJobsDegraded(n) {
  if (enrichmentJobsDegraded) enrichmentJobsDegraded.set(Math.max(0, n));
}
function setEnrichmentProviderCircuit(provider, state) {
  if (enrichmentProviderCircuitState) enrichmentProviderCircuitState.set({ provider: String(provider || 'unknown') }, Math.max(0, Math.min(2, Number(state) || 0)));
}

function incDeepAnalysisStarted() {
  if (deepAnalysisStarted) deepAnalysisStarted.inc();
}
function incDeepAnalysisCompleted(verdict) {
  if (deepAnalysisCompleted) deepAnalysisCompleted.inc({ verdict: String(verdict || 'unknown') });
}
function incDeepAnalysisFailed(reason) {
  if (deepAnalysisFailed) deepAnalysisFailed.inc({ reason: String(reason || 'unknown') });
}
function observeDeepAnalysisDuration(seconds) {
  if (deepAnalysisDurationHist && Number.isFinite(seconds)) {
    deepAnalysisDurationHist.observe(Math.max(0, seconds));
  }
}

module.exports = {
  startMetricsServer,
  refreshQueueMetrics,
  refreshDbMetrics,
  renderMetrics,
  renderEnrichmentMetrics,
  refreshEnrichmentPendingMetrics,
  setEnrichmentTaskState,
  observeEnrichmentTaskDuration,
  incEnrichmentProviderRequest,
  setEnrichmentProviderState,
  setEnrichmentPending,
  incQualificationTotal,
  incQualificationFailure,
  isEnabled: () => enabled,
  incCompositionOrigin,
  incCampaignReview,
  incAiCampaignApproval,
  incEmailSent: () => inc(emailsSentTotal),
  incEmailFailed: () => inc(emailsFailedTotal),
  incEmailRateLimited: () => inc(emailsRateLimitedTotal),
  incWhatsAppSent: () => inc(whatsappSentTotal),
  incWhatsAppFailed: () => inc(whatsappFailedTotal),
  observeAvaExtractDuration,
  incAvaExtractFile,
  incAvaExtractLlmFailure,
  observeAvaExtractDuration,
  incAvaExtractFile,
  incAvaExtractLlmFailure,
  incDeepAnalysisStarted,
  incDeepAnalysisCompleted,
  incDeepAnalysisFailed,
  observeDeepAnalysisDuration,
  setEnrichmentTasksParked,
  incEnrichmentTasksParked,
  incEnrichmentTasksRepublished,
  incEnrichmentParkExpired,
  incEnrichmentFailuresReal,
  setEnrichmentJobsDegraded,
  setEnrichmentProviderCircuit,
  incDiscoveryJobFinished,
  incDiscoveryProviderRun,
  observeDiscoveryProviderDuration,
  incDiscoveryCandidates,
  incDiscoveryEvidence,
  incDiscoveryEstimatedCost,
};

// ─── Campaign Studio (specs/010) — métricas studio_* ───────────────────────

const studioSchedulerTicks = enabled
  ? new client.Counter({
      name: 'studio_scheduler_ticks_total',
      help: 'Ticks do scheduler do Studio por resultado',
      labelNames: ['result'],
      registers: [registry],
    })
  : null;
const studioSendsEnqueued = enabled
  ? new client.Counter({
      name: 'studio_sends_enqueued_total',
      help: 'Leads liberados pelo scheduler do Studio por canal',
      labelNames: ['channel'],
      registers: [registry],
    })
  : null;
const studioGuardrailPauses = enabled
  ? new client.Counter({
      name: 'studio_guardrail_pauses_total',
      help: 'Pausas de automação por guard-rails (anomalia)',
      labelNames: ['channel', 'reason'],
      registers: [registry],
    })
  : null;
const studioAiBatchItems = enabled
  ? new client.Counter({
      name: 'studio_ai_batch_items_total',
      help: 'Itens de geração em lote do Studio por resultado',
      labelNames: ['kind', 'result'],
      registers: [registry],
    })
  : null;
const studioComplianceReviews = enabled
  ? new client.Counter({
      name: 'studio_compliance_reviews_total',
      help: 'Pareceres do Compliance Guard por nível',
      labelNames: ['level'],
      registers: [registry],
    })
  : null;
const studioQueueWaitHist = enabled
  ? new client.Histogram({
      name: 'studio_queue_wait_seconds',
      help: 'Tempo entre agendamento e envio no Studio',
      labelNames: ['channel'],
      buckets: [1, 5, 15, 60, 300, 900, 3600, 21600],
      registers: [registry],
    })
  : null;

function incStudioSchedulerTick(result) {
  if (studioSchedulerTicks) studioSchedulerTicks.inc({ result: result || 'ok' });
}
function incStudioSendsEnqueued(channel, count) {
  if (studioSendsEnqueued) studioSendsEnqueued.inc({ channel: channel || 'unknown' }, count || 1);
}
function incStudioGuardrailPause(reason) {
  if (studioGuardrailPauses) studioGuardrailPauses.inc({ channel: 'any', reason: reason || 'anomaly' });
}
function incStudioAiBatchItem(kind, result) {
  if (studioAiBatchItems) studioAiBatchItems.inc({ kind: kind || 'unknown', result: result || 'ok' });
}
function incStudioComplianceReview(level) {
  if (studioComplianceReviews) studioComplianceReviews.inc({ level: level || 'ok' });
}
function observeStudioQueueWait(channel, seconds) {
  if (studioQueueWaitHist && Number.isFinite(seconds)) {
    studioQueueWaitHist.observe({ channel: channel || 'unknown' }, Math.max(0, seconds));
  }
}

module.exports.incStudioSchedulerTick = incStudioSchedulerTick;
module.exports.incStudioSendsEnqueued = incStudioSendsEnqueued;
module.exports.incStudioGuardrailPause = incStudioGuardrailPause;
module.exports.incStudioAiBatchItem = incStudioAiBatchItem;
module.exports.incStudioComplianceReview = incStudioComplianceReview;
module.exports.observeStudioQueueWait = observeStudioQueueWait;

const studioJourneyLeadsGauge = enabled
  ? new client.Gauge({
      name: 'studio_journey_leads_by_block',
      help: 'Leads do Studio por bloco de journey',
      labelNames: ['journeyId', 'blockId', 'status'],
      registers: [registry],
    })
  : null;
function setStudioJourneyLeads(journeyId, blockId, status, count) {
  if (studioJourneyLeadsGauge) studioJourneyLeadsGauge.set({ journeyId, blockId, status }, count || 0);
}
module.exports.setStudioJourneyLeads = setStudioJourneyLeads;

// ─── Campaign Studio Cockpit (specs/011) — gate, ledger e sugestões ─────────

const studioGateEvaluations = enabled
  ? new client.Counter({
      name: 'studio_gate_evaluations_total',
      help: 'Avaliações do gate de reputação por resultado (allow/block) e motivo',
      labelNames: ['result', 'reason'],
      registers: [registry],
    })
  : null;
const studioGateConsumed = enabled
  ? new client.Counter({
      name: 'studio_gate_units_consumed_total',
      help: 'Unidades de saldo consumidas pelo gate por canal',
      labelNames: ['channel'],
      registers: [registry],
    })
  : null;
const studioLedgerEvents = enabled
  ? new client.Counter({
      name: 'studio_ledger_events_total',
      help: 'Eventos do ledger de reputação por tipo e canal',
      labelNames: ['type', 'channel'],
      registers: [registry],
    })
  : null;
const studioLedgerRefunds = enabled
  ? new client.Counter({
      name: 'studio_ledger_refunds_total',
      help: 'Estornos idempotentes de envio por canal (AD-13)',
      labelNames: ['channel'],
      registers: [registry],
    })
  : null;
const studioSuggestionsShown = enabled
  ? new client.Counter({
      name: 'studio_suggestions_shown_total',
      help: 'Sugestões contextuais exibidas no Cockpit por tipo',
      labelNames: ['kind'],
      registers: [registry],
    })
  : null;
const studioAutonomyWake = enabled
  ? new client.Counter({
      name: 'studio_autonomy_wake_total',
      help: 'Decisões do Contrato de Autonomia por evento e resultado (wake/silent/aggregated)',
      labelNames: ['type', 'result'],
      registers: [registry],
    })
  : null;

function incGateEvaluation(result, reason) {
  if (studioGateEvaluations) {
    studioGateEvaluations.inc({ result: result || 'allow', reason: result === 'block' ? String(reason || 'unknown') : 'none' });
  }
}
function incGateBlock(reason) {
  incGateEvaluation('block', reason);
}
function incGateConsumed(channel, count) {
  if (studioGateConsumed) studioGateConsumed.inc({ channel: channel || 'unknown' }, count || 1);
}
function incLedgerEvent(type, channel) {
  if (studioLedgerEvents) studioLedgerEvents.inc({ type: type || 'unknown', channel: channel || 'unknown' });
}
function incLedgerRefund(channel) {
  if (studioLedgerRefunds) studioLedgerRefunds.inc({ channel: channel || 'unknown' });
}
function incSuggestionsShown(kind) {
  if (studioSuggestionsShown) studioSuggestionsShown.inc({ kind: kind || 'unknown' });
}
function incAutonomyWake(type, result) {
  if (studioAutonomyWake) studioAutonomyWake.inc({ type: type || 'unknown', result: result || 'silent' });
}

module.exports.incGateEvaluation = incGateEvaluation;
module.exports.incGateBlock = incGateBlock;
module.exports.incGateConsumed = incGateConsumed;
module.exports.incLedgerEvent = incLedgerEvent;
module.exports.incLedgerRefund = incLedgerRefund;
module.exports.incSuggestionsShown = incSuggestionsShown;
module.exports.incAutonomyWake = incAutonomyWake;
