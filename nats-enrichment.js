// =============================================================================
// nats-enrichment.js
// Integração com o pipeline de enriquecimento via NATS JetStream.
//
// Fluxo (documentação do enrichment-worker):
//   1. Publicamos  enrichment.company.requested.v1
//      com { cnpj, company_id, request_event_id } e header Nats-Msg-Id=event_id
//      (Dedup no envio: reenvios dentro de 2 min são ignorados pelo stream).
//   2. Consumidor durável exclusivo (b2base-results) escuta
//      enrichment.company.completed.v1 e persiste o resultado IDEMPOTENTE
//      (chave: company_id + enrichment_version), ACK somente após persistir,
//       nak() em erro para reentrega.
//   3. Monitoramos a DLQ enrichment.company.dlq.v1 (ex.: CNPJ inválido).
//
// Entrega é at-least-once: o consumidor pode receber a mesma mensagem mais de
// uma vez. A persistência idempotente garante que não duplicamos nem perdemos.
//
// O cliente `nats` (npm) expõe a mesma API da doc: connect(), StringCodec(),
// JSONCodec(), jetstream(), pull_subscribe dada a durabilidade. Aqui usamos a
// API JS: js.consumers.get(), consumer.fetch() e AckPolicy.
// =============================================================================

const { connect, StringCodec, JSONCodec, headers } = require('nats');
const { randomUUID, createHash } = require('crypto');
// Feature 005: roteamento do card pós-enriquecimento (premium → Análise profunda).
const { getOrgPlan } = require('./plan');
const pipelineTransitions = require('./pipeline-transitions');

const sc = StringCodec();
const jc = JSONCodec();

// Namespace fixo para derivar um UUID determinístico (uuidv5) do CNPJ.
// O enrichment-worker exige `company_id` como UUID e usa esse ID para versionar
// os enriquecimentos (enrichment_version). Derivar do CNPJ garante estabilidade
// entre chamadas (re-enriquecimento mantém a mesma empresa no lado do worker).
const B2BASE_NAMESPACE = '6f4c1a2e-9b7d-4e3a-8c5f-1d2e3a4b5c6d';

function deterministicCompanyId(cnpj) {
  const ns = Buffer.from(B2BASE_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(String(cnpj || ''), 'utf8')]))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value) {
  const n = toNumberOrNull(value);
  return n === null ? null : Math.round(n);
}

// O worker envia um `summary` reduzido no evento completed.v1. Aceitamos tanto
// as chaves antigas (tech_count, commercial_potential) quanto as atuais
// (technologies, people, social_platforms...) publicadas pelo _summary do job_runner.
function buildEnrichmentSummary(summary) {
  return {
    domain: summary.domain ?? null,
    website_active: summary.website_active != null ? Boolean(summary.website_active) : null,
    corporate_email: summary.corporate_email != null ? Boolean(summary.corporate_email) : null,
    launch_velocity: toNumberOrNull(summary.launch_velocity),
    operational_readiness: toNumberOrNull(summary.operational_readiness),
    commercial_potential: toNumberOrNull(summary.commercial_potential),
    tech_count: toIntOrNull(summary.tech_count ?? summary.technologies),
    people: toIntOrNull(summary.people),
    social_platforms: toIntOrNull(summary.social_platforms),
    financial_indicators: toIntOrNull(summary.financial_indicators),
    relationship_edges: toIntOrNull(summary.relationship_edges),
  };
}

// ---------------------------------------------------------------------------
// Config (env com defaults). Conexão delegada ao módulo compartilhado
// nats-stream.js — mesmo comportamento, um único ponto de conexão.
// ---------------------------------------------------------------------------
const natsStream = require('./nats-stream');
const NATS_URL = natsStream.NATS_URL;
const NATS_STREAM = natsStream.NATS_STREAM;
const NATS_DURABLE = process.env.NATS_DURABLE || 'b2base-results';
const NATS_REQUEST_SUBJECT = process.env.NATS_REQUEST_SUBJECT || 'enrichment.company.requested.v1';
const NATS_COMPLETED_SUBJECT = process.env.NATS_COMPLETED_SUBJECT || 'enrichment.company.completed.v1';
// O worker publica resumos terminais em dois subjects pelo status final
// (graph_director._emit_company_result / job_runner): COMPLETED -> completed.v1,
// PARTIAL -> partial.v1. Sem consumir o partial.v1, leads com resultado parcial
// ficam presos em "pending" para sempre.
const NATS_PARTIAL_SUBJECT = process.env.NATS_PARTIAL_SUBJECT || 'enrichment.company.partial.v1';
const NATS_PARTIAL_DURABLE = process.env.NATS_PARTIAL_DURABLE || `${NATS_DURABLE}-partial`;
const NATS_DLQ_SUBJECT = process.env.NATS_DLQ_SUBJECT || 'enrichment.company.dlq.v1';
const NATS_BATCH = parseInt(process.env.NATS_BATCH || '20', 10);
const NATS_FETCH_TIMEOUT_MS = parseInt(process.env.NATS_FETCH_TIMEOUT_MS || '5000', 10);
const NATS_ACK_WAIT_S = parseInt(process.env.NATS_ACK_WAIT_S || '30', 10);

let _nc = null;          // conexão NATS ativa
let _js = null;          // JetStream
let _consumerRunning = false;

function isNatsEnabled() {
  // Desliga o consumer se explicitamente desabilitado (ex.: dev local sem NATS)
  return String(process.env.NATS_ENABLED || 'true') === 'true';
}

function normalizeCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

async function connectNats() {
  // Delega ao módulo compartilhado (mesma semântica: reconnect infinito,
  // boot não bloqueante, singleton por processo).
  const nc = await natsStream.connectNats({ name: 'b2base-backend' });
  _nc = nc;
  _js = nc.jetstream();
  return _nc;
}

// ---------------------------------------------------------------------------
// PUBLISH — enrichment.company.requested.v1
// ---------------------------------------------------------------------------
// Envia um pedido de enriquecimento. Best-effort: se o NATS estiver fora do
// ar, loga e não quebra o request HTTP. Retorna o event_id usado (dedup).
async function requestEnrichment(prisma, prospectOrId) {
  const prospect = typeof prospectOrId === 'string'
    ? await prisma.prospect.findUnique({ where: { id: prospectOrId } })
    : prospectOrId;
  if (!prospect) return null;
  if (!isNatsEnabled()) {
    console.log(`[nats] desabilitado; ignorando pedido para prospect ${prospect.id}`);
    return null;
  }

  const eventId = randomUUID();
  const cnpj = normalizeCnpj(prospect.cnpj);
  // Sem chave de enriquecimento não há o que pedir — o caller cai no fallback
  // (que marca unavailable). Leads importados sem CNPJ ficam nesse caso.
  if (!cnpj) {
    console.log(`[nats] prospect ${prospect.id} sem CNPJ; ignorando pedido de enriquecimento`);
    return null;
  }
  // O worker valida `company_id` como UUID (Pydantic uuid.UUID). O id do
  // Prospect é um CUID, então derivamos um UUID estável do CNPJ.
  const companyId = deterministicCompanyId(cnpj);

  if (cnpj.length !== 14) {
    console.warn(`[nats] CNPJ inválido para prospect ${prospect.id}: "${prospect.cnpj}" -> irá para a DLQ.`);
    // Ainda publicamos; o worker manda para a DLQ enrichment.company.dlq.v1.
  }

  const payload = {
    version: '1',
    event_id: eventId,
    company_id: companyId,
    cnpj,
    company_name: prospect.companyName || undefined,
    trade_name: prospect.tradeName || undefined,
    published_at: new Date().toISOString(),
  };

  try {
    const nc = await connectNats();
    // js.publish exige ack do JetStream: se o stream não conseguir armazenar a
    // mensagem (ex.: storage do server cheio), o erro volta aqui em vez de ser
    // descartado silenciosamente como no publish core (fire-and-forget).
    const js = nc.jetstream();
    // Nats-Msg-Id: dedup no envio (reenvios dentro de 2 min são ignorados).
    const hdr = headers();
    hdr.set('Nats-Msg-Id', eventId);
    await js.publish(
      NATS_REQUEST_SUBJECT,
      jc.encode(payload),
      { headers: hdr, timeout: 5000 }
    );
    console.log(`[nats] pedido publicado ${NATS_REQUEST_SUBJECT} company=${companyId} cnpj=${cnpj} event=${eventId}`);
    // Ledger: correlaciona event_id → prospect/org. O resultado volta com
    // request_event_id e o roteamento funciona mesmo com o mesmo CNPJ em
    // vários orgs. Falha no ledger não desfaz o pedido (fallback por CNPJ).
    await prisma.enrichmentRequest.create({
      data: {
        eventId,
        orgId: prospect.orgId,
        prospectId: prospect.id,
        cnpj,
        taxIdType: prospect.taxIdType || 'br_cnpj',
      },
    }).catch((err) => console.error(`[nats] falha ao registrar ledger de ${eventId}: ${err.message}`));
    return eventId;
  } catch (error) {
    console.error(`[nats] falha ao publicar pedido para ${companyId}: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// PERSISTÊNCIA IDEMPOTENTE
// ---------------------------------------------------------------------------
// Upsert da linha de enriquecimento com chave única (companyId, enrichmentVersion).
// Depois aplica os campos no Prospect somente se a versão for mais nova do que
// a já aplicada (protege contra reordering / mensagens antigas chegando depois).
async function persistEnrichmentResult(prisma, result) {
  // O evento CompanyResultEventV1 traz enrichment_version/status/cnpj/company_id
  // no TOPO do payload; `summary` contém apenas os 7 campos reduzidos (domain,
  // commercial_potential etc.). Ler essas chaves do topo evita cair no default.
  const summary = result.summary || {};
  const cnpj = normalizeCnpj(result.cnpj || summary.cnpj);
  const companyId = result.company_id || summary.company_id || deterministicCompanyId(cnpj);
  // O worker publica `enrichment_version: null` e `version` como string ("1").
  // Sem a coerção o Prisma rejeita a query (Expected Int, provided String) e a
  // mensagem entra em loop de nak até ser abandonada (max_deliver).
  const enrichmentVersion = toIntOrNull(result.enrichment_version ?? result.version) ?? 1;
  const status = (result.status || 'COMPLETED').toUpperCase();
  const requestEventId = result.request_event_id || null;

  if (!companyId && !cnpj) {
    throw new Error('Enrichment result sem company_id nem cnpj — impossível persistir');
  }

  // Correlação com o Prospect ANTES de persistir (a linha do log leva a
  // rastreabilidade). Preferimos o ledger (request_event_id → prospect), que
  // funciona mesmo com o mesmo CNPJ cadastrado em vários orgs; o fallback por
  // CNPJ cobre eventos publicados antes do ledger existir.
  let prospect = null;
  if (requestEventId) {
    const ledgerRow = await prisma.enrichmentRequest
      .findUnique({ where: { eventId: requestEventId } })
      .catch(() => null);
    if (ledgerRow) {
      prospect = await prisma.prospect.findUnique({ where: { id: ledgerRow.prospectId } });
    }
  }
  if (!prospect && cnpj) {
    const candidates = await prisma.prospect.findMany({
      where: { cnpj },
      orderBy: { createdAt: 'desc' },
      take: 2,
      select: { id: true, orgId: true, status: true, enrichmentVersion: true },
    });
    if (candidates.length > 1) {
      console.warn(
        `[nats] CNPJ ${cnpj} existe em ${candidates.length} orgs e o evento não tem ledger — ` +
        `aplicando no prospect mais recente; o ledger de requests roteia sem ambiguidade.`
      );
    }
    prospect = candidates[0] || null;
  }

  // Registra/upsert idempotente. Se já existe com a mesma (companyId, version),
  // mantemos os dados originais (não sobrescreve com duplicata).
  const existing = await prisma.cnpjEnrichment.findUnique({
    where: { companyId_enrichmentVersion: { companyId, enrichmentVersion } },
  });

  const row = await prisma.cnpjEnrichment.upsert({
    where: { companyId_enrichmentVersion: { companyId, enrichmentVersion } },
    create: {
      companyId,
      cnpj,
      enrichmentVersion,
      requestEventId,
      status,
      errorCode: summary.error_code || null,
      errorMessage: summary.error_message || null,
      score: toIntOrNull(summary.commercial_potential),
      rawPayload: result,
      orgId: prospect?.orgId || null,
      prospectId: prospect?.id || null,
    },
    update: {
      // Nunca sobrescreve dados válidos já persistidos com campo undefined/null.
      ...((existing?.status !== 'COMPLETED' && status === 'COMPLETED') ? {
        status,
        errorCode: summary.error_code || null,
        errorMessage: summary.error_message || null,
      } : {}),
      // Completa a rastreabilidade quando o resultado chegou sem ledger e o
      // fallback por CNPJ encontrou o prospect.
      ...(!existing?.prospectId && prospect ? { orgId: prospect.orgId, prospectId: prospect.id } : {}),
    },
  });

  // Aplica no Prospect apenas se for um resultado mais novo do que o aplicado.
  if (prospect) {
    const appliedVersion = prospect.enrichmentVersion || 0;
    if (status === 'COMPLETED' || status === 'PARTIAL') {
      if (enrichmentVersion > appliedVersion) {
        const commercialPotential = toIntOrNull(summary.commercial_potential);
        // Feature 005: premium pousa em "Análise profunda" (a análise de IA é
        // disparada pelo deep-analysis.js via gatilho de entrada no estágio);
        // demais planos seguem direto para "Prontas para contato" como antes.
        const nextStatus = pipelineTransitions.statusAfterEnrichment(
          // Status PÓS-conclusão (o update abaixo grava 'enriched'/'partial').
          { ...prospect, enrichmentStatus: status === 'PARTIAL' ? 'partial' : 'enriched' },
          await getOrgPlan(prisma, prospect.orgId)
        );
        await prisma.prospect.update({
          where: { id: prospect.id },
          data: {
            ...(commercialPotential != null ? { opportunityScore: commercialPotential } : {}),
            enrichmentSummary: {
              ...(prospect.enrichmentSummary || {}),
              ...buildEnrichmentSummary(summary),
            },
            enrichmentStatus: status === 'PARTIAL' ? 'partial' : 'enriched',
            enrichmentSource: 'nats.enrichment',
            enrichmentError: null,
            enrichmentVersion,
            enrichedAt: new Date(),
            ...(nextStatus
              ? {
                  status: nextStatus,
                  ...(nextStatus === 'deep_analysis' ? { analysisStatus: 'not_started' } : {}),
                }
              : {}),
          },
        });

        // Feature 005: card pousou em "Análise profunda" (premium) — dispara a
        // análise de IA. Fire-and-forget: falha aqui não afeta o consumer.
        if (nextStatus === 'deep_analysis') {
          try {
            const fresh = await prisma.prospect.findUnique({ where: { id: prospect.id } });
            if (fresh) {
              const runner = require('./deep-analysis').getSharedRunner(prisma);
              const enqueued = await runner.enqueue(fresh, { trigger: 'auto' });
              if (enqueued.started) enqueued.done.catch(() => {});
            }
          } catch (analysisErr) {
            console.error('[deep-analysis] gatilho pós-enriquecimento falhou:', analysisErr.message);
          }
        }

        // Suíte multicanal pós-enriquecimento (email/WhatsApp). Falhas
        // isoladas não afetam o consumer.
        try {
          const campaignSuite = require('./campaign-suite');
          await campaignSuite.onLeadEnriched(prisma, {
            ...prospect,
            enrichmentStatus: status === 'PARTIAL' ? 'partial' : 'enriched',
            enrichmentVersion,
          });
        } catch (suiteErr) {
          console.error('[suite] erro pós-enriquecimento (nats):', suiteErr.message);
        }
      }
    } else if (status === 'FAILED') {
      if (enrichmentVersion > appliedVersion) {
        await prisma.prospect.update({
          where: { id: prospect.id },
          data: {
            enrichmentStatus: 'error',
            enrichmentSource: 'nats.enrichment',
            enrichmentError: row.errorMessage || summary.error_message || 'Enrichment failed',
            enrichmentVersion,
            enrichedAt: new Date(),
          },
        });
      }
    }
    // DISCARDED: pedido inválido — marcamos sem aplicar dados.
  } else if (enrichmentVersion > appliedVersion && commercialPotential == null) {
    // Worker respondeu SEM commercial_potential (parciais/incompletos):
    // recalcula o score localmente com os sinais disponíveis — sem isso o
    // lead fica eternamente com o default de import (60).
    const { recalcLeadScore } = require('./opportunity-score');
    await recalcLeadScore(prisma, prospect).catch((err) =>
      console.error('[nats] recalcLeadScore falhou:', err.message)
    );
  }

  return row;
}

// ---------------------------------------------------------------------------
// CONSUMERS — enrichment.company.{completed,partial}.v1 (duráveis, idempotentes)
// ---------------------------------------------------------------------------
// Garante o consumer durável (cria se não existir). Um durable por subject:
// o JetStream (2.x) só aceita um filter_subject por consumer.
async function ensureResultConsumer(jsm, durable, subject) {
  try {
    await jsm.consumers.info(NATS_STREAM, durable);
    console.log(`[nats] consumer durável já existe: ${durable}`);
  } catch (_e) {
    await jsm.consumers.add(NATS_STREAM, {
      durable_name: durable,
      filter_subject: subject,
      ack_policy: 'explicit',
      ack_wait: NATS_ACK_WAIT_S * 1000 * 1000 * 1000, // nanoseconds
      max_deliver: 5,
    });
    console.log(`[nats] consumer durável criado: ${durable}`);
  }
}

async function startEnrichmentConsumer(prisma) {
  if (!isNatsEnabled()) {
    console.log('[nats] consumer desabilitado (NATS_ENABLED=false).');
    return;
  }

  try {
    const nc = await connectNats();
    const js = nc.jetstream();
    const jsm = await nc.jetstreamManager();

    await ensureResultConsumer(jsm, NATS_DURABLE, NATS_COMPLETED_SUBJECT);
    await ensureResultConsumer(jsm, NATS_PARTIAL_DURABLE, NATS_PARTIAL_SUBJECT);

    _consumerRunning = true;
    console.log(`[nats] consumindo ${NATS_COMPLETED_SUBJECT} (durável=${NATS_DURABLE})`);
    console.log(`[nats] consumindo ${NATS_PARTIAL_SUBJECT} (durável=${NATS_PARTIAL_DURABLE})`);

    // Loops de consumo em pull. Rodam em background e reconectam sozinhos.
    const runConsumeLoop = (durable) => {
      (async function consumeLoop() {
        while (_consumerRunning) {
          try {
            const info = await jsm.consumers.info(NATS_STREAM, durable);
            const consumer = js.consumers.getPullConsumerFor(info);
            const msgs = await consumer.fetch({ max_messages: NATS_BATCH, expires: NATS_FETCH_TIMEOUT_MS });
            for await (const m of msgs) {
              try {
                const result = jc.decode(m.data);
                await persistEnrichmentResult(prisma, result);
                await m.ack();            // ACK somente após persistir
              } catch (err) {
                console.error('[nats] erro ao processar mensagem:', (err && (err.stack || err.message)) || String(err));
                try {
                  await m.nak();          // reentrega se falhar
                } catch (_) { /* ignora */ }
              }
            }
          } catch (err) {
            // Timeout/sem mensagens é normal; apenas segue o loop.
            if (!(err && (String(err.message).includes('timeout') || String(err.message).includes('nothing') || err.code === '404'))) {
              console.error(`[nats] erro no loop do consumer ${durable}:`, err.message);
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        }
      })();
    };
    runConsumeLoop(NATS_DURABLE);
    runConsumeLoop(NATS_PARTIAL_DURABLE);
  } catch (error) {
    console.error('[nats] falha ao iniciar consumer:', error.message);
  }
}

// ---------------------------------------------------------------------------
// DLQ MONITOR — enrichment.company.dlq.v1
// ---------------------------------------------------------------------------
async function startDlqMonitor() {
  if (!isNatsEnabled()) return;
  try {
    const nc = await connectNats();
    const sub = nc.subscribe(NATS_DLQ_SUBJECT);
    (async () => {
      for await (const m of sub) {
        try {
          const data = jc.decode(m.data);
          console.warn(`[nats][DLQ] mensagem rejeitada: ${JSON.stringify(data)}`);
        } catch (_e) {
          console.warn(`[nats][DLQ] mensagem não-JSON recebida: ${sc.decode(m.data)}`);
        }
      }
    })();
    console.log(`[nats] monitorando DLQ ${NATS_DLQ_SUBJECT}`);
  } catch (error) {
    console.error('[nats] falha ao monitorar DLQ:', error.message);
  }
}

async function shutdown() {
  _consumerRunning = false;
  if (_nc) {
    try { await _nc.drain(); } catch (_e) { /* ignora */ }
    try { await _nc.close(); } catch (_e) { /* ignora */ }
    _nc = null;
    _js = null;
  }
}

module.exports = {
  isNatsEnabled,
  connectNats,
  getJs: () => _js,
  requestEnrichment,
  startEnrichmentConsumer,
  startDlqMonitor,
  persistEnrichmentResult,
  shutdown,
  NATS_URL,
  NATS_STREAM,
  NATS_DURABLE,
  NATS_PARTIAL_DURABLE,
  NATS_PARTIAL_SUBJECT,
};
