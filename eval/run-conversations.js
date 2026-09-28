'use strict';

const fs = require('fs');
const path = require('path');

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
  return { id: conversation.id, name: conversation.name, failures, score: scoreConversation(conversation, failures, turns) };
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
  const report = { generatedAt: new Date().toISOString(), baseUrl, overall, threshold, passed: overall >= threshold && results.every((r) => r.failures.length === 0), cases: results };
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
main().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
