'use strict';

/**
 * studio/ai/vision.js — LEITURA DE IMAGEM (visão) via gateway LiteLLM
 * (OpenAI-compatível: content parts com image_url data-URL).
 *
 * Usado pela extração de materiais de imagem (material-service deps
 * `imageExtract`): descreve produto/oferta/público/texto do banner para o
 * extractor estruturado que já existe. Sem LITELLM configurado →
 * isConfigured() false → o material degrada para 'needs_manual' como hoje.
 * Modelo sem suporte a visão → erro da API → degradação explicável
 * (VISION_UNAVAILABLE), nunca quebra o fluxo do material.
 */

const { llmUrl } = (() => {
  // Espelho leve de llm-client (mesmo gateway) sem importar o cliente de
  // texto — a visão tem payload e timeout próprios.
  return {
    llmUrl: () => process.env.LITELLM_URL || 'http://localhost:4000',
  };
})();

function isConfigured() {
  return Boolean(process.env.LITELLM_URL || process.env.LITELLM_API_KEY);
}

function visionModel() {
  return process.env.STUDIO_VISION_MODEL || process.env.LITELLM_MODEL || 'gpt-4o-mini';
}

// O mime DECLARADO no upload não é confiável: clientes mandam 'image/jpg'
// (não-padrão) ou 'application/octet-stream' para .jpeg — e o gateway
// rejeita o data-url com mime inválido, matando a extração do material
// (png/jpg de browser sempre vinham certos; jpeg por outros caminhos, não).
// A assinatura (magic bytes) do buffer vence qualquer mime declarado.
const IMAGE_SIGNATURES = [
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, // RIFF….WEBP
];

function sniffImageMime(buffer) {
  for (const sig of IMAGE_SIGNATURES) {
    if (!sig.bytes.every((byte, i) => buffer[i] === byte)) continue;
    if (sig.mime !== 'image/webp') return sig.mime;
    if (buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return sig.mime;
  }
  return null;
}

function normalizeImageMime(buffer, mimeType) {
  const sniffed = sniffImageMime(buffer);
  if (sniffed) return sniffed;
  const declared = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (declared === 'image/jpg') return 'image/jpeg';
  if (/^image\/(png|jpeg|webp|gif)$/.test(declared)) return declared;
  return 'image/jpeg';
}

/**
 * Descreve a imagem para o extractor: produto, oferta, público, textos do
 * banner e cores — em texto corrido (o extractor estruturado consome texto).
 * @returns {Promise<string>} descrição.
 */
async function describeImage({ buffer, mimeType = 'image/jpeg', hint = null, timeoutMs = 45000 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    const err = new Error('buffer de imagem vazio');
    err.code = 'VISION_INVALID_INPUT';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('vision timeout')), timeoutMs);
  try {
    const dataUrl = `data:${normalizeImageMime(buffer, mimeType)};base64,${buffer.toString('base64')}`;
    const res = await fetch(`${llmUrl()}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LITELLM_API_KEY ? { Authorization: `Bearer ${process.env.LITELLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: visionModel(),
        max_tokens: 700,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Descreva esta imagem de MATERIAL DE VENDA para uma base de prospecção B2B. ' +
                  'Liste objetivamente: (1) PRODUTO/serviço anunciado; (2) OFERTA/promessa/CTA; ' +
                  '(3) PÚBLICO-alvo aparente; (4) TODO texto que aparece na imagem, literal; ' +
                  '(5) cores e estilo visual. Seja fiel à imagem — nada de inventar.' +
                  (hint ? ` Contexto informado pelo usuário: ${hint}` : ''),
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`VISION_HTTP_${res.status}: ${(body && body.error && body.error.message) || 'gateway indisponível'}`);
      err.code = 'VISION_UNAVAILABLE';
      throw err;
    }
    const content = body && body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content;
    if (!content || !String(content).trim()) {
      const err = new Error('vision respondeu vazio');
      err.code = 'VISION_EMPTY';
      throw err;
    }
    return String(content).trim();
  } catch (err) {
    if (!err.code) {
      err.code = (signalAborted(err)) ? 'VISION_TIMEOUT' : 'VISION_UNAVAILABLE';
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function signalAborted(err) {
  return String((err && err.name) || '').includes('Abort') || String((err && err.message) || '').includes('timeout');
}

module.exports = { isConfigured, describeImage, visionModel, normalizeImageMime };
