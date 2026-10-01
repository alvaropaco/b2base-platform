'use strict';

/**
 * eval/run-conversations.js — evaluator conversacional canônico.
 *
 * Roda a suíte determinística contra o ambiente DEPLOYADO
 * (padrão: https://www.b2base.net), autenticando como usuário dedicado de
 * avaliação e criando campanhas frescas `[AI-EVAL]` — nunca reusa campanha
 * de cliente, nunca aprova/dispara nada.
 *
 * Uso:
 *   B2BASE_EVAL_EMAIL=... B2BASE_EVAL_PASSWORD=... pnpm run eval:chat
 *
 * Variáveis:
 *   B2BASE_EVAL_URL            (padrão https://www.b2base.net)
 *   B2BASE_EVAL_EMAIL/_PASSWORD credenciais da conta de avaliação (obrigatórias)
 *   B2BASE_EVAL_THRESHOLD      (padrão 85) — gate do score determinístico
 *   B2BASE_EVAL_CASES          (padrão eval/conversations/core.json)
 *   B2BASE_EVAL_ONLY           roda um único caso por id (smoke)
 *   B2BASE_EVAL_JUDGE          "true" habilita o LLM-as-a-Judge
 *   B2BASE_EVAL_JUDGE_THRESHOLD (padrão 7) — report, não gate
 *
 * Saída: resumo no console + JSON completo em eval/reports/.
 */

const fs = require('fs');
const path = require('path');
const { createAuthenticatedEvalClient } = require('./auth');
const { loadSuite, evaluateCase, percentile } = require('./lib');
const { judgeConversation, JUDGE_VERSION } = require('./llm-judge');

const ROOT = path.join(__dirname, '..');

function cfg() {
  return {
    baseUrl: process.env.B2BASE_EVAL_URL || 'https://www.b2base.net',
    threshold: Number(process.env.B2BASE_EVAL_THRESHOLD || 85),
    casesPath: process.env.B2BASE_EVAL_CASES || path.join(__dirname, 'conversations', 'core.json'),
    only: process.env.B2BASE_EVAL_ONLY || null,
    judge: String(process.env.B2BASE_EVAL_JUDGE || '').toLowerCase() === 'true',
    judgeThreshold: Number(process.env.B2BASE_EVAL_JUDGE_THRESHOLD || 7),
  };
}

const TURN_TIMEOUT_MS = 150_000; // turnos de produção já observados em até ~60s

async function runCase(client, caseDef, judgeDeps) {
  const stamp = new Date().toISOString().slice(0, 10);
  const campaignName = `[AI-EVAL] ${stamp} ${caseDef.id}`;
  const campaign = await client.createCampaign({ name: campaignName, channels: caseDef.channels || ['email'] });
  const turns = [];
  for (const message of caseDef.turns) {
    const t0 = Date.now();
    let result;
    try {
      result = await client.chat(campaign.id, message);
    } catch (err) {
      turns.push({ user: message, reply: '', cards: [], latencyMs: Date.now() - t0, streamError: String(err.message) });
      continue;
    }
    turns.push({
      user: message,
      reply: result?.reply || '',
      cards: result?.cards || [],
      latencyMs: Date.now() - t0,
      streamError: result?.error || null,
    });
  }

  // Epic 3 (Story 3.4): passos de HTTP da jornada (ex.: aprovar/agendar pela
  // mesma porta que a zona de decisão da UI usa) — `calls` roda DEPOIS dos
  // turnos, na ordem; falha vira httpError do caso, não exceção do runner.
  const callErrors = [];
  for (const call of caseDef.calls || []) {
    try {
      await client.callJson(String(call.path).replaceAll(':campaignId', campaign.id), {
        method: call.method || 'POST',
        body: call.body || {},
      });
    } catch (err) {
      callErrors.push(`${call.method || 'POST'} ${call.path}: ${String(err.message)}`);
    }
  }

  const wantsCertificate = (caseDef.expect || []).some((e) => e.type === 'certificateGreen');
  const state = await client.getState(campaign.id).catch(() => null);
  const traces = await client.getTraces(campaign.id).catch(() => null);
  const certificate = wantsCertificate ? await client.getCertificate(campaign.id).catch(() => null) : null;
  const ctx = { turns, state, traces: Array.isArray(traces) ? traces : null, certificate };
  const outcome = evaluateCase(caseDef, ctx);

  // Telemetria operacional (StudioChatTrace) — métricas sem conteúdo.
  const tracesSummary = Array.isArray(traces)
    ? {
        turns: traces.length,
        llmModels: [...new Set(traces.map((t) => t.llmModel).filter(Boolean))],
        totalTokens: traces.reduce((sum, t) => sum + Number(t.llmTotalTokens || 0), 0),
        fallbackUsed: traces.filter((t) => t.llmFallbackUsed).length,
        truncated: traces.filter((t) => t.llmTruncated).length,
        failedTurns: traces.filter((t) => t.status === 'failed').length,
      }
    : null;

  // Classificação simples de falha de infraestrutura: gateway LLM sem
  // saldo/rate-limit não é regressão de comportamento — é bloqueador operacional.
  const streamErrors = turns.map((t) => t.streamError).filter(Boolean);
  const llmGatewayErrors = streamErrors.filter((e) => /LiteLLM|Insufficient Balance|rate.?limit|429/i.test(e));

  let judge = null;
  let judgeError = null;
  if (judgeDeps) {
    const conversation = turns.map((t) => ({ user: t.user, reply: t.reply, cards: t.cards }));
    try {
      judge = await judgeConversation({ callLlm: judgeDeps.callLlm, conversation, caseDef });
    } catch (err) {
      judgeError = { code: err.code || 'JUDGE_ERROR', message: String(err.message) };
    }
  }

  return {
    id: outcome.id,
    title: outcome.title,
    campaignId: campaign.id,
    campaignName,
    pass: outcome.pass,
    score: Math.round(outcome.score * 10) / 10,
    assertions: outcome.assertions,
    failures: outcome.failures,
    turns: outcome.turns,
    latencyMs: turns.map((t) => t.latencyMs),
    httpErrors: [...callErrors, ...turns.filter((t) => t.streamError && !llmGatewayErrors.includes(t.streamError)).map((t) => t.streamError)],
    llmGatewayErrors,
    traces: tracesSummary,
    tracesAvailable: traces !== null,
    judge,
    judgeError,
  };
}

function aggregate(results) {
  const allLatencies = results.flatMap((r) => r.latencyMs);
  const assertions = results.flatMap((r) => r.assertions);
  const judgeScores = results.filter((r) => r.judge).map((r) => r.judge.overall);
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  return {
    conversations: results.length,
    turns: allLatencies.length,
    deterministicScore: assertions.length
      ? Math.round((assertions.filter((a) => a.pass).length / assertions.length) * 1000) / 10
      : 0,
    failedCases: results.filter((r) => !r.pass).map((r) => r.id),
    latencyMs: {
      avg: avg(allLatencies),
      p50: percentile(allLatencies, 50),
      p95: percentile(allLatencies, 95),
      p99: percentile(allLatencies, 99),
    },
    httpErrors: results.flatMap((r) => r.httpErrors),
    llmGatewayErrors: results.flatMap((r) => r.llmGatewayErrors || []),
    totalTokens: results.reduce((sum, r) => sum + (r.traces?.totalTokens || 0), 0),
    tracesAvailable: results.every((r) => r.tracesAvailable),
    judge: judgeScores.length
      ? {
          version: JUDGE_VERSION,
          avg: avg(judgeScores),
          min: Math.min(...judgeScores),
          max: Math.max(...judgeScores),
          errors: results.filter((r) => r.judgeError).map((r) => ({ id: r.id, ...r.judgeError })),
        }
      : null,
  };
}

async function main() {
  const config = cfg();
  const suite = loadSuite(fs.readFileSync(config.casesPath, 'utf8'));
  const cases = config.only ? suite.cases.filter((c) => c.id === config.only) : suite.cases;
  if (cases.length === 0) throw new Error(`Nenhum caso encontrado (${config.only || suite.version}).`);

  console.log(`# Evaluador conversacional — ${config.baseUrl}`);
  console.log(`suíte ${suite.version} · ${cases.length} caso(s) · gate determinístico ≥ ${config.threshold}${config.judge ? ` · judge ≥ ${config.judgeThreshold} (${JUDGE_VERSION})` : ' · judge desligado'}`);

  const client = await createAuthenticatedEvalClient({ baseUrl: config.baseUrl });
  const session = await client.getSession().catch(() => null);
  console.log(`autenticado como: ${session?.email || '(sessão resolvida)'} · org: ${session?.orgId || session?.organizationId || '(resolvida no servidor)'}`);

  let judgeDeps = null;
  if (config.judge) {
    const { callLlm } = require(path.join(ROOT, 'llm-client.js'));
    judgeDeps = { callLlm };
  }

  const results = [];
  for (const caseDef of cases) {
    process.stdout.write(`→ ${caseDef.id} … `);
    try {
      const r = await runCase(client, caseDef, judgeDeps);
      results.push(r);
      const judgeNote = r.judge ? ` · judge ${r.judge.overall}` : r.judgeError ? ` · judge ${r.judgeError.code}` : '';
      const avgMs = r.latencyMs.length ? Math.round(r.latencyMs.reduce((a, b) => a + b, 0) / r.latencyMs.length) : 0;
      console.log(`${r.pass ? 'PASS' : 'FAIL'} (${r.score}) · ${r.turns.length} turno(s) · média/turno ${avgMs}ms${judgeNote}`);
      for (const f of r.failures) console.log(`   ✗ ${f.id}: ${f.detail}`);
    } catch (err) {
      console.log(`ERRO: ${err.message}`);
      results.push({ id: caseDef.id, title: caseDef.title, pass: false, score: 0, assertions: [], failures: [{ id: 'runner', detail: err.message }], turns: [], latencyMs: [], httpErrors: [], llmGatewayErrors: [], tracesAvailable: false, judge: null, judgeError: null });
    }
  }

  const summary = aggregate(results);
  const report = {
    timestamp: new Date().toISOString(),
    target: config.baseUrl,
    datasetVersion: suite.version,
    threshold: config.threshold,
    judgeEnabled: config.judge,
    judgeThreshold: config.judgeThreshold,
    summary,
    results,
  };

  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  console.log('\n# Resumo');
  console.log(`score determinístico: ${summary.deterministicScore} (gate ≥ ${config.threshold}) — ${summary.failedCases.length} caso(s) falhando`);
  console.log(`conversas: ${summary.conversations} · turnos: ${summary.turns}`);
  console.log(`latência/turno ms: méd ${summary.latencyMs.avg} · p50 ${summary.latencyMs.p50} · p95 ${summary.latencyMs.p95} · p99 ${summary.latencyMs.p99}`);
  if (summary.llmGatewayErrors.length > 0) {
    console.log(`⚠️ BLOQUEADOR OPERACIONAL: ${summary.llmGatewayErrors.length} turno(s) falharam no gateway LLM (ex.: saldo LiteLLM). Isso NÃO é regressão de comportamento.`);
  }
  if (summary.judge) {
    console.log(`judge (${summary.judge.version}): méd ${summary.judge.avg} · mín ${summary.judge.min} · máx ${summary.judge.max} (report, não gate)`);
    for (const e of summary.judge.errors) console.log(`   judge ${e.id}: ${e.code}`);
  }
  if (!summary.tracesAvailable) console.log('traces: endpoint /traces indisponível neste deploy (telemetria StudioChatTrace ainda não implantada aqui)');
  console.log(`relatório: ${file}`);

  const passed = summary.deterministicScore >= config.threshold;
  console.log(passed ? '\nGATE: PASS' : `\nGATE: FAIL (score < ${config.threshold})`);
  process.exitCode = passed ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`evaluator falhou: ${err.message}`);
    process.exitCode = 2;
  });
}

module.exports = { runCase, aggregate, cfg };
