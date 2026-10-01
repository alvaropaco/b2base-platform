'use strict';

/**
 * eval/judge-gateway.js — cliente do JUDGE INDEPENDENTE (Story 4.5, D3).
 *
 * O judge v2 roda num gateway DISTINTO do SUT: o agente avaliado fala com o
 * LiteLLM (LITELLM_*); o judge fala com o Laya (B2BASE_JUDGE_*) — "a nota não
 * é chutar o próprio jogo". API OpenAI-compatível (/chat/completions), mesmo
 * contrato de retorno do llm-client ({ content, model, usage, truncated }).
 *
 * Variáveis:
 *   B2BASE_JUDGE_URL      base do gateway do judge (ex.: https://laya.example)
 *   B2BASE_JUDGE_API_KEY  bearer do gateway
 *   B2BASE_JUDGE_MODEL    modelo dedicado do judge
 *   B2BASE_JUDGE_TIMEOUT_MS (default 60000)
 *
 * Sem B2BASE_JUDGE_URL o judge v2 não existe e a suíte cai para o v1
 * (LiteLLM) — o runner registra qual versão rodou no relatório.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

function judgeConfig() {
  return {
    url: process.env.B2BASE_JUDGE_URL || null,
    apiKey: process.env.B2BASE_JUDGE_API_KEY || null,
    model: process.env.B2BASE_JUDGE_MODEL || null,
    timeoutMs: Number(process.env.B2BASE_JUDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
}

function isJudgeV2Configured() {
  const cfg = judgeConfig();
  return Boolean(cfg.url && cfg.model);
}

/**
 * callLlm-compatível apontando para o gateway do judge. Lança com .code
 * (JUDGE_TIMEOUT / JUDGE_HTTP_ERROR) — o runner classifica como infra.
 */
async function createJudgeLlm(overrides = {}) {
  const cfg = { ...judgeConfig(), ...overrides };
  if (!cfg.url || !cfg.model) throw new Error('judge v2 requer B2BASE_JUDGE_URL e B2BASE_JUDGE_MODEL');

  return async function judgeLlmCall({ system, user, temperature = 0, maxTokens = 3000, jsonMode = true } = {}) {
    if (!user) throw new Error('judge v2 requer prompt');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let res;
    try {
      res = await fetch(`${cfg.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
          ],
          temperature,
          max_tokens: maxTokens,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
    } catch (err) {
      const errCode = String((err && err.code) || '');
      if (err.name === 'AbortError' || errCode.startsWith('UND_ERR_')) {
        const timeoutErr = new Error(`judge_timeout_${cfg.timeoutMs}ms`);
        timeoutErr.code = 'JUDGE_TIMEOUT';
        throw timeoutErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body && body.error && body.error.message ? `: ${body.error.message}` : '';
      } catch (_) { /* corpo não-JSON */ }
      const httpErr = new Error(`JUDGE HTTP ${res.status}${detail}`);
      httpErr.code = 'JUDGE_HTTP_ERROR';
      httpErr.status = res.status;
      throw httpErr;
    }
    const json = await res.json();
    const choice = (json.choices && json.choices[0]) || {};
    return {
      content: (choice.message && choice.message.content) || '',
      usage: json.usage || null,
      model: cfg.model,
      truncated: choice.finish_reason === 'length',
    };
  };
}

module.exports = { judgeConfig, isJudgeV2Configured, createJudgeLlm };
