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
// /orcamento, páginas de unidade/filial. Quando os caminhos fixos NÃO
// renderam um wa.me, seguimos links internos de contato com orçamento
// fechado (5 páginas, 15s, 8s por página) — o timeout da capability (60s)
// cobre o resto do pipeline (Places/CNPJ/Instagram/Twilio).
const CRAWL_EXTRA_PATHS = ['atendimento', 'orcamento', 'sac', 'unidades', 'contate'];
const CRAWL_MAX_EXTRA_PAGES = 5;
const CRAWL_BUDGET_MS = 15000;
const CRAWL_PAGE_TIMEOUT_MS = 8000;
const CRAWL_LINK_RE = /<a\s[^>]*href\s*=\s*["']([^"'\s#]+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
const CRAWL_PRIO_RE = /(contat|fale|whats|w\.me|zap|sac|atendiment|orcament|unidade|filial|loja|quem-?somos|sobre-nos|a-?empresa|equipe|converse|falan)/i;
const CRAWL_SKIP_RE = /\.(pdf|jpe?g|png|gif|webp|svg|css|js|mjs|zip|rar|mp[34]|xml|rss|ico|woff2?)($|\?)|(wp-admin|wp-login|xmlrpc\.php|\/feed)($|\/|\?)|\b(facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)\b/i;
const WA_LINKS_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?[^"' >]*?phone=|web\.whatsapp\.com\/send\?[^"' >]*?phone=|whatsapp:\/\/send\?phone=)\+?([0-9]{10,13})/gi;
const BR_PHONE_RE = /\(?\d{2}\)?[\s.-]?\d{4}[-.\s]?\d{4}/g;
const WHATS_KEYWORD_RE = /whats[a-zç]*|w\.me|\bzap\b/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
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
  for (const m of html.matchAll(/mailto:\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi)) raw.add(m[1].toLowerCase());
  for (const m of html.matchAll(new RegExp(EMAIL_RE.source, 'gi'))) raw.add(m[0].toLowerCase());
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
      return await res.text();
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
 * a) Site oficial: home + /contato + /fale-conosco e, se NADA render wa.me,
 *    CRAWL INTERNO com orçamento seguindo links internos de contato
 *    (atendimento, orçamento, unidades, âncoras "fale conosco"…).
 *    Extração via REGEX (wa.me/api.whatsapp/web.whatsapp + números perto de
 *    "whats|zap"). Cada candidato carrega URL + TRECHO literal. Coleta também
 *    e-mails e o link do Instagram (para a fonte 2d).
 */
async function collectFromSite(identidade, { fetchImpl = fetch, signal, logger } = {}) {
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
  const harvest = (html, url) => {
    // wa.me / api.whatsapp / web.whatsapp → candidato tipo wa_link
    for (const m of html.matchAll(new RegExp(WA_LINKS_RE.source, 'gi'))) {
      const raw = digitsOnly(m[1]);
      if (!raw || raw.length < 10) continue;
      const trecho = html.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80).replace(/\s+/g, ' ').trim();
      out.candidates.push({ raw, tipo: 'wa_link', url, trecho, host: dominio });
    }
    // Números perto de "WhatsApp|Whats|Zap" → tipo wa_contexto
    for (const kw of html.matchAll(WHATS_KEYWORD_RE)) {
      const win = html.slice(Math.max(0, kw.index - 120), kw.index + 200);
      for (const ph of win.matchAll(new RegExp(BR_PHONE_RE.source, 'g'))) {
        const raw = digitsOnly(ph[0]);
        if (raw.length < 10 || raw.length > 13) continue;
        const trecho = win.slice(Math.max(0, ph.index - 40), ph.index + ph[0].length + 40).replace(/\s+/g, ' ').trim();
        out.candidates.push({ raw, tipo: 'wa_contexto', url, trecho, host: dominio });
      }
    }
  };
  const captureMeta = (html, url) => {
    if (!out.instagramHandle) {
      const ig = html.match(/instagram\.com\/([A-Za-z0-9_.]{2,40})/i);
      if (ig && !/\/p\//.test(ig[0])) out.instagramHandle = ig[1].replace(/\.$/, '');
    }
    out.emails.push(...extractEmailsFromHtml(html, { hostDomain: dominio }).map((e) => ({ email: e, url })));
  };

  for (const path of SITE_CONTACT_PATHS) {
    const url = `${base}/${path}`;
    const html = await fetchPageText(url, { fetchImpl, signal });
    if (!html) continue;
    out.pages.push({ url, html });
    captureMeta(html, url);
    harvest(html, url);
  }

  // ── Crawl interno: só quando os caminhos fixos NÃO renderam wa.me ─────────
  if (!out.candidates.some((c) => c.tipo === 'wa_link') && out.pages.length) {
    const visited = new Set(out.pages.map((p) => normUrl(p.url)).filter(Boolean));
    const discovered = [];
    for (const p of out.pages) discovered.push(...extractInternalLinks(p.html, p.url, dominio));
    discovered.sort((a, b) => b.prio - a.prio);
    const queue = [];
    const seen = new Set(visited);
    for (const l of discovered) {
      if (seen.has(l.url)) continue;
      seen.add(l.url);
      queue.push(l.url);
    }
    // Caminhos brasileiros comuns que nem sempre estão no menu.
    for (const extra of CRAWL_EXTRA_PATHS) {
      const url = normUrl(`${base}/${extra}`);
      if (url && !seen.has(url)) {
        seen.add(url);
        queue.push(url);
      }
    }
    const crawlStartedAt = Date.now();
    let crawled = 0;
    for (const url of queue.slice(0, CRAWL_MAX_EXTRA_PAGES)) {
      if (signal && signal.aborted) break;
      if (Date.now() - crawlStartedAt > CRAWL_BUDGET_MS) break;
      const html = await fetchPageText(url, { fetchImpl, signal, timeoutMs: CRAWL_PAGE_TIMEOUT_MS });
      crawled += 1;
      if (!html) continue;
      out.pages.push({ url, html });
      captureMeta(html, url);
      harvest(html, url);
      // wa.me encontrado numa página profunda encerra o crawl (o restante do
      // orçamento fica para Places/CNPJ/Instagram/Twilio).
      if (out.candidates.some((c) => c.tipo === 'wa_link')) break;
    }
    logger && logger.info && logger.info(`crawl interno ${dominio}: ${crawled} página(s) extra(s)`);
  }

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
  const out = { candidates: [] };
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
  for (const email of emails) {
    out.candidates.push({ raw: null, email, tipo: 'instagram', url, trecho: `bio do Instagram (@${site.instagramHandle})`, host: 'instagram.com' });
  }
  if (!out.candidates.length) logger && logger.info && logger.info('instagram: perfil sem telefone/e-mail público na bio');
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
 * { whatsapp, status, score, fontes, identidade_usada, motivo_descarte,
 *   nao_confirmado, email, domain, dominio_confirmado, search_unavailable }
 * `whatsapp` só vem preenchido quando status = 'confirmado'.
 */
async function discoverLeadContact(prisma, prospect, deps = {}) {
  const { fetchImpl = fetch, signal, logger } = deps;
  const identidade = await resolveIdentity(prisma, prospect, { fetchImpl, signal, logger });
  const site = await collectFromSite(identidade, { fetchImpl, signal, logger });
  const places = await collectFromGooglePlaces(identidade, { fetchImpl, signal, logger });
  const cnpjSource = collectFromCnpj(identidade);
  const instagram = await collectFromInstagram(identidade, site, { fetchImpl, signal, logger });

  const allCandidates = [
    ...site.candidates,
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

  // E-mail corporativo: literal na fonte (site oficial / CNPJ), mesma regra
  // de ouro — com a URL da fonte para exibição clicável.
  const emailPick = site.emails[0] || (identidade.email_cnpj
    ? { email: identidade.email_cnpj, url: identidade.cnpj ? `https://brasilapi.com.br/api/cnpj/v1/${identidade.cnpj}` : null }
    : null);
  const email = emailPick ? emailPick.email : null;
  const email_fonte = emailPick ? emailPick.url : null;

  const status = melhor ? 'confirmado' : (naoConfirmado ? 'nao_confirmado' : 'nao_encontrado');

  return {
    whatsapp: melhor ? melhor.e164 : null,
    status,
    score: melhor ? melhor.score : (naoConfirmado ? naoConfirmado.score : 0),
    fontes: fontesDoEscolhido,
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
    domain: identidade.dominio,
    dominio_confirmado: identidade.dominio_confirmado,
    search_unavailable: false,
  };
}

module.exports = {
  discoverLeadContact,
  resolveIdentity,
  collectFromSite,
  collectFromGooglePlaces,
  collectFromCnpj,
  collectFromInstagram,
  normalizeAndValidate,
  scoreCandidates,
  extractEmailsFromHtml,
  extractInternalLinks,
  normUrl,
  searchableName,
  nameTokens,
  dddMatchesState,
  DDD_UF,
  SCORE_BASE,
};
