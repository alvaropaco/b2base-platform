// =============================================================================
// workers/digital-presence.js — worker company.digital_presence (QA 2026-10-07,
// reclamação de usuário: o enriquecimento puxava só o fixo da Receita e
// ignorava o WhatsApp da empresa no site dela).
//
// Fluxo por lead:
//   1. domínio no input → crawla direto;
//   2. sem domínio → descobre via searxng pelo nome da empresa (1ª busca) e
//      crawla o melhor resultado (.com.br / nome no domínio preferidos).
// Procura wa.me / api.whatsapp.com / whatsapp:// no HTML (home + /contato) e,
// ANTES de publicar com prioridade (o enrichment-manager aplica na FRENTE de
// cnpjPhones — o motor de disparo WhatsApp usa cnpjPhones[0]), valida o
// número no Twilio Lookup (gate twilio-lookup.js): fixo/toll-free/inválido
// NÃO vira prioritário (whatsapp_rejected) e o lead fica com o fixo da
// Receita. Twilio ausente/indisponível → fail-open (promove como antes).
//
// APENAS lógica de negócio aqui — infra é do SDK (workers/sdk).
// Rodar: `node workers/digital-presence.js`.
// =============================================================================

const { createWorkerRuntime } = require('./sdk/runtime');
const { searxSearch } = require('../searxng');

const WA_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send(?:\?|&)(?:[^ ]*phone=)|whatsapp:\/\/send\?(?:[^ ]*phone=))\+?([0-9]+)/i;
const CONTACT_PATHS = ['', 'contato', 'fale-conosco', 'contact', 'contact-us'];

function extractWhatsAppFromHtml(html) {
  if (!html) return null;
  const matches = [];
  for (const m of html.matchAll(new RegExp(WA_RE.source, 'gi'))) {
    let digits = String(m[1] || '').replace(/\D/g, '');
    if (!digits) continue;
    // wa.me/988739001 (sem DDI/DDD) é inutilizável sem contexto — exige 10-13.
    if (digits.length >= 10 && digits.length <= 13) matches.push(digits);
  }
  if (matches.length === 0) return null;
  // Completa DDI 55 quando falta (número BR de 10-11 dígitos).
  const normalized = matches.map((d) => (d.length <= 11 && !d.startsWith('55') ? `55${d}` : d));
  return normalized[0];
}

async function fetchPage(url, { signal, fetchImpl = fetch }) {
  const res = await fetchImpl(url, { signal, redirect: 'follow', headers: { Accept: 'text/html,*/*' } });
  if (!res.ok) return '';
  return res.text();
}

/**
 * Gate Twilio Lookup: o wa.me extraído do site só vira prioritário se a linha
 * plausivelmente carrega WhatsApp. Falha de gate (Twilio sem credenciais,
 * circuito aberto, rede) = ALLOW — o gate protege contra dado ruim
 * CONFIRMADO, não contra falta de dado. Provider 'twilio.lookup' no registry
 * (rate limit/circuit breaker compartilhados, o pacote é cobrado por lookup).
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

/** Descobre o domínio da empresa pelo nome via searxng (só resulta .br/.com). */
async function discoverDomain(companyName, { signal, searx = searxSearch } = {}) {
  let results = [];
  try {
    results = await searx(`${companyName} contato`, { signal, limit: 8 });
  } catch (_e) {
    return null;
  }
  const slug = String(companyName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
  const scored = results
    .map((r) => {
      try {
        const host = new URL(r.url).hostname.replace(/^www\./, '');
        return { host, url: r.url, score: (host.includes(slug) ? 2 : 0) + (host.endsWith('.com.br') || host.endsWith('.com') ? 1 : 0) };
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored[0] && scored[0].score > 0 ? scored[0].host : null;
}

const executors = {
  async 'company.digital_presence'(task, { signal, logger, fetchImpl = fetch, deps = {} } = {}) {
    let domain = String(task.input.domain || '').toLowerCase().trim();
    const companyName = String(task.input.companyName || '').trim();
    if (!domain && !companyName) {
      return { status: 'FAILED', error: { type: 'INVALID_INPUT', message: 'company.digital_presence exige domain ou companyName', retryable: false } };
    }

    const found = { domain: domain || null, whatsapp: null };
    let sourceUrl = null;

    if (!domain && companyName) {
      domain = await discoverDomain(companyName, { signal });
      found.domain = domain;
      if (!domain) {
        // Resultado negativo válido: empresa sem presença web encontrada.
        return {
          status: 'COMPLETED',
          provider: 'site.crawl',
          data: { domain: null, digital_presence: { whatsapp: null }, contacts: [] },
          facts: [],
        };
      }
    }

    const base = `https://${domain}`;
    for (const path of CONTACT_PATHS) {
      if (found.whatsapp) break;
      let html = '';
      try {
        html = await fetchPage(`${base}/${path}`, { signal, fetchImpl });
      } catch (_e) {
        continue; // página inacessível → tenta a próxima
      }
      if (!sourceUrl && html) sourceUrl = `${base}/${path}`;
      const wa = extractWhatsAppFromHtml(html);
      if (wa) {
        found.whatsapp = wa;
        found.domain = domain;
        break;
      }
    }

    if (!found.whatsapp) {
      // Negativo válido: site não tem WhatsApp (não é falha — sem retry storm).
      return {
        status: 'COMPLETED',
        provider: 'site.crawl',
        data: { domain: found.domain, digital_presence: { whatsapp: null }, contacts: [] },
        facts: found.domain && sourceUrl
          ? [{ attribute: 'company.domain', value: found.domain, confidence: 0.6, evidence: { sourceType: 'site.crawl', url: sourceUrl, retrievedAt: new Date().toISOString() } }]
          : [],
      };
    }

    // ── Gate Twilio: número confirmadamente ruim não vira prioritário ──────
    const waPhone = `+${found.whatsapp}`;
    const gate = await gateWhatsApp(waPhone, { deps, fetchImpl, signal, logger });
    if (gate.decision === 'BLOCK') {
      // Negativo válido: o manager não promove (dp.whatsapp null) e o lead
      // mantém o fixo da Receita em cnpjPhones[0].
      logger.info(`digital_presence ${found.domain}: WhatsApp ${waPhone} rejeitado (${gate.reason}) — mantendo fila da Receita`);
      return {
        status: 'COMPLETED',
        provider: 'site.crawl',
        data: {
          domain: found.domain,
          digital_presence: { whatsapp: null, whatsapp_rejected: waPhone, rejected_reason: gate.reason },
          contacts: [],
        },
        facts: [
          ...(found.domain && sourceUrl
            ? [{ attribute: 'company.domain', value: found.domain, confidence: 0.6, evidence: { sourceType: 'site.crawl', url: sourceUrl, retrievedAt: new Date().toISOString() } }]
            : []),
          { attribute: 'contact.whatsapp.rejected', value: waPhone, confidence: 0.9,
            evidence: { sourceType: 'twilio', provider: 'twilio.lookup', retrievedAt: new Date().toISOString() } },
        ],
      };
    }

    logger.info(`digital_presence ${found.domain}: WhatsApp ${waPhone} (${sourceUrl || base})${gate.checked ? ` [twilio: ${gate.reason}]` : ''}`);
    return {
      status: 'COMPLETED',
      provider: 'site.crawl',
      data: {
        domain: found.domain,
        digital_presence: { whatsapp: waPhone },
        contacts: [{ type: 'whatsapp', value: waPhone, classification: 'FOUND', confidence: 0.8 }],
      },
      facts: [
        { attribute: 'contact.whatsapp', value: waPhone, confidence: 0.8,
          evidence: { sourceType: 'site.crawl', url: sourceUrl || base, retrievedAt: new Date().toISOString() } },
        ...(gate.checked && gate.lineType
          ? [{ attribute: 'contact.whatsapp_line_type', value: gate.lineType, confidence: 1,
              evidence: { sourceType: 'twilio', provider: 'twilio.lookup', retrievedAt: new Date().toISOString() } }]
          : []),
      ],
    };
  },
};

function createDigitalPresenceWorker({ prisma, js, jsm = null, deps = {} } = {}) {
  const logger = deps.logger || require('../logger').createLogger({ component: 'worker', family: 'digital-presence' });
  const rawStore = prisma ? require('../raw-store').createRawStore({ prisma }) : null;
  const twilioLookup = deps.twilioLookup || require('../twilio-lookup');
  const { makeResultPublisher } = require('./sdk/result-publisher');
  const runtime = createWorkerRuntime({
    name: 'digital-presence',
    // Subject real da capability: enrichment.task.company.digital_presence.v1
    // (o nome do worker NÃO é o prefixo do subject — sem este filtro explícito
    // o durable consumia o subject errado e as tasks voltavam 'sem executor').
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
      // Gate Twilio dentro do executor: registry para rate limit/circuit
      // breaker do provider 'twilio.lookup' + cliente lookup injetável.
      execDeps: { registry: deps.registry || null, twilioLookup },
      ...deps,
    },
  });
  // ANTES do return — este arquivo já quebrou uma vez com o registro depois
  // do return (c89e8d4e): worker subia, consumia nada (código morto).
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
    const registry = require('../enrichment-provider-registry').getWorkerRegistry();
    const runtime = createDigitalPresenceWorker({ prisma, js, jsm, deps: { registry } });
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

module.exports = { executors, createDigitalPresenceWorker, extractWhatsAppFromHtml, discoverDomain, gateWhatsApp };
