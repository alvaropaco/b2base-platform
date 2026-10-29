'use strict';

/**
 * studio/resolve-image-link.js — LINK DE PÁGINA → IMAGEM REAL (2026-10-28).
 *
 * O dono cola links de imagem no Cockpit que NÃO são arquivos diretos — são
 * PÁGINAS (ex.: álbum/galeria em qualquer host) e o cliente de e-mail não
 * renderiza página, só arquivo. Este módulo é AGNÓSTICO de host:
 *   1. reconhece link de página (URL http/https que não termina em arquivo
 *      de imagem) e extrai o link da IMAGEM direta (og:image / twitter:image
 *      do HTML — ou a própria resposta, quando a URL já serve image/*);
 *   2. baixa os BYTES da imagem direta (com User-Agent de navegador e teto
 *      de tamanho);
 *   3. devolve buffer + mime + origem para o chamador salvar no storage do
 *      Studio (banner passa a ser NOSSO — bytes no storage, saída pela URL
 *      pública do bucket/CDN ou embutida por CID; sem dependência do site
 *      de origem depois).
 *
 * Fail honesto: bloqueio (429/403), página sem imagem, arquivo não-imagem ou
 * tamanho acima do teto viram erro com causa — o chamador reporta no card.
 */

const FETCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // mesmo teto das fotos por anexo

// ── Relay Cloudflare (Worker) para host que bloqueia o IP de origem ─────────
// Caso real: imgur devolve 429/403 para IP de datacenter. Com o Worker
// b2base-media-relay publicado (cloudflare/media-relay/) e as DUAS envs
// configuradas, o fetch bloqueado tenta UMA vez pelo relay — o Cloudflare
// busca na edge e devolve página/bytes. Sem relay configurado, bloqueio
// vira erro honesto com causa (comportamento de sempre).

const RELAY_URL = () => String(process.env.MEDIA_FETCH_RELAY_URL || '').replace(/\/$/, '');
const RELAY_AUTH = () => String(process.env.MEDIA_FETCH_RELAY_AUTH || '');

function isRelayConfigured() {
  return Boolean(RELAY_URL() && RELAY_AUTH());
}

async function relayFetch(url, accept, { fetchImpl } = {}) {
  const endpoint = `${RELAY_URL()}?url=${encodeURIComponent(String(url))}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 20000);
  try {
    return await (fetchImpl || global.fetch)(endpoint, {
      signal: controller.signal,
      headers: { Authorization: RELAY_AUTH(), Accept: accept },
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch de página/imagem com fallback: direto primeiro; 429/403 (ou falha de
 * rede, quando há relay) → UMA tentativa pelo relay do Cloudflare.
 */
async function fetchWithRelayFallback(url, accept, { fetchImpl } = {}) {
  const doFetch = fetchImpl || global.fetch;
  let res = null;
  let directErr = null;
  try {
    res = await doFetch(String(url), { headers: { 'User-Agent': FETCH_UA, Accept: accept }, redirect: 'follow' });
  } catch (err) {
    directErr = err;
  }
  if ((!res || res.status === 429 || res.status === 403) && isRelayConfigured()) {
    try {
      const via = await relayFetch(url, accept, { fetchImpl });
      if (via) res = via;
    } catch (_err) { /* queda no resultado direto/erro original */ }
  }
  if (!res) throw (directErr || new Error('fetch falhou'));
  return res;
}

function isImageUrl(url) {
  return /\.(png|jpe?g|webp|gif)(\?|$)/i.test(String(url || '').split(/[?#]/)[0] || '');
}

/** URL http/https que NÃO é arquivo de imagem direto — é página p/ resolver. */
function isPageUrl(url) {
  const target = String(url || '').trim();
  return /^https?:\/\//i.test(target) && !isImageUrl(target);
}

/** Extrai o link da imagem direta do HTML de uma página (og:image primeiro). */
function extractDirectImageFromHtml(html) {
  const og = String(html || '').match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (og && og[1]) return og[1].replace(/&amp;/g, '&');
  const twitter = String(html || '').match(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i);
  if (twitter && twitter[1]) return twitter[1].replace(/&amp;/g, '&');
  return null;
}

/**
 * URL → { imageUrl } com o link DIRETO da imagem. Arquivo direto (termina em
 * .jpg/.png/…) já é o link final; PÁGINA é aberta e o link da imagem extraído
 * do HTML. Erro 429/403 vira causa explícita.
 */
async function resolveDirectImageUrl(url, { fetchImpl } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) {
    const err = new Error('O link precisa ser http/https completo.');
    err.code = 'IMAGE_LINK_INVALID';
    throw err;
  }
  if (isImageUrl(target)) return { imageUrl: target };

  let res = null;
  try {
    res = await fetchWithRelayFallback(target, 'text/html', { fetchImpl });
  } catch (err) {
    const e = new Error(`Não consegui abrir o link (${err.message}).`);
    e.code = 'IMAGE_LINK_FETCH_FAILED';
    throw e;
  }
  if (res.status === 429 || res.status === 403) {
    const e = new Error(`O site bloqueou a leitura agora (HTTP ${res.status}). Tenta de novo em instantes, me manda o link DIRETO da imagem (termina em .jpg/.png) ou anexa o arquivo aqui no chat.`);
    e.code = 'IMAGE_LINK_BLOCKED';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`O link respondeu HTTP ${res.status} — confere se a página existe.`);
    e.code = 'IMAGE_LINK_HTTP_ERROR';
    throw e;
  }
  // Alguns CDNs servem imagem sem extensão no path: se a resposta JÁ é
  // image/*, a própria URL é o link direto — nada a extrair do HTML.
  const ctype = res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('content-type') || '') : '';
  if (/^image\//i.test(ctype)) return { imageUrl: target };

  const html = await res.text().catch(() => '');
  const direct = extractDirectImageFromHtml(html);
  if (!direct) {
    const e = new Error('Abri a página, mas não encontrei imagem direta nela. Me manda o link direto da imagem (termina em .jpg/.png) ou anexa o arquivo.');
    e.code = 'IMAGE_LINK_NO_IMAGE';
    throw e;
  }
  return { imageUrl: direct };
}

/**
 * Baixa os BYTES da imagem direta (teto de tamanho + imagem real por magic
 * bytes no chamador). Só http/https; 429/403 vira causa explícita.
 */
async function downloadImageBytes(url, { fetchImpl } = {}) {
  let res = null;
  try {
    res = await fetchWithRelayFallback(String(url), 'image/*', { fetchImpl });
  } catch (err) {
    const e = new Error(`Não consegui baixar a imagem (${err.message}).`);
    e.code = 'IMAGE_DOWNLOAD_FAILED';
    throw e;
  }
  if (res.status === 429 || res.status === 403) {
    const e = new Error(`O site bloqueou o download da imagem (HTTP ${res.status}). Tenta de novo em instantes ou anexa o arquivo aqui no chat.`);
    e.code = 'IMAGE_LINK_BLOCKED';
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`O download da imagem respondeu HTTP ${res.status}.`);
    e.code = 'IMAGE_DOWNLOAD_HTTP_ERROR';
    throw e;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    const e = new Error('O download veio vazio.');
    e.code = 'IMAGE_DOWNLOAD_EMPTY';
    throw e;
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    const e = new Error(`A imagem passa de ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB — usa uma versão menor.`);
    e.code = 'IMAGE_TOO_LARGE';
    throw e;
  }
  return buffer;
}

/**
 * Garante que NENHUM bloco image do emailDoc fique com src de PÁGINA (link
 * que não é arquivo de imagem — não renderiza em cliente de e-mail):
 *   - resolve a imagem direta, baixa os bytes e PROMOVE para o storage do
 *     Studio — o src passa a ser a URL pública do bucket (quando
 *     MEDIA_PUBLISH_* configurado) ou local (/media/<hash>, embutível por
 *     CID no envio);
 *   - o que NÃO resolve (host virou shell sem imagem, bloqueio sem relay) é
 *     REMOVIDO do doc em vez de segurar o envio — banner de página nunca
 *     renderizaria de qualquer forma. O emailDoc é persistido na origem
 *     (melhor-esforço) com a cura.
 *
 * Usado por send_test_message (chat), pelo disparo real (outreach-workers) e
 * pela auto-cura (media-backfill): o mesmo banner resolvido em todos os
 * caminhos — e o envio NUNCA fica bloqueado por src legado quebrado.
 */
async function ensureImageSourcesResolved(emailDoc, deps = {}) {
  const storage = require('./storage');
  const { fetchImpl, readGenerated, readBuffer, publishMedia, persist } = deps;
  const blocks = emailDoc && Array.isArray(emailDoc.blocks) ? emailDoc.blocks : [];
  let changed = false;
  // Ordem reversa: remoção por splice não bagunça índices ainda não vistos.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b || b.type !== 'image' || typeof b.src !== 'string' || !isPageUrl(b.src)) continue;
    try {
      const { imageUrl: direct } = await resolveDirectImageUrl(b.src, { fetchImpl });
      const bytes = await downloadImageBytes(direct, { fetchImpl });
      const mime = require('./ai/vision').normalizeImageMime(bytes, direct);
      const promoted = storage.saveGenerated(bytes, storage.extFromMime(mime, direct));
      let src = `/media/${promoted}`;
      if (typeof publishMedia === 'function') {
        const pub = await publishMedia(promoted, { readGenerated: storage.readGenerated, readBuffer: storage.readBuffer });
        if (pub && pub.provider === 'remote' && pub.url) src = pub.url;
      }
      b.src = src;
      changed = true;
    } catch (_err) {
      // Sem cura possível: o banner sai da mensagem (nunca renderizaria) e o
      // doc segue limpo — o envio NUNCA fica refém de um src legado quebrado.
      blocks.splice(i, 1);
      changed = true;
    }
  }
  if (changed && typeof persist === 'function') {
    try { await persist(emailDoc); } catch (_e) { /* melhor-esforço: o envio segue com o resolvido em memória */ }
  }
  return emailDoc;
}

module.exports = {
  ensureImageSourcesResolved,
  MAX_IMAGE_BYTES,
  isPageUrl,
  isImageUrl,
  isRelayConfigured,
  extractDirectImageFromHtml,
  resolveDirectImageUrl,
  downloadImageBytes,
};
