// =============================================================================
// searxng.js — camada de BUSCA WEB compartilhada (enriquecimento, discovery,
// workers de busca). Contrato de sempre: array de { title, content, url }.
//
// 2026-10-13 — incidente "nenhum WhatsApp encontrado": a instância SearXNG
// degrada em silêncio (engines upstream bloqueiam o IP dela) e passou a
// devolver LIXO irrelevante ou zero resultados — todo lead virava "sem
// WhatsApp" com a busca morta. Agora a busca soma DOIS backends
// independentes (SearXNG + DuckDuckGo HTML), dedup por URL, com cache curto
// para não martelar os motores em rodadas repetidas ("continua o
// enriquecimento"). Falha de um backend nunca derruba a busca: fail-open.
// =============================================================================

const SEARXNG_URL = (process.env.SEARXNG_URL || 'https://search.0xcloud.net').replace(/\/+$/, '');
const DDG_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Cache em memória (mesmo processo): query → resultados. TTL curto — o
// objetivo é poup os motores dentro de uma mesma rodada, não servir dado velho.
const CACHE_TTL_MS = Number(process.env.WEB_SEARCH_CACHE_TTL_MS || 600000);
const cache = new Map(); // key -> { at, results }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.results;
}

function cachePut(key, results) {
  if (cache.size > 500) cache.clear(); // teto simples; enriquecimento é o único cliente
  cache.set(key, { at: Date.now(), results });
}

/** Só a instância SearXNG (formato JSON). */
async function searxngOnly(query, { timeoutMs = 15000, limit = 8 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${SEARXNG_URL}/search?format=json&q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`searxng HTTP ${res.status}`);
    const json = await res.json();
    return (json.results || []).slice(0, limit).map((r) => ({
      title: r.title || '',
      content: r.content || '',
      url: r.url || '',
    }));
  } finally {
    clearTimeout(timer);
  }
}

/** DuckDuckGo HTML (backend independente, sem chave) → mesmo contrato. */
async function duckduckgoSearch(query, { timeoutMs = 12000, limit = 8 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { Accept: 'text/html,*/*', 'Accept-Language': 'pt-BR,pt;q=0.9', 'User-Agent': DDG_UA },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    const out = [];
    for (const m of html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      let url = m[1];
      const deco = url.match(/[?&]uddg=([^&]+)/);
      if (deco) url = decodeURIComponent(deco[1]);
      if (!/^https?:\/\//.test(url)) continue;
      const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      out.push({ title, content: snippets[out.length] || '', url });
      if (out.length >= limit) break;
    }
    return out;
  } catch (_e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Busca web mesclada: SearXNG + DuckDuckGo, dedup por URL (searx primeiro —
 * quando saudável é o melhor; o DDG garante cobertura quando a instância
 * degrada ou zera). Contrato/assinatura idênticos ao searxSearch antigo:
 * TODOS os chamadores (multi-fonte, descoberta de domínio, workers) herdam.
 */
async function searxSearch(query, { timeoutMs, limit = 8, useCache = true } = {}) {
  const key = `${limit}|${query}`;
  if (useCache) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }
  const [searx, ddg] = await Promise.all([
    searxngOnly(query, { timeoutMs, limit }).catch(() => []),
    duckduckgoSearch(query, { timeoutMs, limit }).catch(() => []),
  ]);
  const seen = new Set();
  const merged = [];
  for (const r of [...searx, ...ddg]) {
    const keyUrl = String(r.url || '').replace(/\/+$/, '');
    if (!keyUrl || !/^https?:\/\//.test(keyUrl) || seen.has(keyUrl)) continue;
    seen.add(keyUrl);
    merged.push(r);
    if (merged.length >= limit * 2) break; // dobra o pool quando os dois backends respondem
  }
  if (useCache && merged.length > 0) cachePut(key, merged);
  return merged;
}

module.exports = { searxSearch, duckduckgoSearch, searxngOnly, SEARXNG_URL };
