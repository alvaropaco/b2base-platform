'use strict';

/**
 * studio/ai/embeddings.js — cliente de embeddings do Cockpit (Epic 2, D1).
 *
 * MESMO padrão do `cnpj-data-publisher` (processing/embedder.py): POST
 * OpenAI-compatible `{base}/v1/embeddings` no gateway LiteLLM (o MESMO
 * LITELLM_URL/LITELLM_API_KEY do chat — nenhuma dependência nova,
 * constituição VI), model `gemini-embedding` (env STUDIO_EMBEDDING_MODEL),
 * batch ≤128, timeout via AbortController e retry 1×.
 *
 * D1 — a semântica amplia recall e FALHA PARA BAIXO: sem LITELLM_URL o
 * cliente está desabilitado (`embedTexts` devolve null) e a captura segue
 * lexical-only, explicada no card. Nada da captura depende de LLM generativo.
 */

const DEFAULT_MODEL = 'gemini-embedding';
const DEFAULT_BATCH = 128; // publisher usa 128 (EMBEDDING_BATCH_SIZE)
const DEFAULT_TIMEOUT_MS = 20_000;

function baseUrl() {
  return String(process.env.LITELLM_URL || '').trim().replace(/\/+$/, '');
}

function apiKey() {
  return process.env.LITELLM_API_KEY || '';
}

function modelName() {
  return process.env.STUDIO_EMBEDDING_MODEL || DEFAULT_MODEL;
}

/**
 * Forma texto do pgvector: `[0.1,0.2,...]` (embedder.py::_to_pgvector).
 * Exportado para capture-service e backfill escreverem vetores idênticos.
 */
function toPgVector(values) {
  return '[' + values.map((v) => String(Number(v))).join(',') + ']';
}

/**
 * Fábrica com deps injetáveis (`fetchImpl` nos testes — padrão stub de LLM
 * de test/studio-chat.test.js:95). `embedTexts(texts) → number[][]` devolve
 * um vetor POR TEXTO de entrada, na MESMA ordem; null quando desabilitado.
 */
function createEmbeddingsClient(deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  // Guard `>0`: env ≤0/NaN NUNCA pode zerar o timeout (matava todo embedding
  // com abort imediato) — cai no default.
  const envTimeout = Number(process.env.STUDIO_EMBEDDING_TIMEOUT_MS);
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs)
    : envTimeout > 0 ? envTimeout
      : DEFAULT_TIMEOUT_MS;
  const batchSize = Number(deps.batchSize) > 0 ? Number(deps.batchSize) : DEFAULT_BATCH;
  const retryDelayMs = Number(deps.retryDelayMs) > 0 ? Number(deps.retryDelayMs) : 500;

  /** Falha VALE retry (transiente): timeout ou HTTP 5xx. 4xx/shape não. */
  function isRetryable(err) {
    if (!err) return false;
    if (err.code === 'EMBEDDINGS_TIMEOUT') return true;
    return err.code === 'EMBEDDINGS_HTTP_ERROR' && Number(err.status) >= 500;
  }

  async function embedBatch(texts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl()}/v1/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
        },
        body: JSON.stringify({ model: modelName(), input: texts }),
        signal: controller.signal,
      });
    } catch (err) {
      const name = String((err && err.name) || '');
      if (name === 'AbortError' || String((err && err.code) || '').startsWith('UND_ERR_')) {
        const timeoutErr = new Error(`embeddings_timeout_${timeoutMs}ms`);
        timeoutErr.code = 'EMBEDDINGS_TIMEOUT';
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const httpErr = new Error(`Embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
      httpErr.code = 'EMBEDDINGS_HTTP_ERROR';
      httpErr.status = res.status;
      throw httpErr;
    }
    const payload = await res.json();
    // OpenAI-compatible: {"data": [{"index": i, "embedding": [...]}, ...]}
    const rows = (payload && Array.isArray(payload.data) ? payload.data : [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = rows.map((r) => r && r.embedding);
    const malformed = vectors.length !== texts.length ||
      vectors.some((v) => !Array.isArray(v) || v.some((x) => !Number.isFinite(Number(x))));
    if (malformed) {
      const err = new Error(`embeddings endpoint devolveu vetores inválidos para ${texts.length} entradas`);
      err.code = 'EMBEDDINGS_SHAPE';
      throw err;
    }
    return vectors;
  }

  /**
   * Vetores para TODOS os textos (batch ≤128). Contrato: UM vetor por texto
   * de entrada, NA MESMA ORDEM — strings em branco vão como vieram (o
   * chamador decide se manda; o endpoint que responde). null quando
   * LITELLM_URL ausente: captura segue lexical-only. Retry 1× APENAS para
   * falha transitória (timeout / HTTP 5xx), com delay — 4xx e shape inválido
   * propagam na 1ª tentativa (repetir seria repetir o mesmo erro).
   */
  async function embedTexts(texts) {
    const list = Array.isArray(texts) ? texts : [];
    if (!baseUrl()) return null;
    if (list.length === 0) return [];
    const vectors = [];
    for (let i = 0; i < list.length; i += batchSize) {
      const chunk = list.slice(i, i + batchSize);
      let batch;
      try {
        batch = await embedBatch(chunk);
      } catch (err) {
        if (!isRetryable(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        batch = await embedBatch(chunk); // retry 1× — 2ª falha propaga
      }
      vectors.push(...batch);
    }
    return vectors;
  }

  return {
    embedTexts,
    isConfigured: () => Boolean(baseUrl()),
    _embedBatchForTests: embedBatch,
  };
}

module.exports = {
  createEmbeddingsClient,
  toPgVector,
  DEFAULT_MODEL,
  DEFAULT_BATCH,
};
