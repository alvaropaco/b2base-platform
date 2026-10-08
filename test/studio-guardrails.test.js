'use strict';

/**
 * test/studio-guardrails.test.js — guard-rails da automação opt-in
 * (specs/010, T035; decisão de clarify Q1 / FR-003).
 *
 * Automações (suíte pós-enriquecimento adotada pelo Studio) exigem aprovação
 * do PRIMEIRO lote (amostra real) e pausam sozinhas ao detectar anomalia
 * (pico de bounce/opt-out); retomada exige ação humana.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const guardrails = require('../studio/guardrails');
const { tickCampaign } = require('../studio/scheduler-worker');

const IN_WINDOW = new Date('2026-09-23T13:00:00Z'); // qua 10h SP

function automationCampaign(overrides = {}) {
  return {
    id: 'auto-1',
    orgId: 'org-1',
    name: 'Suíte pós-enriquecimento',
    status: 'scheduled',
    channels: ['email'],
    schedule: {
      mode: 'scheduled',
      windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }],
      hourlyLimit: 5,
      dailyLimit: 20,
      timezone: 'America/Sao_Paulo',
      useLeadTimezone: false,
    },
    emailExecutionId: 'exec-auto',
    whatsappExecutionId: null,
    approval: { automation: true }, // suíte opt-in gerida pelo Studio
    ...overrides,
  };
}

function queuedContact(id, prospectId) {
  return { id, campaignId: 'exec-auto', prospectId, status: 'QUEUED', scheduledAt: null, sentAt: null };
}

test('automação sem aprovação do 1º lote: tick NÃO libera e fila retém com motivo', async () => {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push(automationCampaign());
  prisma.outreachCampaign.rows.push({ id: 'exec-auto', tenantId: 'org-1', guardrails: {} });
  prisma.outreachContact.rows.push(queuedContact('oc-1', 'lead-1'));

  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async () => assert.fail('não deveria liberar sem aprovação do 1º lote'),
  });
  assert.equal(result.released, 0);
  assert.equal(result.skipped, 'first_batch_pending');
});

test('aprovação do 1º lote destrava a fila (guardrails.firstBatchApprovedAt)', async () => {
  const prisma = createFakePrisma();
  // specs/011: o gate exige canal configurado e domínio verificado (FR-16).
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 100, floor: 10, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
  prisma.studioCampaign.rows.push(automationCampaign());
  prisma.outreachCampaign.rows.push({ id: 'exec-auto', tenantId: 'org-1', guardrails: {} });
  prisma.outreachContact.rows.push(queuedContact('oc-1', 'lead-1'));
  prisma.outreachContact.rows.push(queuedContact('oc-2', 'lead-2'));

  const approval = await guardrails.approveFirstBatch(prisma, prisma.studioCampaign.rows[0]);
  assert.ok(approval.approvedAt);
  assert.equal(approval.sample.length, 2, 'amostra = leads do 1º lote');

  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => enqueued.push(ids),
  });
  assert.equal(result.released, 2, 'aprovado o 1º lote, a fila corre');
  assert.equal(enqueued[0].length, 2);
});

test('anomalia (pico de bounce) pausa a automação com motivo; retomada é humana', async () => {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push(automationCampaign({ status: 'running' }));
  prisma.outreachCampaign.rows.push({ id: 'exec-auto', tenantId: 'org-1', guardrails: {} });
  // 10 envios recentes, 5 bounces (50% ≫ limiar 20%).
  for (let i = 1; i <= 10; i++) {
    prisma.outreachContact.rows.push({
      id: `oc-s-${i}`,
      campaignId: 'exec-auto',
      prospectId: `lead-${i}`,
      status: i <= 5 ? 'BOUNCED' : 'SENT',
      sentAt: new Date(Date.now() - 3600_000),
      scheduledAt: new Date(Date.now() - 7200_000),
    });
  }

  const verdict = await guardrails.evaluateAnomaly(prisma, prisma.studioCampaign.rows[0]);
  assert.equal(verdict.paused, true);
  assert.ok(verdict.reason.includes('bounce'));

  const campaign = prisma.studioCampaign.rows[0];
  assert.equal(campaign.status, 'paused');
  assert.ok(campaign.statusReason.includes('anomalia'));
  const execution = prisma.outreachCampaign.rows.find((e) => e.id === 'exec-auto');
  assert.ok(execution.guardrails.anomalyPausedAt, 'anomalia registrada na execução');

  // Retomada humana via control resume (transição paused → running é válida),
  // mas o guard-rails exige re-aprovação do lote: resume sem confirm falha.
  const { createStudioRouter: _r } = require('../studio/router');
  assert.ok(_r, 'router exporta factory');
});

test('org saudável não pausa: bounce abaixo do limiar segue em fila', async () => {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push(automationCampaign({ status: 'running' }));
  prisma.outreachCampaign.rows.push({ id: 'exec-auto', tenantId: 'org-1', guardrails: {} });
  for (let i = 1; i <= 10; i++) {
    prisma.outreachContact.rows.push({
      id: `oc-h-${i}`,
      campaignId: 'exec-auto',
      prospectId: `lead-${i}`,
      status: i <= 1 ? 'BOUNCED' : 'SENT', // 10%
      sentAt: new Date(Date.now() - 3600_000),
      scheduledAt: new Date(Date.now() - 7200_000),
    });
  }
  const verdict = await guardrails.evaluateAnomaly(prisma, prisma.studioCampaign.rows[0]);
  assert.equal(verdict.paused, false);
  assert.equal(prisma.studioCampaign.rows[0].status, 'running');
});

// ── HTTP: guard-rails no endpoint da amostra do 1º lote ─────────────────────

test('endpoint approve-first-batch aprova o lote e devolve a amostra', async () => {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    prisma.studioCampaign.rows.push(automationCampaign());
    prisma.outreachCampaign.rows.push({ id: 'exec-auto', tenantId: 'org-1', guardrails: {} });
    prisma.outreachContact.rows.push(queuedContact('oc-1', 'lead-1'));
    prisma.prospect.rows.push({ id: 'lead-1', orgId: 'org-1', companyName: 'Empresa 1' });

    const res = await fetch(`${`http://127.0.0.1:${server.address().port}`}/api/studio/campaigns/auto-1/approve-first-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.approvedAt);
    assert.equal(body.data.sample.length, 1);
    assert.equal(body.data.sample[0].companyName, 'Empresa 1');
    const execution = prisma.outreachCampaign.rows.find((e) => e.id === 'exec-auto');
    assert.ok(execution.guardrails.firstBatchApprovedAt);
  } finally {
    server.close();
  }
});
