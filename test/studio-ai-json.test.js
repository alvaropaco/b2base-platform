'use strict';

/**
 * test/studio-ai-json.test.js — fix da issue de extração flaky:
 * parse tolerante de saída de LLM (prosa, cercas, truncamento) e retry com
 * prompt de reparo no extractor (specs/010).
 */

const test = require('node:test');
const assert = require('node:assert');
const { parseModelJson } = require('../studio/ai/json');
const { createExtractor } = require('../studio/ai/extract');

test('parseModelJson: JSON com prosa antes/depois é extraído (varredura balanceada)', () => {
  const parsed = parseModelJson('Claro! Aqui está a extração:\n{"product":"ERP","offer":"30 dias"}\nQualquer coisa depois.');
  assert.equal(parsed.product, 'ERP');
  assert.equal(parsed.offer, '30 dias');
});

test('parseModelJson: cerca com texto residual e chaves dentro de strings', () => {
  const fenced = parseModelJson('```json\n{"product":"ERP {especial}","offer":"x"}\n```\nEspero que ajude!');
  assert.equal(fenced.product, 'ERP {especial}');

  const prose = parseModelJson('Resposta: {"text":"ele disse {\\"oi\\"}"}');
  assert.equal(prose.text, 'ele disse {"oi"}');
});

test('parseModelJson: JSON truncado → null (caller faz retry/reparo)', () => {
  assert.equal(parseModelJson('{"product":"ERP","offer":"30'), null);
  assert.equal(parseModelJson(''), null);
  assert.equal(parseModelJson(null), null);
});

test('extractor: LLM "flaky" (1ª chamada com prosa) extrai sem retry graças ao parse tolerante', async () => {
  const calls = [];
  const extractor = createExtractor({
    callLlm: async (opts) => {
      calls.push(opts);
      return {
        content: 'Segue a extração:\n{"product":"ERP industrial","offer":"implantação 30 dias","benefits":["fiscal"],"audience":"indústrias","cta":"demo","confidence":0.9}',
      };
    },
  });
  const result = await extractor.extractFromText('texto do material');
  assert.equal(result.product, 'ERP industrial');
  assert.equal(calls.length, 1, 'parse tolerante resolve na 1ª tentativa');
});

test('extractor: saída truncada na 1ª tentativa → retry com reparo recupera', async () => {
  const prompts = [];
  let call = 0;
  const extractor = createExtractor({
    callLlm: async (opts) => {
      call += 1;
      prompts.push(opts.user);
      if (call === 1) {
        return { content: '{"product":"ERP","offer":"implanta' }; // truncado
      }
      return {
        content: '{"product":"ERP","offer":"implantação","benefits":[],"audience":"indústria","cta":"demo","confidence":0.8}',
      };
    },
  });
  const result = await extractor.extractFromText('texto');
  assert.equal(result.offer, 'implantação');
  assert.equal(call, 2, 'segunda tentativa após parse falho');
  assert.ok(prompts[1].includes('NÃO foi JSON utilizável'), '2ª chamada usa prompt de REPARO');
  assert.ok(prompts[1].includes('{"product":"ERP","offer":"implanta'), 'reparo inclui a resposta ruim');
});

test('extractor: usa o modelo premium (AI_CAMPAIGN_LLM_MODEL) na extração', async () => {
  process.env.AI_CAMPAIGN_LLM_MODEL = 'deepseek-test';
  let usedModel = null;
  const extractor = createExtractor({
    callLlm: async (opts) => {
      usedModel = opts.model;
      return { content: '{"product":"x"}' };
    },
  });
  await extractor.extractFromText('texto');
  delete process.env.AI_CAMPAIGN_LLM_MODEL;
  assert.equal(usedModel, 'deepseek-test', 'extração roda no modelo premium');
});

// ── Revisão Epic 1: só infraestrutura consome orçamento de retry ────────────

test('callLlmJson: erro NÃO-infra (bug de código/401) vai direto — sem consumir retry', async () => {
  const { callLlmJson } = require('../studio/ai/json');
  let calls = 0;
  await assert.rejects(
    () => callLlmJson(
      async () => {
        calls += 1;
        const err = new Error('Cannot read property of undefined');
        err.code = 'CODE_BUG';
        throw err;
      },
      { buildUser: () => 'x', validate: () => null }
    ),
    (e) => e.code === 'CODE_BUG'
  );
  assert.equal(calls, 1, 'throw imediato — re-tentar não conserta bug');
});

test('callLlmJson: erro de autenticação com status (401/403) também não re-tenta', async () => {
  const { callLlmJson } = require('../studio/ai/json');
  let calls = 0;
  await assert.rejects(
    () => callLlmJson(
      async () => {
        calls += 1;
        const err = new Error('Invalid API key');
        err.status = 401;
        throw err;
      },
      { buildUser: () => 'x', validate: () => null }
    ),
    (e) => e.status === 401
  );
  assert.equal(calls, 1);
});

test('callLlmJson: erro de rede cru (fetch failed) é infra — consome retry de parse', async () => {
  const { callLlmJson } = require('../studio/ai/json');
  let calls = 0;
  await assert.rejects(
    () => callLlmJson(
      async () => {
        calls += 1;
        throw new Error('fetch failed');
      },
      { buildUser: () => 'x', validate: () => null, parseAttempts: 2 }
    ),
    (e) => e.code === 'LLM_JSON_FAILED'
  );
  assert.equal(calls, 2, 'infra re-tenta antes de degradar');
  assert.match(String(calls), /2/);
});
