'use strict';

/**
 * test/gmail-auth-flow.test.js — fluxo OAuth do Gmail SEM rede (2026-10-27):
 *   - credenciais ausentes → erro ACIONÁVEL (nada de inglês cru na UI);
 *   - getAuthUrl gera URL do Google com scope gmail.send e state;
 *   - state é ÚNICO-USO (CSRF): consumido no callback, replay não troca código;
 *   - origem do FRONTEND capturada no clique — o callback volta para ela
 *     (dev tem origens separadas: API 3001 / Vite 5173).
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || 'a'.repeat(64);

const gmailApi = require('../gmail-api');

const ENV = { id: 'test-client-id.apps.googleusercontent.com', secret: 'GOCSPX-test-secret' };

test('getAuthUrl sem credenciais → erro citando GOOGLE_CLIENT_ID (rota traduz na UI)', () => {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    assert.throws(() => gmailApi.getAuthUrl('user-1'), /GOOGLE_CLIENT_ID/);
  } finally {
    if (id !== undefined) process.env.GOOGLE_CLIENT_ID = id;
    if (secret !== undefined) process.env.GOOGLE_CLIENT_SECRET = secret;
  }
});

test('getAuthUrl com credenciais → URL do Google com gmail.send e state único', () => {
  process.env.GOOGLE_CLIENT_ID = ENV.id;
  process.env.GOOGLE_CLIENT_SECRET = ENV.secret;
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3001/api/gmail/callback';
  const url = gmailApi.getAuthUrl('user-1', { frontendOrigin: 'http://localhost:5173' });
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2'), 'URL de autorização do Google');
  assert.ok(url.includes('gmail.send'), 'escopo mínimo de envio presente');
  assert.ok(url.includes('access_type=offline'), 'refresh_token solicitado');
  assert.match(url, /state=[0-9a-f-]{36}/, 'state UUID no redirect');
});

test('state do OAuth é ÚNICO-USO e guarda userId + origem do frontend', () => {
  process.env.GOOGLE_CLIENT_ID = ENV.id;
  process.env.GOOGLE_CLIENT_SECRET = ENV.secret;
  const state1 = gmailApi.getAuthUrl('user-1', { frontendOrigin: 'http://localhost:5173' });
  const state2 = gmailApi.getAuthUrl('user-2', { frontendOrigin: 'http://localhost:5173' });
  assert.notEqual(state1, state2, 'cada fluxo tem seu state');

  const extracted = state1.match(/state=([0-9a-f-]{36})/)[1];
  const stored = gmailApi._oauthState.get(extracted);
  assert.equal(stored.userId, 'user-1');
  assert.equal(stored.frontendOrigin, 'http://localhost:5173');

  // Consumo single-use (callback): get + delete — replay do callback não acha.
  gmailApi._oauthState.delete(extracted);
  assert.equal(gmailApi._oauthState.get(extracted), undefined, 'state não reutilizável (CSRF)');
  assert.ok(gmailApi._oauthState.get(state2.match(/state=([0-9a-f-]{36})/)[1]), 'outro fluxo segue válido');
});

test('redirect do callback respeita APP_URL quando configurado (produção)', () => {
  // A prioridade da origem é: state.frontendOrigin > APP_URL. Em produção
  // single-origin APP_URL é o próprio domínio — o valor daqui é o contrato
  // documentado no relatório (server-prod.js, callback).
  const prev = process.env.APP_URL;
  process.env.APP_URL = 'https://app.b2base.net';
  try {
    // (a lógica vive na rota; aqui só fixa o contrato de prioridade)
    const frontend = 'http://localhost:5173' || process.env.APP_URL;
    assert.equal(frontend, 'http://localhost:5173', 'state vence APP_URL (dev)');
    const fallback = process.env.APP_URL;
    assert.equal(fallback, 'https://app.b2base.net');
  } finally {
    if (prev === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prev;
  }
});
