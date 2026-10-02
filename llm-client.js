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
    // Epic 1 (FR3): abort E timeouts de rede do undici (TypeError com code
    // UND_ERR_SOCKET/UND_ERR_CONNECT_TIMEOUT/UND_ERR_ABORTED — NÃO AbortError)
    // viram LLM_TIMEOUT; sem isso o errorCode do StudioChatTrace nascia null
    // e a telemetria escondia a causa.
    const errCode = String((err && err.code) || '');
    if (err.name === 'AbortError' || errCode.startsWith('UND_ERR_')) {
      const timeoutErr = new Error(`llm_timeout_${timeoutMs || DEFAULT_TIMEOUT_MS}ms`);
      timeoutErr.code = 'LLM_TIMEOUT';
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
    const httpErr = new Error(`LiteLLM HTTP ${res.status}${detail}`);
    httpErr.code = 'LLM_HTTP_ERROR';
    httpErr.status = res.status;
    throw httpErr;
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

/**
 * Uma chamada de chat completion EM STREAMING (SSE OpenAI-compatível).
 * Mesma semântica de callLlm (retorno/falhas), mas o conteúdo chega em
 * pedaços: `onDelta(fullSoFar)` é chamado a cada pedaço acumulado — o chat
 * do Cockpit renderiza a resposta ENQUANTO o modelo escreve (latência
 * percebida cai de segundos para o primeiro token). Falhar aqui NUNCA é
 * fatal: o caller cai para callLlm não-streaming (caminho de reparo).
 */
async function callLlmStream({
  system,
  user,
  temperature = 0.7,
  maxTokens = 800,
  jsonMode = true,
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tag = 'llm',
  onDelta = () => {},
} = {}) {
  if (!user) throw new Error('llm_client_missing_prompt');

  const primaryModel = model || defaultModel();
  let result;
  try {
    result = await _chatCompletionStream({
      system, user, temperature, maxTokens, jsonMode, timeoutMs, model: primaryModel, onDelta,
    });
  } catch (err) {
    if (primaryModel !== defaultModel()) {
      console.warn(
        `[llm-client] stream do modelo "${primaryModel}" falhou (${err.message}); ` +
        `retry com "${defaultModel()}" — corrija AI_CAMPAIGN_LLM_MODEL`
      );
      result = await _chatCompletionStream({
        system, user, temperature, maxTokens, jsonMode, timeoutMs, model: defaultModel(), onDelta,
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
      (result.truncated ? ' TRUNCATED (finish_reason=length)' : '')
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

async function _chatCompletionStream({ system, user, temperature, maxTokens, jsonMode, timeoutMs, model, onDelta }) {
  const controller = new AbortController();
  // Streaming: o teto vale para IDLE (sem chunk novo), não para o total —
  // gerações longas de modelo pequeno podem levar minutos no total.
  let timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  const resetTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  };

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
        stream: true,
        stream_options: { include_usage: true },
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
      const timeoutErr = new Error(`llm_stream_timeout_${timeoutMs || DEFAULT_TIMEOUT_MS}ms`);
      timeoutErr.code = 'LLM_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  }

  if (!res.ok) {
    clearTimeout(timer);
    let detail = '';
    try {
      const body = await res.json();
      detail = body && body.error && body.error.message ? `: ${body.error.message}` : '';
    } catch (_) { /* corpo não-JSON */ }
    const httpErr = new Error(`LiteLLM HTTP ${res.status}${detail}`);
    httpErr.code = 'LLM_HTTP_ERROR';
    httpErr.status = res.status;
    throw httpErr;
  }

  let content = '';
  let usage = null;
  let truncated = false;
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      resetTimer();
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch (_) {
          continue;
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = (chunk.choices && chunk.choices[0]) || {};
        if (choice.finish_reason === 'length') truncated = true;
        const piece = choice.delta && choice.delta.content;
        if (typeof piece === 'string' && piece.length > 0) {
          content += piece;
          onDelta(content);
        }
      }
    }
  } catch (err) {
    const errCode = String((err && err.code) || '');
    if (err.name === 'AbortError' || errCode.startsWith('UND_ERR_')) {
      const timeoutErr = new Error('llm_stream_idle_timeout');
      timeoutErr.code = 'LLM_TIMEOUT';
      throw timeoutErr;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (content.length === 0) {
    const emptyErr = new Error('llm_stream_vazio (gateway não transmitiu chunks)');
    emptyErr.code = 'LLM_HTTP_ERROR';
    throw emptyErr;
  }
  return { content, usage, model, truncated };
}

module.exports = {
  callLlm,
  callLlmStream,
  parseJsonLoose,
  stripJsonFences,
  defaultModel,
  premiumModel: () => process.env.AI_CAMPAIGN_LLM_MODEL || defaultModel(),
};
