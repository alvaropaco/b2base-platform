'use strict';

/**
 * test/studio-suggestions.test.js — o Briefing do Mordomo (specs/011, AD-9;
 * FR-21…FR-25). Ranking determinístico, ≤3 chips com motivo citável,
 * graceful degradation (0 chips sem candidato forte) e Dia Zero.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const suggestions = require('../studio/suggestions');

const NOW = new Date('2026-09-24T13:00:00Z'); // qui 10h SP

function seedOrg(prisma, { leads = 0, campaigns = [] } = {}) {
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  for (let i = 0; i < leads; i++) {
    prisma.prospect.rows.push({ id: `lead-${i}`, orgId: 'org-1', companyName: `Empresa ${i}`, cnpj: `12440${i}000120`, status: 'qualified' });
  }
  for (const campaign of campaigns) {
    prisma.studioCampaign.rows.push({ orgId: 'org-1', channels: ['email'], schedule: {}, ...campaign });
  }
  return prisma;
}

test('respostas quentes (dinheiro parado) vencem o ranking e citam o dado (FR-21/FR-24)', async () => {
  const prisma = seedOrg(createFakePrisma(), {
    leads: 200,
    campaigns: [{ id: 'c-1', name: 'ERP SP', status: 'scheduled', updatedAt: new Date('2026-09-24T10:00:00Z') }],
  });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'email', balance: 400, floor: 10, ceiling: 400, rampStage: 2, domainAuthStatus: 'verified' });
  prisma.studioReplyClassification.rows.push(
    { orgId: 'org-1', label: 'interested', confidence: 0.92, createdAt: new Date('2026-09-23T11:00:00Z') },
    { orgId: 'org-1', label: 'meeting_request', confidence: 0.88, createdAt: new Date('2026-09-23T12:00:00Z') },
    { orgId: 'org-1', label: 'interested', confidence: 0.3, createdAt: new Date('2026-09-23T12:00:00Z') }, // confiança baixa: fora
    { orgId: 'org-1', label: 'not_interested', confidence: 0.95, createdAt: new Date('2026-09-23T12:00:00Z') } // não é quente
  );

  const home = await suggestions.suggestions(prisma, { orgId: 'org-1', now: NOW });
  assert.equal(home.chips[0].kind, 'hot_replies', 'dinheiro parado primeiro');
  assert.ok(home.chips[0].motivo.includes('2'), 'motivo cita o dado que motivou');
  assert.ok(home.chips[0].prompt, 'chip inicia o diálogo (FR-25)');
});

test('aberturas sozinhas NÃO motivam chip de reengajamento (FR-24)', async () => {
  const prisma = seedOrg(createFakePrisma(), { leads: 5 });
  prisma.studioReplyClassification.rows.push(
    { orgId: 'org-1', label: 'interested', confidence: 0.4, createdAt: new Date('2026-09-24T10:00:00Z') }
  );
  const home = await suggestions.suggestions(prisma, { orgId: 'org-1', now: NOW });
  assert.ok(home.chips.every((c) => c.kind !== 'hot_replies'), 'confiança baixa não é sinal forte');
});

test('no máximo 3 chips, ranqueados: quentes > saldo/rascunho > aprovação (FR-21)', async () => {
  const prisma = seedOrg(createFakePrisma(), {
    leads: 500,
    campaigns: [
      { id: 'c-draft', name: 'Parada', status: 'draft', updatedAt: new Date('2026-09-18T10:00:00Z') },
      { id: 'c-review', name: 'Em revisão', status: 'in_review', updatedAt: new Date('2026-09-24T10:00:00Z') },
    ],
  });
  prisma.studioReplyClassification.rows.push(
    { orgId: 'org-1', label: 'interested', confidence: 0.9, createdAt: new Date('2026-09-23T11:00:00Z') }
  );
  const home = await suggestions.suggestions(prisma, { orgId: 'org-1', now: NOW });
  assert.ok(home.chips.length <= 3, 'teto de 3 chips');
  assert.deepEqual(home.chips.map((c) => c.kind), ['hot_replies', 'resume_draft', 'pending_approval']);
  assert.ok(home.chips.every((c) => c.motivo && c.label), 'todo chip carrega motivo citável');
});

test('graceful degradation: sem sinal forte → 0 chips, nunca chip genérico (FR-22)', async () => {
  const prisma = seedOrg(createFakePrisma(), { leads: 3, campaigns: [] });
  const home = await suggestions.suggestions(prisma, { orgId: 'org-1', now: NOW });
  assert.equal(home.diaZero, false, 'org tem dados — não é Dia Zero');
  assert.deepEqual(home.chips, [], 'zero chips (ausência, não sugestão fraca)');
});

test('Dia Zero: org sem dados recebe convites de primeiros passos (FR-23)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'trial' });
  const home = await suggestions.suggestions(prisma, { orgId: 'org-1', now: NOW });
  assert.equal(home.diaZero, true);
  assert.ok(home.chips.length >= 1 && home.chips.length <= 3);
  assert.ok(home.chips.some((c) => c.kind === 'day_zero_import'), 'primeiro passo: importar leads');
  assert.ok(home.chips.every((c) => !c.campaignId), 'Dia Zero não sugere operação');
});

test('saldo saudável + campanha pronta → chip de autorização com % citável (FR-21)', async () => {
  const prisma = seedOrg(createFakePrisma(), {
    campaigns: [{ id: 'c-1', name: 'ERP SP', status: 'approved', updatedAt: new Date('2026-09-24T10:00:00Z') }],
  });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'email', balance: 330, floor: 10, ceiling: 400, rampStage: 3, domainAuthStatus: 'verified' });
  const home = await suggestions.suggestions(prisma, { orgId: 'org-1', now: NOW });
  const balance = home.chips.find((c) => c.kind === 'balance_window');
  assert.ok(balance, 'chip de janela+saldo');
  assert.ok(balance.label.includes('%'), 'percentual concreto no chip');
  assert.equal(balance.campaignId, 'c-1');
});

// ── HTTP: home do Cockpit ────────────────────────────────────────────────────

async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path) => {
    const res = await fetch(`${base}/api/studio${path}`, { method });
    return { res, body: await res.json() };
  };
  return { server, prisma, api };
}

test('GET /cockpit/home: sugestões + saldo + pausa + campanha ativa num único contrato', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.studioCampaign.rows.push({ id: 'c-1', orgId: 'org-1', name: 'Ativa', status: 'running', channels: ['email'], schedule: {} });
    prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'email', balance: 200, floor: 10, ceiling: 400, rampStage: 1, domainAuthStatus: 'verified' });
    const { res, body } = await api('GET', '/cockpit/home');
    assert.equal(res.status, 200);
    assert.equal(body.data.diaZero, false);
    assert.ok(Array.isArray(body.data.chips), 'chips do mordomo');
    assert.ok(Array.isArray(body.data.balances) && body.data.balances.length === 1, 'saldo por canal');
    assert.equal(body.data.paused, false);
    assert.equal(body.data.activeCampaignId, 'c-1', 'Rail existe porque há campanha');
  } finally {
    server.close();
  }
});

test('GET /cockpit/home sem campanha: Rail ausente (activeCampaignId null — FR-3)', async () => {
  const { server, api } = await startServer();
  try {
    const { body } = await api('GET', '/cockpit/home');
    assert.equal(body.data.activeCampaignId, null);
  } finally {
    server.close();
  }
});
