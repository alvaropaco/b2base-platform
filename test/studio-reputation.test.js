'use strict';

/**
 * test/studio-reputation.test.js — Orçamento de Reputação (specs/011, AD-3;
 * FR-14/FR-17/FR-18/FR-20). O writer único muta saldo SÓ na mesma transação
 * do evento do ledger; estorno é idempotente por refId (unique (type, refId));
 * saldo nunca negativo; floor efetivo responde à autenticação de domínio.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const reputation = require('../studio/reputation');

function verifiedAccount(prisma, overrides = {}) {
  prisma.studioReputationAccount.rows.push({
    id: 'acc-1', orgId: 'org-1', channel: 'email',
    balance: 100, floor: 10, ceiling: 100, rampStage: 0,
    domainAuthStatus: 'verified', domainAuthDetail: {},
    ...overrides,
  });
  return prisma.studioReputationAccount.rows[0];
}

test('débito: UPDATE condicional concede a fatia que o saldo cobre e grava o evento (AD-3/AD-4)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma);

  const result = await reputation.debit(prisma, {
    orgId: 'org-1', channel: 'email', amount: 30, refType: 'batch', refId: 'batch-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.granted, 30);
  assert.equal(result.balance, 70, 'saldo debitado na account');
  const event = prisma.studioReputationEvent.rows.find((e) => e.refId === 'batch-1');
  assert.ok(event, 'evento do ledger presente');
  assert.equal(event.type, 'debit');
  assert.equal(event.amount, 30);
  assert.equal(event.balanceAfter, 70, 'auditoria FR-20: saldo resultante no evento');
});

test('débito idempotente por refId: o mesmo lote nunca debita 2× (AD-13)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma);

  const first = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 10, refId: 'batch-x' });
  const second = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 10, refId: 'batch-x' });
  assert.equal(first.granted, 10);
  assert.equal(second.replayed, true, '2ª chamada é replay');
  assert.equal(second.granted, 0, 'replay não debita de novo');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 90, 'saldo debitado 1x');
  assert.equal(prisma.studioReputationEvent.rows.length, 1, 'um evento só');
});

test('saldo nunca negativo: débito maior que o disponível concede a fatia e explica o resto (FR-15)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma, { balance: 30 });

  const result = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 100, refId: 'batch-big' });
  assert.equal(result.ok, true, 'fatia concedida (fatiamento é lei — matriz I/O)');
  assert.equal(result.granted, 20, 'saldo efetivo = balance − floor');
  assert.equal(result.deficit, 80, 'quanto falta (FR-15)');
  assert.ok(result.availableAt, 'quando libera (FR-15)');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 10, 'para no floor — nunca negativo');
  assert.ok(result.balance >= 0);
});

test('domínio não verificado → saldo EFETIVO zero (FR-16/AD-8)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma, { domainAuthStatus: 'unverified' });

  const balance = await reputation.getBalance(prisma, 'org-1', 'email');
  assert.equal(balance.available, 0, 'nada disponível até verificar');
  assert.equal(balance.floor, 100, 'floor efetivo congela o saldo inteiro');

  const result = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 1, refId: 'b-1' });
  assert.equal(result.ok, false, 'gate bloqueia com instrução (fail-closed do warm-up)');
});

test('verificação verde libera o saldo da regra (FR-16)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma, { domainAuthStatus: 'unverified' });

  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'verified', detail: { spf: true, dkim: true } });
  const balance = await reputation.getBalance(prisma, 'org-1', 'email');
  assert.equal(balance.available, 90, 'floor configurado volta a valer');
});

test('estorno de envio: credit idempotente por messageId (AD-13)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma, { balance: 50 });
  await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 1, refId: 'batch-1' });

  const first = await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'email', messageId: 'msg-1', reason: 'falha definitiva' });
  const retry = await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'email', messageId: 'msg-1', reason: 'falha definitiva (retry do worker)' });

  assert.equal(first.ok, true);
  assert.equal(first.credited, 1);
  assert.equal(retry.replayed, true, 'retry/requeue do worker não estorna 2×');
  assert.equal(retry.credited, 0);
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 50, 'saldo restaurado exatamente 1x');
  const credit = prisma.studioReputationEvent.rows.find((e) => e.type === 'credit');
  assert.equal(credit.refType, 'send');
  assert.equal(credit.refId, 'msg-1');
});

test('reposição diária de warm-up: idempotente por dia e respeita o teto (FR-17)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma, { balance: 95, ceiling: 100 });

  const day1 = await reputation.applyDailyReplenishment(prisma, 'org-1', 'email', new Date('2026-09-26T10:00:00Z'));
  assert.equal(day1.credited, 5, 'só o headroom até o teto');
  const day2 = await reputation.applyDailyReplenishment(prisma, 'org-1', 'email', new Date('2026-09-26T22:00:00Z'));
  assert.equal(day2.credited, 0, 'mesmo dia não repõe 2× (teto atingido)');

  const events = prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit');
  assert.equal(events.length, 1);
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 100, 'teto respeitado');
});

test('WhatsApp é conservador: rampa e teto menores que e-mail (FR-18)', () => {
  assert.ok(reputation.CHANNEL_POLICY.whatsapp.startBalance < reputation.CHANNEL_POLICY.email.startBalance);
  assert.ok(reputation.CHANNEL_POLICY.whatsapp.rampStages.at(-1) < reputation.CHANNEL_POLICY.email.rampStages.at(-1));
});

test('penalize: sinal de rejeição/bloqueio reduz o saldo com evento de bloqueio (FR-18/FR-14)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma, { channel: 'whatsapp', balance: 30, floor: 5 });

  const result = await reputation.penalize(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 10, reason: 'mensagem rejeitada', refId: 'wa-1' });
  assert.equal(result.penalized, 10);
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 20);
  const block = prisma.studioReputationEvent.rows.find((e) => e.type === 'block');
  assert.ok(block, 'evento append-only do bloqueio');
  const again = await reputation.penalize(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 10, reason: 'retry', refId: 'wa-1' });
  assert.equal(again.penalized, 0, 'mesma ocorrência não pune 2×');
});

test('promoteRamp: engajamento positivo sobe o estágio/teto da rampa — nunca desce (FR-17)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma);

  await reputation.promoteRamp(prisma, 'org-1', 'email');
  assert.equal(prisma.studioReputationAccount.rows[0].rampStage, 1);
  assert.equal(prisma.studioReputationAccount.rows[0].ceiling, 200);

  await reputation.promoteRamp(prisma, 'org-1', 'email');
  await reputation.promoteRamp(prisma, 'org-1', 'email');
  const last = await reputation.promoteRamp(prisma, 'org-1', 'email');
  void last;
  assert.equal(prisma.studioReputationAccount.rows[0].rampStage, 3, 'estágio máximo');
});

test('ensureAccount: org nova começa com saldo conservador (FR-17) e é idempotente', async () => {
  const prisma = createFakePrisma();
  const first = await reputation.ensureAccount(prisma, 'org-9', 'email');
  const second = await reputation.ensureAccount(prisma, 'org-9', 'email');
  assert.equal(first.balance, reputation.CHANNEL_POLICY.email.startBalance);
  assert.equal(second.id, first.id, 'mesma account (unique orgId+channel)');
  assert.equal(prisma.studioReputationAccount.rows.length, 1);
});

test('canal inválido: NUNCA cria account com rampa de e-mail — rejeita explícito', async () => {
  const prisma = createFakePrisma();
  await assert.rejects(() => reputation.ensureAccount(prisma, 'org-1', 'tiktok'), /não suportado/i);
  assert.throws(() => reputation.channelPolicy('sms'), /não suportado/i);
  assert.equal(prisma.studioReputationAccount.rows.length, 0, 'nenhuma account criada');
});

test('piso configurável: STUDIO_REP_FLOOR=0 deixa o saldo efetivo = saldo (AC 30/100)', () => {
  const account = { channel: 'email', balance: 30, floor: 0, domainAuthStatus: 'verified' };
  assert.equal(reputation.effectiveBalance(account), 30, 'floor 0 não drena a fatia');
});

test('recordDomainAuth aceita estado prewarmed (FR-17/FR-28) — floor volta a valer sem DNS', async () => {
  const prisma = createFakePrisma();
  await reputation.ensureAccount(prisma, 'org-1', 'email');
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'prewarmed', detail: { declared: true } });
  assert.equal(prisma.studioReputationAccount.rows[0].domainAuthStatus, 'prewarmed');
  const balance = await reputation.getBalance(prisma, 'org-1', 'email');
  assert.equal(balance.available, balance.balance - balance.floor, 'prewarmed não congela o saldo');
});

test('recordDomainAuth com history responde o piso: penalizado mínimo, pré-aquecido elevado (FR-28)', async () => {
  const prisma = createFakePrisma();
  await reputation.ensureAccount(prisma, 'org-1', 'email');
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'unverified', history: 'penalizado' });
  assert.equal(prisma.studioReputationAccount.rows[0].floor, 0, 'penalizado → piso mínimo');
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'unverified', history: 'pre-aquecido' });
  assert.equal(
    prisma.studioReputationAccount.rows[0].floor,
    reputation.CHANNEL_POLICY.email.floor * 4,
    'pré-aquecido → piso elevado (override sob responsabilidade do cliente)'
  );
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'unverified', history: 'novo' });
  assert.equal(prisma.studioReputationAccount.rows[0].floor, reputation.CHANNEL_POLICY.email.floor);
});

test('painel de saldo: cada variação é atribuível a um evento listado (FR-20)', async () => {
  const prisma = createFakePrisma();
  verifiedAccount(prisma);
  await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 5, refId: 'b-1', reason: 'lote da campanha X' });
  await reputation.credit(prisma, { orgId: 'org-1', channel: 'email', amount: 5, refType: 'ramp', refId: 'ramp:dia', reason: 'reposição' });

  const events = await reputation.listEvents(prisma, 'org-1', { channel: 'email' });
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.reason), 'todo evento tem explicação');
  const account = await reputation.getBalance(prisma, 'org-1', 'email');
  assert.equal(account.balance, 100);
});
