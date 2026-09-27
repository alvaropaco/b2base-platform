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
 * Chamada LLM com expectativa de JSON + reparo (US chat/compose/segment-nl).
 * `buildUser(previousRaw)` recebe null na 1ª tentativa e a resposta inválida
 * nas seguintes (prompt de reparo). `validate` decide se o JSON serve.
 * Resposta truncada (finish_reason=length) vira pedido explícito de concisão
 * no retry — truncado nunca parseia, então o reparo precisa encurtar.
 */
async function callLlmJson(llm, { system, buildUser, validate, maxTokens = 1200, temperature = 0.4, model, tag, attempts = 2 }) {
  let lastRaw = null;
  let lastProblem = null;
  let lastTruncated = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let user = buildUser(attempt === 1 ? null : lastRaw);
    if (attempt > 1 && lastTruncated) {
      user += '\n\nIMPORTANTE: sua resposta anterior foi CORTADA por limite de tamanho e ficou um JSON inválido. Responda de forma muito mais concisa (texts curtos, rationale em até 2 frases) garantindo que o JSON feche.';
    }
    const result = await llm({
      system,
      user,
      jsonMode: true,
      temperature: attempt === 1 ? temperature : 0,
      maxTokens,
      model,
      tag,
    });
    lastRaw = result.content;
    lastTruncated = Boolean(result.truncated);
    const parsed = parseModelJson(result.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (!validate) return parsed;
      const problem = validate(parsed);
      if (!problem) return parsed;
      lastProblem = problem;
    } else if (lastTruncated) {
      lastProblem = 'resposta truncada por limite de tokens';
    } else {
      lastProblem = 'resposta não é JSON';
    }
  }
  const err = new Error(`Resposta não é JSON utilizável após ${attempts} tentativas${lastProblem ? ` (${lastProblem})` : ''}.`);
  err.code = 'LLM_JSON_FAILED';
  err.status = 502;
  throw err;
}

module.exports.callLlmJson = callLlmJson;
