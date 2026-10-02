'use strict';

/**
 * test/studio-llm-repair.test.js — fix dos cards de erro do chat:
 * composeForTone e segment-nl com retry de reparo (callLlmJson) — primeira
 * resposta truncada/fora do catálogo é recuperada na 2ª chamada.
 *
 * QA 2026-10-02 (bug 3/6 do dono): o pacote de 3 canais num JSON só era a
 * tarefa que o modelo mais truncava/estourava timeout. Novo contrato:
 * chamada 1 = e-mail (JSON pesado, retry com reparo); chamada 2 = canais
 * curtos (pequena, BEST-EFFORT — falhar nunca derruba o pacote).
 */

const test = require('node:test');
const assert = require('node:assert');
const { createComposer } = require('../studio/ai/compose');
const { createSegmentNl } = require('../studio/ai/segment-nl');

const EMAIL_OK = {
  content: JSON.stringify({
    title: 'ERP',
    email: { subject: 'Olá {{companyName}}', preheader: 'x', blocks: [{ type: 'text', text: 'Olá {{firstName}}' }] },
  }),
};

const SHORT_OK = {
  content: JSON.stringify({
    whatsapp: { text: 'Oi {{firstName}}!' },
    linkedinText: 'texto',
    timing: 'terça 10h',
  }),
};

test('compose: e-mail truncado na 1ª tentativa → reparo recupera; canais curtos na sequência', async () => {
  const calls = [];
  const composer = createComposer({
    callLlm: async (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        // Truncada: e-mail aberto, o JSON nunca fecha.
        return { content: '{"title":"ERP","email":{"subject":"Olá {{companyName}}","preheader":"x","blocks":[{"type":"text","text":"Olá' };
      }
      if (calls.length === 2) return EMAIL_OK;
      return SHORT_OK;
    },
  });
  const pack = await composer.composeForTone({ tone: 'comercial', sourceText: 'ERP industrial' });
  assert.ok(pack.email.subject.includes('{{companyName}}'));
  assert.equal(calls.length, 3, 'email (falha + reparo) + canais curtos');
  assert.ok(calls[1].maxTokens >= 2000, 'maxTokens alto para o e-mail (evita truncar)');
  assert.ok(calls[1].user.includes('NÃO foi JSON utilizável'), '2ª chamada é prompt de reparo');
  assert.equal(calls[1].temperature, 0, 'reparo roda a temperature 0');
  assert.equal(calls[2].maxTokens < 2000, true, 'canais curtos são um JSON pequeno');
  assert.ok(pack.whatsapp.text);
});

test('compose: pacote sem o e-mail também dispara reparo (validação por canal)', async () => {
  const calls = [];
  const composer = createComposer({
    callLlm: async (opts) => {
      calls.push(opts);
      if (calls.length === 1) return { content: '{"title":"só título"}' };
      if (calls.length === 2) return EMAIL_OK;
      return SHORT_OK;
    },
  });
  const pack = await composer.composeForTone({ tone: 'formal', sourceText: 'x' });
  assert.ok(pack.email.subject);
  assert.ok(pack.whatsapp.text);
  assert.equal(calls.length, 3, 'validação do e-mail + chamada dos canais curtos');
});

test('compose: canais curtos falhando NUNCA derruba o pacote (best-effort)', async () => {
  const composer = createComposer({
    callLlm: async (opts) => {
      // Chamada do e-mail OK; chamada dos canais curtos SEMPRE inválida
      // (callLlmJson esgota parseAttempts e lança LLM_JSON_FAILED).
      if (String(opts.user).includes('CANAIS CURTOS')) {
        return { content: '{"whatsapp": {' };
      }
      return EMAIL_OK;
    },
  });
  const pack = await composer.composeForTone({ tone: 'comercial', sourceText: 'ERP' });
  assert.ok(pack.email, 'e-mail segue pronto mesmo sem canais curtos');
  assert.equal(pack.whatsapp, null, 'whatsapp ausente vira null, não erro');
});

test('segment-nl: critérios fora do catálogo na 1ª tentativa → reparo com o erro', async () => {
  const calls = [];
  const segmentNl = createSegmentNl({
    callLlm: async (opts) => {
      calls.push(opts);
      if (calls.length === 1) {
        return {
          content: JSON.stringify({
            criteria: { version: 1, groups: 'ausente' },
            rationale: 'x',
          }),
        };
      }
      return {
        content: JSON.stringify({
          criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'indústria' }] }] },
          rationale: 'indústrias',
        }),
      };
    },
  });
  const result = await segmentNl.fromPrompt('indústrias');
  assert.equal(result.rationale, 'indústrias');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].user.includes('NÃO atendeu ao formato do catálogo'));
});
