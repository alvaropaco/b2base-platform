'use strict';

/**
 * studio/ai/image-gen.js — GERAÇÃO DE IMAGEM (banner de e-mail) via gateway
 * LiteLLM, endpoint OpenAI-compatível /v1/images/generations.
 *
 * Modelo configurado por STUDIO_IMAGE_MODEL (ex.: 'gpt-image-1',
 * 'dall-e-3', 'gemini-2.0-flash-exp-image-generation' — o que o gateway
 * expuser); sem STUDIO_IMAGE_MODEL → isConfigured() false e o chat degrada
 * com instrução honesta (nada de fingir geração).
 *
 * Devolve { buffer, mimeType } — o storage do Studio grava e a rota pública
 * /media/:name serve para os clientes de e-mail dos leads.
 */

function llmUrl() {
  return process.env.LITELLM_URL || 'http://localhost:4000';
}

function imageModel() {
  return process.env.STUDIO_IMAGE_MODEL || '';
}

function isConfigured() {
  return Boolean(imageModel() && (process.env.LITELLM_URL || process.env.LITELLM_API_KEY));
}

/**
 * Gera a imagem do prompt. @returns {Promise<{buffer: Buffer, mimeType: string}>}
 * Aceita b64_json (OpenAI/gateway) ou url (alguns providers) — url é baixada.
 */
async function generateImage({ prompt, size = '1024x1024', timeoutMs = 120000, fetchImpl = fetch } = {}) {
  if (!isConfigured()) {
    const err = new Error('STUDIO_IMAGE_MODEL não configurado — geração de imagem indisponível neste ambiente.');
    err.code = 'IMAGE_GEN_NOT_CONFIGURED';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('image-gen timeout')), timeoutMs);
  try {
    const res = await fetchImpl(`${llmUrl()}/v1/images/generations`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LITELLM_API_KEY ? { Authorization: `Bearer ${process.env.LITELLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: imageModel(), prompt, n: 1, size, response_format: 'b64_json' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Code carrega o STATUS (2026-10-22): o handler do chat usa IMAGE_GEN_
      // HTTP_400/404/422 para saber que a recusa é do FORMATO (size) e cair
      // no quadrado — 'IMAGE_GEN_UNAVAILABLE' genérico escondia isso.
      const err = new Error(`IMAGE_GEN_HTTP_${res.status}: ${(body && body.error && body.error.message) || 'gateway indisponível'}`);
      err.code = `IMAGE_GEN_HTTP_${res.status}`;
      throw err;
    }
    const item = body && body.data && body.data[0];
    if (item && item.b64_json) {
      return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png' };
    }
    if (item && item.url) {
      const file = await fetchImpl(item.url, { signal: controller.signal });
      if (!file.ok) {
        const err = new Error(`IMAGE_GEN_ASSET_HTTP_${file.status}`);
        err.code = 'IMAGE_GEN_UNAVAILABLE';
        throw err;
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const mimeType = file.headers && file.headers.get ? (file.headers.get('content-type') || 'image/png') : 'image/png';
      return { buffer, mimeType: mimeType.split(';')[0] };
    }
    const err = new Error('gateway respondeu sem imagem');
    err.code = 'IMAGE_GEN_EMPTY';
    throw err;
  } catch (err) {
    if (!err.code) err.code = String((err && err.message) || '').includes('timeout') ? 'IMAGE_GEN_TIMEOUT' : 'IMAGE_GEN_UNAVAILABLE';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, generateImage, imageModel };
