'use strict';

/**
 * test/llm-client.test.js — mapeamento de erros do gateway (Epic 1, FR3):
 * abort e timeouts de rede do undici (TypeError UND_ERR_*) viram
 * err.code='LLM_TIMEOUT'; HTTP não-OK vira 'LLM_HTTP_ERROR' — sem isso o
 * errorCode do StudioChatTrace nascia null e a telemetria escondia a causa.
 * Fetch global stubado: o módulo roda de verdade (sem fabricar o erro).
 */

const test = require('node:test');
const assert = require('node:assert');
const { callLlm } = require('../llm-client');

function withFetch(impl, run) {
  const original = global.fetch;
  global.fetch = impl;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      global.fetch = original;
    });
}

test('llm-client: undici TypeError UND_ERR_SOCKET → err.code LLM_TIMEOUT', async () => {
  await withFetch(async () => {
    throw Object.assign(new TypeError('fetch failed'), { code: 'UND_ERR_SOCKET' });
  }, async () => {
    await assert.rejects(
      () => callLlm({ user: 'oi', timeoutMs: 1000 }),
      (err) => err.code === 'LLM_TIMEOUT'
    );
  });
});

test('llm-client: UND_ERR_CONNECT_TIMEOUT também vira LLM_TIMEOUT', async () => {
  await withFetch(async () => {
    throw Object.assign(new TypeError('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  }, async () => {
    await assert.rejects(
      () => callLlm({ user: 'oi', timeoutMs: 1000 }),
      (err) => err.code === 'LLM_TIMEOUT'
    );
  });
});

test('llm-client: AbortError do controller → err.code LLM_TIMEOUT', async () => {
  await withFetch(async (_url, opts) => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    void opts;
    throw err;
  }, async () => {
    await assert.rejects(
      () => callLlm({ user: 'oi', timeoutMs: 1000 }),
      (err) => err.code === 'LLM_TIMEOUT'
    );
  });
});

test('llm-client: HTTP não-OK do gateway → err.code LLM_HTTP_ERROR com status', async () => {
  await withFetch(async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: { message: 'bad gateway' } }),
  }), async () => {
    await assert.rejects(
      () => callLlm({ user: 'oi', timeoutMs: 1000 }),
      (err) => {
        assert.equal(err.code, 'LLM_HTTP_ERROR');
        assert.equal(err.status, 502);
        assert.match(err.message, /502/);
        return true;
      }
    );
  });
});
