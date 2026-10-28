'use strict';

/**
 * studio/media-url.js — resolução da URL PÚBLICA das imagens do Studio.
 *
 * Regras (2026-10-27, pedido do dono: "não invente domínio, localhost não é
 * URL pública"):
 *   - A origem pública vem de APP_URL (produção: domínio com HTTPS atrás do
 *     proxy). SEM APP_URL → base local (request origin), que NÃO é pública —
 *     detectável por isPublicHttpUrl.
 *   - Quando a base não é pública, o envio de e-mail NÃO depende dela: o
 *     banner vai EMBUTIDO por CID (studio/email-inline.js). A URL pública só
 *     é preferida quando existe de verdade (APP_URL configurado ou offload
 *     para bucket/CDN via media-publisher).
 */

const PRIVATE_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** URL http/https cujo host NÃO é local/rede privada (i.e., publicável). */
function isPublicHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !PRIVATE_HOST_RE.test(parsed.hostname);
  } catch (_err) {
    return false;
  }
}

/**
 * Base pública da aplicação: APP_URL quando é uma URL pública de verdade;
 * senão a origem do request (dev) — e o chamador sabe, por isPublicHttpUrl,
 * que essa base NÃO é alcançável externamente.
 */
function resolvePublicBaseUrl({ appUrl, origin } = {}) {
  const app = String(appUrl || '').trim().replace(/\/$/, '');
  if (app && isPublicHttpUrl(app)) return app;
  const org = String(origin || '').trim().replace(/\/$/, '');
  if (org && isPublicHttpUrl(org)) return org;
  return app || org || '';
}

function mediaPublicUrl(base, fileName) {
  const cleanBase = String(base || '').replace(/\/$/, '');
  const cleanName = String(fileName || '').replace(/^\/+/, '');
  return cleanBase ? `${cleanBase}/media/${cleanName}` : `/media/${cleanName}`;
}

module.exports = { isPublicHttpUrl, resolvePublicBaseUrl, mediaPublicUrl, PRIVATE_HOST_RE };
