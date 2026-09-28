'use strict';

/**
 * eval/llm-judge.js — LLM-as-a-Judge para a suíte conversacional.
 *
 * Avalia a CONVERSA produzida pelo sistema em produção (não é a fonte da
 * verdade: as asserções determinísticas continuam sendo a 1ª linha de
 * regressão). Reprojetado com validação estrita de schema, metadados e
 * temperatura 0 para reprodutibilidade.
 *
 * Erros explícitos: JUDGE_INVALID_JSON / JUDGE_INVALID_SCHEMA /
 * JUDGE_INVALID_SCORE. O overall é calculado AQUI (média ponderada das
 * métricas validadas) — o número que o modelo devolver é informativo apenas.
 */

const { WEIGHTED_METRICS } = require('./lib');

const JUDGE_VERSION = 'v1';
const METRIC_NAMES = Object.keys(WEIGHTED_METRICS);

const SYSTEM = [
  'Você é um avaliador rigoroso de experiências conversacionais (LLM-as-a-Judge).',
  'Avalie a conversa entre um usuário e o assistente de criação de campanhas do B2Base.',
  'Notas de 0 a 10 em cada métrica:',
  METRIC_NAMES.map((m) => `- ${m}`).join('\n'),
  'Seja cético: resposta genérica, alucinação (fatos não presentes no contexto), fallback que culpa o',
  'usuário, repetição de cards ou perda de contexto derrubam as notas. Responda SOMENTE JSON:',
  '{"correctness":0-10,"relevance":0-10,"contextRetention":0-10,"conversationFlow":0-10,',
  ' "clarification":0-10,"toolUse":0-10,"concision":0-10,',
  ' "issues":["problema concreto com evidência curta"],',
  ' "improvements":["melhoria acionável"],',
  ' "summary":"1 frase"}',
].join('\n');

function buildTranscript(conversation) {
  return conversation
    .map((turn, i) => {
      const cards = (turn.cards || []).map((c) => c.type).join(', ') || '—';
      return `TURNO ${i + 1}\nUSUÁRIO: ${turn.user}\nASSISTENTE: ${turn.reply}\n[cards: ${cards}]`;
    })
    .join('\n\n');
}

/** Validação estrita: tipos, faixa 0..10 e arrays. Devolve { metrics, issues, improvements, summary } ou lança. */
function validateJudgeOutput(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('saída do judge não é um objeto');
    err.code = 'JUDGE_INVALID_JSON';
    throw err;
  }
  const metrics = {};
  for (const name of METRIC_NAMES) {
    const v = parsed[name];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      const err = new Error(`métrica "${name}" ausente ou não numérica`);
      err.code = 'JUDGE_INVALID_SCHEMA';
      throw err;
    }
    if (v < 0 || v > 10) {
      const err = new Error(`métrica "${name}" fora da faixa 0..10 (${v})`);
      err.code = 'JUDGE_INVALID_SCORE';
      throw err;
    }
    metrics[name] = v;
  }
  const arr = (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 10) : [];
  return {
    metrics,
    issues: arr(parsed.issues),
    improvements: arr(parsed.improvements),
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 400) : null,
  };
}

/** Overall ponderado calculado localmente a partir das métricas validadas. */
function weightedOverall(metrics) {
  let total = 0;
  for (const [name, w] of Object.entries(WEIGHTED_METRICS)) total += metrics[name] * w;
  return Math.round(total * 100) / 100;
}

/**
 * judgeConversation({ callLlm, conversation, caseDef }) →
 * { version, metrics, overall, issues, improvements, summary,
 *   model, latencyMs, usage, evaluatedAt }
 * Propaga erro com .code (JUDGE_INVALID_*) para o runner marcar o caso.
 */
async function judgeConversation({ callLlm, conversation, caseDef }) {
  if (typeof callLlm !== 'function') throw new Error('judge requer callLlm (llm-client.js)');
  const user = [
    caseDef ? `CENÁRIO ESPERADO DO CASO "${caseDef.id}": ${caseDef.title}` : null,
    'CONVERSA REAL:',
    buildTranscript(conversation),
  ]
    .filter(Boolean)
    .join('\n\n');

  const t0 = Date.now();
  const result = await callLlm({
    system: SYSTEM,
    user,
    jsonMode: true,
    temperature: 0,
    maxTokens: 2000,
    tag: 'eval:judge',
  });
  const latencyMs = Date.now() - t0;

  let raw;
  try {
    raw = JSON.parse(String(result.content || '').replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  } catch (_e) {
    const err = new Error('judge devolveu JSON inválido');
    err.code = 'JUDGE_INVALID_JSON';
    throw err;
  }
  const validated = validateJudgeOutput(raw);
  return {
    version: JUDGE_VERSION,
    ...validated,
    overall: weightedOverall(validated.metrics),
    model: result.model || null,
    latencyMs,
    usage: result.usage || null,
    evaluatedAt: new Date().toISOString(),
  };
}

module.exports = { JUDGE_VERSION, METRIC_NAMES, validateJudgeOutput, weightedOverall, judgeConversation };
