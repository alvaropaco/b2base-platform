'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

function loadCases(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function includesAny(value, needles) {
  const text = String(value || '').toLowerCase();
  return (needles || []).some((needle) => text.includes(String(needle).toLowerCase()));
}

function evaluateTurn(result, expected) {
  const failures = [];
  if (expected?.reply?.nonEmpty && !String(result?.reply || '').trim()) {
    failures.push('reply_empty');
  }

  const cardTypes = Array.isArray(result?.cards) ? result.cards.map((c) => c.type) : [];
  for (const type of expected?.cardsContain || []) {
    if (!cardTypes.includes(type)) failures.push('missing_card:' + type);
  }

  if (expected?.replyAny && !includesAny(result?.reply, expected.replyAny)) {
    failures.push('reply_missing_expected_concept');
  }

  return failures;
}

function scoreConversation(conversation, failures, turns) {
  const totalTurns = conversation.turns.length;
  const failedTurns = failures.length;
  const correctness = totalTurns ? Math.max(0, (totalTurns - failedTurns) / totalTurns) : 1;
  const contextRetention = turns.length === totalTurns ? 1 : 0;
  const flow = failures.length === 0 ? 1 : 0;
  const overall = Number(((correctness * 0.55 + contextRetention * 0.15 + flow * 0.30) * 100).toFixed(1));
  return { correctness, contextRetention, flow, overall };
}

async function runCase(baseUrl, orgId, campaignFactory, conversation) {
  const created = await campaignFactory(baseUrl, orgId, conversation);
  const turns = [];
  const failures = [];

  for (const turn of conversation.turns) {
    const response = await fetch(
      baseUrl + '/api/studio/campaigns/' + encodeURIComponent(created.campaignId) + '/chat',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-org-id': orgId },
        body: JSON.stringify({ message: turn.user })
      }
    );

    let body = null;
    try { body = await response.json(); } catch (_) {}
    assert.ok(response.ok, conversation.id + ': chat endpoint returned ' + response.status);

    const result = body?.data || {};
    turns.push(result);
    failures.push(...evaluateTurn(result, turn.assert));
  }

  return {
    id: conversation.id,
    name: conversation.name,
    turns,
    failures,
    score: scoreConversation(conversation, failures, turns)
  };
}

async function main() {
  const baseUrl = process.env.B2BASE_EVAL_URL || 'http://127.0.0.1:3001';
  const orgId = process.env.B2BASE_EVAL_ORG_ID || 'eval-org';
  const casesFile = process.env.B2BASE_EVAL_CASES || path.join(__dirname, '../conversations/core.json');
  const cases = loadCases(casesFile);

  const campaignFactory = async (base, org) => {
    const response = await fetch(base + '/api/studio/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-test-org-id': org },
      body: JSON.stringify({ name: 'Eval ' + Date.now(), channels: ['email'] })
    });
    if (!response.ok) throw new Error('Could not create eval campaign: ' + response.status);
    const body = await response.json();
    return { campaignId: body?.data?.id };
  };

  const results = [];
  for (const conversation of cases) {
    results.push(await runCase(baseUrl, orgId, campaignFactory, conversation));
  }

  const overall = results.length
    ? Number((results.reduce((sum, r) => sum + r.score.overall, 0) / results.length).toFixed(1))
    : 100;

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    cases: results,
    overall,
    passed: results.every((r) => r.failures.length === 0),
    threshold: Number(process.env.B2BASE_EVAL_THRESHOLD || 85)
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.passed || report.overall < report.threshold) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exitCode = 1;
});
