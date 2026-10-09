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
// Lazy: lido na HORA DA CHAMADA — testes stubam require('../searxng').searxSearch.
const searxng = require('../searxng');

const WA_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send(?:\?|&)(?:[^ ]*phone=)|whatsapp:\/\/send\?(?:[^ ]*phone=))\+?([0-9]+)/i;
const CONTACT_PATHS = ['', 'contato', 'fale-conosco', 'contact', 'contact-us'];

function extractWhatsAppFromHtml(html) {
  if (!html) return null;
  const matches = [];
  for (const m of html.matchAll(new RegExp(WA_RE.source, 'gi'))) {
    let digits = String(m[1] || '').replace(/\D/g, '');
    if (!digits) continue;
    // wa.me/988739001 (sem DDI/DDD) é inutilizável sem contexto — exige 10-13.
    if (digits.length < 10 || digits.length > 13) continue;
    // DDI estrangeiro (+91 etc.) não é WhatsApp da empresa BR — rejeita.
    if (digits.length > 11 && !digits.startsWith('55')) continue;
    matches.push(digits);
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
async function discoverDomain(companyName, { signal, searx = searxng.searxSearch } = {}) {
  let results = [];
  try {
    results = await searxng.searxSearch(`${companyName} contato`, { signal, limit: 8 });
  } catch (_e) {
    return null;
  }
  const slug = String(companyName || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
  // ≥2 tokens do nome no host (nome completo no host vale sozinho): um .com
  // genérico NÃO é evidência — spam com nome parecido virava "domain" do lead.
  const toks = nameTokens({ companyName });
  const needToks = Math.min(2, toks.length);
  const scored = results
    .map((r) => {
      try {
        const host = new URL(r.url).hostname.replace(/^www\./, '');
        const normHost = dpNormalize(host);
        const tokHits = toks.filter((t) => normHost.includes(t)).length;
        return { host, url: r.url, tokHits, score: (normHost.includes(slug) ? 2 : 0) + (host.endsWith('.com.br') || host.endsWith('.com') ? 1 : 0) };
      } catch (_e) {
        return null;
      }
    })
    .filter(Boolean)
    // Redes sociais/plataformas não são o site da empresa (caso MB: o
    // instagram do açaí virava "domain" do lead e poluía os fatos).
    .filter((s) => !JUNK_HOST_RE.test(s.host))
    .filter((s) => slug.length >= 5 ? s.score >= 2 || s.tokHits >= needToks : s.tokHits >= needToks)
    .sort((a, b) => (b.score + b.tokHits) - (a.score + a.tokHits));
  return scored[0] ? scored[0].host : null;
}

// ── Descoberta multi-fonte (2026-10-09, caso MB: açaí/delivery do interior
// NÃO tem site — o WhatsApp vive em catálogo digital da loja, link aggregators
// e snippets de busca; a descoberta antiga crawleava 1 domínio só e devolvia
// "nenhum WhatsApp encontrado" para a base inteira). Regras de SEGURANÇA:
//   - link wa.me explícito (snippet ou página) = fonte FORTE;
//   - celular formatado (DDD+9+8 dígitos) SÓ em plataforma de catálogo da
//     própria loja (diggy.menu, instadelivery etc.) = fonte MÉDIA;
//   - NUNCA extrai número solto de página genérica/diretório CNPJ — falso
//     positivo (número de outra empresa ou fragmento de CNPJ) é pior que nada;
//   - agregadores de link (taplink/linktr) só valem se o SLUG é o nome da
//     empresa; DDD tem que bater com a UF do lead quando conhecida.
const JUNK_HOST_RE = /(instagram\.|facebook\.com|wikipedia\.org|chatgpt\.com|openai\.com|reddit\.com|youtube\.com|linkedin\.com|tiktok\.com|mercadolivre\.|shopee\.|amazon\.|magazineluiza|americanas\.|pinterest\.|twitter\.com|x\.com|gov\.br|cnpj|casadosdados|informecadastral|plaync\.com|purple\.fr|sj\.se|reverso\.)/i;
const AGGREGATOR_HOST_RE = /(taplink\.cc|linktr\.ee|beacons\.ai|campsite\.bio|msha\.ke|liinks\.co|bio\.link)/i;
const CATALOG_HOST_RE = /(diggy\.menu|instadelivery\.com\.?br?|cardapioweb\.com|cardapio\.br\.com|pede\.ai|oatapp\.|sugerencia|pedidosite|cardapioonline|pedidoweb|quickd|wcardapio|garcomcdl|cardapio\.|menu\.|delivery\.)/i;
const WA_LINK_GLOBAL_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?[^"' >]*?phone=|whatsapp:\/\/send\?phone=)\+?([0-9]{10,13})/gi;
const BR_MOBILE_RE = /(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9\d{4}[\s.-]?\d{4}/g;

// DDD → UF (compacto): protege contra loja de outro estado com nome parecido.
const DDD_UF = {
  11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP',
  21: 'RJ', 22: 'RJ', 24: 'RJ', 27: 'ES', 28: 'ES', 31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG',
  35: 'MG', 37: 'MG', 38: 'MG', 41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR',
  47: 'SC', 48: 'SC', 49: 'SC', 51: 'RS', 52: 'RS', 53: 'RS', 54: 'RS', 55: 'RS',
  61: 'DF', 62: 'GO', 63: 'TO', 64: 'GO', 65: 'MT', 66: 'MT', 67: 'MS', 68: 'AC', 69: 'RO',
  71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA', 81: 'PE', 82: 'AL', 83: 'PB', 84: 'RN',
  85: 'CE', 86: 'PI', 87: 'PE', 88: 'CE', 89: 'PI', 91: 'PA', 92: 'AM', 93: 'PA', 94: 'PA',
  95: 'RR', 96: 'AP', 97: 'AM', 98: 'MA', 99: 'MA',
};

function dpNormalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Nome "de busca": fantasia quando existe; razão social sem sufixos societários. */
function searchableName({ companyName, tradeName }) {
  const fancy = String(tradeName || '').trim();
  if (fancy.length >= 3) return fancy;
  return String(companyName || '')
    .toUpperCase()
    .replace(/\s+(LTDA|ME\b|MEI|EPP|EIRELI|S\/A|SA)\b.*$/, '')
    .replace(/\s+(COMERCIO|INDUSTRIA|SERVICOS|DISTRIBUICAO|ALIMENTOS|PERFUMARIA|COSMETICOS).*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens (≥3 letras) do nome legal — gate de relevância das páginas. */
function nameTokens({ companyName }) {
  return dpNormalize(String(companyName || '').replace(/\s+(LTDA|ME\b|MEI|EPP|EIRELI|S\/A|SA)\b.*$/, ''))
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Canoniza para disparo BR: 10-11 dígitos ganham DDI 55; 12-13 só valgem se
 * JÁ começarem com 55. Número estrangeiro (ex.: +919560534592 — a Índia que o
 * crawler velho registrou como WhatsApp de "SABOR DO REINO DOS CEUS") NUNCA
 * passa: mandar para outro país queima a conta de disparo.
 */
function canonWhatsAppDigits(d) {
  const digits = digitsOnly(d);
  if (digits.length < 10 || digits.length > 13) return null;
  if (digits.length > 11 && !digits.startsWith('55')) return null;
  return digits.startsWith('55') ? digits : `55${digits}`;
}

function extractWaLinks(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(WA_LINK_GLOBAL_RE.source, 'gi'))) {
    const canon = canonWhatsAppDigits(m[1]);
    if (canon) out.push(canon);
  }
  return out;
}

/** Celular BR formatado (DDD + 9 + 8 dígitos) — SÓ para catálogo da loja. */
function extractCatalogMobiles(html) {
  const out = [];
  for (const m of html.matchAll(new RegExp(BR_MOBILE_RE.source, 'g'))) {
    const d = digitsOnly(m[0]);
    const dd = d.startsWith('55') && d.length === 13 ? d.slice(2) : d;
    if (dd.length === 11 && dd[2] === '9') out.push(`55${dd}`);
  }
  return out;
}

function dddMatchesState(phone55, state) {
  if (!state) return true; // sem UF conhecida, não filtra
  const uf = DDD_UF[digitsOnly(phone55).slice(2, 4)];
  return !uf || uf === String(state).toUpperCase().trim();
}

async function fetchPageText(url, { signal, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { Accept: 'text/html,*/*', 'Accept-Language': 'pt-BR,pt;q=0.9', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
      });
      if (!res.ok) return null;
      return await res.text();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch (_e) {
    return null;
  }
}

/**
 * Busca multi-fonte por WhatsApp da empresa (caso MB): varre snippets por
 * wa.me, crawleia os melhores candidatos (catálogo digital da loja primeiro)
 * e devolve { whatsapp, domain, sourceUrl } ou null. Nunca devolve número
 * de fonte fraca em UF diferente da do lead.
 */
/**
 * WhatsApp que aparece na HOME do host é CONTATO DA PLATAFORMA, não da
 * empresa — diretórios (GuiaPJ etc.) embutem o próprio suporte no header de
 * todas as páginas e o crawler registrou o número do GUIA como WhatsApp do
 * sushi (falso positivo real, 2026-10-09). Memoizado por host.
 */
const hostBlacklistCache = new Map();
async function platformWaBlacklist(url, { signal, logger } = {}) {
  let origin = '';
  try { origin = new URL(url).origin; } catch (_e) { return new Set(); }
  if (hostBlacklistCache.has(origin)) return hostBlacklistCache.get(origin);
  const promise = (async () => {
    const html = await fetchPageText(`${origin}/`, { signal, timeoutMs: 8000 });
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

async function discoverWhatsAppMultiSource({ companyName, tradeName, state, signal, logger }) {
  const searchName = searchableName({ companyName, tradeName });
  if (!searchName || searchName.length < 3) return null;
  const tokens = nameTokens({ companyName });
  const needTokens = Math.min(2, tokens.length);
  const slugJoined = tokens.join('');

  const strong = []; // wa.me explícito
  const weak = []; // celular em catálogo da loja
  const pushStrong = (num, url) => { if (num && !strong.some((h) => h.num === num)) strong.push({ num, url }); };
  const pushWeak = (num, url) => { if (num && !weak.some((h) => h.num === num) && dddMatchesState(num, state)) weak.push({ num, url }); };

  const catalogUrls = [];
  const generalUrls = [];
  const seenHosts = new Set();

  const queries = [
    `${searchName} whatsapp`,
    `${searchName} cardapio delivery`,
    `"${String(companyName || '').trim()}"`,
  ];
  for (const query of queries) {
    let results = [];
    try {
      results = await searxng.searxSearch(query, { signal, limit: 8 });
    } catch (_e) {
      continue;
    }
    for (const r of results) {
      for (const num of extractWaLinks(`${r.url || ''} ${r.title || ''} ${r.content || ''}`)) {
        if (dddMatchesState(num, state)) pushStrong(num, r.url || 'snippet');
      }
      if (strong.length > 0) return finish();
      let host = '';
      try {
        host = new URL(r.url).hostname.replace(/^www\./, '');
      } catch (_e) {
        continue;
      }
      if (seenHosts.has(host) || JUNK_HOST_RE.test(host)) continue;
      const hay = dpNormalize(`${host} ${r.title || ''} ${r.content || ''}`);
      if (tokens.filter((t) => hay.includes(t)).length < needTokens) continue;
      seenHosts.add(host);
      if (AGGREGATOR_HOST_RE.test(host)) {
        // agregador de links de MUITAS empresas: só vale se o slug é o nome
        const slug = dpNormalize((r.url.split(/\/+/)[2] || ''));
        if (slugJoined.length >= 5 && (slug.includes(slugJoined) || tokens.filter((t) => slug.includes(t)).length >= Math.min(2, tokens.length))) {
          catalogUrls.push(r.url);
        }
      } else if (CATALOG_HOST_RE.test(host)) {
        catalogUrls.push(r.url);
      } else {
        generalUrls.push(r.url);
      }
    }
    if (strong.length > 0) return finish();
  }

  // Crawleia até 3 páginas: catálogo da loja/agregador com slug certo primeiro.
  const crawlOrder = [...catalogUrls, ...generalUrls].slice(0, 3);
  for (const url of crawlOrder) {
    const html = await fetchPageText(url, { signal });
    if (!html) continue;
    const hay = dpNormalize(html);
    if (tokens.filter((t) => hay.includes(t)).length < needTokens) continue;
    // Número que a PLATAFORMA usa nela mesma (home do host) não é da empresa.
    const blacklist = await platformWaBlacklist(url, { signal, logger });
    for (const num of extractWaLinks(html)) {
      if (!blacklist.has(num)) pushStrong(num, url);
    }
    if (strong.length > 0) return finish();
    if (CATALOG_HOST_RE.test(url) || AGGREGATOR_HOST_RE.test(url)) {
      for (const num of extractCatalogMobiles(html)) {
        if (!blacklist.has(num)) pushWeak(num, url);
      }
    }
  }

  function finish() {
    const pick = strong[0] || weak[0] || null;
    if (!pick) return null;
    let domain = null;
    try { domain = new URL(pick.url).hostname.replace(/^www\./, ''); } catch (_e) { /* url de snippet */ }
    logger && logger.info && logger.info(`multi-source: WhatsApp ${pick.num} via ${pick.url}`);
    return { whatsapp: pick.num, domain, sourceUrl: pick.url, strength: strong.length > 0 ? 'wa_link' : 'catalog_phone' };
  }
  return finish();
}

const executors = {
  async 'company.digital_presence'(task, { signal, logger, fetchImpl = fetch, deps = {} } = {}) {
    let domain = String(task.input.domain || '').toLowerCase().trim();
    const companyName = String(task.input.companyName || '').trim();
    const tradeName = String(task.input.tradeName || '').trim();
    const state = String(task.input.state || '').trim().toUpperCase();
    if (!domain && !companyName) {
      return { status: 'FAILED', error: { type: 'INVALID_INPUT', message: 'company.digital_presence exige domain ou companyName', retryable: false } };
    }

    const found = { domain: domain || null, whatsapp: null };
    let sourceUrl = null;

    // 1) Site conhecido ou descoberto: crawlea em busca de wa.me (como antes).
    if (domain) {
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
    }

    // 2) Sem site (ou site sem WhatsApp): busca multi-fonte — snippets,
    //    catálogo digital da loja, agregadores de link com o nome no slug.
    if (!found.whatsapp && companyName) {
      const multi = await discoverWhatsAppMultiSource({ companyName, tradeName, state, signal, logger });
      if (multi) {
        found.whatsapp = multi.whatsapp;
        found.domain = found.domain || multi.domain;
        sourceUrl = multi.sourceUrl;
      }
    }

    // 3) Sem domínio ANTES da busca e nada encontrado: domínio descoberto?
    //    (mantém o fato company.domain para as próximas rodas)
    if (!domain && companyName && !found.whatsapp) {
      const disc = await discoverDomain(companyName, { signal });
      found.domain = disc;
      if (disc && !found.whatsapp) {
        // último tiro: crawleia o domínio descoberto (a busca pode não ter
        // passado por ele se o snippet não casou 2 tokens)
        const base = `https://${disc}`;
        for (const path of CONTACT_PATHS) {
          if (found.whatsapp) break;
          let html = '';
          try {
            html = await fetchPage(`${base}/${path}`, { signal, fetchImpl });
          } catch (_e) {
            continue;
          }
          if (!sourceUrl && html) sourceUrl = `${base}/${path}`;
          const wa = extractWhatsAppFromHtml(html);
          if (wa) {
            found.whatsapp = wa;
            break;
          }
        }
      }
    }
    found.domain = found.domain || domain || null;

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

    logger.info(`digital_presence ${found.domain}: WhatsApp ${waPhone} (${sourceUrl || found.domain})${gate.checked ? ` [twilio: ${gate.reason}]` : ''}`);
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
          evidence: { sourceType: 'site.crawl', url: sourceUrl || `https://${found.domain}`, retrievedAt: new Date().toISOString() } },
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
  // Gate Twilio dentro do executor: registry para rate limit/circuit breaker
  // do provider 'twilio.lookup' + cliente lookup injetável. Merge por chave
  // (mesmo padrão do workers/company-deep.js): caller vence por chave, mas um
  // execDeps parcial não apaga os defaults — registry ausente no execDeps do
  // caller NÃO deixa o gate fail-open por falta de dependência.
  const execDeps = {
    registry: deps.registry || null,
    twilioLookup,
    ...(deps.execDeps || {}),
  };
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
      ...deps,
      execDeps,
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

/**
 * Domínio "da empresa" (não é plataforma/redirecionador): usado pelo chat
 * para decidir se o domínio descoberto merece virar lead.domain. Catálogo
 * digital (diggy.menu etc.) e agregador (taplink/linktr) NÃO são o site da
 * empresa — persistir lá poluiria a chave de enriquecimento das próximas rodas.
 */
function isCompanyDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (!h) return false;
  return !JUNK_HOST_RE.test(h) && !AGGREGATOR_HOST_RE.test(h) && !CATALOG_HOST_RE.test(h);
}

module.exports = {
  executors,
  createDigitalPresenceWorker,
  extractWhatsAppFromHtml,
  discoverDomain,
  gateWhatsApp,
  isCompanyDomain,
  discoverWhatsAppMultiSource,
  // helpers puros (testes das regras de segurança da multi-fonte)
  canonWhatsAppDigits,
  extractCatalogMobiles,
  searchableName,
  nameTokens,
  dddMatchesState,
  platformWaBlacklist,
};
