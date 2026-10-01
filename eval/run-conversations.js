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
const { isJudgeV2Configured, createJudgeLlm } = require('./judge-gateway');

const ROOT = path.join(__dirname, '..');

/** Epic 4 (L2): erros de AMBIENTE — não contaminam o score do agente. */
const INFRA_ERROR_RE =
  /LiteLLM|Insufficient Balance|rate.?limit|429|timeout|timed out|HTTP 5\d\d|ECONN|socket|fetch failed|JUDGE_TIMEOUT|JUDGE_HTTP_ERROR/i;

function cfg() {
  return {
    baseUrl: process.env.B2BASE_EVAL_URL || 'https://www.b2base.net',
    threshold: Number(process.env.B2BASE_EVAL_THRESHOLD || 85),
    casesPath: process.env.B2BASE_EVAL_CASES || path.join(__dirname, 'conversations', 'core.json'),
    only: process.env.B2BASE_EVAL_ONLY || null,
    judge: String(process.env.B2BASE_EVAL_JUDGE || '').toLowerCase() === 'true',
    judgeThreshold: Number(process.env.B2BASE_EVAL_JUDGE_THRESHOLD || 7),
    // Epic 4 (L2/anti-flake): cada caso roda N× e só falha na maioria.
    repeat: Math.max(1, Number(process.env.B2BASE_EVAL_REPEAT || 1)),
    // Epic 4 (4.5/D3): baseline v1×v2 no primeiro run com o judge novo.
    judgeBaseline: String(process.env.B2BASE_EVAL_JUDGE_BASELINE || '').toLowerCase() === 'true',
    // Epic 4 (4.3): captura-sem-mcp exige ambiente com token isolado.
    mcpIsolated: String(process.env.B2BASE_EVAL_MCP_ISOLATED || '').toLowerCase() === 'true',
  };
}

/**
 * Epic 4 (Story 4.2): separa FALHA DE AGENTE de FALHA DE AMBIENTE. Um caso
 * que falhou com erros 100% infra (gateway sem saldo, timeout, 5xx do deploy)
 * é classificado 'infra' — sai do score e do gate; o resto é regressão de
 * comportamento ('agent').
 */
function classifyCase(result) {
  if (result.pass) return null;
  const errors = [...(result.httpErrors || []), ...(result.llmGatewayErrors || [])];
  if (errors.length === 0) return 'agent';
  return errors.every((e) => INFRA_ERROR_RE.test(String(e))) ? 'infra' : 'agent';
}

/** Requisitos de ambiente declarados pelo caso (Epic 4, 4.3). */
function requirementMet(required) {
  if (!required) return true;
  if (required === 'mcp_isolated') return cfg().mcpIsolated;
  return false;
}

const TURN_TIMEOUT_MS = 150_000; // turnos de produção já observados em até ~60s

async function runCase(client, caseDef, judgeDeps, baselineDeps = null) {
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
      judge = await judgeConversation({
        callLlm: judgeDeps.callLlm,
        conversation,
        caseDef,
        version: judgeDeps.version,
      });
    } catch (err) {
      judgeError = { code: err.code || 'JUDGE_ERROR', message: String(err.message) };
    }
  }

  // Epic 4 (4.5/D3): baseline v1×v2 no primeiro run com o judge novo —
  // comparação registrada no relatório, sem truncamento de JSON.
  let baselineJudge = null;
  let baselineJudgeError = null;
  if (baselineDeps) {
    const conversation = turns.map((t) => ({ user: t.user, reply: t.reply, cards: t.cards }));
    try {
      baselineJudge = await judgeConversation({
        callLlm: baselineDeps.callLlm,
        conversation,
        caseDef,
        version: baselineDeps.version,
      });
    } catch (err) {
      baselineJudgeError = { code: err.code || 'JUDGE_ERROR', message: String(err.message) };
    }
  }

  // Epic 4 (4.2): traceIds por turno — diagnóstico sem reprodução manual.
  const traceIds = Array.isArray(traces)
    ? traces.map((t) => ({ turnIndex: t.turnIndex ?? null, traceId: t.id ?? null, status: t.status ?? null, errorCode: t.errorCode ?? null }))
    : null;

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
    traceIds,
    judge,
    judgeError,
    baselineJudge,
    baselineJudgeError,
  };
}

function aggregate(results) {
  const allLatencies = results.flatMap((r) => r.latencyMs);
  const assertions = results.flatMap((r) => r.assertions);
  const judgeScores = results.filter((r) => r.judge).map((r) => r.judge.overall);
  const judgeVersion = results.map((r) => r.judge && r.judge.version).filter(Boolean)[0] || JUDGE_VERSION;
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const baselineScores = results.filter((r) => r.baselineJudge).map((r) => r.baselineJudge.overall);
  return {
    conversations: results.length,
    turns: allLatencies.length,
    deterministicScore: assertions.length
      ? Math.round((assertions.filter((a) => a.pass).length / assertions.length) * 1000) / 10
      : 0,
    failedCases: results.filter((r) => r.pass === false).map((r) => r.id),
    infraCases: results.filter((r) => r.classification === 'infra').map((r) => r.id),
    agentFailures: results.filter((r) => r.pass === false && r.classification !== 'infra').map((r) => r.id),
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
    repeat: results[0]?.runs || 1,
    judge: judgeScores.length
      ? {
          version: judgeVersion,
          avg: avg(judgeScores),
          min: Math.min(...judgeScores),
          max: Math.max(...judgeScores),
          errors: results.filter((r) => r.judgeError).map((r) => ({ id: r.id, ...r.judgeError })),
          // Epic 4 (4.5/D3): baseline v1×v2 comparado no primeiro run.
          baseline: baselineScores.length
            ? {
                version: results.find((r) => r.baselineJudge)?.baselineJudge?.version || 'v1',
                avg: avg(baselineScores),
                delta: avg(judgeScores) != null && avg(baselineScores) != null
                  ? Math.round((avg(judgeScores) - avg(baselineScores)) * 100) / 100
                  : null,
                errors: results.filter((r) => r.baselineJudgeError).map((r) => ({ id: r.id, ...r.baselineJudgeError })),
              }
            : null,
        }
      : null,
  };
}

async function main() {
  const config = cfg();
  const suite = loadSuite(fs.readFileSync(config.casesPath, 'utf8'));
  const allCases = config.only ? suite.cases.filter((c) => c.id === config.only) : suite.cases;
  if (allCases.length === 0) throw new Error(`Nenhum caso encontrado (${config.only || suite.version}).`);
  // Epic 4 (4.3): caso com requisito de ambiente não atendido é PULADO (não
  // falha) — ex.: captura-sem-mcp exige token isolado (B2BASE_EVAL_MCP_ISOLATED).
  const cases = [];
  const skipped = [];
  for (const caseDef of allCases) {
    if (requirementMet(caseDef.requires)) cases.push(caseDef);
    else skipped.push(caseDef.id);
  }

  const judgeLabel = config.judge ? (isJudgeV2Configured() ? 'v2 (gateway independente do SUT)' : 'v1 (LiteLLM do SUT)') : null;
  console.log(`# Evaluador conversacional — ${config.baseUrl}`);
  console.log(
    `suíte ${suite.version} · ${cases.length} caso(s)${skipped.length ? ` (${skipped.length} pulado(s): ${skipped.join(', ')})` : ''}` +
      ` · gate determinístico ≥ ${config.threshold} · N=${config.repeat}${config.judge ? ` · judge ${judgeLabel} ≥ ${config.judgeThreshold}` : ' · judge desligado'}`
  );

  const client = await createAuthenticatedEvalClient({ baseUrl: config.baseUrl });
  const session = await client.getSession().catch(() => null);
  console.log(`autenticado como: ${session?.email || '(sessão resolvida)'} · org: ${session?.orgId || session?.organizationId || '(resolvida no servidor)'}`);

  // Epic 4 (4.5/D3): judge primário = v2 (Laya, gateway independente) quando
  // configurado; sem Laya cai para o v1 (LiteLLM do SUT, report-only). Na
  // baseline, v1 e v2 rodam e o relatório compara.
  let judgeDeps = null;
  let baselineDeps = null;
  if (config.judge) {
    if (isJudgeV2Configured()) {
      judgeDeps = { callLlm: await createJudgeLlm(), version: 'v2' };
      if (config.judgeBaseline) {
        baselineDeps = { callLlm: require(path.join(ROOT, 'llm-client.js')).callLlm, version: 'v1' };
      }
    } else {
      judgeDeps = { callLlm: require(path.join(ROOT, 'llm-client.js')).callLlm, version: 'v1' };
    }
  }

  const results = [];
  for (const caseDef of cases) {
    process.stdout.write(`→ ${caseDef.id} … `);
    // Epic 4 (L2/anti-flake): roda N× — só reprova na MAIORIA de falhas.
    const runs = [];
    try {
      for (let i = 0; i < config.repeat; i += 1) {
        const r = await runCase(client, caseDef, judgeDeps, baselineDeps);
        runs.push(r);
        const judgeNote = r.judge ? ` · judge ${r.judge.overall}` : r.judgeError ? ` · judge ${r.judgeError.code}` : '';
        const avgMs = r.latencyMs.length ? Math.round(r.latencyMs.reduce((a, b) => a + b, 0) / r.latencyMs.length) : 0;
        console.log(`${r.pass ? 'PASS' : 'FAIL'} (${r.score}) · ${r.turns.length} turno(s) · média/turno ${avgMs}ms${judgeNote}${config.repeat > 1 ? ` [run ${i + 1}/${config.repeat}]` : ''}`);
        for (const f of r.failures) console.log(`   ✗ ${f.id}: ${f.detail}`);
      }
    } catch (err) {
      console.log(`ERRO: ${err.message}`);
      runs.push({ id: caseDef.id, title: caseDef.title, pass: false, score: 0, assertions: [], failures: [{ id: 'runner', detail: err.message }], turns: [], latencyMs: [], httpErrors: [String(err.message)], llmGatewayErrors: [], tracesAvailable: false, judge: null, judgeError: null });
    }
    const passes = runs.filter((r) => r.pass).length;
    const majorityPass = passes * 2 > runs.length;
    // O relatório do caso traz a 1ª execução completa + o veredito anti-flake.
    const merged = {
      ...runs[0],
      pass: majorityPass,
      blocking: Boolean(caseDef.blocking),
      runs: runs.length,
      runResults: runs.map((r) => ({ pass: r.pass, score: r.score })),
    };
    merged.classification = classifyCase(merged);
    results.push(merged);
    if (config.repeat > 1) console.log(`   veredito ${caseDef.id}: ${majorityPass ? 'PASS' : 'FAIL'} (${passes}/${runs.length} runs)${merged.classification === 'infra' ? ' · classificado INFRA (não contamina o agente)' : ''}`);
  }

  // Epic 4 (L2): falha classificada `infra` NÃO contamina o score/gate do
  // agente — sai do aggregate; o relatório mantém tudo (allResults).
  const scored = results.filter((r) => !(r.pass === false && r.classification === 'infra'));
  const summary = aggregate(scored);
  const report = {
    timestamp: new Date().toISOString(),
    target: config.baseUrl,
    datasetVersion: suite.version,
    threshold: config.threshold,
    repeat: config.repeat,
    judgeEnabled: config.judge,
    judgeThreshold: config.judgeThreshold,
    skippedCases: skipped,
    summary,
    results,
  };

  const reportsDir = path.join(__dirname, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));

  console.log('\n# Resumo');
  console.log(`score determinístico: ${summary.deterministicScore} (gate ≥ ${config.threshold}) — ${summary.agentFailures.length} falha(s) de agente, ${summary.infraCases.length} caso(s) infra (fora do score)`);
  console.log(`conversas: ${summary.conversations} · turnos: ${summary.turns} · N=${config.repeat} (falha só na maioria)`);
  console.log(`latência/turno ms: méd ${summary.latencyMs.avg} · p50 ${summary.latencyMs.p50} · p95 ${summary.latencyMs.p95} · p99 ${summary.latencyMs.p99}`);
  if (skipped.length) console.log(`pulados (requisito de ambiente não atendido): ${skipped.join(', ')}`);
  if (summary.llmGatewayErrors.length > 0) {
    console.log(`⚠️ BLOQUEADOR OPERACIONAL: ${summary.llmGatewayErrors.length} turno(s) falharam no gateway LLM (ex.: saldo LiteLLM). Isso NÃO é regressão de comportamento.`);
  }
  if (summary.judge) {
    console.log(`judge (${summary.judge.version}): méd ${summary.judge.avg} · mín ${summary.judge.min} · máx ${summary.judge.max} (report, não gate)`);
    for (const e of summary.judge.errors) console.log(`   judge ${e.id}: ${e.code}`);
    if (summary.judge.baseline) {
      const b = summary.judge.baseline;
      console.log(`baseline ${b.version}×${summary.judge.version}: v${b.version.slice(1)} méd ${b.avg} × v${summary.judge.version.slice(1)} méd ${summary.judge.avg} — delta ${b.delta}`);
    }
  }
  if (!summary.tracesAvailable) console.log('traces: endpoint /traces indisponível neste deploy (telemetria StudioChatTrace ainda não implantada aqui)');
  console.log(`relatório: ${file}`);

  // Gate (Epic 4): score ≥ threshold SEM falha de agente; caso `blocking`
  // reprovado (journey-e2e) impede considerar a release saudável (4.4).
  const blockingFailures = results.filter((r) => r.blocking && r.pass === false && r.classification !== 'infra');
  for (const f of blockingFailures) console.log(`BLOQUEANTE reprovado: ${f.id} — release NÃO considerada saudável`);
  const passed = summary.deterministicScore >= config.threshold && summary.agentFailures.length === 0 && blockingFailures.length === 0;
  console.log(passed ? '\nGATE: PASS' : `\nGATE: FAIL (score ${summary.deterministicScore} < ${config.threshold} ou falha de agente/bloqueante)`);
  process.exitCode = passed ? 0 : 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`evaluator falhou: ${err.message}`);
    process.exitCode = 2;
  });
}

module.exports = { runCase, aggregate, cfg, classifyCase, requirementMet, INFRA_ERROR_RE };
