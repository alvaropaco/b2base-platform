'use strict';

/**
 * test/resolve-image-relay.test.js — RELAY CLOUDFLARE no resolvedor de
 * imagem (2026-10-28): host que bloqueia o IP de origem (429/403 — caso real
 * do imgur em datacenter) tenta UMA vez pelo Worker b2base-media-relay
 * (MEDIA_FETCH_RELAY_URL + MEDIA_FETCH_RELAY_AUTH). Sem relay configurado o
 * bloqueio vira erro honesto (comportamento de sempre).
 */

const { test } = require('node:test');
const assert = require('node:assert');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');

function withRelayEnv(url, auth, fn) {
  const prevUrl = process.env.MEDIA_FETCH_RELAY_URL;
  const prevAuth = process.env.MEDIA_FETCH_RELAY_AUTH;
  if (url === undefined) delete process.env.MEDIA_FETCH_RELAY_URL;
  else process.env.MEDIA_FETCH_RELAY_URL = url;
  if (auth === undefined) delete process.env.MEDIA_FETCH_RELAY_AUTH;
  else process.env.MEDIA_FETCH_RELAY_AUTH = auth;
  return Promise.resolve().then(fn).finally(() => {
    if (prevUrl === undefined) delete process.env.MEDIA_FETCH_RELAY_URL;
    else process.env.MEDIA_FETCH_RELAY_URL = prevUrl;
    if (prevAuth === undefined) delete process.env.MEDIA_FETCH_RELAY_AUTH;
    else process.env.MEDIA_FETCH_RELAY_AUTH = prevAuth;
  });
}

test('relay: página bloqueada (429) direto → resolve via relay (og:image)', async () => {
  const { resolveDirectImageUrl, isRelayConfigured } = require('../studio/resolve-image-link');
  await withRelayEnv('https://relay.exemplo.workers.dev', 'Bearer segredo', async () => {
    assert.ok(isRelayConfigured(), 'relay configurado');
    const seen = [];
    const fetchImpl = async (u, opts = {}) => {
      const url = String(u);
      seen.push(url);
      if (url === 'https://galeria.exemplo.com/a/abc') {
        assert.equal(opts.headers.Accept, 'text/html');
        return { ok: false, status: 429, headers: undefined, text: async () => '' };
      }
      if (url === 'https://relay.exemplo.workers.dev?url=' + encodeURIComponent('https://galeria.exemplo.com/a/abc')) {
        assert.equal(opts.headers.Authorization, 'Bearer segredo');
        return { ok: true, status: 200, headers: undefined, text: async () => '<meta property="og:image" content="https://cdn.exemplo.com/arte.jpg" />' };
      }
      throw new Error('fetch inesperado: ' + url);
    };
    const out = await resolveDirectImageUrl('https://galeria.exemplo.com/a/abc', { fetchImpl });
    assert.equal(out.imageUrl, 'https://cdn.exemplo.com/arte.jpg');
    assert.ok(seen.some((u) => u.includes('relay.exemplo.workers.dev')), 'passou pelo relay');
  });
});

test('relay: bytes da imagem com download bloqueado (403) → vêm pelo relay', async () => {
  const { downloadImageBytes } = require('../studio/resolve-image-link');
  await withRelayEnv('https://relay.exemplo.workers.dev', 'Bearer segredo', async () => {
    const fetchImpl = async (u) => {
      const url = String(u);
      if (url === 'https://cdn.exemplo.com/arte.jpg') return { ok: false, status: 403, arrayBuffer: async () => new ArrayBuffer(0) };
      if (url.startsWith('https://relay.exemplo.workers.dev?url=')) {
        return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
      }
      throw new Error('fetch inesperado: ' + url);
    };
    const buf = await downloadImageBytes('https://cdn.exemplo.com/arte.jpg', { fetchImpl });
    assert.deepEqual(buf, PNG, 'bytes reais via relay');
  });
});

test('relay: falha de rede no fetch direto → relay cobre', async () => {
  const { resolveDirectImageUrl } = require('../studio/resolve-image-link');
  await withRelayEnv('https://relay.exemplo.workers.dev', 'Bearer segredo', async () => {
    const fetchImpl = async (u) => {
      const url = String(u);
      if (url === 'https://galeria.exemplo.com/a/xyz') throw new Error('ECONNRESET');
      if (url.startsWith('https://relay.exemplo.workers.dev?url=')) {
        return { ok: true, status: 200, headers: undefined, text: async () => '<meta name="twitter:image" content="https://cdn.exemplo.com/x.png" />' };
      }
      throw new Error('fetch inesperado: ' + url);
    };
    const out = await resolveDirectImageUrl('https://galeria.exemplo.com/a/xyz', { fetchImpl });
    assert.equal(out.imageUrl, 'https://cdn.exemplo.com/x.png');
  });
});

test('sem relay configurado: bloqueio 429 vira erro honesto IMAGE_LINK_BLOCKED', async () => {
  const { resolveDirectImageUrl, isRelayConfigured } = require('../studio/resolve-image-link');
  await withRelayEnv(undefined, undefined, async () => {
    assert.equal(isRelayConfigured(), false, 'relay fora');
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '' });
    await assert.rejects(
      () => resolveDirectImageUrl('https://galeria.exemplo.com/a/abc', { fetchImpl }),
      (err) => err.code === 'IMAGE_LINK_BLOCKED' && /429/.test(err.message)
    );
  });
});

test('relay configurado mas relay TAMBÉM bloqueia → erro honesto com o status', async () => {
  const { resolveDirectImageUrl } = require('../studio/resolve-image-link');
  await withRelayEnv('https://relay.exemplo.workers.dev', 'Bearer segredo', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '' });
    await assert.rejects(
      () => resolveDirectImageUrl('https://galeria.exemplo.com/a/abc', { fetchImpl }),
      (err) => err.code === 'IMAGE_LINK_BLOCKED'
    );
  });
});
