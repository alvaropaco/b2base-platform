'use strict';

/**
 * test/studio-media-publisher.test.js — PUBLICAÇÃO OPCIONAL de mídia em
 * bucket/CDN por HTTP PUT (2026-10-27). Configurada (MEDIA_PUBLISH_*), a
 * imagem recebe URL pública estável; qualquer falha → fallback local
 * fail-safe (a rota /media de sempre). Não configurada → local direto.
 *
 * O HTTP é INJETADO (deps.fetchImpl) — sem sockets reais (um keep-alive
 * pendurava o processo do node --test).
 */

const test = require('node:test');
const assert = require('node:assert');
const { publishMedia } = require('../studio/media-publisher');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');
const NAME = 'abcdefabcdefabcdefabcdefabcdef12.png';
const deps = { readGenerated: () => PNG, readBuffer: () => PNG };

function withEnv(fn) {
  process.env.MEDIA_PUBLISH_PUT_URL = 'https://api.upload.example/objects/{fileName}';
  process.env.MEDIA_PUBLISH_AUTH = 'Bearer token-teste';
  process.env.MEDIA_PUBLISH_PUBLIC_BASE = 'https://cdn.b2base.com';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      delete process.env.MEDIA_PUBLISH_PUT_URL;
      delete process.env.MEDIA_PUBLISH_AUTH;
      delete process.env.MEDIA_PUBLISH_PUBLIC_BASE;
    });
}

test('configurado: PUT com Authorization + Content-Type e URL pública estável', async () => {
  await withEnv(async () => {
    const seen = [];
    const fetchImpl = async (url, opts = {}) => {
      seen.push({
        url: String(url),
        method: opts.method,
        auth: opts.headers.Authorization,
        type: opts.headers['Content-Type'],
        bytes: Buffer.from(opts.body),
      });
      return { ok: true, status: 200 };
    };
    const out = await publishMedia(NAME, { ...deps, fetchImpl });
    assert.equal(out.provider, 'remote');
    assert.equal(out.url, 'https://cdn.b2base.com/abcdefabcdefabcdefabcdefabcdef12.png', 'URL pública estável');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'PUT');
    assert.equal(seen[0].auth, 'Bearer token-teste', 'auth do bucket');
    assert.equal(seen[0].type, 'image/png', 'MIME correto');
    assert.deepEqual(seen[0].bytes, PNG, 'BYTES reais publicados');
    assert.ok(seen[0].url.endsWith(`/${NAME}`), 'fileName no endpoint');
  });
});

test('PUT falha (HTTP 500) → fallback LOCAL fail-safe (nunca quebra o envio)', async () => {
  await withEnv(async () => {
    const out = await publishMedia(NAME, {
      ...deps,
      fetchImpl: async () => ({ ok: false, status: 500 }),
    });
    assert.equal(out.provider, 'local', 'cai para local');
    assert.equal(out.url, null);
    assert.match(out.error, /publish_http_500/);
  });
});

test('PUT com erro de rede (fetch lança) → fallback LOCAL com a causa', async () => {
  await withEnv(async () => {
    const out = await publishMedia(NAME, {
      ...deps,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(out.provider, 'local');
    assert.match(out.error, /publish_failed: ECONNREFUSED/);
  });
});

test('não configurado → local direto com publishing_not_configured', async () => {
  delete process.env.MEDIA_PUBLISH_PUT_URL;
  const out = await publishMedia(NAME, deps);
  assert.equal(out.provider, 'local');
  assert.equal(out.error, 'publishing_not_configured');
});

test('arquivo inexistente → local com file_not_found (sem PUT às cegas)', async () => {
  await withEnv(async () => {
    const out = await publishMedia('ffffffffffffffffffffffffffffffff.png', {
      readGenerated: () => { throw new Error('nope'); },
      readBuffer: () => { throw new Error('nope'); },
    });
    assert.equal(out.provider, 'local');
    assert.equal(out.error, 'file_not_found');
  });
});
