'use strict';

/**
 * test/studio-media-url.test.js — URL PÚBLICA de mídia (2026-10-27):
 * localhost/rede privada NÃO é URL pública (regra do dono — não inventar
 * domínio); APP_URL público vence a origem do request; a URL de mídia é
 * determinística a partir da base.
 */

const test = require('node:test');
const assert = require('node:assert');
const { isPublicHttpUrl, resolvePublicBaseUrl, mediaPublicUrl } = require('../studio/media-url');

test('isPublicHttpUrl: localhost/rede privada/loopback NÃO são públicos', () => {
  assert.equal(isPublicHttpUrl('http://localhost:3001/media/x.png'), false);
  assert.equal(isPublicHttpUrl('http://127.0.0.1:3001/x'), false);
  assert.equal(isPublicHttpUrl('http://0.0.0.0/x'), false);
  assert.equal(isPublicHttpUrl('http://[::1]:3001/x'), false);
  assert.equal(isPublicHttpUrl('http://192.168.0.10/x'), false);
  assert.equal(isPublicHttpUrl('http://10.1.2.3/x'), false);
  assert.equal(isPublicHttpUrl('http://172.20.1.1/x'), false);
  assert.equal(isPublicHttpUrl('http://169.254.1.1/x'), false);
  assert.equal(isPublicHttpUrl('não é url'), false);
  assert.equal(isPublicHttpUrl(''), false);
});

test('isPublicHttpUrl: domínio público http/https É publicável', () => {
  assert.equal(isPublicHttpUrl('https://www.b2base.net/media/x.png'), true);
  assert.equal(isPublicHttpUrl('https://cdn.b2base.com/abc.png'), true);
  assert.equal(isPublicHttpUrl('http://empresa.com.br/x'), true, 'http público é publicável (HTTPS vem do proxy)');
});

test('resolvePublicBaseUrl: APP_URL público vence a origem; origem pública é aceita', () => {
  assert.equal(
    resolvePublicBaseUrl({ appUrl: 'https://www.b2base.net', origin: 'http://localhost:5173' }),
    'https://www.b2base.net',
    'APP_URL público vence'
  );
  assert.equal(
    resolvePublicBaseUrl({ appUrl: 'http://localhost:5173', origin: 'https://www.b2base.net' }),
    'https://www.b2base.net',
    'APP_URL local → cai para a origem pública'
  );
  assert.equal(
    resolvePublicBaseUrl({ appUrl: 'http://localhost:5173', origin: 'http://localhost:5173' }),
    'http://localhost:5173',
    'dev sem público nenhum devolve a origem local (o chamador sabe que não é pública)'
  );
  assert.equal(resolvePublicBaseUrl({}), '');
  // Barras finais normalizadas.
  assert.equal(resolvePublicBaseUrl({ appUrl: 'https://www.b2base.net/' }), 'https://www.b2base.net');
});

test('mediaPublicUrl: /media/<nome> determinístico a partir da base', () => {
  assert.equal(mediaPublicUrl('https://cdn.b2base.com', 'abc123.png'), 'https://cdn.b2base.com/media/abc123.png');
  assert.equal(mediaPublicUrl('https://cdn.b2base.com/', 'abc123.png'), 'https://cdn.b2base.com/media/abc123.png');
  assert.equal(mediaPublicUrl('', 'abc123.png'), '/media/abc123.png', 'sem base → caminho relativo');
});
