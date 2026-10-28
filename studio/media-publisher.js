'use strict';

/**
 * studio/media-publisher.js — PUBLICAÇÃO OPCIONAL das imagens do Studio em
 * armazenamento/CDN externo (produção), por HTTP PUT genérico.
 *
 * POR QUÊ (2026-10-27, "URLs HTTPS públicas estáveis"): em produção atrás de
 * um domínio com HTTPS, a rota local /media já é pública (o proxy repassa) —
 * nada a fazer além de APP_URL. Quando o servidor NÃO é alcançável pela
 * internet (dev, self-host sem domínio), o dono pode configurar um destino
 * externo (ex.: Cloudflare R2 API, MinIO gateway, CDN com upload PUT) e as
 * imagens passam a ter URL pública própria.
 *
 * Configuração (todas obrigatórias juntas para ativar):
 *   MEDIA_PUBLISH_PUT_URL  — endpoint com {fileName} substituído (ex.:
 *     https://api.cloudflare.com/client/v4/accounts/<acct>/r2/buckets/<b>/objects/{fileName})
 *   MEDIA_PUBLISH_AUTH     — valor do header Authorization (ex.: Bearer ...)
 *   MEDIA_PUBLISH_PUBLIC_BASE — base pública onde o arquivo fica servido
 *     (ex.: https://cdn.seudominio.com)
 *
 * Fail-safe: qualquer falha de publicação → devolve provider 'local' e o
 * chamador usa a rota /media local de sempre (nunca quebra o envio).
 */

const PUBLISH_PUT_URL = () => process.env.MEDIA_PUBLISH_PUT_URL || '';
const PUBLISH_AUTH = () => process.env.MEDIA_PUBLISH_AUTH || '';
const PUBLISH_PUBLIC_BASE = () => String(process.env.MEDIA_PUBLISH_PUBLIC_BASE || '').replace(/\/$/, '');

/** Publicação externa configurada? (as três envs juntas) */
function isRemotePublishConfigured() {
  return Boolean(PUBLISH_PUT_URL() && PUBLISH_AUTH() && PUBLISH_PUBLIC_BASE());
}

function contentTypeFor(fileName) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

/**
 * Publica o arquivo já salvo no storage local.
 * @param {string} fileName - nome no storage (hash.ext, gerado/ ou base)
 * @param {object} deps - { readGenerated, readBuffer, fetchImpl? }
 * @returns {Promise<{provider:'remote'|'local', url: string|null, error?: string}>}
 */
async function publishMedia(fileName, deps = {}) {
  const { readGenerated, readBuffer, fetchImpl } = deps;
  const safe = String(fileName || '').replace(/^\/+/, '');
  const publicBase = PUBLISH_PUBLIC_BASE();
  if (!PUBLISH_PUT_URL() || !PUBLISH_AUTH() || !publicBase) {
    return { provider: 'local', url: null, error: 'publishing_not_configured' };
  }
  let buffer = null;
  try {
    buffer = readGenerated ? readGenerated(safe) : null;
  } catch (_e) { /* pode ser anexo na base do storage */ }
  if (!buffer && readBuffer) {
    try { buffer = readBuffer(safe); } catch (_e) { /* sem arquivo */ }
  }
  if (!buffer) {
    return { provider: 'local', url: null, error: 'file_not_found' };
  }

  const endpoint = PUBLISH_PUT_URL().replace('{fileName}', encodeURIComponent(safe));
  try {
    const doFetch = fetchImpl || global.fetch;
    const res = await doFetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: PUBLISH_AUTH(),
        'Content-Type': contentTypeFor(safe),
      },
      body: buffer,
    });
    if (!res || !res.ok) {
      const status = res ? res.status : 0;
      return { provider: 'local', url: null, error: `publish_http_${status}` };
    }
    return { provider: 'remote', url: `${publicBase}/${safe}` };
  } catch (err) {
    return { provider: 'local', url: null, error: `publish_failed: ${err.message}` };
  }
}

module.exports = { isRemotePublishConfigured, publishMedia, contentTypeFor };
