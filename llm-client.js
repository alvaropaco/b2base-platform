/**
 * llm-client.js — cliente compartilhado para o gateway LiteLLM (API
 * OpenAI-compatível /v1/chat/completions).
 *
 * Motivação: havia 3 cópias do mesmo fetch inline (outreach-workers,
 * reengagement-agent, reengagement-reply). O código NOVO da esteira de IA
 * (campanha premium, geração por lead no WhatsApp) usa este cliente, que
 * acrescenta o que as cópias inline não tinham:
 *   - timeout via AbortController (gateway travado não segura o worker);
 *   - log de usage (tokens) — antes ninguém lia o consumo de LLM;
 *   - override de modelo por chamada (AI_CAMPAIGN_LLM_MODEL) com retry-fallback
 *     para o modelo padrão caso o alias não exista no gateway.
 *
 * As cópias inline existentes NÃO foram migradas de propósito (escopo/risco).
 */

// Gateway do cluster pode ter picos (fila do router): 30s cobre o p99 sem
// travar o worker por muito tempo. Chamadores específicos podem sobrescrever.
const DEFAULT_TIMEOUT_MS = 30000;

function llmUrl() {
  return process.env.LITELLM_URL || 'http://localhost:4000';
}

function defaultModel() {
  return process.env.LITELLM_MODEL || 'qwen/qwen2.5-7b-instruct';
}

/**
 * Remove cercas de código (```json ... ```) que alguns modelos adicionam mesmo
 * em JSON mode. Retorna string pronta para JSON.parse.
 */
function stripJsonFences(content) {
  const s = String(content || '').trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : s;
}

/**
 * Uma chamada de chat completion. Retorna { content, usage, model }.
 * Lança em qualquer falha (caller decide o fallback — padrão do repo).
 *
 * @param {object} opts
 * @param {string} opts.system   system prompt
 * @param {string} opts.user     user prompt
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.maxTokens=800]
 * @param {boolean} [opts.jsonMode=true]  response_format json_object
 * @param {string} [opts.model]  override (ex.: AI_CAMPAIGN_LLM_MODEL)
 * @param {number} [opts.timeoutMs=12000]
 * @param {string} [opts.tag='llm']  etiqueta para o log de usage
 */
async function callLlm({
  system,
  user,
  temperature = 0.7,
  maxTokens = 800,
  jsonMode = true,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tag = 'llm',
} = {}) {
  if (!user) throw new Error('llm_client_missing_prompt');

  const primaryModel = model || defaultModel();
  let result;
  try {
    result = await _chatCompletion({
      system, user, temperature, maxTokens, jsonMode, timeoutMs, model: primaryModel,
    });
  } catch (err) {
    // Alias configurado não existe no gateway (ou erro transitório dele):
    // cai para o modelo padrão para a feature não parar, mas grita no log —
    // operação deve corrigir o AI_CAMPAIGN_LLM_MODEL.
    if (primaryModel !== defaultModel()) {
      console.warn(
        `[llm-client] modelo "${primaryModel}" falhou (${err.message}); ` +
        `retry com "${defaultModel()}" — corrija AI_CAMPAIGN_LLM_MODEL`
      );
      result = await _chatCompletion({
        system, user, temperature, maxTokens, jsonMode, timeoutMs, model: defaultModel(),
      });
      result.fallbackUsed = true;
    } else {
      throw err;
    }
  }

  const usage = result.usage || null;
  if (usage) {
    console.log(
      `[llm-client] usage tag=${tag} model=${result.model} ` +
      `prompt=${usage.prompt_tokens || 0} completion=${usage.completion_tokens || 0}` +
      (result.truncated ? ' TRUNCATED (finish_reason=length — aumente maxTokens)' : '')
    );
  }
  return {
    content: result.content,
    usage,
    model: result.model,
    truncated: Boolean(result.truncated),
    fallbackUsed: Boolean(result.fallbackUsed),
  };
}

async function _chatCompletion({ system, user, temperature, maxTokens, jsonMode, timeoutMs, model }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${llmUrl()}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LITELLM_API_KEY
          ? { Authorization: `Bearer ${process.env.LITELLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model,
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
    if (err.name === 'AbortError') throw new Error(`llm_timeout_${timeoutMs}ms`);
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
    throw new Error(`LiteLLM HTTP ${res.status}${detail}`);
  }

  const json = await res.json();
  const choice = (json.choices && json.choices[0]) || {};
  const content = (choice.message && choice.message.content) || '';
  return {
    content,
    usage: json.usage || null,
    model,
    truncated: choice.finish_reason === 'length',
  };
}

/**
 * JSON.parse tolerante (cercas de código, conteúdo vazio). Retorna null se
 * não conseguir — callers usam fallback determinístico.
 */
function parseJsonLoose(content) {
  try {
    return JSON.parse(stripJsonFences(content));
  } catch (_) {
    return null;
  }
}

module.exports = {
  callLlm,
  parseJsonLoose,
  stripJsonFences,
  defaultModel,
  premiumModel: () => process.env.AI_CAMPAIGN_LLM_MODEL || defaultModel(),
};
