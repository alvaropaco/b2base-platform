'use strict';

/**
 * eval/auth.js — autenticação programática do evaluator.
 *
 * O evaluator autentica como um usuário DEDICADO de avaliação usando o MESMO
 * mecanismo da aplicação real: Firebase Auth (e-mail/senha) → ID token →
 * POST /api/auth/session → cookie de sessão httpOnly (b2base_session).
 *
 * Nada de headers de teste (x-test-org-id): a organização é resolvida no
 * servidor a partir do usuário autenticado, exatamente como o Studio faz.
 *
 * Credenciais NUNCA vão para o Git: B2BASE_EVAL_EMAIL / B2BASE_EVAL_PASSWORD
 * (env ou CI secrets). A API key web do Firebase é pública (vem no bundle do
 * frontend), mas ainda assim é lida de env ou do .env.local local.
 */

const fs = require('fs');
const path = require('path');

const FIREBASE_IDENTITY_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword';

/** Resolve a API key web do Firebase (pública): env → apps/web/.env.local. */
function resolveFirebaseApiKey() {
  if (process.env.B2BASE_FIREBASE_API_KEY) return process.env.B2BASE_FIREBASE_API_KEY;
  if (process.env.VITE_FIREBASE_API_KEY) return process.env.VITE_FIREBASE_API_KEY;
  const envLocal = path.join(__dirname, '..', 'apps', 'web', '.env.local');
  try {
    const raw = fs.readFileSync(envLocal, 'utf8');
    const match = raw.match(/^VITE_FIREBASE_API_KEY=(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  } catch (_e) { /* arquivo ausente: segue para o erro explícito */ }
  throw new Error(
    'API key web do Firebase não encontrada: defina B2BASE_FIREBASE_API_KEY (ou VITE_FIREBASE_API_KEY no apps/web/.env.local).'
  );
}

/** Login no Firebase Auth (REST) → ID token da conta de avaliação. */
async function firebaseSignIn({ email, password, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(`${FIREBASE_IDENTITY_URL}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.idToken) {
    const reason = body.error?.message || `HTTP ${res.status}`;
    throw new Error(`Falha no login Firebase (${reason}) — verifique B2BASE_EVAL_EMAIL/B2BASE_EVAL_PASSWORD.`);
  }
  return { idToken: body.idToken, localId: body.localId, expiresIn: Number(body.expiresIn || 0) * 1000 };
}

/** Extrai cookies de Set-Cookie (Node ≥18.14 getSetCookie; fallback header único). */
function cookiesFromResponse(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * createAuthenticatedEvalClient({ baseUrl, email, password, fetchImpl })
 * → cliente com a MESMA sessão do Studio real:
 *   createCampaign, chat, getState, getHistory, getTraces, getSession.
 */
async function createAuthenticatedEvalClient({
  baseUrl = process.env.B2BASE_EVAL_URL || 'https://www.b2base.net',
  email = process.env.B2BASE_EVAL_EMAIL,
  password = process.env.B2BASE_EVAL_PASSWORD,
  firebaseApiKey,
  fetchImpl = fetch,
} = {}) {
  if (!email || !password) {
    throw new Error('Credenciais ausentes: defina B2BASE_EVAL_EMAIL e B2BASE_EVAL_PASSWORD.');
  }
  const base = String(baseUrl).replace(/\/+$/, '');
  const apiKey = firebaseApiKey || resolveFirebaseApiKey();
  let cookie = null;
  let identity = null;

  async function login() {
    const { idToken } = await firebaseSignIn({ email, password, apiKey, fetchImpl });
    const res = await fetchImpl(`${base}/api/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });
    if (!res.ok) throw new Error(`POST /api/auth/session falhou: HTTP ${res.status}`);
    const setCookies = cookiesFromResponse(res);
    const sessionCookie = setCookies.find((c) => c.startsWith('b2base_session='));
    if (!sessionCookie) throw new Error('Cookie de sessão b2base_session ausente na resposta.');
    cookie = sessionCookie.split(';')[0];
  }

  async function request(path, { method = 'GET', body, timeoutMs = 150_000, retryAuth = true } = {}) {
    if (!cookie) await login();
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 && retryAuth) {
      cookie = null;
      return request(path, { method, body, timeoutMs, retryAuth: false });
    }
    return res;
  }

  async function json(path, opts = {}) {
    const method = opts.method || 'GET';
    const res = await request(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const message = body?.error?.message || body?.error || `HTTP ${res.status}`;
      throw new Error(`${method} ${path} falhou: ${message}`);
    }
    return body.data;
  }

  const client = {
    baseUrl: base,
    /** Resolve sessão/usuário — usado no smoke inicial do evaluator. */
    async getSession() {
      identity = await json('/api/auth/session');
      return identity;
    },
    /** Cria campanha DEDICADA de avaliação (nunca reusa campanha de cliente). */
    createCampaign({ name, channels = ['email'] }) {
      return json('/api/studio/campaigns', { method: 'POST', body: { name, channels } });
    },
    /**
     * Um turno de conversa via SSE — o MESMO endpoint da UI real
     * (POST /campaigns/:id/chat/stream). Consome os frames e devolve
     * { reply, cards, statuses, error, campaignStatus }: falhas do backend
     * (ex.: gateway LLM sem saldo) aparecem em `error`, não como reply vazio.
     */
    async chat(campaignId, message) {
      const res = await request(`/api/studio/campaigns/${campaignId}/chat/stream`, {
        method: 'POST',
        body: { message },
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        throw new Error(`chat/stream HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const out = { reply: '', cards: [], statuses: [], error: null, campaignStatus: null };
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1];
          const dataRaw = frame.match(/^data: (.+)$/m)?.[1];
          if (!event) continue;
          const data = dataRaw ? JSON.parse(dataRaw) : {};
          if (event === 'reply') out.reply = data.text || '';
          else if (event === 'card') out.cards.push(data.card);
          else if (event === 'card_error') out.cards.push({ type: 'error', ...data.card });
          else if (event === 'status') out.statuses.push(data.label || data.phase || null);
          else if (event === 'error') { out.error = data.message || 'erro no stream'; finished = true; }
          else if (event === 'done') { out.campaignStatus = data.campaignStatus ?? null; finished = true; }
        }
      }
      return out;
    },
    getState(campaignId) {
      return json(`/api/studio/campaigns/${campaignId}/state`);
    },
    getHistory(campaignId) {
      return json(`/api/studio/campaigns/${campaignId}/chat`);
    },
    /** Telemetria operacional — 404 vira null (nem todo deploy tem traces). */
    async getTraces(campaignId) {
      const res = await request(`/api/studio/campaigns/${campaignId}/traces`);
      if (res.status === 404) return null;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return null;
      return body.data ?? body;
    },
  };

  // Login imediato: falha rápido e com mensagem clara antes da suíte rodar.
  await login();
  return client;
}

module.exports = { createAuthenticatedEvalClient, firebaseSignIn, resolveFirebaseApiKey, cookiesFromResponse };
