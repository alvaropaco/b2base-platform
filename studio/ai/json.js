'use strict';

/**
 * studio/ai/json.js — parse tolerante da saída de LLM (fix issue extração).
 *
 * Modelos às vezes devolvem JSON com prosa antes/depois ("Aqui está: {..."),
 * cercas com texto residual ou saída truncada. `parseModelJson` tenta, em
 * ordem: JSON direto → cerca não-ancorada → primeiro objeto balanceado
 * (respeitando strings). Truncado → null (o caller decide o retry).
 */

function balancedObjectSlice(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // JSON truncado (fechamento nunca chegou)
}

function parseModelJson(content) {
  const s = String(content || '').trim();
  if (!s) return null;

  // 1) JSON direto.
  try {
    return JSON.parse(s);
  } catch (_) {
    /* segue */
  }

  // 2) Cerca de código (não-ancorada — permite prosa antes/depois).
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_) {
      /* segue */
    }
  }

  // 3) Primeiro objeto balanceado no texto (prosa em volta).
  const start = s.indexOf('{');
  if (start >= 0) {
    const slice = balancedObjectSlice(s, start);
    if (slice) {
      try {
        return JSON.parse(slice);
      } catch (_) {
        /* segue */
      }
    }
  }
  return null;
}

module.exports = { parseModelJson, balancedObjectSlice };

/**
 * Chamada LLM com expectativa de JSON + reparo POR ESTÁGIO (Epic 1, FR1).
 * `buildUser(previousRaw)` recebe null na 1ª tentativa e a resposta inválida
 * nas seguintes (prompt de reparo). `validate` decide se o JSON serve.
 * Resposta truncada (finish_reason=length) vira pedido explícito de concisão
 * no retry — truncado nunca parseia, então o reparo precisa encurtar.
 *
 * Dois orçamentos INDEPENDENTES (retry por estágio):
 *   - `parseAttempts` (default 3): tentativas cuja saída NÃO virou JSON
 *     utilizável — inclui falhas de infraestrutura do LLM (timeout/HTTP,
 *     err.code LLM_TIMEOUT/LLM_HTTP_ERROR), que nunca produziram JSON.
 *   - `validateAttempts` (default 2): tentativas que parsearam mas foram
 *     rejeitadas pelo `validate` (ex.: critérios fora do catálogo).
 * O loop segue enquanto sobrar orçamento nos DOIS estágios; o erro final
 * informa qual estágio esgotou (o trace carrega o errorCode).
 */
/**
 * Só INFRAESTRUTURA consome orçamento de parse (Epic 1): timeout/HTTP do
 * gateway e erro de rede cru (undici "fetch failed", ECONN*). Bug de código,
 * 401/403 de autenticação (têm status) ou qualquer outra exceção vai DIRETO
 * sem retry — re-tentar não conserta e queima o deadline.
 */
function isInfraLlmError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === 'LLM_TIMEOUT' || err.code === 'LLM_HTTP_ERROR') return true;
  if (err.status != null || err.response != null) return false;
  return /fetch failed|network|econn|etimedout|socket|eai_again|abort/i.test(
    String(err.message || err.code || '')
  );
}

/** Deadline suave: esgotado, nenhum retry NOVO começa (o turno degrada). */
const RETRY_DEADLINE_MS = 75_000;

async function callLlmJson(llm, { system, buildUser, validate, maxTokens = 1200, temperature = 0.4, model, tag, timeoutMs, parseAttempts = 3, validateAttempts = 2 }) {
  let lastRaw = null;
  let lastProblem = null;
  let lastTruncated = false;
  let lastLlmError = null;
  let parseFailures = 0; // saída não virou JSON utilizável (ou LLM falhou)
  let validateFailures = 0; // parseou, mas o validate rejeitou
  const startedAt = Date.now();

  while (parseFailures < parseAttempts && validateFailures < validateAttempts) {
    if (parseFailures + validateFailures > 0 && Date.now() - startedAt > RETRY_DEADLINE_MS) {
      lastProblem = lastProblem || 'deadline de retry esgotado';
      break;
    }
    const isFirst = parseFailures === 0 && validateFailures === 0;
    let user = buildUser(isFirst ? null : lastRaw);
    if (!isFirst && lastTruncated) {
      user += '\n\nIMPORTANTE: sua resposta anterior foi CORTADA por limite de tamanho e ficou um JSON inválido. Responda de forma muito mais concisa (texts curtos, rationale em até 2 frases) garantindo que o JSON feche.';
    }
    let result;
    try {
      result = await llm({
        system,
        user,
        jsonMode: true,
        temperature: isFirst ? temperature : 0,
        maxTokens,
        model,
        tag,
        timeoutMs,
      });
    } catch (err) {
      // Timeout/HTTP/rede do gateway conta no orçamento do estágio de parse
      // (nunca produziu JSON) — o retry por estágio cobre gateway instável
      // antes de degradar o turno. Qualquer outro erro é throw imediato.
      if (!isInfraLlmError(err)) throw err;
      parseFailures += 1;
      lastLlmError = err;
      lastProblem = `falha de LLM (${err.code || err.message})`;
      continue;
    }
    lastRaw = result.content;
    lastTruncated = Boolean(result.truncated);
    const parsed = parseModelJson(result.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!validate) return parsed;
      const problem = validate(parsed);
      if (!problem) return parsed;
      lastProblem = problem;
      validateFailures += 1;
    } else {
      parseFailures += 1;
      lastProblem = lastTruncated ? 'resposta truncada por limite de tokens' : 'resposta não é JSON';
    }
  }

  const stage = validateFailures >= validateAttempts ? 'validação' : 'parse';
  const err = new Error(
    `Resposta não é JSON utilizável — estágio ${stage} esgotado ` +
      `(${parseFailures} tentativa(s) de parse, ${validateFailures} de validação)` +
      `${lastProblem ? ` (${lastProblem})` : ''}.` +
      // A causa raiz de infra (quando houve) vai na mensagem — erro visível.
      (lastLlmError ? ` Causa raiz: [${lastLlmError.code || 'sem código'}] ${lastLlmError.message}` : '')
  );
  err.code = 'LLM_JSON_FAILED';
  err.status = 502;
  err.stage = stage;
  err.llmCode = lastLlmError ? lastLlmError.code || null : null;
  throw err;
}

module.exports.callLlmJson = callLlmJson;
