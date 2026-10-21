'use strict';

/**
 * workers/contact-discovery.js — descoberta de contato com FONTE e SCORE.
 *
 * REGRA DE OURO (2026-10-14, refactor do enriquecimento): nenhum número pode
 * ser gerado/inventado. Todo candidato carrega a URL da FONTE e o TRECHO
 * literal onde o número aparece; a identidade do lead é confirmada ANTES da
 * busca (CNPJ→BrasilAPI > domínio > nome+cidade+UF) e todo número é
 * normalizado/validado (libphonenumber) e pontuado. Sem fonte → null +
 * status "nao_encontrado". Retornar vazio é sempre melhor que errado.
 *
 * Módulo PURO (sem NATS/prisma obrigatório): fetch injetável para testes.
 * Consumido pelo executor company.digital_presence (workers/digital-presence.js).
 */

const libphonenumber = require('google-libphonenumber');
const searxng = require('../searxng');

const phoneUtil = libphonenumber.PhoneNumberUtil.getInstance();
const PhoneNumberFormat = libphonenumber.PhoneNumberFormat;
const PhoneNumberType = libphonenumber.PhoneNumberType;

// ── Tabela oficial DDD → UF (Brasil tem exatamente estes DDDs) ──────────────
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

const SITE_CONTACT_PATHS = ['', 'contato', 'fale-conosco'];
// ── Crawl interno (2026-10-15 — "entrar no site de verdade") ────────────────
// Home + /contato não bastam: muito site esconde o WhatsApp em /atendimento,
// /orcamento, páginas de unidade/filial. Seguimos links internos de contato
// com orçamento fechado — o timeout da capability (60s) cobre o resto do
// pipeline (Places/CNPJ/Instagram/Twilio).
// 2026-10-16 (spec ampliar-crawl-sites-whatsapp-email): 5→12 páginas com
// concorrência ≤3 (~2× páginas no MESMO teto de 16s/lead) e o crawl NÃO
// aborta mais na 1ª wa.me — as internas são a principal fonte de e-mail
// (contato@/comercial@); parar cedo é deixar resultado na mesa. Parada só
// por orçamento/teto de páginas.
// 2026-10-19 (aprofundar): crawl em 2 ONDAS — as páginas da 1ª onda também
// doam links (ex.: /unidades → /unidade-sao-jose com o WhatsApp da filial;
// /sobre → /equipe com o comercial@). Teto 12→20 páginas TOTAIS repartido
// entre as ondas; orçamento/concorrência/cap de bytes intocados — quem corta
// continua sendo o relógio, não o site.
const CRAWL_EXTRA_PATHS = ['atendimento', 'orcamento', 'sac', 'unidades', 'contate'];
const CRAWL_MAX_EXTRA_PAGES = 20;
// Profundidade máxima: 1 = links das páginas fixas (era o limite), 2 = uma
// ondinha a mais a partir das internas. BFS em ondas, nunca em profundidade
// infinita — perímetro segue sendo o MESMO domínio.
const CRAWL_MAX_DEPTH = 2;
const SITE_CRAWL_CONCURRENCY = 3;
// Cap de bytes por página (~512 KB — lição OOM ee3f2ce0): página gigante é
// cortada e o INÍCIO é parseado (nav/header é onde vivem os contatos).
const MAX_PAGE_BYTES = 512 * 1024;
const CRAWL_BUDGET_MS = 15000;
const CRAWL_PAGE_TIMEOUT_MS = 8000;
// Orçamento do ESTÁGIO site inteiro (caminhos fixos + crawl) quando o caller
// informa o início do lead — deixa o restante do timeout de 30s para as
// fontes que vêm depois (Places, Instagram) e o gate Twilio.
const SITE_STAGE_BUDGET_MS = 16000;
// Largura da lista de candidatos exposta p/ a cadeia do gate Twilio —
// semântica DISTINTA de GATE_MAX_LOOKUPS (workers/digital-presence.js), que
// é o teto de CUSTO em lookups: lookups reais = min(GATE_MAX_LOOKUPS,
// |wa_candidates|). Subir só este NÃO gera lookup extra (o gate corta em
// GATE_MAX_LOOKUPS); subir só aquele não alcança candidatos além deste.
const WA_CANDIDATES_MAX = 2;

// ── Busca web multi-fonte (2026-10-15 — "ampliar a área de busca") ──────────
// Porta do estágio caso MB (2026-10-09, derrubado pelo refactor de 14/10):
// varre SNIPPETS de busca (SearXNG+DuckDuckGo) por wa.me e crawleia os
// melhores resultados — catálogo digital da loja (diggy.menu, instadelivery
// etc.) e agregador de links (taplink/linktr com slug do nome). Regras:
//   - link wa.me explícito (snippet ou página) com identidade ok = FORTE;
//   - celular formatado SÓ em catálogo/agregador da própria loja = MÉDIO;
//   - NUNCA número solto de página genérica/diretório (falso positivo pior
//     que nada — caso Ninas × O Pensador);
//   - WhatsApp da PLATAFORMA na home do host é blacklisted (caso GuiaPJ);
//   - DDD tem que bater com a UF quando conhecida.
const WEBSEARCH_QUERIES_EXTRA = ['cardapio delivery'];
const WEBSEARCH_CRAWL_MAX = 3;
const WEBSEARCH_STAGE_BUDGET_MS = 12000;
const WEBSEARCH_PAGE_TIMEOUT_MS = 8000;
const AGGREGATOR_HOST_RE = /(taplink\.cc|linktr\.ee|beacons\.ai|campsite\.bio|msha\.ke|liinks\.co|bio\.link)/i;
const CATALOG_HOST_RE = /(diggy\.menu|instadelivery\.com\.?br?|cardapioweb\.com|cardapio\.br\.com|pede\.ai|oatapp\.|sugerencia|pedidosite|cardapioonline|pedidoweb|quickd|wcardapio|garcomcdl|cardapio\.|menu\.|delivery\.)/i;
const BR_MOBILE_RE = /(?:\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9\d{4}[\s.-]?\d{4}/g;
const CRAWL_LINK_RE = /<a\s[^>]*href\s*=\s*["']([^"'\s#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
const CRAWL_PRIO_RE = /(contat|fale|whats|w\.me|zap|sac|atendiment|orcament|unidade|filial|loja|quem-?somos|sobre-nos|a-?empresa|equipe|converse|falan)/i;
const CRAWL_SKIP_RE = /\.(pdf|jpe?g|png|gif|webp|svg|css|js|mjs|zip|rar|mp[34]|xml|rss|ico|woff2?)($|\?)|(wp-admin|wp-login|xmlrpc\.php|\/feed)($|\/|\?)|\b(facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\b/i;
const WA_LINKS_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?[^"' >]*?phone=|web\.whatsapp\.com\/send\?[^"' >]*?phone=|whatsapp:\/\/send\?phone=)\+?([0-9]{10,13})/gi;
// 4-5 dígitos no 1º grupo: pega o formato mobile BR padrão "97654-3210"
// (5+4) SEM perder o fixo "3456-7890" (4+4). Falsos positivos ficam por
// conta dos gates de jusante: 10-13 dígitos + libphonenumber + DDD×UF +
// anti-alucinação (dígitos literais no trecho).
const BR_PHONE_RE = /\(?\d{2}\)?[\s.-]?\d{4,5}[-.\s]?\d{4}/g;
const WHATS_KEYWORD_RE = /whats[a-zç]*|w\.me|\bzap\b/gi;
// Local part limitado a 64 (RFC 5321) e casamento ancorado num separador
// (fim de string ou caractere fora do local part): SEM isso, o
// `[a-z0-9._%+-]+` retrocede por posição num run longo de caracteres
// não-e-mail (JS minificado/base64) → O(n²) de CPU queima o worker mesmo
// com o cap de bytes (lição da página gigante, 2026-10-16).
const EMAIL_RE = /(?:^|[^a-z0-9._%+-])([a-z0-9._%+-]{1,64}@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi;
const EMAIL_JUNK_RE = /(noreply|no-reply|nao-?responda|donotreply|postmaster|abuse|webmaster|hostmaster|sentry|wixpress|example\.|wordpress|godaddy|\.png$|\.jpe?g$|\.gif$|\.webp$|\.svg$)/i;
const EMAIL_CONTACT_PREF_RE = /^(contato|contact|comercial|vendas|financeiro|info|informacoes|fale|oi|ola|atendimento|diretoria|sac)/i;
const JUNK_HOST_RE = /(instagram\.|facebook\.com|wikipedia\.org|chatgpt\.com|openai\.com|reddit\.com|youtube\.com|linkedin\.com|tiktok\.com|mercadolivre\.|shopee\.|amazon\.|pinterest\.|twitter\.com|x\.com|gov\.br|cnpj|casadosdados|informecadastral)/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// ── helpers puros ────────────────────────────────────────────────────────────
function dpNormalize(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function digitsOnly(v) {
  return String(v || '').replace(/\D/g, '');
}
function cleanDomain(v) {
  return String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
/** Nome de busca: fantasia vence; razão social sem sufixos societários. */
function searchableName({ companyName, tradeName } = {}) {
  const fancy = String(tradeName || '').trim();
  if (fancy.length >= 3) return fancy;
  return String(companyName || '')
    .toUpperCase()
    .replace(/\s+(LTDA|ME\b|MEI|EPP|EIRELI|S\/A|SA)\b.*$/, '')
    .replace(/\s+(COMERCIO|INDUSTRIA|SERVICOS|DISTRIBUICAO|ALIMENTOS|PERFUMARIA|COSMETICOS).*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/** Tokens (≥3 letras) do nome legal — usado nos gates de identidade. */
function nameTokens({ companyName } = {}) {
  return dpNormalize(String(companyName || '').replace(/\s+(LTDA|ME\b|MEI|EPP|EIRELI|S\/A|SA)\b.*$/, ''))
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}
/** DDD existe e bate com a UF (quando a UF é conhecida). */
function dddMatchesState(phoneE164, state) {
  const ddd = digitsOnly(phoneE164).slice(2, 4);
  const uf = DDD_UF[ddd];
  if (!uf) return false; // DDD inexistente = fragmento/lixo
  if (state && uf !== String(state).toUpperCase().trim()) return false;
  return true;
}

/**
 * E-mails públicos da página (mailto + texto), sem lixo. Melhor primeiro:
 * domínio igual ao do host, depois prefixos de contato, depois demais.
 */
function extractEmailsFromHtml(html, { hostDomain } = {}) {
  if (!html) return [];
  const raw = new Set();
  for (const m of html.matchAll(/mailto:\s*([a-z0-9._%+-]{1,64}@[a-z0-9.-]+\.[a-z]{2,})/gi)) raw.add(m[1].toLowerCase());
  for (const m of html.matchAll(new RegExp(EMAIL_RE.source, 'gi'))) raw.add(m[1].toLowerCase());
  const clean = [...raw].filter((e) => !EMAIL_JUNK_RE.test(e));
  const score = (e) => {
    let n = 0;
    const dom = e.split('@')[1] || '';
    if (hostDomain && dom && (hostDomain.includes(dom) || dom.includes(hostDomain))) n -= 4;
    if (EMAIL_CONTACT_PREF_RE.test(e.split('@')[0])) n -= 2;
    return n;
  };
  return clean.sort((a, b) => score(a) - score(b)).slice(0, 5);
}

/**
 * Corpo da resposta limitado a `maxBytes` (lição OOM ee3f2ce0), cortado em
 * BYTES. Com stream: lê em chunks até o teto (cancel aguardado — rejeição
 * de cancel vira unhandled rejection e derruba o worker); se `read()`
 * rejeitar no meio (rede caiu), DECODIFICA E DEVOLVE o parcial já
 * bufferizado — o body ficou locked, `res.text()` lançaria e o trabalho
 * feito seria descartado. Sem stream (stubs de teste): corta o texto por
 * bytes (Buffer.byteLength/subarray), não por caracteres.
 */
async function readBodyCapped(res, maxBytes) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let capped = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) { capped = true; break; }
      }
    } catch (_e) {
      /* parcial bufferizado vale mais que nada — segue para o decode */
    }
    if (capped) {
      try { await reader.cancel(); } catch (_e) { /* stream já encerrado */ }
    }
    const buf = new Uint8Array(Math.min(total, maxBytes));
    let off = 0;
    for (const c of chunks) {
      if (off >= buf.length) break;
      const slice = c.byteLength > buf.length - off ? c.subarray(0, buf.length - off) : c;
      buf.set(slice, off);
      off += slice.length;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  return Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8');
}

/** Concorrência limitada: até `limit` workers consomem a lista em ordem. */
async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        await fn(items[i], i);
      } catch (_e) { /* item problemático não derruba o lote */ }
    }
  });
  await Promise.all(workers);
}

async function fetchPageText(url, { fetchImpl = fetch, signal, timeoutMs = 12000 } = {}) {
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
        headers: { Accept: 'text/html,*/*', 'Accept-Language': 'pt-BR,pt;q=0.9', 'User-Agent': UA },
      });
      if (!res.ok) return null;
      return await readBodyCapped(res, MAX_PAGE_BYTES);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch (_e) {
    return null;
  }
}

async function fetchJson(url, { fetchImpl = fetch, signal, timeoutMs = 12000 } = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch (_e) {
    return null;
  }
}

// ── ETAPA 1 — Resolução de identidade ───────────────────────────────────────
/**
 * Confirma QUAL empresa é o lead antes de buscar qualquer contato.
 * Força: CNPJ (BrasilAPI) > domínio do cadastro > nome+cidade+UF.
 */
async function resolveIdentity(prisma, prospect, { fetchImpl = fetch, signal, logger } = {}) {
  const p = prospect || {};
  const identidade = {
    cnpj: digitsOnly(p.cnpj).length === 14 ? digitsOnly(p.cnpj) : null,
    razao_social: null,
    nome_fantasia: String(p.tradeName || '').trim() || null,
    dominio: cleanDomain(p.domain),
    dominio_confirmado: false, // true = domínio do cadastro e o site responde
    cidade: String(p.city || '').trim() || null,
    uf: String(p.state || '').trim().toUpperCase() || null,
    endereco: null,
    telefone_cnpj: null,
    email_cnpj: null,
    cnpj_confirmado: false,
    nome_busca: searchableName(p),
  };

  // 1) CNPJ → BrasilAPI (mais forte). Falha da API NUNCA derruba a busca:
  //    segue com a identidade do cadastro (nível fraco) sinalizada.
  if (identidade.cnpj) {
    const data = await fetchJson(`https://brasilapi.com.br/api/cnpj/v1/${identidade.cnpj}`, { fetchImpl, signal });
    if (data && data.razao_social) {
      identidade.cnpj_confirmado = true;
      identidade.razao_social = data.razao_social || null;
      identidade.nome_fantasia = data.nome_fantasia || identidade.nome_fantasia;
      if (data.municipio) identidade.cidade = data.municipio;
      if (data.uf) identidade.uf = data.uf;
      identidade.endereco = [
        data.descricao_tipo_de_logradouro, data.logradouro, data.numero, data.bairro,
        data.cep ? `CEP ${data.cep}` : null,
      ].filter(Boolean).join(', ') || null;
      identidade.telefone_cnpj = data.ddd_telefone_1 ? String(data.ddd_telefone_1) : null;
      if (data.email && !EMAIL_JUNK_RE.test(String(data.email))) identidade.email_cnpj = String(data.email).toLowerCase();
      identidade.fontes_confirmacao = ['brasilapi'];
      logger && logger.info && logger.info(`identidade: CNPJ ${identidade.cnpj} confirmado (BrasilAPI) — ${identidade.razao_social}`);
    } else {
      logger && logger.warn && logger.warn('identidade: BrasilAPI indisponível/sem dados — seguindo com cadastro');
    }
  }

  // 2) Domínio: confirmado quando é do CADASTRO e o site responde.
  if (identidade.dominio) {
    const html = await fetchPageText(`https://${identidade.dominio}/`, { fetchImpl, signal, timeoutMs: 10000 });
    identidade.dominio_confirmado = Boolean(html && html.length > 50);
  }
  return identidade;
}

/** URL normalizada p/ dedupe de crawl: sem hash e sem barra final. Null = inválida. */
function normUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.href.replace(/\/$/, '');
  } catch (_e) {
    return null;
  }
}

/**
 * Links internos promissores de uma página (crawl de contato): mesmo host
 * (subdomínio do domínio vale — o gate "oficial" já usa includes), fora
 * assets/anexos/redes sociais, priorizados por palavra de contato na URL
 * ou no texto do anchor.
 */
function extractInternalLinks(html, pageUrl, dominio) {
  const out = new Map();
  const dom = String(dominio || '').replace(/^www\./, '');
  const hostOk = (h) => {
    const clean = String(h || '').replace(/^www\./, '');
    return dom && (clean === dom || clean.endsWith(`.${dom}`));
  };
  for (const m of html.matchAll(CRAWL_LINK_RE)) {
    const rawHref = m[1];
    const text = dpNormalize(String(m[2] || '').replace(/<[^>]+>/g, ' '));
    if (/^(mailto:|tel:|javascript:|data:)/i.test(rawHref)) continue;
    let u;
    try { u = new URL(rawHref, pageUrl); } catch (_e) { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (!hostOk(u.hostname)) continue;
    const norm = normUrl(u.href);
    if (!norm || norm.length > 200) continue;
    if (CRAWL_SKIP_RE.test(norm)) continue;
    if (out.has(norm)) continue;
    const pathLower = u.pathname.toLowerCase();
    const prio = (CRAWL_PRIO_RE.test(pathLower) ? 1 : 0) + (text && CRAWL_PRIO_RE.test(text) ? 1 : 0);
    out.set(norm, { url: norm, prio });
  }
  return [...out.values()];
}

// ── ETAPA 2 — Coleta de candidatos (fontes determinísticas) ─────────────────
/**
 * a) Site oficial: home + /contato + /fale-conosco (concorrência ≤3) e CRAWL
 *    INTERNO com orçamento seguindo links internos de contato (atendimento,
 *    orçamento, unidades, âncoras "fale conosco"…). O crawl roda SEMPRE que
 *    há orçamento — mesmo depois de achar wa.me — porque as páginas internas
 *    são a principal fonte de e-mail corporativo. Parada só por
 *    orçamento/teto de páginas.
 *    Extração via REGEX (wa.me/api.whatsapp/web.whatsapp + números perto de
 *    "whats|zap"). Cada candidato carrega URL + TRECHO literal. Coleta também
 *    e-mails e o link do Instagram (para a fonte 2d).
 */
async function collectFromSite(identidade, { fetchImpl = fetch, signal, logger, startedAt = null } = {}) {
  const out = { candidates: [], pages: [], instagramHandle: null, emails: [] };
  let dominio = identidade.dominio;

  // Fallback de domínio (busca) — MARCADO não-confirmado: nunca habilita o
  // score 95 (site oficial confirmado). Sem isso, homônimo virava fonte.
  if (!dominio) {
    try {
      const results = await searxng.searxSearch(`${identidade.nome_busca} contato`, { signal, limit: 8 });
      const slug = dpNormalize(identidade.nome_busca);
      for (const r of results) {
        let host = '';
        try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_e) { continue; }
        if (JUNK_HOST_RE.test(host)) continue;
        const hay = dpNormalize(`${host} ${r.title || ''} ${r.content || ''}`);
        const toks = nameTokens({ companyName: identidade.razao_social || identidade.nome_busca });
        if (toks.filter((t) => hay.includes(t)).length < Math.min(2, Math.max(1, toks.length))) continue;
        dominio = host;
        break;
      }
    } catch (_e) { /* sem busca — dominio segue null */ }
    if (dominio) logger && logger.info && logger.info(`domínio por busca (NÃO confirmado): ${dominio}`);
  }
  if (!dominio) return out;

  const base = `https://${dominio}`;

  /** Extração por página (wa_link + wa_contexto) — compartilhada fixos × crawl. */
  const harvest = (html, url, ord) => {
    // wa.me / api.whatsapp / web.whatsapp → candidato tipo wa_link
    for (const m of html.matchAll(new RegExp(WA_LINKS_RE.source, 'gi'))) {
      const raw = digitsOnly(m[1]);
      if (!raw || raw.length < 10) continue;
      const trecho = html.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).replace(/\s+/g, ' ').trim();
      out.candidates.push({ raw, tipo: 'wa_link', url, trecho, host: dominio, ord });
    }
    // Números perto de "WhatsApp|Whats|Zap" → tipo wa_contexto
    for (const kw of html.matchAll(WHATS_KEYWORD_RE)) {
      const win = html.slice(Math.max(0, kw.index - 120), kw.index + 200);
      for (const ph of win.matchAll(new RegExp(BR_PHONE_RE.source, 'g'))) {
        const raw = digitsOnly(ph[0]);
        if (raw.length < 10 || raw.length > 13) continue;
        const trecho = win.slice(Math.max(0, ph.index - 40), ph.index + ph[0].length + 40).replace(/\s+/g, ' ').trim();
        out.candidates.push({ raw, tipo: 'wa_contexto', url, trecho, host: dominio, ord });
      }
    }
  };
  const captureMeta = (html, url, ord) => {
    if (!out.instagramHandle) {
      const ig = html.match(/instagram\.com\/([A-Za-z0-9_.]{2,40})/i);
      if (ig && !/\/p\//.test(ig[0])) out.instagramHandle = ig[1].replace(/\.$/, '');
    }
    out.emails.push(...extractEmailsFromHtml(html, { hostDomain: dominio }).map((e) => ({ email: e, url, ord })));
  };
  // Fetch paralelo ≠ conclusão paralela: cada página carrega sua ordem de
  // SUBMISSÃO (ord) e as acumulações são reordenadas por ela antes do
  // retorno — emailPick (emails[0]) e os empates de score têm que ser
  // determinísticos entre runs (o fill-if-empty do manager eterniza o vencedor).
  let seq = 0;
  const processPage = async (url, { timeoutMs } = {}) => {
    const ord = seq++;
    const html = await fetchPageText(url, { fetchImpl, signal, timeoutMs });
    if (!html) return null;
    out.pages.push({ url, html });
    captureMeta(html, url, ord);
    harvest(html, url, ord);
    return { url, html };
  };

  // Caminhos fixos em paralelo (concorrência ≤3): 3 páginas no tempo de ~1.
  await mapLimit(SITE_CONTACT_PATHS, SITE_CRAWL_CONCURRENCY, (path) => processPage(`${base}/${path}`));

  // ── Crawl interno em ONDAS: SEMPRE roda (orçamento permitting) ──────────────
  // As internas são a principal fonte de contato@; parar na 1ª wa.me deixava
  // o e-mail na mesa (matrix "WA na home, e-mail na interna"). 2026-10-19:
  // 2 ondas — páginas da onda 1 doam os links delas (profundidade 2), teto
  // de páginas TOTAIS e orçamento compartilhados entre as ondas.
  if (out.pages.length) {
    const visited = new Set(out.pages.map((p) => normUrl(p.url)).filter(Boolean));
    const seen = new Set(visited);
    const enqueueNew = (links, into) => {
      for (const l of links) {
        if (seen.has(l.url)) continue;
        seen.add(l.url);
        into.push(l.url);
      }
    };
    const crawlStartedAt = Date.now();
    // Orçamento do ESTÁGIO site relativo ao INÍCIO do lead (quando o caller
    // informa startedAt): o crawl não pode comer o tempo de Places/CNPJ/
    // Instagram/Twilio — leads que demoram na home ficavam sem nenhuma
    // outra fonte (abort de 30s do enrich-base matava o lead no meio).
    const stageStartedAt = Number.isFinite(startedAt) ? startedAt : crawlStartedAt;
    const stageDeadline = stageStartedAt + (Number.isFinite(startedAt) ? SITE_STAGE_BUDGET_MS : CRAWL_BUDGET_MS);
    let crawled = 0;
    // Uma onda: fatia do teto que SOBROU (compartilhado entre ondas),
    // concorrência ≤3, checagem de orçamento antes de CADA fetch — páginas
    // em voo terminam pelo próprio timeout (≤8s). Determinística: a lista de
    // páginas buscadas vem na ordem da fila, não na ordem de conclusão.
    const crawlWave = async (queue) => {
      const slice = queue.slice(0, Math.max(0, CRAWL_MAX_EXTRA_PAGES - crawled));
      const fetchedPages = new Array(slice.length);
      await mapLimit(slice, SITE_CRAWL_CONCURRENCY, async (url, i) => {
        if (signal && signal.aborted) return;
        if (Date.now() > stageDeadline) return;
        crawled += 1;
        fetchedPages[i] = await processPage(url, { timeoutMs: CRAWL_PAGE_TIMEOUT_MS });
        // SEM aborto na 1ª wa.me: segue para colher e-mails nas demais páginas
        // (parada só por orçamento/teto de páginas).
      });
      return fetchedPages.filter(Boolean);
    };

    // ONDA 1 — links das páginas fixas (home/contato/fale-conosco) +
    // caminhos brasileiros comuns que nem sempre estão no menu.
    const wave1 = [];
    for (const p of out.pages) wave1.push(...extractInternalLinks(p.html, p.url, dominio));
    wave1.sort((a, b) => b.prio - a.prio);
    const queue1 = [];
    enqueueNew(wave1, queue1);
    for (const extra of CRAWL_EXTRA_PATHS) {
      const url = normUrl(`${base}/${extra}`);
      if (url && !seen.has(url)) {
        seen.add(url);
        queue1.push(url);
      }
    }
    const wave1Pages = await crawlWave(queue1);

    // ONDA 2 (profundidade 2): as internas da onda 1 doam os links delas —
    // /unidades → /unidade-sao-jose com o WhatsApp da filial, /sobre →
    // /equipe com o comercial@. Doação determinística (ordem da fila da
    // onda 1; prio dentro de cada página) e MESMO teto/orçamento.
    if (wave1Pages.length) {
      const wave2 = [];
      for (const p of wave1Pages) wave2.push(...extractInternalLinks(p.html, p.url, dominio));
      wave2.sort((a, b) => b.prio - a.prio);
      const queue2 = [];
      enqueueNew(wave2, queue2);
      await crawlWave(queue2);
    }
    logger && logger.info && logger.info(`crawl interno ${dominio}: ${crawled} página(s) extra(s)`);
  }

  // Reordena por SUBMISSÃO (estável — ordem dentro da página preservada): a
  // conclusão do fetch paralelo não pode definir emails[0] nem empates de score.
  out.emails.sort((a, b) => a.ord - b.ord);
  out.candidates.sort((a, b) => a.ord - b.ord);
  logger && logger.info && logger.info(`site ${dominio}: ${out.candidates.length} candidato(s) em ${out.pages.length} página(s)`);
  return out;
}

/** b) Google Places (Text Search + Details) — só com cidade/endereço batendo. */
async function collectFromGooglePlaces(identidade, { fetchImpl = fetch, signal, apiKey = process.env.GOOGLE_PLACES_API_KEY, logger } = {}) {
  const out = { candidates: [], motivo_ausencia: null };
  if (!apiKey) {
    out.motivo_ausencia = 'GOOGLE_PLACES_API_KEY não configurada — fonte pulada';
    return out;
  }
  const query = [identidade.nome_busca, identidade.cidade, identidade.uf].filter(Boolean).join(' ');
  const search = await fetchJson(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`,
    { fetchImpl, signal }
  );
  const hit = search && Array.isArray(search.results) && search.results[0];
  if (!hit || !hit.place_id) {
    out.motivo_ausencia = 'Google Places sem resultado';
    return out;
  }
  const details = await fetchJson(
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(hit.place_id)}&fields=formatted_phone_number,formatted_address&key=${apiKey}`,
    { fetchImpl, signal }
  );
  const d = details && details.result;
  if (!d || !d.formatted_phone_number) {
    out.motivo_ausencia = 'Google Places sem telefone no place';
    return out;
  }
  // Gate: o endereço do place tem que citar a cidade/UF da identidade.
  const addrNorm = dpNormalize(d.formatted_address || '');
  const cityOk = identidade.cidade && addrNorm.includes(dpNormalize(identidade.cidade));
  const ufOk = identidade.uf && addrNorm.includes(String(identidade.uf).toLowerCase());
  if (!cityOk && !ufOk) {
    out.motivo_ausencia = `Google Places: endereço "${d.formatted_address}" não bate com a identidade`;
    logger && logger.warn && logger.warn(out.motivo_ausencia);
    return out;
  }
  out.candidates.push({
    raw: digitsOnly(d.formatted_phone_number),
    tipo: 'google_places',
    url: `https://maps.googleapis.com/maps/api/place/details/json?place_id=${hit.place_id}`,
    trecho: `telefone ${d.formatted_phone_number} — endereço ${d.formatted_address}`,
    host: 'maps.googleapis.com',
    endereco_bate: true,
  });
  return out;
}

/** c) Telefone do CNPJ (BrasilAPI) — costuma ser fixo/desatualizado: peso baixo. */
function collectFromCnpj(identidade) {
  const raw = digitsOnly(identidade.telefone_cnpj);
  if (raw.length < 10) return { candidates: [] };
  // ddd_telefone_1 vem sem DDI (ex.: "1637112002") — parse com região BR.
  // O trecho carrega o telefone LITERAL: a checagem anti-alucinação confere
  // os dígitos contra a fonte (aqui, o próprio JSON da BrasilAPI).
  return { candidates: [{ raw, tipo: 'cnpj', url: identidade.cnpj ? `https://brasilapi.com.br/api/cnpj/v1/${identidade.cnpj}` : null, trecho: `ddd_telefone_1 = ${identidade.telefone_cnpj} (BrasilAPI, CNPJ ${identidade.cnpj})`, host: 'brasilapi.com.br' }] };
}

/** d) Instagram — SÓ se o perfil vier linkado pelo site oficial. */
async function collectFromInstagram(identidade, site, { fetchImpl = fetch, signal, logger } = {}) {
  const out = { candidates: [], emails: [] };
  if (!site.instagramHandle) return out;
  const url = `https://www.instagram.com/${site.instagramHandle}/`;
  const html = await fetchPageText(url, { fetchImpl, signal, timeoutMs: 10000 });
  if (!html) return out; // login-wall/404 → skip honesto
  const og = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
  const bio = og ? og[1] : '';
  const emails = extractEmailsFromHtml(bio || html.slice(0, 200000), {});
  for (const m of (bio || '').matchAll(new RegExp(BR_PHONE_RE.source, 'g'))) {
    const raw = digitsOnly(m[0]);
    if (raw.length < 10 || raw.length > 13) continue;
    out.candidates.push({
      raw, tipo: 'instagram', url, trecho: `bio do Instagram (@${site.instagramHandle}): ${m[0]}`, host: 'instagram.com',
    });
  }
  // E-mail da bio NÃO é mais descartado (2026-10-19): muita loja publica o
  // comercial@ SÓ no Instagram. Segue literal na fonte, com a URL do perfil
  // — o emailPick do orquestrador usa como fallback depois do site oficial.
  for (const email of emails) {
    out.candidates.push({ raw: null, email, tipo: 'instagram', url, trecho: `bio do Instagram (@${site.instagramHandle})`, host: 'instagram.com' });
    out.emails.push({ email, url });
  }
  if (!out.candidates.length) logger && logger.info && logger.info('instagram: perfil sem telefone/e-mail público na bio');
  return out;
}

// ── Fonte: busca web multi-fonte (snippets, catálogos, agregadores) ─────────

/** Canoniza para disparo BR: 10-11 dígitos ganham 55; 12-13 só se já 55. */
function canonWhatsAppDigits(v) {
  const digits = digitsOnly(v);
  if (digits.length < 10 || digits.length > 13) return null;
  if (digits.length > 11 && !digits.startsWith('55')) return null;
  return digits.startsWith('55') ? digits : `55${digits}`;
}

/**
 * O resultado/página é SOBRE a empresa? (url+título com ≥2 tokens do nome, ou
 * 1 no hay + 1 no host). Listamentos de diretório citam o lead no CONTEÚDO
 * mas não na identidade — sem esse gate o número extraído era do restaurante
 * ERRADO (caso Ninas × O Pensador).
 */
function identityOk({ host, url, title }, tokens) {
  const identityHay = dpNormalize(`${url || ''} ${title || ''}`);
  const identityTok = tokens.filter((t) => identityHay.includes(t)).length;
  if (identityTok >= Math.min(2, tokens.length)) return true;
  if (identityTok < 1) return false;
  const hostTok = tokens.filter((t) => dpNormalize(host || '').includes(t)).length;
  return hostTok >= 1;
}

/** Celular BR formatado (DDD + 9 + 8) COM o trecho literal (anti-alucinação). */
function extractCatalogMobiles(html) {
  const out = [];
  for (const m of html.matchAll(new RegExp(BR_MOBILE_RE.source, 'g'))) {
    const d = digitsOnly(m[0]);
    const dd = d.startsWith('55') && d.length === 13 ? d.slice(2) : d;
    if (dd.length === 11 && dd[2] === '9') out.push({ num: `55${dd}`, trecho: m[0] });
  }
  return out;
}

/**
 * WhatsApp que aparece na HOME do host é CONTATO DA PLATAFORMA, não da
 * empresa — diretórios embutem o próprio suporte no header (caso GuiaPJ:
 * o número do GUIA virou WhatsApp do sushi). Memoizado por origin.
 */
const platformWaCache = new Map();
async function platformWaBlacklist(url, { signal, logger } = {}) {
  let origin = '';
  try { origin = new URL(url).origin; } catch (_e) { return new Set(); }
  if (platformWaCache.has(origin)) return platformWaCache.get(origin);
  const promise = (async () => {
    const html = await fetchPageText(`${origin}/`, { signal, timeoutMs: 8000 });
    const set = new Set();
    if (html) {
      for (const m of html.matchAll(new RegExp(WA_LINKS_RE.source, 'gi'))) {
        const canon = canonWhatsAppDigits(m[1]);
        if (canon) set.add(canon);
      }
    }
    if (set.size > 0) logger && logger.info && logger.info(`platformWaBlacklist ${origin}: ${[...set].join(', ')}`);
    return set;
  })();
  platformWaCache.set(origin, promise);
  try {
    return await promise;
  } catch (_e) {
    platformWaCache.delete(origin);
    return new Set();
  }
}

/**
 * AMPLIAÇÃO DA ÁREA DE BUSCA: snippets de busca + catálogos/agregadores.
 * Devolve candidatos { raw, tipo: 'wa_link'|'catalogo', url, trecho, host } —
 * mesmos gates do pipeline (anti-alucinação via trecho literal, DDD×UF no
 * score, identidade pelo nome). Roda SÓ quando o site oficial não rendeu
 * wa.me (o caller decide) e com orçamento de estágio próprio.
 */
async function collectFromWebSearch(identidade, { fetchImpl = fetch, signal, logger, startedAt = null } = {}) {
  const out = { candidates: [], emails: [], searchReturnedResults: false };
  const searchName = identidade.nome_busca;
  if (!searchName || String(searchName).length < 3) return out;
  const tokens = nameTokens({ companyName: identidade.razao_social || searchName });
  if (!tokens.length) return out;
  const needTokens = Math.min(2, tokens.length);
  const slugJoined = tokens.join('');
  const stageDeadline = (Number.isFinite(startedAt) ? startedAt : Date.now()) + WEBSEARCH_STAGE_BUDGET_MS;

  const strong = [];
  const weak = [];
  const pushStrong = (num, url, trecho, host) => {
    if (num && !strong.some((s) => s.num === num)) strong.push({ num, url: url || null, trecho: trecho || '', host: host || null });
  };
  const pushWeak = (num, url, trecho, host) => {
    if (num && !weak.some((s) => s.num === num) && dddMatchesState(num, identidade.uf)) weak.push({ num, url: url || null, trecho: trecho || '', host: host || null });
  };

  const catalogUrls = [];
  const generalUrls = [];
  const seenHosts = new Set();
  const queries = [`${searchName} whatsapp`, ...WEBSEARCH_QUERIES_EXTRA.map((q) => `${searchName} ${q}`), `"${searchName}"`];
  for (const query of queries) {
    if (signal && signal.aborted) break;
    if (Date.now() > stageDeadline) break;
    let results = [];
    try {
      results = await searxng.searxSearch(query, { signal, limit: 8 });
    } catch (_e) {
      continue;
    }
    if (results.length > 0) out.searchReturnedResults = true;
    for (const r of results) {
      let snipHost = '';
      try { snipHost = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_e) { /* url de snippet */ }
      const snipIdentity = identityOk({ host: snipHost, url: r.url, title: r.title }, tokens);
      const snippet = `${r.title || ''} ${r.content || ''}`.replace(/\s+/g, ' ').trim().slice(0, 200);
      for (const m of `${r.url || ''} ${r.title || ''} ${r.content || ''}`.matchAll(new RegExp(WA_LINKS_RE.source, 'gi'))) {
        const num = canonWhatsAppDigits(m[1]);
        if (snipIdentity && dddMatchesState(num, identidade.uf)) pushStrong(num, r.url, `wa.me ${snippet}`, snipHost);
      }
      if (strong.length > 0) break;
      if (!r.url || seenHosts.has(snipHost) || JUNK_HOST_RE.test(snipHost)) continue;
      const hay = dpNormalize(`${snipHost} ${r.title || ''} ${r.content || ''}`);
      if (tokens.filter((t) => hay.includes(t)).length < needTokens) continue;
      if (!identityOk({ host: snipHost, url: r.url, title: r.title }, tokens)) continue;
      seenHosts.add(snipHost);
      if (AGGREGATOR_HOST_RE.test(snipHost)) {
        // agregador de MUITAS empresas: só vale se o slug é o nome da loja
        const slug = dpNormalize((r.url.split(/\/+/)[2] || ''));
        if (slugJoined.length >= 5 && (slug.includes(slugJoined) || tokens.filter((t) => slug.includes(t)).length >= needTokens)) {
          catalogUrls.push(r.url);
        }
      } else if (CATALOG_HOST_RE.test(snipHost)) {
        catalogUrls.push(r.url);
      } else {
        generalUrls.push(r.url);
      }
    }
    if (strong.length > 0) break;
  }

  // Crawleia os melhores resultados: catálogo da loja/agregador com slug certo.
  const crawlOrder = [...catalogUrls, ...generalUrls].slice(0, WEBSEARCH_CRAWL_MAX);
  for (const url of crawlOrder) {
    if (signal && signal.aborted) break;
    if (Date.now() > stageDeadline) break;
    const html = await fetchPageText(url, { fetchImpl, signal, timeoutMs: WEBSEARCH_PAGE_TIMEOUT_MS });
    if (!html) continue;
    const hay = dpNormalize(html);
    if (tokens.filter((t) => hay.includes(t)).length < needTokens) continue;
    // A PÁGINA em si é sobre a empresa? O <title> (fallback og:title/h1) tem
    // que citar o nome — a página "restaurantes próximos" do diretório tem o
    // título do OUTRO restaurante e o número extraído era dele.
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/property="og:title" content="([^"]*)"/i) || html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titleHay = dpNormalize(titleMatch ? titleMatch[1] : '');
    if (tokens.filter((t) => titleHay.includes(t)).length < Math.min(2, tokens.length)) continue;
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_e) { /* url externa */ }
    // E-mail literal na página da PRÓPRIA loja (2026-10-19): passou no gate
    // de título, é sobre a empresa — contato@/comercial@ ali entra como
    // fallback do emailPick quando o site oficial não tem e-mail. E-mail do
    // PRÓPRIO host (rodapé da plataforma, ex.: contato@diggy.menu) fica fora
    // — é o contato da plataforma, não da loja (mesmo espírito do GuiaPJ).
    for (const e of extractEmailsFromHtml(html, {})) {
      const eDom = e.split('@')[1] || '';
      if (host && eDom && (eDom === host || eDom.endsWith(`.${host}`))) continue;
      if (!out.emails.some((x) => x.email === e)) out.emails.push({ email: e, url });
    }
    // Número que a PLATAFORMA usa nela mesma (home do host) não é da empresa.
    // EXCEÇÃO — site da PRÓPRIA empresa: host contém o primeiro token do nome
    // ('gustto.com.br' para D GUSTTO) e o wa.me da home É dela.
    const ownHost = (() => {
      const first = tokens[0];
      if (!first) return false;
      if (JUNK_HOST_RE.test(host) || AGGREGATOR_HOST_RE.test(host) || CATALOG_HOST_RE.test(host)) return false;
      return dpNormalize(host).includes(first);
    })();
    const blacklist = ownHost ? new Set() : await platformWaBlacklist(url, { signal, logger });
    const hostTldBr = /\.br(\.|:|\/|$)/.test(url.toLowerCase());
    for (const m of html.matchAll(new RegExp(WA_LINKS_RE.source, 'gi'))) {
      const raw = digitsOnly(m[1]);
      const canon = canonWhatsAppDigits(raw);
      if (!canon) continue;
      if (!hostTldBr && !raw.startsWith('55')) continue; // estrangeiro ambíguo — fora
      if (blacklist.has(canon)) continue;
      const trecho = html.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim();
      pushStrong(canon, url, trecho, host);
    }
    if ((CATALOG_HOST_RE.test(url) || AGGREGATOR_HOST_RE.test(url)) && !ownHost) {
      for (const { num, trecho } of extractCatalogMobiles(html)) {
        if (!blacklist.has(num)) pushWeak(num, url, `catálogo: ${trecho}`, host);
      }
    }
  }

  for (const s of strong) out.candidates.push({ raw: s.num, tipo: 'wa_link', url: s.url, trecho: s.trecho, host: s.host });
  for (const w of weak) out.candidates.push({ raw: w.num, tipo: 'catalogo', url: w.url, trecho: w.trecho, host: w.host });
  if (out.candidates.length) logger && logger.info && logger.info(`busca web: ${out.candidates.length} candidato(s) (${strong.length} forte/ ${weak.length} catálogo)`);
  return out;
}

// ── ETAPA 3 — Normalização e validação (libphonenumber + anti-alucinação) ───
function normalizeAndValidate(candidates, identidade, { logger } = {}) {
  const out = [];
  const descartes = [];
  const byE164 = new Map();
  for (const c of candidates) {
    if (!c || !c.raw) continue;
    let e164 = null;
    let nacional = null;
    let mobile = false;
    try {
      const n = phoneUtil.parse(c.raw, 'BR');
      if (!phoneUtil.isValidNumber(n)) {
        descartes.push(`${c.raw}: número inválido (libphonenumber)`);
        continue;
      }
      e164 = phoneUtil.format(n, PhoneNumberFormat.E164);
      nacional = String(n.getNationalNumber());
      const t = phoneUtil.getNumberType(n);
      mobile = t === PhoneNumberType.MOBILE || t === PhoneNumberType.FIXED_LINE_OR_MOBILE;
    } catch (err) {
      descartes.push(`${c.raw}: falha no parse (${String(err.message).slice(0, 60)})`);
      continue;
    }
    const ddd = nacional.slice(0, 2);
    const ufTabela = DDD_UF[ddd];
    if (!ufTabela) {
      descartes.push(`${e164}: DDD ${ddd} não existe`);
      continue;
    }
    const dddIncompativel = Boolean(identidade.uf && ufTabela !== identidade.uf);
    // Anti-alucinação: os dígitos têm que existir LITERALMENTE na fonte.
    const fonteDigitoOk = !c.trecho || digitsOnly(c.trecho).includes(digitsOnly(c.raw));
    if (!fonteDigitoOk) {
      descartes.push(`${e164}: dígitos ausentes no texto da fonte (anti-alucinação)`);
      continue;
    }
    const item = {
      e164, nacional, ddd, uf: ufTabela, mobile,
      dddIncompativel,
      tipo: c.tipo, url: c.url || null, trecho: c.trecho || '', host: c.host || null,
      endereco_bate: Boolean(c.endereco_bate),
      raw: c.raw,
    };
    // Corroboração: mesmo número em 2+ fontes (hosts) independentes.
    if (!byE164.has(e164)) byE164.set(e164, []);
    byE164.get(e164).push(item);
    out.push(item);
  }
  for (const [e164, group] of byE164) {
    const hosts = new Set(group.map((g) => g.host));
    if (hosts.size >= 2) for (const g of group) g.corroborado = true;
    void e164;
  }
  if (descartes.length) logger && logger.info && logger.info(`normalização: ${descartes.length} candidato(s) descartado(s)`);
  return { normalized: out, descartes };
}

// ── ETAPA 4 — Score de confiança ─────────────────────────────────────────────
const SCORE_BASE = {
  wa_link_confirmado: 95,      // link wa.me/api.whatsapp no site oficial confirmado
  wa_contexto_confirmado: 85,  // número rotulado "WhatsApp" no site oficial
  google_places: 70,           // Places com endereço/cidade batendo
  instagram: 70,               // bio do perfil linkado pelo site oficial
  cnpj: 40,                    // só telefone do CNPJ
  wa_link_nao_confirmado: 70,  // site não confirmado (descoberto por busca)
  wa_contexto_nao_confirmado: 60,
  catalogo: 70,                // celular na PRÓPRIA loja digital/agregador com slug certo (caso MB)
};
const SCORE_MIN_CONFIRMADO = 70;
const SCORE_MIN_NAO_CONFIRMADO = 40;
const CORROBORACAO_BONUS = 15;
const PENALIDADE_DDD = 30;

function scoreCandidates(normalized, identidade) {
  const scored = normalized.map((c) => {
    const oficial = identidade.dominio_confirmado && c.host && dpNormalize(c.host).includes(dpNormalize(identidade.dominio));
    let score;
    if (c.tipo === 'wa_link') score = oficial ? SCORE_BASE.wa_link_confirmado : SCORE_BASE.wa_link_nao_confirmado;
    else if (c.tipo === 'wa_contexto') score = oficial ? SCORE_BASE.wa_contexto_confirmado : SCORE_BASE.wa_contexto_nao_confirmado;
    else if (c.tipo === 'google_places') score = SCORE_BASE.google_places;
    else if (c.tipo === 'instagram') score = SCORE_BASE.instagram;
    else if (c.tipo === 'catalogo') score = oficial ? SCORE_BASE.wa_contexto_confirmado : SCORE_BASE.catalogo;
    else if (c.tipo === 'cnpj') score = SCORE_BASE.cnpj;
    else score = 0;
    if (c.corroborado) score += CORROBORACAO_BONUS;
    if (c.dddIncompativel) score -= PENALIDADE_DDD;
    return { ...c, score: Math.max(0, Math.min(100, score)) };
  });

  const confirmados = scored.filter((c) => c.score >= SCORE_MIN_CONFIRMADO);
  const naoConfirmados = scored.filter((c) => c.score >= SCORE_MIN_NAO_CONFIRMADO && c.score < SCORE_MIN_CONFIRMADO);
  const descartados = scored.filter((c) => c.score < SCORE_MIN_NAO_CONFIRMADO);
  confirmados.sort((a, b) => b.score - a.score);
  naoConfirmados.sort((a, b) => b.score - a.score);

  const motivoDescarte = descartados.map((c) => `${c.e164}: score ${c.score} abaixo do mínimo${c.dddIncompativel ? ' (DDD incompatível com a UF)' : ''}`);
  return { confirmados, naoConfirmados, descartados, motivoDescarte };
}

// ── ETAPA 5 — Orquestrador ───────────────────────────────────────────────────
/**
 * Roda as 4 etapas e devolve a saída obrigatória por lead:
 * { whatsapp, status, score, fontes, wa_candidates, identidade_usada,
 *   motivo_descarte, nao_confirmado, email, email_fonte, email_fonte_tipo,
 *   domain, dominio_confirmado, search_unavailable }
 * `whatsapp` só vem preenchido quando status = 'confirmado';
 * `wa_candidates` (ordenado por score, dedupe por E.164, 1º = `whatsapp`) é
 * o insumo da cadeia do gate Twilio no executor; `email_fonte_tipo` é
 * 'site_oficial' | 'instagram' | 'busca_web' | 'receita' (sourceType do fact
 * `contact.email`).
 */
async function discoverLeadContact(prisma, prospect, deps = {}) {
  const { fetchImpl = fetch, signal, logger } = deps;
  const leadStartedAt = Date.now(); // orçamento compartilhado entre as etapas
  const identidade = await resolveIdentity(prisma, prospect, { fetchImpl, signal, logger });
  const site = await collectFromSite(identidade, { fetchImpl, signal, logger, startedAt: leadStartedAt });
  const places = await collectFromGooglePlaces(identidade, { fetchImpl, signal, logger });
  const cnpjSource = collectFromCnpj(identidade);
  const instagram = await collectFromInstagram(identidade, site, { fetchImpl, signal, logger });
  // AMPLIAÇÃO DA ÁREA DE BUSCA: site não rendeu wa.me? Vai além do próprio
  // site — snippets de busca, catálogo digital da loja e agregadores de link
  // (caso MB), com os gates de identidade do pipeline.
  const webSearch = site.candidates.some((c) => c.tipo === 'wa_link')
    ? { candidates: [], emails: [], searchReturnedResults: true }
    : await collectFromWebSearch(identidade, { fetchImpl, signal, logger, startedAt: leadStartedAt });

  const allCandidates = [
    ...site.candidates,
    ...webSearch.candidates,
    ...places.candidates,
    ...cnpjSource.candidates,
    ...instagram.candidates,
  ].filter((c) => c.raw); // só números seguem o pipeline pontuado

  const { normalized, descartes } = normalizeAndValidate(allCandidates, identidade, { logger });
  const { confirmados, naoConfirmados, motivoDescarte } = scoreCandidates(normalized, identidade);

  const melhor = confirmados[0] || null;
  const naoConfirmado = naoConfirmados[0] || null;
  const fontesDoEscolhido = [];
  if (melhor) {
    const vistos = new Set();
    for (const c of normalized.filter((c) => c.e164 === melhor.e164)) {
      const chave = `${c.tipo}|${c.url}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      fontesDoEscolhido.push({ tipo: c.tipo, url: c.url, trecho: c.trecho });
    }
  }

  // E-mail corporativo: literal na fonte, mesma regra de ouro — com a URL da
  // fonte para exibição clicável (e proveniência do fact `contact.email` no
  // executor). Cadeia do emailPick (2026-10-19): site oficial → bio do
  // Instagram linkado → catálogo da busca web (gates de identidade próprios)
  // → e-mail da Receita. Instagram/busca web eram coletados e DESCARTADOS.
  const emailPick =
    (site.emails[0] && { email: site.emails[0].email, url: site.emails[0].url, tipo: 'site_oficial' })
    || (instagram.emails[0] && { email: instagram.emails[0].email, url: instagram.emails[0].url, tipo: 'instagram' })
    || (webSearch.emails[0] && { email: webSearch.emails[0].email, url: webSearch.emails[0].url, tipo: 'busca_web' })
    || (identidade.email_cnpj
      ? { email: identidade.email_cnpj, url: identidade.cnpj ? `https://brasilapi.com.br/api/cnpj/v1/${identidade.cnpj}` : null, tipo: 'receita' }
      : null);
  const email = emailPick ? emailPick.email : null;
  const email_fonte = emailPick ? emailPick.url : null;
  const email_fonte_tipo = emailPick ? emailPick.tipo : null;

  // Cadeia do gate Twilio (spec ampliar-crawl-sites-whatsapp-email): lista
  // ordenada por score dos candidatos CONFIRMADOS (wa_link confirmado 95 >
  // wa_contexto confirmado 85 > places/instagram/catálogo 70 > …), dedupe por
  // E.164, teto de 2 (o gate valida no máx. 2 lookups/lead). O 1º É o
  // `whatsapp` atual — compat: sem gate, nada muda.
  const wa_candidates = [];
  {
    const vistos = new Set();
    for (const c of confirmados) {
      if (wa_candidates.length >= WA_CANDIDATES_MAX) break;
      if (vistos.has(c.e164)) continue;
      vistos.add(c.e164);
      wa_candidates.push({
        whatsapp: c.e164,
        score: c.score,
        tipo: c.tipo,
        url: c.url || null,
        trecho: (c.trecho || '').slice(0, 200),
        host: c.host || null,
      });
    }
  }

  const status = melhor ? 'confirmado' : (naoConfirmado ? 'nao_confirmado' : 'nao_encontrado');

  return {
    whatsapp: melhor ? melhor.e164 : null,
    status,
    score: melhor ? melhor.score : (naoConfirmado ? naoConfirmado.score : 0),
    fontes: fontesDoEscolhido,
    // Insumo da cadeia do gate Twilio (executor): 1º = `whatsapp`.
    wa_candidates,
    identidade_usada: {
      cnpj: identidade.cnpj,
      cnpj_confirmado: identidade.cnpj_confirmado,
      razao_social: identidade.razao_social,
      nome_fantasia: identidade.nome_fantasia,
      dominio: identidade.dominio,
      dominio_confirmado: identidade.dominio_confirmado,
      cidade: identidade.cidade,
      uf: identidade.uf,
    },
    motivo_descarte: [...descartes, ...motivoDescarte].slice(0, 20),
    nao_confirmado: naoConfirmado
      ? { whatsapp: naoConfirmado.e164, score: naoConfirmado.score, url: naoConfirmado.url, motivo: naoConfirmado.dddIncompativel ? 'DDD incompatível com a UF' : 'fonte única/weight insuficiente' }
      : null,
    email,
    email_fonte,
    email_fonte_tipo,
    domain: identidade.dominio,
    dominio_confirmado: identidade.dominio_confirmado,
    // Busca morta honesta: nada encontrado E os motores de busca não
    // devolveram NADA (instabilidade) — o chat diz "repita em minutos"
    // em vez de afirmar que não existe contato na internet.
    search_unavailable: !melhor && !naoConfirmado && !site.candidates.length && !webSearch.searchReturnedResults,
  };
}

module.exports = {
  discoverLeadContact,
  resolveIdentity,
  collectFromSite,
  collectFromGooglePlaces,
  collectFromCnpj,
  collectFromInstagram,
  collectFromWebSearch,
  normalizeAndValidate,
  scoreCandidates,
  extractEmailsFromHtml,
  extractInternalLinks,
  normUrl,
  identityOk,
  platformWaBlacklist,
  searchableName,
  nameTokens,
  dddMatchesState,
  DDD_UF,
  SCORE_BASE,
  MAX_PAGE_BYTES,
  WA_CANDIDATES_MAX,
  CRAWL_MAX_EXTRA_PAGES,
  CRAWL_MAX_DEPTH,
};
