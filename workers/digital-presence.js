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

// Teto de custo da cadeia do gate (spec ampliar-crawl-sites-whatsapp-email):
// no máx. 2 lookups Twilio por lead — 1º rejeitado tenta o 2º, e para.
// Semântica DISTINTA de WA_CANDIDATES_MAX (contact-discovery), que é a
// LARGURA da lista de candidatos exposta: lookups reais = min(GATE_MAX_
// LOOKUPS, |wa_candidates|). Subir só este não muda nada (a lista corta em
// WA_CANDIDATES_MAX); subir só aquele não gera lookup extra (este corta).
const GATE_MAX_LOOKUPS = 2;

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
 * Implementação canônica vive em contact-discovery (usada também pela
 * busca web multi-fonte); aqui é só re-export.
 */
const platformWaBlacklist = contactDiscovery.platformWaBlacklist;

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

    // Gate Twilio Lookup em CADEIA (spec ampliar-crawl-sites-whatsapp-email):
    // wa.me raspado pode ser fixo/0800/voicemail/inválido — número
    // confirmadamente ruim NÃO é promovido (o lead mantém o fixo da Receita).
    // A descoberta agora devolve `wa_candidates` ordenado por score; o gate
    // valida ATÉ GATE_MAX_LOOKUPS (2) candidatos em cadeia até o 1º passar —
    // um landline rejeitado não mata mais a descoberta quando existe outro
    // candidato válido na fonte. Fail-open inalterado (sem credenciais, sem
    // registry, circuito aberto, erro): o candidato corrente é promovido SEM
    // gastar lookup no próximo — o gate protege contra dado ruim CONFIRMADO,
    // nunca contra falta de dado.
    let whatsapp = r.whatsapp;
    let escolhido = null; // candidato promovido pela cadeia (quando o gate rodou)
    const rejeitados = [];
    const cadeia = (Array.isArray(r.wa_candidates) && r.wa_candidates.length)
      ? r.wa_candidates
      : (whatsapp ? [{
          whatsapp,
          score: r.score,
          tipo: (r.fontes && r.fontes[0] && r.fontes[0].tipo) || 'wa_link',
          url: (r.fontes && r.fontes[0] && r.fontes[0].url) || null,
          trecho: (r.fontes && r.fontes[0] && r.fontes[0].trecho) || '',
        }] : []);
    if (deps.twilioLookup && cadeia.length) {
      // O gate assumiu o controle: a partir daqui, SÓ candidato aprovado é
      // promovido (todos rejeitados → lead mantém o fixo da Receita).
      whatsapp = null;
      let lookups = 0;
      try {
        for (const cand of cadeia) {
          if (lookups >= GATE_MAX_LOOKUPS) break; // teto de custo: 2 lookups/lead
          let gate;
          try {
            gate = await gateWhatsApp(cand.whatsapp, { deps, signal, logger });
          } catch (_e) {
            gate = { decision: 'ALLOW', checked: false, reason: 'GATE_ERROR' }; // fail-open
          }
          if (gate.checked) lookups += 1;
          if (gate.decision === 'BLOCK') {
            logger && logger.warn && logger.warn(`digital_presence: Twilio bloqueou ${cand.whatsapp} (${gate.reason})`);
            r.motivo_descarte = [...(r.motivo_descarte || []), `twilio: ${cand.whatsapp} rejeitado (${gate.reason})`];
            rejeitados.push({ whatsapp: cand.whatsapp, motivo: gate.reason, url: cand.url || null, trecho: (cand.trecho || '').slice(0, 200) });
            continue; // próximo candidato da cadeia
          }
          // ALLOW: candidato bom CONFIRMADO ou fail-open (checked=false →
          // promove o corrente como hoje, sem lookup extra no próximo).
          escolhido = cand;
          whatsapp = cand.whatsapp;
          break;
        }
      } catch (_e) { /* a cadeia NUNCA derruba a descoberta */ }
    }
    const scoreEscolhido = escolhido ? escolhido.score : r.score;
    // Fontes do número promovido: quando a cadeia promove um candidato que
    // NÃO é o 1º, as fontes do 1º (r.fontes) não servem — usa a do promovido.
    const fontesEscolhido = (escolhido && r.whatsapp && escolhido.whatsapp !== r.whatsapp)
      ? [{ tipo: escolhido.tipo, url: escolhido.url || null, trecho: escolhido.trecho || '' }]
      : r.fontes;

    const dp = {
      // REGRA DE OURO: whatsapp só existe quando status = 'confirmado'.
      whatsapp,
      corporate_email: r.email || null,
      corporate_email_fonte: r.email_fonte || null,
      status: r.status,
      score: scoreEscolhido,
      fontes: fontesEscolhido,
      identidade_usada: r.identidade_usada,
      motivo_descarte: r.motivo_descarte,
      // Evidência de rejeição da cadeia (proveniência do que o Twilio barrou).
      whatsapp_rejeitados: rejeitados,
      nao_confirmado: r.nao_confirmado,
      domain: r.domain,
      dominio_confirmado: r.dominio_confirmado,
      search_unavailable: Boolean(r.search_unavailable),
    };
    logger && logger.info && logger.info(`digital_presence: status=${r.status} score=${scoreEscolhido} whatsapp=${whatsapp || 'null'} email=${r.email || 'null'}${rejeitados.length ? ` twilio_rejeitou=${rejeitados.length}` : ''}`);

    const confianca = Math.min(1, Math.max(0, scoreEscolhido / 100));
    const agora = new Date().toISOString();
    return {
      status: 'COMPLETED',
      provider: 'contact.discovery',
      data: {
        digital_presence: dp,
        contacts: whatsapp
          ? [{ type: 'whatsapp', value: whatsapp, classification: 'CONFIRMED', confidence: confianca }]
          : [],
      },
      facts: [
        ...(whatsapp ? (fontesEscolhido || []).map((f) => ({
          attribute: 'contact.whatsapp',
          value: whatsapp,
          confidence: confianca,
          evidence: { sourceType: f.tipo, url: f.url || null, trecho: (f.trecho || '').slice(0, 200), retrievedAt: agora },
        })) : []),
        // Proveniência do e-mail (spec): fact com evidence (sourceType/url) —
        // o manager propaga facts genericamente para o enrichmentSummary.v2.
        ...(r.email ? [{
          attribute: 'contact.email',
          value: r.email,
          confidence: r.email_fonte_tipo === 'receita' ? 0.6 : 0.8,
          evidence: { sourceType: r.email_fonte_tipo || 'site_oficial', url: r.email_fonte || null, retrievedAt: agora },
        }] : []),
      ],
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
