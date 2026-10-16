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
    const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
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

module.exports = { isConfigured, describeImage, visionModel };
