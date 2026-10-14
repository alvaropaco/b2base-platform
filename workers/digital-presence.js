// =============================================================================
// workers/digital-presence.js — executor company.digital_presence.
//
// 2026-10-14 (REFACTOR — regra de ouro): a descoberta de contato virou
// pipeline com FONTE e SCORE em workers/contact-discovery.js:
//   ETAPA 1 identidade confirmada (CNPJ→BrasilAPI > domínio > nome+cidade)
//   ETAPA 2 fontes determinísticas (site oficial, Google Places, CNPJ,
//           Instagram linkado pelo site) — cada candidato com URL + trecho
//   ETAPA 3 libphonenumber (E.164/válido/mobile) + DDD×UF + anti-alucinação
//   ETAPA 4 score (wa.me no site confirmado 95 … só CNPJ 40; DDD errado −30)
//   ETAPA 5 saída com status/fontes/motivo_descarte.
// `digital_presence.whatsapp` SÓ vem preenchido quando status = 'confirmado'
// — os consumos (enrichment-manager, chat) passam a salvar apenas números
// com evidência. Retirados daqui (geravam número de outra empresa):
// multi-fonte por sobreposição de tokens, extração de celular em TEXTO de
// catálogo e o prepend-55 (fabricava número BR de número estrangeiro).
//
// Este arquivo mantém: extração wa.me fonte-literal (usada também pelo
// worker social-presence/maigret), Twilio gate (teste) e bootstrap.
// APENAS lógica de negócio aqui — infra é do SDK (workers/sdk).
// Rodar: `node workers/digital-presence.js`.
// =============================================================================

const { createWorkerRuntime } = require('./sdk/runtime');
const contactDiscovery = require('./contact-discovery');

// ── Extração wa.me (fonte-literal) ──────────────────────────────────────────
const WA_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send(?:\?|&)(?:[^ ]*phone=)|web\.whatsapp\.com\/send\?[^"' >]*?phone=|whatsapp:\/\/send\?(?:[^ ]*phone=))\+?([0-9]+)/i;

/** Canoniza para disparo BR: 10-11 dígitos ganham DDI 55; 12-13 só se já 55. */
function canonWhatsAppDigits(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 13) return null;
  if (digits.length > 11 && !digits.startsWith('55')) return null;
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function extractWaLinksRaw(text) {
  const out = [];
  if (!text) return out;
  for (const m of text.matchAll(new RegExp(WA_RE.source, 'gi'))) {
    const raw = String(m[1]).replace(/\D/g, '');
    const canon = canonWhatsAppDigits(raw);
    if (canon) out.push({ canon, explicitBr: raw.startsWith('55') });
  }
  return out;
}

function extractWaLinks(text) {
  return extractWaLinksRaw(text).map((r) => r.canon);
}

function extractWhatsAppFromHtml(html) {
  const links = extractWaLinksRaw(html);
  return links.length ? links[0].canon : null;
}

async function fetchPage(url, { signal, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { signal, redirect: 'follow', headers: { Accept: 'text/html,*/*' } });
  if (!res.ok) return '';
  return res.text();
}

/**
 * Gate Twilio Lookup (mantido para uso pontual/teste): número
 * confirmadamente ruim não vira candidato. Falha de gate = ALLOW.
 */
async function gateWhatsApp(phoneE164, { deps = {}, fetchImpl = fetch, signal, logger } = {}) {
  const twilio = deps.twilioLookup || null;
  const registry = deps.registry || null;
  if (!twilio || !twilio.isConfigured()) {
    return { decision: 'ALLOW', checked: false, reason: 'TWILIO_NOT_CONFIGURED' };
  }
  if (!registry) {
    return { decision: 'ALLOW', checked: false, reason: 'NO_REGISTRY' };
  }
  const acq = await registry.acquire('twilio.lookup');
  if (!acq.ok) {
    logger && logger.warn && logger.warn(`gateWhatsApp: twilio.lookup indisponível (${acq.reason}) — fail-open`);
    return { decision: 'ALLOW', checked: false, reason: `TWILIO_${acq.reason}` };
  }
  try {
    const res = await twilio.lookupPhoneNumber(phoneE164, { fetchImpl, signal });
    await registry.recordOutcome('twilio.lookup', { ok: res.ok, latencyMs: res.latencyMs || 0 });
    const verdict = twilio.evaluateWhatsAppNumber(res);
    return { ...verdict, checked: true, lineType: res.ok ? res.lineType : null };
  } catch (err) {
    logger && logger.warn && logger.warn(`gateWhatsApp: erro inesperado no lookup (${err.message}) — fail-open`);
    return { decision: 'ALLOW', checked: false, reason: 'TWILIO_ERROR' };
  } finally {
    await acq.ticket.release();
  }
}

/**
 * WhatsApp que aparece na HOME do host é CONTATO DA PLATAFORMA, não da
 * empresa — diretórios embutem o próprio suporte em todas as páginas.
 * Memoizado por origin. Usado pelo worker social-presence (maigret).
 */
const hostBlacklistCache = new Map();
async function platformWaBlacklist(url, { signal, logger } = {}) {
  let origin = '';
  try { origin = new URL(url).origin; } catch (_e) { return new Set(); }
  if (hostBlacklistCache.has(origin)) return hostBlacklistCache.get(origin);
  const promise = (async () => {
    const html = await fetchPage(`${origin}/`, { signal });
    const set = new Set(html ? extractWaLinks(html) : []);
    if (set.size > 0) logger && logger.info && logger.info(`platformWaBlacklist ${origin}: ${[...set].join(', ')}`);
    return set;
  })();
  hostBlacklistCache.set(origin, promise);
  try {
    return await promise;
  } catch (_e) {
    hostBlacklistCache.delete(origin);
    return new Set();
  }
}

/** Domínio "da empresa" (não plataforma/redirecionador) — usado pelo chat. */
function isCompanyDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  return !/(instagram\.|facebook\.com|wikipedia\.org|chatgpt\.com|openai\.com|reddit\.com|youtube\.com|linkedin\.com|tiktok\.com|mercadolivre\.|shopee\.|amazon\.|magazineluiza|americanas\.|pinterest\.|twitter\.com|x\.com|gov\.br|cnpj|casadosdados|informecadastral|taplink\.cc|linktr\.ee|beacons\.ai|diggy\.menu|instadelivery\.com)/i.test(h);
}

// ── Executor: delega para o pipeline com fonte e score ──────────────────────
const executors = {
  async 'company.digital_presence'(task, { signal, logger, deps = {} } = {}) {
    const input = task.input || {};
    const prospect = {
      cnpj: input.cnpj || null,
      companyName: String(input.companyName || '').trim(),
      tradeName: input.tradeName || null,
      city: input.city || null,
      state: input.state || null,
      domain: input.domain || null,
    };
    if (!prospect.companyName && !prospect.cnpj && !prospect.domain) {
      return { status: 'FAILED', error: { type: 'INVALID_INPUT', message: 'company.digital_presence exige cnpj, domain ou companyName', retryable: false } };
    }

    let r;
    try {
      r = await contactDiscovery.discoverLeadContact(null, prospect, { fetchImpl: deps.fetchImpl, signal, logger });
    } catch (err) {
      logger && logger.error && logger.error(`digital_presence: falhou (${err.message})`);
      return { status: 'FAILED', error: { type: 'DISCOVERY_ERROR', message: String(err.message || err).slice(0, 200), retryable: true } };
    }

    const dp = {
      // REGRA DE OURO: whatsapp só existe quando status = 'confirmado'.
      whatsapp: r.whatsapp,
      corporate_email: r.email || null,
      corporate_email_fonte: r.email_fonte || null,
      status: r.status,
      score: r.score,
      fontes: r.fontes,
      identidade_usada: r.identidade_usada,
      motivo_descarte: r.motivo_descarte,
      nao_confirmado: r.nao_confirmado,
      domain: r.domain,
      dominio_confirmado: r.dominio_confirmado,
      search_unavailable: Boolean(r.search_unavailable),
    };
    logger && logger.info && logger.info(`digital_presence: status=${r.status} score=${r.score} whatsapp=${r.whatsapp || 'null'} email=${r.email || 'null'}`);

    return {
      status: 'COMPLETED',
      provider: 'contact.discovery',
      data: {
        digital_presence: dp,
        contacts: r.whatsapp
          ? [{ type: 'whatsapp', value: r.whatsapp, classification: 'CONFIRMED', confidence: Math.min(1, Math.max(0, r.score / 100)) }]
          : [],
      },
      facts: r.whatsapp
        ? r.fontes.map((f) => ({
            attribute: 'contact.whatsapp',
            value: r.whatsapp,
            confidence: Math.min(1, Math.max(0, r.score / 100)),
            evidence: { sourceType: f.tipo, url: f.url || null, trecho: (f.trecho || '').slice(0, 200), retrievedAt: new Date().toISOString() },
          }))
        : [],
    };
  },
};

function createDigitalPresenceWorker({ prisma, js, jsm = null, deps = {} } = {}) {
  const logger = deps.logger || require('../logger').createLogger({ component: 'worker', family: 'digital-presence' });
  const rawStore = prisma ? require('../raw-store').createRawStore({ prisma }) : null;
  const { makeResultPublisher } = require('./sdk/result-publisher');
  const runtime = createWorkerRuntime({
    name: 'digital-presence',
    filterSubject: 'enrichment.task.company.digital_presence.>',
    durable: 'enrichment-engine-company-digital-presence',
    capabilities: require('../enrichment-capabilities'),
    workerVersion: process.env.GIT_SHA || 'dev',
    deps: {
      prisma,
      js,
      jsm,
      publisher: js ? makeResultPublisher({ js }) : null,
      rawStore,
      logger,
      ...deps,
    },
  });
  runtime.registerExecutors(executors);
  return runtime;
}

// Boot direto: `node workers/digital-presence.js`
if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  (async () => {
    const prisma = new PrismaClient();
    const nc = await require('../nats-stream').connectNats({ name: 'b2base-worker-digital-presence' });
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    const runtime = createDigitalPresenceWorker({ prisma, js, jsm });
    await runtime.start();
    const shutdown = async () => {
      await runtime.stop();
      await require('../nats-stream').closeAll();
      await prisma.$disconnect().catch(() => {});
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })().catch((err) => {
    console.error(`[worker:digital-presence] falha no boot: ${err.message}`);
    process.exit(1);
  });
}

// Re-exports de compatibilidade (helpers canônicos vivem em contact-discovery;
// consumidos pelo worker social-presence, chat e testes).
module.exports = {
  executors,
  createDigitalPresenceWorker,
  extractWhatsAppFromHtml,
  extractWaLinks,
  extractWaLinksRaw,
  canonWhatsAppDigits,
  gateWhatsApp,
  platformWaBlacklist,
  isCompanyDomain,
  searchableName: contactDiscovery.searchableName,
  nameTokens: contactDiscovery.nameTokens,
  dddMatchesState: contactDiscovery.dddMatchesState,
  DDD_UF: contactDiscovery.DDD_UF,
  extractEmailsFromHtml: contactDiscovery.extractEmailsFromHtml,
};
