// =============================================================================
// workers/company-deep.js — worker da família company (specs/001-distributed-
// enrichment). Capabilities portadas das esteiras legadas (Fase 11):
//   - company.profile.deep : firmografia profunda (People Data Labs)
//   - company.logo         : logo via Google Favicons (com probe; Clearbit
//     foi descontinuado — logo.clearbit.com fora do DNS)
//   - company.deepgraph    : PONTE com o worker Python OSINT — o serviço
//     existente é tratado como PROVIDER via os contratos legados
//     enrichment.company.*.v1 (research R12), sem nenhuma mudança nele.
//
// Rodar: `node workers/company-deep.js` (ou pnpm run worker:company-deep).
// =============================================================================

const { createWorkerRuntime } = require('./sdk/runtime');
// QA 2026-10-07: company.digital_presence pertence à família company (subject
// enrichment.task.company.>) — o executor vive no módulo digital-presence.
const digitalPresence = require('./digital-presence');
const { makeResultPublisher } = require('./sdk/result-publisher');
const capabilities = require('../enrichment-capabilities');
const { createLogger } = require('../logger');
const { createRawStore } = require('../raw-store');
const natsStream = require('../nats-stream');

/**
 * Executores parametrizáveis (deps injetáveis para testes). Em produção os
 * defaults puxam os módulos legados — comportamento idêntico às esteiras atuais.
 */
function makeExecutors(deps = {}) {
  const {
    pdlCompanyEnrich = (input, opts) => require('../lead-enrichment').pdlCompanyEnrich(input, opts),
    logoForDomain = (domain) => require('../lead-enrichment').logoForDomain(domain),
    fetchImpl = fetch,
    requestEnrichment = (prisma, p) => require('../nats-enrichment').requestEnrichment(prisma, p),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 5000,
  } = deps;

  return {
    'company.digital_presence': digitalPresence.executors['company.digital_presence'],

    async 'company.profile.deep'(task, { logger }) {
      let profile;
      try {
        profile = await pdlCompanyEnrich({
          companyName: task.input.companyName,
          city: task.input.city,
        }, { strict: true });
      } catch (err) {
        // Erro de provider (chave, HTTP, rede) NUNCA é "não encontrado":
        // falha transiente para o manager re-tentar com backoff.
        logger.warn(`company.profile.deep: PDL indisponível para "${task.input.companyName}": ${err.message}`);
        return { status: 'FAILED', error: { type: 'PROVIDER_UNAVAILABLE', message: `PDL indisponível: ${err.message}`, retryable: true } };
      }
      if (!profile) {
        return { status: 'FAILED', error: { type: 'NOT_FOUND', message: 'perfil não encontrado na PDL', retryable: false } };
      }
      return {
        status: 'COMPLETED',
        provider: 'pdl',
        data: profile,
        facts: [
          profile.employee_count != null && { attribute: 'company.employeeCount', value: profile.employee_count, confidence: 0.85,
            evidence: { sourceType: 'pdl', provider: 'pdl', retrievedAt: new Date().toISOString() } },
          profile.industry && { attribute: 'company.industry', value: profile.industry, confidence: 0.85,
            evidence: { sourceType: 'pdl', provider: 'pdl', retrievedAt: new Date().toISOString() } },
        ].filter(Boolean),
      };
    },

    async 'company.logo'(task) {
      const domain = String(task.input.domain || '').toLowerCase();
      const url = logoForDomain(domain);
      // Probe barato: URL inválida/indisponível é resultado negativo válido.
      try {
        const res = await fetchImpl(url, { method: 'HEAD' });
        if (!res.ok) {
          return { status: 'FAILED', error: { type: 'NOT_FOUND', message: `logo HTTP ${res.status}`, retryable: false } };
        }
      } catch (err) {
        return { status: 'FAILED', error: { type: 'PROVIDER_UNAVAILABLE', message: err.message, retryable: true } };
      }
      return {
        status: 'COMPLETED',
        provider: 'google.favicon',
        data: { logo_url: url },
        facts: [{ attribute: 'company.logo', value: url, confidence: 0.9,
          evidence: { sourceType: 'google.favicon', provider: 'google.favicon', url, retrievedAt: new Date().toISOString() } }],
      };
    },

    /**
     * Ponte com o worker Python: publica o pedido legado (com tenant no ledger)
     * e aguarda a conclusão correlacionada via EnrichmentRequest/CnpjEnrichment
     * dentro do timeout da task. Nada muda no serviço Python (research R12).
     */
    async 'company.deepgraph'(task, { logger }) {
      const prospect = await prismaFor(task).prospect.findFirst
        ? await prismaFor(task).prospect.findFirst({ where: { id: task.prospectId } })
        : null;
      if (!prospect || !prospect.cnpj) {
        return { status: 'FAILED', error: { type: 'INVALID_INPUT', message: 'deepgraph exige prospect com CNPJ', retryable: false } };
      }
      const eventId = await requestEnrichment(prismaFor(task), prospect);
      if (!eventId) {
        return { status: 'FAILED', error: { type: 'PROVIDER_UNAVAILABLE', message: 'NATS indisponível para a ponte deepgraph', retryable: true } };
      }

      const deadline = Date.now() + Math.max(task.timeoutMs - 5000, 10000);
      while (Date.now() < deadline) {
        await sleep(pollIntervalMs);
        const ledger = await prismaFor(task).enrichmentRequest.findUnique({ where: { eventId } }).catch(() => null);
        if (!ledger) continue;
        const rows = await prismaFor(task).cnpjEnrichment.findMany({ where: { requestEventId: eventId } });
        const terminal = rows.find((r) => ['COMPLETED', 'PARTIAL', 'FAILED'].includes(r.status));
        if (terminal) {
          if (terminal.status === 'FAILED') {
            return { status: 'FAILED', error: { type: 'INTERNAL', message: terminal.errorMessage || 'deepgraph falhou', retryable: true } };
          }
          return {
            status: 'COMPLETED',
            provider: 'python.worker.graph',
            data: terminal.rawPayload && terminal.rawPayload.summary ? terminal.rawPayload.summary : { status: terminal.status },
            facts: [],
          };
        }
        logger.info(`deepgraph aguardando worker Python (event=${eventId})`);
      }
      return { status: 'FAILED', error: { type: 'TIMEOUT', message: 'worker Python não concluiu dentro do timeout da task', retryable: false } };
    },
  };

  // O prisma do runtime é injetado por deps (mesma instância nos testes).
  function prismaFor(_task) {
    return deps.prisma;
  }
}

/** Monta o runtime completo (boot e testes de integração). */
function createCompanyDeepWorker({ prisma, js, jsm = null, deps = {} } = {}) {
  const logger = createLogger({ component: 'worker', family: 'company' });
  const runtime = createWorkerRuntime({
    name: 'company',
    capabilities,
    workerVersion: process.env.GIT_SHA || 'dev',
    deps: {
      prisma,
      js,
      jsm,
      publisher: js ? makeResultPublisher({ js }) : null,
      rawStore: prisma ? createRawStore({ prisma }) : null,
      logger,
      onMetric: (event, data) => {
        if (event === 'task_duration') require('../metrics').observeEnrichmentTaskDuration(data.capability, data.durationMs / 1000);
        if (event === 'provider_state') require('../metrics').setEnrichmentProviderState(data.provider, data.state);
      },
      ...deps,
    },
  });
  runtime.registerExecutors(makeExecutors({ prisma, ...(deps.execDeps || {}) }));
  return runtime;
}

module.exports = { createCompanyDeepWorker, makeExecutors };

if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  (async () => {
    const prisma = new PrismaClient();
    const nc = await natsStream.connectNats({ name: 'b2base-worker-company' });
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    const registry = require('../enrichment-provider-registry').getWorkerRegistry();
    const runtime = createCompanyDeepWorker({ prisma, js, jsm, deps: { registry } });
    await runtime.start();
    const shutdown = async () => {
      await runtime.stop();
      await natsStream.closeAll();
      await prisma.$disconnect().catch(() => {});
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })().catch((err) => {
    console.error(`[worker:company] falha no boot: ${err.message}`);
    process.exit(1);
  });
}
