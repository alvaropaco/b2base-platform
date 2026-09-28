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
