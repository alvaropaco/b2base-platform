'use strict';

const { callLlm } = require('../llm-client');
const { parseModelJson } = require('../studio/ai/json');

const JUDGE_SYSTEM = [
  'Você é um avaliador rigoroso de conversas de um produto SaaS B2B.',
  'Avalie a conversa como experiência de produto, não como gosto pessoal.',
  'Não penalize diferenças de redação quando o comportamento estiver correto.',
  'Não invente fatos ausentes da conversa.',
  'Responda SOMENTE JSON.',
].join('\\n');

function buildPrompt(conversation, result) {
  const transcript = conversation.turns.map((turn, i) => {
    return 'TURNO ' + (i + 1) + '\\nUSUÁRIO: ' + turn.user + '\\nRESULTADO: ' + JSON.stringify(result.turnOutputs?.[i] || {});
  }).join('\\n\\n');

  return [
    'CASO: ' + conversation.name,
    transcript,
    '',
    'Dê notas inteiras de 0 a 10 para:',
    'correctness, relevance, contextRetention, conversationFlow, clarification, toolUse, concision.',
    'Depois calcule overall como média ponderada (correctness 25%, relevance 15%, contextRetention 15%, flow 15%, clarification 10%, toolUse 10%, concision 10%).',
    'Inclua 1-3 problemas concretos e 1-3 melhorias concretas.',
    'Formato:',
    '{"correctness":0,"relevance":0,"contextRetention":0,"conversationFlow":0,"clarification":0,"toolUse":0,"concision":0,"overall":0,"issues":[],"improvements":[]}',
  ].join('\\n');
}

async function judgeConversation(conversation, result) {
  const startedAt = Date.now();
  const raw = await callLlm({
    system: JUDGE_SYSTEM,
    user: buildPrompt(conversation, result),
    jsonMode: true,
    temperature: 0,
    maxTokens: 700,
    tag: 'eval:judge',
  });
  const parsed = parseModelJson(raw.content);
  if (!parsed || typeof parsed.overall !== 'number') {
    const error = new Error('judge_invalid_json');
    error.code = 'JUDGE_INVALID_JSON';
    throw error;
  }
  return {
    ...parsed,
    latencyMs: Date.now() - startedAt,
    model: raw.model || null,
    usage: raw.usage || null,
  };
}

module.exports = { judgeConversation };