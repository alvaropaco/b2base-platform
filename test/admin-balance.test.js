'use strict';
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const cookieParser = require('cookie');

process.env.ADMIN_USERNAME = 'admin-teste';
process.env.ADMIN_PASSWORD = 'senha-super-secreta';

// Fake prisma só com o que as rotas de saldo usam (org + carteira + ledger).
function makePrisma() {
  const db = { organizations: [], studioReputationAccount: [], studioReputationEvent: [] };
  const matches = (rec, where = {}) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && v.constructor === Object) {
      if ('in' in v) return v.in.includes(rec[k]);
      if ('contains' in v) return String(rec[k] || '').toLowerCase().includes(String(v.contains).toLowerCase());
      if ('mode' in v) return true;
      return Object.entries(v).every(([sk, sv]) => rec[sk] === sv);
    }
    return rec[k] === v;
  });
  return {
    db,
    organization: {
      async findUnique({ where }) { return db.organizations.find((o) => o.id === where.id) || null; },
      async findMany({ where = {}, select }) { return db.organizations.filter((o) => matches(o, where)).map((o) => select ? Object.fromEntries(Object.keys(select).map((k) => [k, o[k]])) : o); },
      async count({ where = {} } = {}) { return db.organizations.filter((o) => matches(o, where)).length; },
      async update({ where, data }) { const o = db.organizations.find((x) => x.id === where.id); Object.assign(o, data); return o; },
    },
    studioReputationAccount: {
      async findFirst({ where }) { return db.studioReputationAccount.find((a) => matches(a, where)) || null; },
      async findMany({ where = {} } = {}) { return db.studioReputationAccount.filter((a) => matches(a, where)); },
      async create({ data }) { const row = { id: `acc_${db.studioReputationAccount.length + 1}`, ...data }; db.studioReputationAccount.push(row); return row; },
      async updateMany({ where, data }) {
        let n = 0;
        for (const a of db.studioReputationAccount) {
          if (!matches(a, where)) continue;
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v === 'object' && 'increment' in v) a[k] = (Number(a[k]) || 0) + Number(v.increment);
            else a[k] = v;
          }
          n++;
        }
        return { count: n };
      },
    },
    studioReputationEvent: {
      async create({ data }) { const row = { id: `evt_${db.studioReputationEvent.length + 1}`, createdAt: new Date(), ...data }; db.studioReputationEvent.push(row); return row; },
      async findFirst({ where }) { return db.studioReputationEvent.find((e) => matches(e, where)) || null; },
      async findMany({ where = {} } = {}) { return db.studioReputationEvent.filter((e) => matches(e, where)); },
    },
    $transaction: async (fn) => fn(module.exports),
  };
}

// reputation.withTx usa prisma.$transaction(fn) — o fake acima já resolve.
async function makeApp() {
  const { createAdminRouter } = require('../admin');
  const prisma = makePrisma();
  // $transaction precisa do próprio prisma
  prisma.$transaction = (fn) => fn(prisma);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (req.headers.cookie) req.cookies = Object.fromEntries(req.headers.cookie.split(';').map((c) => { const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))]; })); next(); });
  app.use('/api/admin', createAdminRouter(prisma));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // login → cookie de sessão
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin-teste', password: 'senha-super-secreta' }) });
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  const api = async (method, path, body) => {
    const res = await fetch(`${base}/api/admin${path}`, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { res, body: await res.json().catch(() => ({})) };
  };
  return { prisma, api, server: () => server.close() };
}

test('admin: POST /orgs/:id/balance credita na carteira única com evento no ledger', async () => {
  const { prisma, api, server } = await makeApp();
  prisma.db.organizations.push({ id: 'org-1', name: 'Cliente X', plan: 'premium' });
  try {
    const { res, body } = await api('POST', '/orgs/org-1/balance', { amount: 250, reason: 'cliente pagou fora' });
    assert.equal(res.status, 200);
    const { WALLET_POLICY } = require('../studio/reputation');
    assert.equal(body.data.credited, 250);
    assert.equal(body.data.balance, WALLET_POLICY.startBalance + 250);
    const acc = prisma.db.studioReputationAccount[0];
    assert.equal(acc.balance, WALLET_POLICY.startBalance + 250);
    assert.equal(acc.channel, 'unified');
    const evt = prisma.db.studioReputationEvent.find((e) => e.type === 'credit');
    assert.ok(evt, 'evento no ledger');
    assert.equal(evt.refType, 'admin');
    assert.equal(evt.balanceAfter, WALLET_POLICY.startBalance + 250);
  } finally { server(); }
});

test('admin: segundo crédito SOMA (cada clique é um crédito novo, refId único)', async () => {
  const { prisma, api, server } = await makeApp();
  prisma.db.organizations.push({ id: 'org-2', name: 'Cliente Y', plan: 'trial' });
  try {
    const { WALLET_POLICY } = require('../studio/reputation');
    await api('POST', '/orgs/org-2/balance', { amount: 100 });
    const { body } = await api('POST', '/orgs/org-2/balance', { amount: 50 });
    assert.equal(body.data.credited, 50);
    assert.equal(body.data.balance, WALLET_POLICY.startBalance + 100 + 50, 'start + 100 + 50');
    const evts = prisma.db.studioReputationEvent.filter((e) => e.type === 'credit');
    assert.equal(evts.length, 2, 'dois eventos no ledger — refId único por chamada');
  } finally { server(); }
});

test('admin: valor inválido e org inexistente → 400/404', async () => {
  const { prisma, api, server } = await makeApp();
  prisma.db.organizations.push({ id: 'org-3', name: 'Cliente Z', plan: 'trial' });
  try {
    const bad = await api('POST', '/orgs/org-3/balance', { amount: 0 });
    assert.equal(bad.res.status, 400);
    const big = await api('POST', '/orgs/org-3/balance', { amount: 999999 });
    assert.equal(big.res.status, 400);
    const missing = await api('POST', '/orgs/org-inexistente/balance', { amount: 10 });
    assert.equal(missing.res.status, 404);
  } finally { server(); }
});

test('admin: GET /orgs/:id/balance devolve saldo e eventos recentes', async () => {
  const { prisma, api, server } = await makeApp();
  prisma.db.organizations.push({ id: 'org-4', name: 'Cliente W', plan: 'premium' });
  try {
    await api('POST', '/orgs/org-4/balance', { amount: 80 });
    const { res, body } = await api('GET', '/orgs/org-4/balance');
    assert.equal(res.status, 200);
    const { WALLET_POLICY } = require('../studio/reputation');
    assert.equal(body.data.balance, WALLET_POLICY.startBalance + 80, 'startBalance da política + crédito manual');
    assert.ok(Array.isArray(body.data.recentEvents) && body.data.recentEvents.length >= 1);
  } finally { server(); }
});

test('admin: listagem de orgs traz o saldo da carteira', async () => {
  const { prisma, api, server } = await makeApp();
  prisma.db.organizations.push({ id: 'org-5', name: 'Cliente V', plan: 'trial' });
  try {
    await api('POST', '/orgs/org-5/balance', { amount: 42 });
    const { body } = await api('GET', '/orgs');
    assert.equal(res_ok(body), true);
    const org = body.data.find((o) => o.id === 'org-5');
    // startBalance da política + 42 do crédito manual
    const { WALLET_POLICY } = require('../studio/reputation');
    assert.equal(org.balance, WALLET_POLICY.startBalance + 42, 'saldo aparece na listagem');
  } finally { server(); }
});

function res_ok(body) { return Boolean(body && body.success); }
