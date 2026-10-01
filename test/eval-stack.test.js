'use strict';

/**
 * test/eval-stack.test.js — testes LOCAIS do evaluator conversacional
 * (sem rede): asserções determinísticas, validação estrita do judge e o
 * fluxo de autenticação do cliente com fetch falso.
 */

const test = require('node:test');
const assert = require('node:assert');
const { percentile, loadSuite, evaluateCase, FORBIDDEN_PHRASES } = require('../eval/lib');
const { validateJudgeOutput, weightedOverall, JUDGE_VERSION } = require('../eval/llm-judge');
const { createAuthenticatedEvalClient, cookiesFromResponse } = require('../eval/auth');

// ── lib: percentis e suíte ──────────────────────────────────────────────────

test('eval lib: percentis cobrem p50/p95/p99 e lista vazia vira null', () => {
  const xs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  assert.equal(percentile(xs, 50), 500);
  assert.equal(percentile(xs, 95), 1000);
  assert.equal(percentile(xs, 99), 1000);
  assert.equal(percentile([], 50), null);
});

test('eval lib: suíte sem casos ou sem turns rejeita com erro claro', () => {
  assert.throws(() => loadSuite({ cases: [] }), /Suíte inválida/);
  assert.throws(() => loadSuite({ cases: [{ id: 'x', turns: [] }] }), /precisa de id e turns/);
  const ok = loadSuite({ version: 't', cases: [{ id: 'a', turns: ['oi'] }] });
  assert.equal(ok.cases[0].id, 'a');
});

// ── F1: fallback antigo é invariante global proibida ────────────────────────

test('eval lib: fallback "Não entendi completamente" reprova qualquer caso (invariante F1)', () => {
  const caseDef = { id: 'x', title: 'x', turns: ['oi'], expect: [{ type: 'replyNonEmpty' }] };
  const bad = evaluateCase(caseDef, { turns: [{ reply: 'Não entendi completamente — pode reformular?', cards: [] }], state: null });
  assert.equal(bad.pass, false);
  assert.ok(bad.failures.some((f) => f.detail.includes(FORBIDDEN_PHRASES[0])), 'invariante reportada');
  const good = evaluateCase(caseDef, { turns: [{ reply: 'Claro! Qual o objetivo?', cards: [] }], state: null });
  assert.equal(good.pass, true);
});

// ── F3: audiência 0 leads exige aviso explícito ─────────────────────────────

test('eval lib: audiência 0 leads sem aviso reprova; com aviso aprova', () => {
  const caseDef = { id: 'y', title: 'y', turns: ['t'], expect: [{ type: 'audienceConsistent' }] };
  const silent = evaluateCase(caseDef, {
    turns: [{ reply: 'Audiência montada!', cards: [{ type: 'audience', label: 'Audiência montada', detail: '0 leads incluídos — filtro setor logística' }] }],
    state: { campaign: {}, extras: { audienceCount: 0 } },
  });
  assert.equal(silent.pass, false, 'card antigo sem aviso não engana a asserção');

  const warnedByReply = evaluateCase(caseDef, {
    turns: [{ reply: '⚠️ A audiência ficou com 0 leads — quer ajustar o segmento?', cards: [{ type: 'audience', emptyMatch: true }] }],
    state: { campaign: {}, extras: { audienceCount: 0 } },
  });
  assert.equal(warnedByReply.pass, true);

  const withLeads = evaluateCase(caseDef, {
    turns: [{ reply: 'ok', cards: [] }],
    state: { campaign: {}, extras: { audienceCount: 3 } },
  });
  assert.equal(withLeads.pass, true, 'audiência > 0 passa trivialmente');
});

// ── judge: validação estrita de schema ──────────────────────────────────────

const VALID_METRICS = { correctness: 8, relevance: 7, contextRetention: 9, conversationFlow: 6, clarification: 7, toolUse: 8, concision: 5 };

test('eval judge: schema válido produz overall ponderado e metadados', () => {
  const out = validateJudgeOutput({ ...VALID_METRICS, issues: ['a'], improvements: [], summary: 'ok' });
  assert.equal(Object.keys(out.metrics).length, 7);
  const expected = Math.round(Object.entries(VALID_METRICS).reduce((acc, [k, v]) => acc + v * { correctness: 0.25, relevance: 0.15, contextRetention: 0.15, conversationFlow: 0.15, clarification: 0.1, toolUse: 0.1, concision: 0.1 }[k], 0) * 100) / 100;
  assert.equal(weightedOverall(out.metrics), expected);
  assert.equal(JUDGE_VERSION, 'v1');
});

test('eval judge: score fora da faixa / não numérico / não JSON têm códigos próprios', () => {
  assert.throws(() => validateJudgeOutput({ ...VALID_METRICS, correctness: 11 }), (e) => e.code === 'JUDGE_INVALID_SCORE');
  assert.throws(() => validateJudgeOutput({ ...VALID_METRICS, concision: 'alta' }), (e) => e.code === 'JUDGE_INVALID_SCHEMA');
  assert.throws(() => validateJudgeOutput(null), (e) => e.code === 'JUDGE_INVALID_JSON');
  // arrays viram [] filtrados, não erro.
  const out = validateJudgeOutput({ ...VALID_METRICS, issues: 'não é array', improvements: [1, 'ok '] });
  assert.deepEqual(out.issues, []);
  assert.deepEqual(out.improvements, ['ok']);
});

// ── auth/client: fluxo completo com fetch falso ─────────────────────────────

/** Resposta SSE falsa (o chat do evaluator consome o stream da UI real). */
function sseResponse(frames) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body, json: async () => ({ success: true, data: {} }) };
}

function fakeFetchSequence() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    if (url.includes('identitytoolkit.googleapis.com')) {
      return { ok: true, status: 200, json: async () => ({ idToken: 'fb-token', localId: 'uid-1', expiresIn: '3600' }), headers: new Headers() };
    }
    if (url.endsWith('/api/auth/session') && (opts.method || 'GET') === 'POST') {
      const h = new Headers();
      h.append('set-cookie', 'b2base_session=jwt.abc; Path=/; HttpOnly');
      return { ok: true, status: 200, json: async () => ({ success: true, data: { email: 'eval@x' } }), headers: h };
    }
    if (url.includes('/chat/stream')) {
      return sseResponse([
        'event: status\ndata: {"phase":"thinking"}\n\n',
        'event: reply\ndata: {"text":"feito"}\n\n',
        'event: card\ndata: {"card":{"type":"objective","label":"Objetivo definido"}}\n\n',
        'event: done\ndata: {"campaignStatus":"in_review"}\n\n',
      ]);
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }), headers: new Headers() };
  };
  return { fetchImpl, calls };
}

test('eval client: login Firebase → sessão → requests com cookie; padrão é produção', async () => {
  const { fetchImpl, calls } = fakeFetchSequence();
  const client = await createAuthenticatedEvalClient({
    baseUrl: 'https://www.b2base.net/',
    email: 'eval@example.com',
    password: 's3cret',
    firebaseApiKey: 'test-key',
    fetchImpl,
  });
  const first = calls[0];
  assert.ok(first.url.includes('accounts:signInWithPassword'), 'login via Firebase REST');
  assert.deepEqual(first.body, { email: 'eval@example.com', password: 's3cret', returnSecureToken: true });
  assert.equal(calls[1].url, 'https://www.b2base.net/api/auth/session', 'troca ID token por sessão');
  assert.equal(client.baseUrl, 'https://www.b2base.net', 'URL canônica de produção, sem trailing slash');

  await client.createCampaign({ name: '[AI-EVAL] x', channels: ['email'] });
  const createCall = calls[2];
  assert.equal(createCall.url, 'https://www.b2base.net/api/studio/campaigns');
  assert.equal(createCall.headers.Cookie, 'b2base_session=jwt.abc', 'cookie de sessão httpOnly enviado');

  const turn = await client.chat('cmp-1', 'olá');
  assert.ok(calls[3].url.endsWith('/api/studio/campaigns/cmp-1/chat/stream'), 'usa o endpoint de stream da UI');
  assert.equal(calls[3].body.message, 'olá');
  assert.equal(turn.reply, 'feito', 'reply extraído do SSE');
  assert.deepEqual(turn.cards.map((c) => c.type), ['objective'], 'cards extraídos do SSE');
  assert.equal(turn.campaignStatus, 'in_review');
  assert.equal(turn.error, null);
});

test('eval client: evento error do stream vira turn error (falha de gateway não vira reply vazio)', async () => {
  const { fetchImpl } = fakeFetchSequenceWith(['event: status\ndata: {"phase":"thinking"}\n\n', 'event: error\ndata: {"message":"LiteLLM HTTP 402: Insufficient Balance"}\n\n']);
  const client = await createAuthenticatedEvalClient({
    baseUrl: 'https://www.b2base.net',
    email: 'a@b.c',
    password: 'p',
    firebaseApiKey: 'k',
    fetchImpl,
  });
  const turn = await client.chat('cmp-2', 'sim');
  assert.equal(turn.error, 'LiteLLM HTTP 402: Insufficient Balance');
  assert.equal(turn.reply, '');
});

function fakeFetchSequenceWith(streamFrames) {
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('identitytoolkit')) {
      return { ok: true, status: 200, json: async () => ({ idToken: 't' }), headers: new Headers() };
    }
    if (url.endsWith('/api/auth/session') && (opts.method || 'GET') === 'POST') {
      const h = new Headers();
      h.append('set-cookie', 'b2base_session=jwt-n; Path=/; HttpOnly');
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }), headers: h };
    }
    if (url.includes('/chat/stream')) return sseResponse(streamFrames);
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }), headers: new Headers() };
  };
  return { fetchImpl };
}

test('eval client: 401 reloga uma vez e repete o request', async () => {
  let count = 0;
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
    if (url.includes('identitytoolkit')) {
      return { ok: true, status: 200, json: async () => ({ idToken: 't' }), headers: new Headers() };
    }
    if (url.endsWith('/api/auth/session') && (opts.method || 'GET') === 'POST') {
      const h = new Headers();
      h.append('set-cookie', 'b2base_session=jwt-n; Path=/; HttpOnly');
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }), headers: h };
    }
    count += 1;
    if (count === 1) {
      return { ok: false, status: 401, json: async () => ({ success: false, error: 'SESSION_EXPIRED' }), headers: new Headers() };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: { ok: true } }), headers: new Headers() };
  };
  const client = await createAuthenticatedEvalClient({
    baseUrl: 'https://www.b2base.net',
    email: 'a@b.c',
    password: 'p',
    firebaseApiKey: 'k',
    fetchImpl,
  });
  const state = await client.getState('cmp-9');
  assert.deepEqual(state, { ok: true });
  const sessionPosts = calls.filter((c) => c.url.endsWith('/api/auth/session') && c.method === 'POST').length;
  assert.ok(sessionPosts >= 2, 'relogin após 401');
  assert.equal(count, 2, 'request repetido exatamente uma vez');
});

test('eval client: getTraces degrada para null em 404 (deploy sem telemetria)', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('identitytoolkit')) return { ok: true, status: 200, json: async () => ({ idToken: 't' }), headers: new Headers() };
    if (url.endsWith('/api/auth/session') && !url.includes('campaigns')) {
      const h = new Headers();
      h.append('set-cookie', 'b2base_session=j; Path=/');
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }), headers: h };
    }
    if (url.includes('/traces')) {
      return { ok: false, status: 404, json: async () => ({ success: false }), headers: new Headers() };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }), headers: new Headers() };
  };
  const client = await createAuthenticatedEvalClient({
    baseUrl: 'https://www.b2base.net',
    email: 'a@b.c',
    password: 'p',
    firebaseApiKey: 'k',
    fetchImpl,
  });
  assert.equal(await client.getTraces('cmp-1'), null);
});

test('eval auth: cookiesFromResponse suporta header único e getSetCookie', () => {
  const h = new Headers();
  h.append('set-cookie', 'a=1; Path=/');
  h.append('set-cookie', 'b=2; Path=/');
  assert.equal(cookiesFromResponse({ headers: h }).length, 2);
  assert.equal(cookiesFromResponse({ headers: new Headers() }).length, 0);
});

// ── Epic 4 (Stories 4.2/4.3/4.5): anti-flake, classificação, judge v2 ──────

const runner = require('../eval/run-conversations');
const { isJudgeV2Configured, createJudgeLlm } = require('../eval/judge-gateway');

test('eval L2: classificação infra×agente — gateway/timeout/5xx são infra, resto é agente', () => {
  assert.equal(runner.classifyCase({ pass: true }), null, 'caso que passa não tem classificação');
  assert.equal(
    runner.classifyCase({ pass: false, httpErrors: [], llmGatewayErrors: ['LiteLLM Insufficient Balance'] }),
    'infra'
  );
  assert.equal(runner.classifyCase({ pass: false, httpErrors: ['POST /chat HTTP 503: deploy'], llmGatewayErrors: [] }), 'infra');
  assert.equal(runner.classifyCase({ pass: false, httpErrors: ['fetch failed'], llmGatewayErrors: [] }), 'infra');
  assert.equal(runner.classifyCase({ pass: false, httpErrors: [], llmGatewayErrors: [] }), 'agent', 'falha sem erro de transporte é do agente');
  assert.equal(
    runner.classifyCase({ pass: false, httpErrors: ['LiteLLM 429'], llmGatewayErrors: [] }),
    'infra',
    'rate limit é ambiente'
  );
});

test('eval L2: cardOrder é subsequência — ordem canônica sem exigir exclusividade', () => {
  const mk = (cards) => ({ turns: cards.map((c) => ({ reply: 'ok', cards: [c] })), state: {}, traces: null, certificate: null });
  const exp = { type: 'cardOrder', cards: ['objective', 'audience', 'content', 'schedule'] };
  const seq = (types) => types.map((t) => ({ type: t }));
  const assertOrder = (types, expected) => {
    const ctx = { turns: types.map((t) => ({ reply: 'ok', cards: seq([t]) })), state: {}, traces: null, certificate: null };
    const { evaluateAssertion } = require('../eval/lib');
    return evaluateAssertion(exp, ctx).pass === expected;
  };
  assert.ok(assertOrder(['objective', 'audience', 'content', 'schedule'], true));
  assert.ok(assertOrder(['objective', 'audience', 'audience', 'content', 'schedule'], true), 'cards extras não quebram');
  assert.ok(assertOrder(['audience', 'objective', 'content', 'schedule'], false), 'inversão reprova');
  assert.ok(assertOrder(['objective', 'audience'], false), 'ausência reprova');
});

test('eval 4.3: captura-sem-mcp só roda com token isolado declarado', () => {
  delete process.env.B2BASE_EVAL_MCP_ISOLATED;
  assert.equal(runner.requirementMet('mcp_isolated'), false);
  process.env.B2BASE_EVAL_MCP_ISOLATED = 'true';
  assert.equal(runner.requirementMet('mcp_isolated'), true);
  assert.equal(runner.requirementMet(null), true, 'caso sem requisito sempre roda');
  assert.equal(runner.requirementMet('requisito_desconhecido'), false, 'requisito desconhecido não rola por padrão');
  delete process.env.B2BASE_EVAL_MCP_ISOLATED;
});

test('eval 4.5: judge v2 só existe com URL e modelo; client fala OpenAI-compatível', async () => {
  delete process.env.B2BASE_JUDGE_URL;
  delete process.env.B2BASE_JUDGE_MODEL;
  assert.equal(isJudgeV2Configured(), false);
  await assert.rejects(() => createJudgeLlm(), /B2BASE_JUDGE_URL/);

  process.env.B2BASE_JUDGE_URL = 'https://laya.example/v1';
  process.env.B2BASE_JUDGE_MODEL = 'judge-model-x';
  assert.equal(isJudgeV2Configured(), true);

  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"correctness":9}', finish_reason: 'stop' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    };
  };
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    const callLlm = await createJudgeLlm();
    const out = await callLlm({ system: 's', user: 'u', jsonMode: true, temperature: 0 });
    assert.equal(out.content, '{"correctness":9}');
    assert.equal(out.model, 'judge-model-x');
    assert.equal(calls[0].url, 'https://laya.example/v1/chat/completions');
    assert.equal(calls[0].body.model, 'judge-model-x');
    assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  } finally {
    global.fetch = originalFetch;
    delete process.env.B2BASE_JUDGE_URL;
    delete process.env.B2BASE_JUDGE_MODEL;
  }
});

test('eval 4.5: judgeConversation rotula a versão de quem avaliou (v2 no relatório)', async () => {
  const { judgeConversation } = require('../eval/llm-judge');
  const callLlm = async () => ({
    content: JSON.stringify({ ...VALID_METRICS, issues: [], improvements: [], summary: 'ok' }),
    model: 'judge-model-x',
    usage: null,
  });
  const v2 = await judgeConversation({ callLlm, conversation: [{ user: 'oi', reply: 'olá', cards: [] }], caseDef: { id: 'x', title: 'X' }, version: 'v2' });
  assert.equal(v2.version, 'v2', 'judge independente registra v2 (D3)');
  const v1 = await judgeConversation({ callLlm, conversation: [{ user: 'oi', reply: 'olá', cards: [] }] });
  assert.equal(v1.version, JUDGE_VERSION);
});

test('eval 4.3: asserções novas — provenancePresent, captureRefused, stateOfferNull, scheduleWindowsMatch', () => {
  const { evaluateAssertion } = require('../eval/lib');
  const ctx = (extra = {}) => ({ turns: [], state: { campaign: { schedule: { windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }] } } }, traces: null, certificate: null, ...extra });

  assert.equal(
    evaluateAssertion({ type: 'provenancePresent' }, { turns: [], state: {}, traces: null, certificate: null, ...{} }).pass,
    false,
    'sem card de captura reprova'
  );
  const captured = (card) => evaluateAssertion({ type: 'provenancePresent' }, { turns: [{ reply: '', cards: [card] }], state: {}, traces: null, certificate: null });
  assert.equal(captured({ type: 'capture', status: 'captured', captureSource: 'mcp-cnpj', baseOwnCount: 3, mcpCount: 2 }).pass, true);
  assert.equal(captured({ type: 'capture', status: 'captured' }).pass, false, 'captured sem proveniência reprova');

  const refused = (card) => evaluateAssertion({ type: 'captureRefused' }, { turns: [{ reply: '', cards: [card] }], state: {}, traces: null, certificate: null });
  assert.equal(refused({ type: 'capture', status: 'refused', reason: 'mcp_not_configured' }).pass, true);
  assert.equal(refused({ type: 'capture', status: 'captured' }).pass, false, 'captured não é recusa');

  assert.equal(evaluateAssertion({ type: 'stateOfferNull' }, ctx()).pass, true);
  assert.equal(evaluateAssertion({ type: 'stateOfferNull' }, { turns: [], state: { campaign: { offer: 'invenção' } }, traces: null, certificate: null }).pass, false, 'oferta inventada reprova');

  assert.equal(evaluateAssertion({ type: 'scheduleWindowsMatch', days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }, ctx()).pass, true);
  assert.equal(
    evaluateAssertion({ type: 'scheduleWindowsMatch', days: [6, 7], startHour: 9, endHour: 18 }, ctx()).pass,
    false,
    'janela divergente reprova (F7)'
  );
});
