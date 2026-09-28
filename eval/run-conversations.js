'use strict';

const fs = require('fs');
const path = require('path');
const { judgeConversation } = require('./llm-judge');

function loadCases(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function includesAny(value, needles) {
  const text = String(value || '').toLowerCase();
  return (needles || []).some((needle) => text.includes(String(needle).toLowerCase()));
}
function evaluateTurn(result, expected) {
  const failures = [];
  if (expected?.reply?.nonEmpty && !String(result?.reply || '').trim()) failures.push('reply_empty');
  const cardTypes = Array.isArray(result?.cards) ? result.cards.map((c) => c.type) : [];
  for (const type of expected?.cardsContain || []) if (!cardTypes.includes(type)) failures.push('missing_card:' + type);
  if (expected?.replyAny && !includesAny(result?.reply, expected.replyAny)) failures.push('reply_missing_expected_concept');
  return failures;
}
function scoreConversation(conversation, failures, turns) {
  const total = conversation.turns.length;
  const failed = failures.length;
  const correctness = total ? Math.max(0, (total - failed) / total) : 1;
  const contextRetention = turns.length === total ? 1 : 0;
  const flow = failed === 0 ? 1 : 0;
  return {
    correctness,
    contextRetention,
    flow,
    overall: Number(((correctness * 0.55 + contextRetention * 0.15 + flow * 0.30) * 100).toFixed(1))
  };
}
async function createCampaign(baseUrl, orgId) {
  const response = await fetch(baseUrl + '/api/studio/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-org-id': orgId },
    body: JSON.stringify({ name: 'Eval ' + Date.now(), channels: ['email'] })
  });
  if (!response.ok) throw new Error('Could not create eval campaign: ' + response.status);
  const body = await response.json();
  const id = body?.data?.id;
  if (!id) throw new Error('Campaign creation returned no id');
  return id;
}
async function runCase(baseUrl, orgId, conversation) {
  const campaignId = await createCampaign(baseUrl, orgId);
  const turns = [];
  const failures = [];
  for (const turn of conversation.turns) {
    const response = await fetch(baseUrl + '/api/studio/campaigns/' + encodeURIComponent(campaignId) + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-org-id': orgId },
      body: JSON.stringify({ message: turn.user })
    });
    let body = null;
    try { body = await response.json(); } catch (_) {}
    if (!response.ok) {
      failures.push('http_' + response.status);
      continue;
    }
    const result = body?.data || {};
    turns.push(result);
    failures.push(...evaluateTurn(result, turn.assert));
  }
  let traces = [];
  try {
    const traceResponse = await fetch(baseUrl + '/api/studio/campaigns/' + encodeURIComponent(campaignId) + '/traces', {
      headers: { 'x-test-org-id': orgId }
    });
    if (traceResponse.ok) {
      const traceBody = await traceResponse.json();
      traces = Array.isArray(traceBody?.data) ? traceBody.data : [];
    }
  } catch (_) {}

  const result = {
    id: conversation.id,
    name: conversation.name,
    failures,
    turnOutputs: turns,
    traces,
    score: scoreConversation(conversation, failures, turns)
  };

  if (process.env.B2BASE_EVAL_JUDGE === 'true') {
    try {
      result.judge = await judgeConversation(conversation, result);
    } catch (error) {
      result.judge = { error: error.code || error.message };
    }
  }
  return result;
}
async function main() {
  const baseUrl = process.env.B2BASE_EVAL_URL || 'http://127.0.0.1:3001';
  const orgId = process.env.B2BASE_EVAL_ORG_ID || 'eval-org';
  const casesFile = process.env.B2BASE_EVAL_CASES || path.join(__dirname, 'conversations/core.json');
  const threshold = Number(process.env.B2BASE_EVAL_THRESHOLD || 85);
  const cases = loadCases(casesFile);
  const results = [];
  for (const conversation of cases) results.push(await runCase(baseUrl, orgId, conversation));
  const overall = results.length ? Number((results.reduce((sum, r) => sum + r.score.overall, 0) / results.length).toFixed(1)) : 100;
  const allTraces = results.flatMap((r) => r.traces || []);
  const traceSummary = allTraces.length ? {
    turns: allTraces.length,
    avgTurnMs: Math.round(allTraces.reduce((s, t) => s + Number(t.durationMs || 0), 0) / allTraces.length),
    avgLlmMs: Math.round(allTraces.reduce((s, t) => s + Number(t.llmDurationMs || 0), 0) / allTraces.length),
    totalPromptTokens: allTraces.reduce((s, t) => s + Number(t.llmPromptTokens || 0), 0),
    totalCompletionTokens: allTraces.reduce((s, t) => s + Number(t.llmCompletionTokens || 0), 0),
    totalTokens: allTraces.reduce((s, t) => s + Number(t.llmTotalTokens || 0), 0),
    fallbackCount: allTraces.filter((t) => t.llmFallbackUsed).length,
    truncationCount: allTraces.filter((t) => t.llmTruncated).length,
    failedTurns: allTraces.filter((t) => t.status === 'failed').length,
    actionCounts: allTraces.flatMap((t) => Array.isArray(t.actionTypes) ? t.actionTypes : []).reduce((acc, type) => {
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {})
  } : null;

  const judgeScores = results.map((r) => r.judge?.overall).filter((v) => typeof v === 'number');
  const judgeOverall = judgeScores.length
    ? Number((judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length).toFixed(2))
    : null;
  const judgeThreshold = Number(process.env.B2BASE_EVAL_JUDGE_THRESHOLD || 7);

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    overall,
    judgeOverall,
    judgeThreshold,
    threshold,
    passed: overall >= threshold &&
      results.every((r) => r.failures.length === 0) &&
      (!process.env.B2BASE_EVAL_JUDGE || process.env.B2BASE_EVAL_JUDGE !== 'true' || (judgeOverall != null && judgeOverall >= judgeThreshold)),
    traceSummary,
    cases: results
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
main().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
