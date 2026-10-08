'use strict';

/**
 * test/studio-gate.test.js — o gate único fail-closed (specs/011, AD-4/AD-5/
 * AD-14; FR-15/FR-19) e a matriz I/O do plano: release com saldo, saldo <
 * lote (fatiamento), org pausada, transição scheduled→running, worker checa
 * pausa e estorno de falha definitiva.
 */

const test = require('node:test');
const assert = require('node:assert');

// Janela do rate limiter aberta 24h — o teste de estorno deve ser
// determinístico (não depende da hora do servidor).
process.env.OUTREACH_ALLOWED_HOURS_START = '0';
process.env.OUTREACH_ALLOWED_HOURS_END = '24';

const { createFakePrisma } = require('./helpers/fake-prisma');
const reputationGate = require('../studio/reputation-gate');
const reputation = require('../studio/reputation');
const bridge = require('../studio/channel-bridge');
const { tickCampaign, tickAll } = require('../studio/scheduler-worker');

const IN_WINDOW = new Date('2026-09-23T13:00:00Z'); // qua 10h SP

function seed(prisma, overrides = {}) {
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false, ...overrides.org });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  // Saldo ÚNICO (2026-10-08): uma linha 'unified' por org.
  prisma.studioReputationAccount.rows.push({
    id: 'acc-1', orgId: 'org-1', channel: 'unified',
    balance: 100, floor: 10, ceiling: 100, rampStage: 0,
    emailSentToday: 0, whatsappSentToday: 0, usageDay: null,
    domainAuthStatus: 'verified', domainAuthDetail: {},
    ...overrides.account,
  });
  return prisma;
}

function campaignFixture(overrides = {}) {
  return {
    id: 'camp-1', orgId: 'org-1', name: 'Campanha', status: 'running',
    channels: ['email'],
    schedule: { mode: 'scheduled', windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }], hourlyLimit: 5, dailyLimit: 50, timezone: 'America/Sao_Paulo', useLeadTimezone: false },
    emailExecutionId: 'exec-1', whatsappExecutionId: null, approval: {},
    ...overrides,
  };
}

// ── evaluate/consume: fail-closed e ordem das checagens ───────────────────────

test('gate: pausa global persistida bloqueia ANTES do saldo (AD-4/FR-19)', async () => {
  const prisma = seed(createFakePrisma(), { org: { studioSendPaused: true } });
  const verdict = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'email', units: 5 });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, 'ORG_PAUSA_GLOBAL');
});

test('gate: canal sem conta configurada bloqueia com CANAL_NAO_CONFIGURADO', async () => {
  const prisma = createFakePrisma(); // sem emailAccount
  const verdict = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'email', units: 5 });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, 'CANAL_NAO_CONFIGURADO');
});

test('gate: FAIL-CLOSED — erro na avaliação bloqueia com motivo técnico (AD-4)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.findUnique = async () => {
    throw new Error('postgres connection reset');
  };
  const verdict = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'email', units: 5 });
  assert.equal(verdict.allow, false, 'nunca allow por omissão');
  assert.equal(verdict.code, 'GATE_ERRO_TECNICO');
  assert.equal(verdict.technical, true);
  const consume = await reputationGate.consume(prisma, { orgId: 'org-1', channel: 'email', units: 5, refId: 'b-1' });
  assert.equal(consume.granted, 0);
  assert.equal(consume.blocked.code, 'GATE_ERRO_TECNICO');
});

test('consume: fatiamento — saldo 30 (efetivo 20) e lote 100 concede a fatia e explica o resto (FR-15)', async () => {
  const prisma = seed(createFakePrisma(), { account: { balance: 30, floor: 10 } });
  const result = await reputationGate.consume(prisma, { orgId: 'org-1', channel: 'email', units: 100, refType: 'batch', refId: 'b-1' });
  assert.equal(result.granted, 20, 'fatia concedida pelo gate (callers não fatiam por fora)');
  assert.equal(result.deficit, 80);
  assert.equal(result.blocked.code, 'SALDO_INSUFICIENTE');
  assert.ok(result.blocked.reason.includes('80'), 'quanto falta');
  assert.ok(result.blocked.availableAt, 'quando libera');
  assert.equal(prisma.studioReputationEvent.rows.filter((e) => e.type === 'debit').length, 1, 'débito único no ledger');
});

test('consume: saldo zerado bloqueia sem conceder nada e nunca fica negativo', async () => {
  const prisma = seed(createFakePrisma(), { account: { balance: 5, floor: 10 } });
  const result = await reputationGate.consume(prisma, { orgId: 'org-1', channel: 'email', units: 10, refId: 'b-1' });
  assert.equal(result.granted, 0);
  assert.equal(result.blocked.code, 'SALDO_INSUFICIENTE');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 5);
});

test('gate: e-mail com domínio não verificado → DOMINIO_NAO_VERIFICADO (elegibilidade explícita no saldo único)', async () => {
  const prisma = seed(createFakePrisma(), { account: { domainAuthStatus: 'unverified' } });
  const verdict = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'email', units: 5 });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, 'DOMINIO_NAO_VERIFICADO');
  assert.ok(verdict.reason.includes('registros DNS'), 'instrução acionável');
  // …mas o saldo único NÃO é refém do domínio: o WhatsApp da mesma org dispara.
  prisma.whatsappAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', status: 'CONNECTED' });
  const wa = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'whatsapp', units: 5 });
  assert.equal(wa.allow, true, 'DNS é elegibilidade do E-MAIL, não do pool');
});

test('gate: cap diário do canal cheio → LIMITE_DIARIO_CANAL com saldo sobrando', async () => {
  const prisma = seed(createFakePrisma(), { account: { balance: 100, whatsappSentToday: 30, usageDay: '2026-09-23' } });
  prisma.whatsappAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', status: 'CONNECTED' });
  const verdict = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'whatsapp', units: 5, now: IN_WINDOW });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.code, 'LIMITE_DIARIO_CANAL');
  assert.ok(verdict.reason.includes('30/30'), 'mostra uso/teto do dia');
  const consume = await reputationGate.consume(prisma, { orgId: 'org-1', channel: 'whatsapp', units: 5, refId: 'b-cap', now: IN_WINDOW });
  assert.equal(consume.granted, 0);
  assert.equal(consume.blocked.code, 'LIMITE_DIARIO_CANAL');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 100, 'nada debitado (cap ≠ saldo)');
});

test('pausa global 1-clique: estado persistido, retomada exige ação explícita (FR-19)', async () => {
  const prisma = seed(createFakePrisma());
  await reputationGate.setOrgPaused(prisma, 'org-1', { paused: true, userId: 'user-1', reason: 'incidente' });
  assert.equal(prisma.organization.rows[0].studioSendPaused, true);
  assert.equal(prisma.organization.rows[0].studioPauseReason, 'incidente');
  assert.equal(await reputationGate.isOrgPaused(prisma, 'org-1'), true);

  await reputationGate.setOrgPaused(prisma, 'org-1', { paused: false });
  assert.equal(prisma.organization.rows[0].studioSendPaused, false);
  assert.equal(await reputationGate.isOrgPaused(prisma, 'org-1'), false);
});

// ── enqueueBatch: primitiva única de fila (AD-14) ────────────────────────────

test('enqueueBatch: filtra inscritos → gate/consume → marca alocação → enfileira (AD-14)', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows.push(campaignFixture());
  prisma.outreachContact.rows.push(
    { id: 'oc-1', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', scheduledAt: null },
    { id: 'oc-2', campaignId: 'exec-1', prospectId: 'lead-2', status: 'QUEUED', scheduledAt: null },
    { id: 'oc-3', campaignId: 'exec-1', prospectId: 'lead-3', status: 'SENT', sentAt: new Date(), scheduledAt: new Date() }, // já enviado
    { id: 'oc-4', campaignId: 'exec-2', prospectId: 'lead-4', status: 'QUEUED', scheduledAt: null } // outra execução
  );
  const enqueued = [];
  const result = await bridge.enqueueBatch(prisma, {
    campaign: prisma.studioCampaign.rows[0],
    channel: 'email',
    prospectIds: ['lead-1', 'lead-2', 'lead-3', 'lead-4'],
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.granted, 2, 'só inscritos elegíveis entram no lote');
  assert.deepEqual(result.enqueued, ['lead-1', 'lead-2']);
  assert.deepEqual(enqueued[0].ids, ['lead-1', 'lead-2']);
  assert.ok(prisma.outreachContact.rows.find((c) => c.id === 'oc-1').scheduledAt, 'marca a alocação (release depois do gate)');
  assert.ok(prisma.studioReputationEvent.rows.find((e) => e.refId === result.batchId), 'débito materializa o batchId');
});

test('enqueueBatch com pausa global: NADA enfileira (edge case da matriz I/O)', async () => {
  const prisma = seed(createFakePrisma(), { org: { studioSendPaused: true } });
  prisma.studioCampaign.rows.push(campaignFixture());
  prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', scheduledAt: null });
  const enqueued = [];
  const result = await bridge.enqueueBatch(prisma, {
    campaign: prisma.studioCampaign.rows[0],
    channel: 'email',
    prospectIds: ['lead-1'],
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.enqueued.length, 0);
  assert.equal(enqueued.length, 0);
  assert.equal(result.blocked.code, 'ORG_PAUSA_GLOBAL');
});

// ── Ciclo de vida: scheduled→running gated (AD-5) ────────────────────────────

test('tick: campanha scheduled vencida com saldo transita a running e libera o lote', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows.push(campaignFixture({ status: 'scheduled' }));
  prisma.outreachContact.rows.push(
    { id: 'oc-1', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', scheduledAt: null },
    { id: 'oc-2', campaignId: 'exec-1', prospectId: 'lead-2', status: 'QUEUED', scheduledAt: null }
  );
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.released, 2);
  assert.equal(prisma.studioCampaign.rows[0].status, 'running', 'transição gated executada');
  const debit = prisma.studioReputationEvent.rows.find((e) => e.type === 'debit');
  assert.ok(debit, 'débito + evento presentes no ledger');
  assert.equal(debit.amount, 2);
});

test('tick: campanha scheduled com domínio não verificado NÃO transita (gate bloqueia com instrução)', async () => {
  const prisma = seed(createFakePrisma(), { account: { domainAuthStatus: 'unverified' } });
  prisma.studioCampaign.rows.push(campaignFixture({ status: 'scheduled' }));
  prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', scheduledAt: null });
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.released, 0);
  assert.equal(result.skipped, 'gate_blocked');
  assert.equal(prisma.studioCampaign.rows[0].status, 'scheduled', 'permanece agendada');
  assert.equal(enqueued.length, 0);
});

test('tickAll: inclui campanhas scheduled vencidas (antes só running — pré-requisito b do addendum)', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows.push(
    campaignFixture({ id: 'camp-s', status: 'scheduled' }),
    campaignFixture({ id: 'camp-r', status: 'running' })
  );
  for (const exec of ['camp-s', 'camp-r']) {
    prisma.outreachContact.rows.push({ id: `oc-${exec}`, campaignId: 'exec-1', prospectId: `lead-${exec}`, status: 'QUEUED', scheduledAt: null });
  }
  // Ambas apontam para exec-1: o segundo tick não reenfileira (idempotência).
  const enqueued = [];
  const results = await tickAll(prisma, {
    now: IN_WINDOW,
    userId: null,
    overrides: {
      enqueueFactory: () => async (channel, ids) => enqueued.push({ channel, ids }),
    },
  });
  assert.equal(results.length, 2, 'scheduled E running varridas');
  assert.ok(results.every((r) => !r.error), JSON.stringify(results));
  assert.equal(results.reduce((sum, r) => sum + (r.released || 0), 0), 2, '1 lote (2 leads) liberado no total');
  assert.equal(prisma.studioCampaign.rows.find((c) => c.id === 'camp-s').status, 'running');
});

test('tick com pausa global: nada libera e o Despertar é informativo (matriz I/O)', async () => {
  const prisma = seed(createFakePrisma(), { org: { studioSendPaused: true } });
  prisma.studioCampaign.rows.push(campaignFixture({ status: 'scheduled' }));
  prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', scheduledAt: null });
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.released, 0);
  assert.equal(enqueued.length, 0);
  assert.equal(result.skipped, 'gate_blocked');
  // Despertar informativo (lista fechada FR-31 — bloqueio de agendamento).
  const wakes = prisma.opsNotification.rows.filter((n) => n.kind === 'wake');
  assert.equal(wakes.length, 1, '1 Despertar (bloqueio por pausa/saldo)');
});

// ── Worker checa pausa antes de CADA envio (AD-5) ────────────────────────────

test('outreach processSend: pausa global re-agenda em vez de enviar (FR-19)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: true });
  prisma.outreachCampaign.rows.push({ id: 'camp-1', tenantId: 'org-1', status: 'active' });
  prisma.outreachContact.rows.push({ id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-1', status: 'SCHEDULED', emailAccount_id: 'ea-1' });
  prisma.outreachMessage.rows.push({ id: 'msg-1', contactId: 'ct-1', status: 'SCHEDULED', body: 'x', contact: { campaign: { tenantId: 'org-1', status: 'active' } } });

  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  const enqueued = [];
  const origQueueFactory = workers._setQueueFactoryForTests;
  // fake de fila: captura o re-agendamento em vez de falar com o Redis.
  workers._setQueueFactoryForTests(() => ({
    add: async (job) => { enqueued.push(job); return { id: 'job-1' }; },
    getJob: async () => null,
  }));
  try {
    const result = await workers.processSend({ data: { messageId: 'msg-1' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'job-1' });
    assert.equal(result.paused, 'org_paused');
    assert.equal(enqueued.length, 1, 'mensagem re-agendada (retomada explícita a desperta)');
    assert.equal(prisma.outreachMessage.rows[0].status, 'SCHEDULED', 'nada enviado');
  } finally {
    origQueueFactory(() => {});
  }
});

test('outreach processSend: falha definitiva estorna 1 unidade idempotente (AD-13)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 99, floor: 0, ceiling: 100, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'verified' });
  prisma.studioReputationEvent.rows.push({ id: 'ev-1', orgId: 'org-1', channel: 'email', type: 'debit', amount: 1, balanceAfter: 99, refType: 'batch', refId: 'batch-1' });
  prisma.outreachCampaign.rows.push({ id: 'camp-1', tenantId: 'org-1', status: 'active' });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.outreachContact.rows.push({ id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-sem-email', status: 'SCHEDULED', emailAccount_id: 'ea-1' });
  prisma.outreachMessage.rows.push({ id: 'msg-sem-email', contactId: 'ct-1', status: 'SCHEDULED', body: 'x', contact: { campaign: { tenantId: 'org-1', status: 'active' }, emailAccount_id: 'ea-1' } });
  prisma.prospect.rows.push({ id: 'lead-sem-email', orgId: 'org-1', cnpjEmail: null });

  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(() => ({
    add: async () => ({ id: 'job-1' }),
    getJob: async () => null,
  }));
  const result = await workers.processSend({ data: { messageId: 'msg-sem-email' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'job-1' });
  assert.equal(result.failed, 'no_recipient_email');
  const credit = prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'msg-sem-email');
  assert.ok(credit, 'estorno registrado no ledger');
  assert.equal(credit.refType, 'send');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 100, 'saldo restaurado');

  // Requeue do worker (mesma mensagem) NÃO estorna 2×.
  await workers.processSend({ data: { messageId: 'msg-sem-email' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'job-2' });
  const credits = prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit' && e.refId === 'msg-sem-email');
  assert.equal(credits.length, 1, 'unique (type, refId) impede duplo estorno');
});

// ── SC-011: nenhuma placeholder crua sai ao lead (gate no envio) ─────────────

test('SC-011: processSend remove placeholder residual antes de enviar (incidente 2026-10)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.outreachCampaign.rows.push({ id: 'camp-1', tenantId: 'org-1', status: 'active' });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'resend', email: 'venda@empresa.com', status: 'connected' });
  prisma.outreachContact.rows.push({
    id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-1', status: 'SCHEDULED', emailAccount_id: 'ea-1',
    campaign: { id: 'camp-1', tenantId: 'org-1', status: 'active', sequence: [] },
  });
  prisma.outreachMessage.rows.push({
    id: 'msg-ph', contactId: 'ct-1', status: 'SCHEDULED',
    subject: 'Garantimos Leads quentes',
    body: 'Olá {{firstName}}, tudo bem?\n\nAqui é o(a) B2Base. Garantimos Leads quentes.',
    htmlBody: '<p>Olá {{firstName}}, tudo bem?</p>',
    contact: { campaign: { tenantId: 'org-1', status: 'active', studioAttachments: null }, emailAccount_id: 'ea-1', prospectId: 'lead-1', status: 'SCHEDULED' },
  });
  prisma.prospect.rows.push({ id: 'lead-1', orgId: 'org-1', cnpjEmail: 'contato@lead.com.br' });

  const emailProvider = require('../email-provider');
  const sent = [];
  const realSend = emailProvider.sendEmailForAccount;
  emailProvider.sendEmailForAccount = async (_prisma, _accountId, payload) => {
    sent.push(payload);
    return { messageId: 'pm-1', threadId: 'th-1' };
  };
  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(() => ({ add: async () => ({ id: 'j' }), getJob: async () => null }));
  try {
    const result = await workers.processSend({ data: { messageId: 'msg-ph' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'job-ph' });
    assert.ok(result.messageId, 'envio seguiu após sanitizar');
    assert.equal(sent.length, 1, 'provider chamado 1×');
    assert.ok(!sent[0].body.includes('{{'), 'placeholder removida do corpo ENVIADO');
    assert.ok(!sent[0].htmlBody.includes('{{'), 'placeholder removida do html ENVIADO');
    assert.ok(!sent[0].subject.includes('{{'), 'subject limpo');
    assert.match(sent[0].body, /Olá, tudo bem\?/, 'sem rastro de espaço pendurado');
    const stored = prisma.outreachMessage.rows.find((m) => m.id === 'msg-ph');
    assert.ok(!stored.body.includes('{{'), 'banco reflete o que foi enviado');
    assert.equal(stored.status, 'SENT');
  } finally {
    emailProvider.sendEmailForAccount = realSend;
    workers._setQueueFactoryForTests(() => {});
  }
});

// ── Caminho WhatsApp do scheduler (waContactModel — AD-5/AD-14) ──────────────

test('tick WA: libera via waContactModel, marca nextSendAt e debita o canal', async () => {
  const prisma = seed(createFakePrisma());
  prisma.whatsappAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', status: 'CONNECTED' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'unified', balance: 50, floor: 10, ceiling: 50, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'unverified' });
  prisma.studioCampaign.rows.push(campaignFixture({ channels: ['whatsapp'], emailExecutionId: null, whatsappExecutionId: 'wexec-1' }));
  prisma.whatsappCampaignContact.rows.push({ id: 'wc-1', campaignId: 'wexec-1', prospectId: 'lead-wa-1', status: 'QUEUED', nextSendAt: null });
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.released, 1);
  assert.equal(enqueued[0].channel, 'whatsapp');
  assert.ok(prisma.whatsappCampaignContact.rows[0].nextSendAt, 'marca a alocação do canal WA');
  const debit = prisma.studioReputationEvent.rows.find((e) => e.type === 'debit');
  assert.equal(debit.channel, 'whatsapp', 'débito no canal WhatsApp');
});

// ── FR-37: descadastro nasce no compile (headers RFC 8058 + rodapé) ──────────

test('FR-37: compile de e-mail injeta List-Unsubscribe/Post + rodapé de descadastro', async () => {
  const prisma = createFakePrisma();
  const campaign = { id: 'camp-fr37', orgId: 'org-1', name: 'FR37', objective: null, offer: null, channels: ['email'] };
  const execution = await bridge.ensureEmailExecution(prisma, campaign, {
    subject: 'Oi {{firstName}}',
    emailDoc: { blocks: [{ type: 'text', text: 'Corpo da mensagem.' }] },
    unsubscribeUrl: 'https://b2base.net/u/token-1',
    unsubscribeMailto: 'mailto:unsubscribe@empresa.com?subject=unsubscribe',
  });
  const headers = execution.emailHeaders;
  assert.ok(headers['List-Unsubscribe'].includes('https://b2base.net/u/token-1'), 'URL pública no header');
  assert.ok(headers['List-Unsubscribe'].includes('mailto:'), 'mailto como alternativa');
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', 'one-click RFC 8058');
  assert.ok(execution.emailTemplateBody.includes('Não quer mais receber'), 'rodapé acessível no corpo compilado');
});

// ── AD-13 em ambos os workers: estorno em falha definitiva (e só nela) ───────

test('outreach: contato em estado terminal → estorno idempotente (AD-13)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 99, floor: 0, ceiling: 100, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'verified' });
  prisma.outreachCampaign.rows.push({ id: 'camp-1', tenantId: 'org-1', status: 'active' });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.outreachContact.rows.push({ id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-1', status: 'SCHEDULED', emailAccount_id: 'ea-1' });
  prisma.outreachMessage.rows.push({ id: 'msg-term', contactId: 'ct-1', status: 'SCHEDULED', body: 'x', contact: { campaign: { tenantId: 'org-1', status: 'active' }, emailAccount_id: 'ea-1', status: 'REPLIED' } });

  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(() => ({ add: async () => ({ id: 'j' }), getJob: async () => null }));

  const result = await workers.processSend({ data: { messageId: 'msg-term' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'j1' });
  assert.equal(result.cancelled, true);
  const credit = prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'msg-term');
  assert.ok(credit, 'estorno registrado antes de cancelar');
});

test('outreach: provider falha na ÚLTIMA tentativa → estorna; antes disso NÃO estorna', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 99, floor: 0, ceiling: 100, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'verified' });
  prisma.studioReputationEvent.rows.push({ id: 'ev-d1', orgId: 'org-1', channel: 'email', type: 'debit', amount: 1, balanceAfter: 99, refType: 'batch', refId: 'batch-1' });
  prisma.outreachCampaign.rows.push({ id: 'camp-1', tenantId: 'org-1', status: 'active' });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.outreachContact.rows.push({ id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-1', status: 'SCHEDULED', emailAccount_id: 'ea-1' });
  prisma.outreachMessage.rows.push({ id: 'msg-fail', contactId: 'ct-1', status: 'SCHEDULED', body: 'x', contact: { campaign: { tenantId: 'org-1', status: 'active' }, emailAccount_id: 'ea-1', prospectId: 'lead-1', status: 'SCHEDULED' } });
  prisma.prospect.rows.push({ id: 'lead-1', orgId: 'org-1', cnpjEmail: 'lead@empresa.com' });

  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(() => ({ add: async () => ({ id: 'j' }), getJob: async () => null }));

  // Falha do provider via seam não-destruturado do email-provider.
  const emailProviderMod = require('../email-provider');
  const originalSend = emailProviderMod.sendEmailForAccount;
  emailProviderMod.sendEmailForAccount = async () => {
    throw new Error('SMTP 550 mailbox unavailable');
  };
  try {
    // Tentativa NÃO-final: re-tenta SEM estornar (falha transitória).
    await assert.rejects(
      workers.processSend({ data: { messageId: 'msg-fail' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'j1' }),
      /SMTP 550/
    );
    assert.equal(
      prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit' && e.refId === 'msg-fail').length,
      0,
      'falha transitória não estorna'
    );

    // Última tentativa: falha definitiva → estorna exatamente 1×.
    await assert.rejects(
      workers.processSend({ data: { messageId: 'msg-fail' }, attemptsMade: 2, opts: { attempts: 3 }, id: 'j2' }),
      /SMTP 550/
    );
    const credits = prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit' && e.refId === 'msg-fail');
    assert.equal(credits.length, 1, 'estorno único na falha definitiva');
    assert.equal(prisma.studioReputationAccount.rows[0].balance, 100);
  } finally {
    emailProviderMod.sendEmailForAccount = originalSend;
  }
});

test('whatsapp: contato terminal estorna; provider falho na última penaliza e desperta', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'unified', balance: 20, floor: 0, ceiling: 30, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'unverified' });
  prisma.studioReputationEvent.rows.push({ id: 'ev-wa', orgId: 'org-1', channel: 'whatsapp', type: 'debit', amount: 1, balanceAfter: 20, refType: 'batch', refId: 'batch-wa' });

  // Modelos de WA que o fake-prisma não cobre (mensagem/conversa do motor).
  prisma.whatsAppCampaignContact = {
    rows: [{ id: 'cc-1', campaignId: 'wcamp-1', prospectId: 'lead-1', status: 'QUEUED' }],
    async findUnique({ where }) {
      return this.rows.find((r) => r.id === where.id) || null;
    },
  };
  prisma.whatsAppMessage = {
    rows: [{
      id: 'wmsg-1', orgId: 'org-1', campaignContactId: 'cc-1', conversationId: 'conv-1',
      status: 'PENDING', content: 'oi', contact: null,
      conversation: { id: 'conv-1', chatId: '55119999@c.us', whatsappAccount: { id: 'wacc-1', status: 'CONNECTED', sessionName: 'sess' } },
    }],
    async findUnique({ where }) {
      return this.rows.find((r) => r.id === where.id) || null;
    },
    async update({ where, data }) {
      const row = this.rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };
  prisma.whatsAppConversation = { async update() {} };

  const workers = require('../whatsapp-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests({
    sequence: { add: async () => ({ id: 'j' }) },
    send: { add: async () => ({ id: 'j' }) },
  });

  // 1) Contato terminal → cancela e estorna.
  prisma.whatsAppCampaignContact.rows[0].status = 'REPLIED';
  const cancelled = await workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 0, opts: { attempts: 5 }, id: 'j1' });
  assert.equal(cancelled.cancelled, true);
  assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno do terminal');

  // 2) Provider falho na ÚLTIMA tentativa → estorno + penalize + Despertar.
  prisma.whatsAppCampaignContact.rows[0].status = 'SENDING';
  prisma.whatsAppMessage.rows[0].status = 'PENDING';
  const waha = require('../waha-provider');
  const originalSendText = waha.WAHAWhatsAppProvider.sendText;
  waha.WAHAWhatsAppProvider.sendText = async () => {
    throw new Error('WAHA: número bloqueado');
  };
  try {
    // Tentativa não-final: sem estorno e sem penalização.
    await assert.rejects(
      workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 0, opts: { attempts: 5 }, id: 'j2' }),
      /bloqueado/
    );
    assert.equal(prisma.studioReputationEvent.rows.filter((e) => e.type === 'block').length, 0, 'transitória não penaliza');

    await assert.rejects(
      workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 4, opts: { attempts: 5 }, id: 'j3' }),
      /bloqueado/
    );
    assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno definitivo');
    const block = prisma.studioReputationEvent.rows.find((e) => e.type === 'block');
    assert.ok(block, 'penalização do canal (FR-18)');
    assert.equal(block.refId, 'wmsg-1');
    const wake = prisma.opsNotification.rows.find((n) => n.kind === 'wake');
    assert.ok(wake, 'Despertar de rejeição WhatsApp (FR-31)');
    assert.equal(wake.payload.type, 'studio.whatsapp.rejected');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }
});

test('outreach: checagem de pausa que falha → pause_check_failed (fail-closed)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.organization.findUnique = async () => {
    throw new Error('db connection lost');
  };
  prisma.outreachCampaign.rows.push({ id: 'camp-1', tenantId: 'org-1', status: 'active' });
  prisma.outreachContact.rows.push({ id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-1', status: 'SCHEDULED', emailAccount_id: 'ea-1' });
  prisma.outreachMessage.rows.push({ id: 'msg-px', contactId: 'ct-1', status: 'SCHEDULED', body: 'x', contact: { campaign: { tenantId: 'org-1', status: 'active' }, emailAccount_id: 'ea-1' } });

  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  const enqueued = [];
  workers._setQueueFactoryForTests(() => ({
    add: async (job) => { enqueued.push(job); return { id: 'j' }; },
    getJob: async () => null,
  }));
  const result = await workers.processSend({ data: { messageId: 'msg-px' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'j1' });
  assert.equal(result.paused, 'pause_check_failed');
  assert.equal(enqueued.length, 1, 're-agendado, não perdido');
  assert.equal(prisma.outreachMessage.rows[0].status, 'SCHEDULED', 'nada enviado');
});

test('outreach: orgId ausente → fail-closed, re-agenda sem checar', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.outreachCampaign.rows.push({ id: 'camp-1', status: 'active' }); // sem tenantId
  prisma.outreachContact.rows.push({ id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-1', status: 'SCHEDULED', emailAccount_id: 'ea-1' });
  prisma.outreachMessage.rows.push({ id: 'msg-noorg', contactId: 'ct-1', status: 'SCHEDULED', body: 'x', contact: { campaign: { status: 'active' }, emailAccount_id: 'ea-1' } });

  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  const enqueued = [];
  workers._setQueueFactoryForTests(() => ({
    add: async (job) => { enqueued.push(job); return { id: 'j' }; },
    getJob: async () => null,
  }));
  const result = await workers.processSend({ data: { messageId: 'msg-noorg' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'j1' });
  assert.equal(result.paused, 'pause_check_failed');
  assert.equal(enqueued.length, 1);
});

// ── AC da matriz I/O: "saldo 30, lote 100 → exatamente 30 enfileiradas" ──────
// ÚLTIMO teste do arquivo: recarrega os módulos com STUDIO_REP_FLOOR=0.

test('AC: saldo 30 e lote 100 → exatamente 30 enfileiradas (STUDIO_REP_FLOOR=0)', async () => {
  process.env.STUDIO_REP_FLOOR = '0';
  delete require.cache[require.resolve('../studio/reputation')];
  delete require.cache[require.resolve('../studio/reputation-gate')];
  delete require.cache[require.resolve('../studio/channel-bridge')];
  const freshBridge = require('../studio/channel-bridge');
  try {
    // Sem seed(): a ÚNICA account é a do cenário (saldo 30, piso 0 via env).
    const prisma = createFakePrisma();
    prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
    prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
    prisma.studioReputationAccount.rows.push({ id: 'acc-30', orgId: 'org-1', channel: 'unified', balance: 30, floor: 0, ceiling: 100, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'verified' });
    prisma.studioCampaign.rows.push(campaignFixture());
    const contacts = [];
    for (let i = 1; i <= 100; i++) {
      contacts.push({ id: `oc-${i}`, campaignId: 'exec-1', prospectId: `lead-${i}`, status: 'QUEUED', scheduledAt: null });
    }
    prisma.outreachContact.rows.push(...contacts);
    const enqueued = [];
    const result = await freshBridge.enqueueBatch(prisma, {
      campaign: prisma.studioCampaign.rows[0],
      channel: 'email',
      prospectIds: contacts.map((c) => c.prospectId),
      enqueue: async (channel, ids) => enqueued.push(ids),
    });
    assert.equal(result.granted, 30, 'gate concede exatamente a fatia do saldo');
    assert.equal(result.enqueued.length, 30, 'exatamente 30 enfileiradas');
    assert.equal(enqueued[0].length, 30);
    assert.equal(result.blocked.code, 'SALDO_INSUFICIENTE', 'restante bloqueado com motivo');
    assert.ok(result.blocked.reason.includes('70'), 'explica quanto falta');
    const debit = prisma.studioReputationEvent.rows.find((e) => e.type === 'debit');
    assert.equal(debit.amount, 30, 'débito materializa as 30 unidades');
    assert.equal(prisma.studioReputationAccount.rows[0].balance, 0);
    assert.ok(prisma.outreachContact.rows.filter((c) => c.scheduledAt).length === 30, '30 marcações de alocação');
  } finally {
    delete process.env.STUDIO_REP_FLOOR;
    delete require.cache[require.resolve('../studio/reputation')];
    delete require.cache[require.resolve('../studio/reputation-gate')];
    delete require.cache[require.resolve('../studio/channel-bridge')];
  }
});

// ── QA 2026-10-06: cura de órfãs — alocados sem mensagem voltam à fila ───────

test('enqueueBatch: órfãs alocadas sem mensagem voltam à fila; quem tem mensagem não duplica', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows.push(campaignFixture());
  const alocadoEm = new Date('2026-10-06T17:06:00Z');
  prisma.outreachContact.rows.push(
    // Órfã do skip antigo: alocada às 17:06, mensagem JAMAIS criada.
    { id: 'oc-orfa', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', scheduledAt: alocadoEm },
    // Em voo de verdade: alocada E com mensagem — NÃO pode reentrar.
    { id: 'oc-viva', campaignId: 'exec-1', prospectId: 'lead-2', status: 'SCHEDULED', scheduledAt: alocadoEm }
  );
  prisma.outreachMessage.rows.push({ id: 'msg-viva', contactId: 'oc-viva', status: 'SCHEDULED' });
  const enqueued = [];
  const result = await bridge.enqueueBatch(prisma, {
    campaign: prisma.studioCampaign.rows[0],
    channel: 'email',
    prospectIds: ['lead-1', 'lead-2'],
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.deepEqual(result.enqueued, ['lead-1'], 'órfã realocada; em voo não duplica');
  const orfa = prisma.outreachContact.rows.find((c) => c.id === 'oc-orfa');
  assert.ok(orfa.scheduledAt, 're-alocada pelo lote');
});

test('enqueueBatch: CANCELLED por removido_da_selecao SEM mensagem ressuscita; quem recebeu não', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows.push(campaignFixture());
  prisma.outreachContact.rows.push(
    // Cancelado pelo sync com a audiência antiga — nunca recebeu nada.
    { id: 'oc-morto', campaignId: 'exec-1', prospectId: 'lead-1', status: 'CANCELLED', cancelReason: 'removido_da_selecao', scheduledAt: null },
    // Cancelado DEPOIS de enviar — descartado de verdade.
    { id: 'oc-enviou', campaignId: 'exec-1', prospectId: 'lead-2', status: 'CANCELLED', cancelReason: 'removido_da_selecao', scheduledAt: null }
  );
  prisma.outreachMessage.rows.push({ id: 'msg-enviada', contactId: 'oc-enviou', status: 'SENT' });
  const enqueued = [];
  const result = await bridge.enqueueBatch(prisma, {
    campaign: prisma.studioCampaign.rows[0],
    channel: 'email',
    prospectIds: ['lead-1', 'lead-2'],
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.deepEqual(result.enqueued, ['lead-1'], 'só o que nunca recebeu volta');
  const morto = prisma.outreachContact.rows.find((c) => c.id === 'oc-morto');
  assert.equal(morto.status, 'QUEUED', 'ressuscitado');
  assert.equal(morto.cancelReason, null, 'motivo limpo');
  const enviou = prisma.outreachContact.rows.find((c) => c.id === 'oc-enviou');
  assert.equal(enviou.status, 'CANCELLED', 'quem já recebeu permanece descartado');
});

test('enqueueBatch WA: órfãs alocadas sem mensagem voltam à fila do WhatsApp', async () => {
  const prisma = seed(createFakePrisma());
  prisma.whatsappAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', status: 'CONNECTED' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'unified', balance: 50, floor: 10, ceiling: 50, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'unverified' });
  prisma.studioCampaign.rows.push(campaignFixture({ channels: ['whatsapp'], emailExecutionId: null, whatsappExecutionId: 'exec-1' }));
  prisma.whatsAppCampaignContact.rows.push(
    // Órfã: alocada ontem (nextSendAt vencido), job JAMAIS enfileirado.
    { id: 'wcc-orfa', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', nextSendAt: new Date('2026-10-06T19:10:00Z') }
  );
  const enqueued = [];
  const result = await bridge.enqueueBatch(prisma, {
    campaign: prisma.studioCampaign.rows[0],
    channel: 'whatsapp',
    prospectIds: ['lead-1'],
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.deepEqual(result.enqueued, ['lead-1'], 'órfã WA realocada');
  assert.ok(
    prisma.whatsAppCampaignContact.rows.find((c) => c.id === 'wcc-orfa').nextSendAt,
    're-alocada pelo lote'
  );
});

// ── 2026-10-08: cura de no_phone no reforço — lead ganhou telefone, volta ────

test('enqueueBatch WA: CANCELLED por no_phone ressuscita quando o lead GANHA telefone (com consentimento)', async () => {
  const prisma = seed(createFakePrisma());
  prisma.whatsappAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', status: 'CONNECTED' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'unified', balance: 50, floor: 0, ceiling: 50, rampStage: 0, emailSentToday: 0, whatsappSentToday: 0, usageDay: null, domainAuthStatus: 'verified' });
  prisma.studioCampaign.rows.push(campaignFixture({ channels: ['whatsapp'], emailExecutionId: null, whatsappExecutionId: 'exec-1' }));
  // Dois contatos cancelados por no_phone no lançamento original (sem telefone na época).
  prisma.whatsAppCampaignContact.rows.push(
    { id: 'wcc-fone', campaignId: 'exec-1', prospectId: 'lead-1', status: 'CANCELLED', cancelReason: 'no_phone' },
    { id: 'wcc-semtel', campaignId: 'exec-1', prospectId: 'lead-2', status: 'CANCELLED', cancelReason: 'no_phone' }
  );
  // lead-1 GANHOU telefone (e tem consentimento); lead-2 continua sem número.
  prisma.prospect.rows.push(
    { id: 'lead-1', orgId: 'org-1', cnpjPhones: ['5512982007955'] },
    { id: 'lead-2', orgId: 'org-1', cnpjPhones: [] }
  );
  prisma.studioLeadConsent.rows.push({ id: 'cons-1', orgId: 'org-1', prospectId: 'lead-1', channel: 'whatsapp', source: 'chat' });

  const enqueued = [];
  const result = await bridge.enqueueBatch(prisma, {
    campaign: prisma.studioCampaign.rows[0],
    channel: 'whatsapp',
    prospectIds: ['lead-1', 'lead-2'],
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.deepEqual(result.enqueued, ['lead-1'], 'só quem TEM telefone + consentimento volta à fila');
  const revived = prisma.whatsAppCampaignContact.rows.find((r) => r.id === 'wcc-fone');
  assert.equal(revived.status, 'QUEUED', 'ressuscitado');
  assert.equal(revived.cancelReason, null, 'motivo limpo');
  const still = prisma.whatsAppCampaignContact.rows.find((r) => r.id === 'wcc-semtel');
  assert.equal(still.status, 'CANCELLED', 'sem telefone continua fora');
  assert.equal(still.cancelReason, 'no_phone');
});
