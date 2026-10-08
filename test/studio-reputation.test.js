'use strict';

/**
 * test/studio-reputation.test.js — SALDO ÚNICO de envios (specs/011, AD-3;
 * unificação e-mail+WhatsApp de 2026-10-08). O writer único muta saldo SÓ na
 * mesma transação do evento do ledger; estorno é idempotente por refId
 * (unique (type, refId)); saldo nunca negativo; os dois canais consomem o
 * MESMO pool e cada um tem teto diário de ritmo (caps por estágio de rampa).
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const reputation = require('../studio/reputation');

/** Conta única da org (fixture no formato novo). */
function walletAccount(prisma, overrides = {}) {
  prisma.studioReputationAccount.rows.push({
    id: 'acc-1', orgId: 'org-1', channel: 'unified',
    balance: 100, floor: 10, ceiling: 100, rampStage: 0,
    emailSentToday: 0, whatsappSentToday: 0, usageDay: null,
    domainAuthStatus: 'verified', domainAuthDetail: {},
    ...overrides,
  });
  return prisma.studioReputationAccount.rows[0];
}

test('débito no POOL ÚNICO: UPDATE condicional concede a fatia e grava o evento com o rótulo do canal (AD-3/AD-4)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma);

  const result = await reputation.debit(prisma, {
    orgId: 'org-1', channel: 'email', amount: 30, refType: 'batch', refId: 'batch-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.granted, 30);
  assert.equal(result.balance, 70, 'saldo único debitado na account');
  assert.equal(result.cap, reputation.capFor('email', 0), 'cap diário do canal no estágio');
  const event = prisma.studioReputationEvent.rows.find((e) => e.refId === 'batch-1');
  assert.ok(event, 'evento do ledger presente');
  assert.equal(event.type, 'debit');
  assert.equal(event.amount, 30);
  assert.equal(event.channel, 'email', 'rótulo do canal do disparo (auditoria)');
  assert.equal(event.balanceAfter, 70, 'auditoria FR-20: saldo resultante no evento');
});

test('POOL COMPARTILHADO: débito por e-mail e por WhatsApp consomem o MESMO saldo', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 50 });

  const email = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 10, refId: 'b-email' });
  const wa = await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 10, refId: 'b-wa' });
  assert.equal(email.ok && wa.ok, true);
  assert.equal(email.balance, 40, 'e-mail drenou o pool');
  assert.equal(wa.balance, 30, 'WhatsApp drenou o MESMO pool');
  assert.equal(prisma.studioReputationAccount.rows.length, 1, 'uma account só por org');
  const wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 30);
  assert.equal(wallet.usedToday.email, 10);
  assert.equal(wallet.usedToday.whatsapp, 10, 'uso do dia separado por canal');
});

test('débito idempotente por refId: o mesmo lote nunca debita 2× (AD-13)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma);

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
  walletAccount(prisma, { balance: 30 });

  const result = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 100, refId: 'batch-big' });
  assert.equal(result.ok, true, 'fatia concedida (fatiamento é lei — matriz I/O)');
  assert.equal(result.granted, 20, 'saldo efetivo = balance − floor');
  assert.equal(result.deficit, 80, 'quanto falta (FR-15)');
  assert.equal(result.limitBinding, 'balance', 'o eixo que limitou foi o saldo');
  assert.ok(result.availableAt, 'quando libera (FR-15)');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 10, 'para no floor — nunca negativo');
});

test('CAP DIÁRIO: WhatsApp (30/dia no estágio 0) bloqueia com saldo sobrando — LIMITE_DIARIO_CANAL', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 100 });

  const first = await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 30, refId: 'b-1' });
  assert.equal(first.granted, 30, 'cap cobre o lote inteiro');
  assert.equal(first.limitBinding, null);

  const over = await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 5, refId: 'b-2' });
  assert.equal(over.ok, false, 'cap cheio bloqueia MESMO com saldo');
  assert.equal(over.code, 'LIMITE_DIARIO_CANAL');
  assert.equal(over.available, 60, 'saldo único continua lá (70 − piso 10 de efetivo)');
  assert.equal(over.cap, 30);
  assert.equal(over.capUsed, 30);
  // O mesmo pedido pelo E-MAIL passa — o cap é POR CANAL, o pool é um:
  const email = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 5, refId: 'b-3' });
  assert.equal(email.ok, true);
});

test('CAP DIÁRIO: partial grant na borda do cap (pedido 40, restam 30)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 100 });

  const result = await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 40, refId: 'b-cap' });
  assert.equal(result.ok, true);
  assert.equal(result.granted, 30, 'concede até o cap');
  assert.equal(result.deficit, 10);
  assert.equal(result.limitBinding, 'cap');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 70);
  assert.equal(prisma.studioReputationAccount.rows[0].whatsappSentToday, 30);
});

test('reset lazy do contador: dia novo, cap novo (usageDay)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 100, whatsappSentToday: 30, usageDay: '2026-10-07' });

  const nextDay = await reputation.debit(prisma, {
    orgId: 'org-1', channel: 'whatsapp', amount: 5, refId: 'b-dia2', now: new Date('2026-10-08T10:00:00Z'),
  });
  assert.equal(nextDay.ok, true, 'dia virou → cap zerou');
  assert.equal(nextDay.capUsed, 5);
  const row = prisma.studioReputationAccount.rows[0];
  assert.equal(row.whatsappSentToday, 5, 'contador substituído (não incrementado sobre o dia velho)');
  assert.equal(row.usageDay, '2026-10-08');
});

test('DNS deixa de ser matemática de saldo: conta unverified debita o pool (o GATE bloqueia o e-mail)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { domainAuthStatus: 'unverified' });

  const result = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 5, refId: 'b-1' });
  assert.equal(result.ok, true, 'o writer não trava por domínio — quem bloqueia é o gate (com instrução)');
  const wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.available, 85, 'saldo efetivo independe do DNS agora (95 − piso 10)');
});

test('estorno de envio: credit idempotente por messageId (AD-13) — credita o pool', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 50 });
  await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 1, refId: 'batch-1' });

  const first = await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'whatsapp', messageId: 'msg-1', reason: 'falha definitiva' });
  const retry = await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'whatsapp', messageId: 'msg-1', reason: 'retry do worker' });

  assert.equal(first.ok, true);
  assert.equal(first.credited, 1);
  assert.equal(retry.replayed, true, 'retry/requeue do worker não estorna 2×');
  assert.equal(retry.credited, 0);
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 50, 'saldo restaurado exatamente 1x');
  const credit = prisma.studioReputationEvent.rows.find((e) => e.type === 'credit');
  assert.equal(credit.refType, 'send');
  assert.equal(credit.refId, 'msg-1');
});

test('compra Stripe (top-up) credita o POOL — e sessão LEGADA com canal antigo também', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 20 });

  const topup = await reputation.credit(prisma, {
    orgId: 'org-1', channel: 'unified', amount: 100, refType: 'topup', refId: 'topup:s1',
  });
  assert.equal(topup.credited, 100);
  // Legado: webhook de sessão comprada antes da unificação (channel 'email')
  const legacy = await reputation.credit(prisma, {
    orgId: 'org-1', channel: 'email', amount: 50, refType: 'topup', refId: 'topup:s2',
  });
  assert.equal(legacy.credited, 50);
  const wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 170, 'tudo foi para o MESMO pool');
});

test('reposição diária da carteira: idempotente por dia e respeita o teto (FR-17)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 95, ceiling: 100 });

  const day1 = await reputation.applyDailyReplenishment(prisma, 'org-1', new Date('2026-09-26T10:00:00Z'));
  assert.equal(day1.credited, 5, 'só o headroom até o teto');
  const day2 = await reputation.applyDailyReplenishment(prisma, 'org-1', new Date('2026-09-26T22:00:00Z'));
  assert.equal(day2.credited, 0, 'mesmo dia não repõe 2× (teto atingido)');

  const events = prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit');
  assert.equal(events.length, 1);
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 100, 'teto respeitado');
});

test('CAPS por canal são diferentes e o WhatsApp é conservador (FR-18 no mundo unificado)', () => {
  const emailMax = reputation.CHANNEL_CAP_RAMPS.email.at(-1);
  const waMax = reputation.CHANNEL_CAP_RAMPS.whatsapp.at(-1);
  assert.ok(waMax < emailMax, 'WhatsApp nunca tem cap maior que e-mail');
  assert.equal(reputation.capFor('whatsapp', 0), 30);
  assert.equal(reputation.capFor('whatsapp', 2), 80);
  assert.equal(reputation.capFor('email', 3), 800);
  assert.throws(() => reputation.capFor('sms', 0), /não suportado/i);
});

test('penalize: rejeição/bloqueio WhatsApp drena o POOL com evento de bloqueio (FR-18/FR-14)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 30, floor: 5 });

  const result = await reputation.penalize(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 10, reason: 'mensagem rejeitada', refId: 'wa-1' });
  assert.equal(result.penalized, 10);
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 20);
  const block = prisma.studioReputationEvent.rows.find((e) => e.type === 'block');
  assert.ok(block, 'evento append-only do bloqueio');
  const again = await reputation.penalize(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 10, reason: 'retry', refId: 'wa-1' });
  assert.equal(again.penalized, 0, 'mesma ocorrência não pune 2×');
});

test('promoteRamp: sobe estágio → teto da carteira E caps dos dois canais crescem (nunca desce)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma);

  await reputation.promoteRamp(prisma, 'org-1');
  let row = prisma.studioReputationAccount.rows[0];
  assert.equal(row.rampStage, 1);
  assert.equal(row.ceiling, 200);
  let wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.caps.email, 200);
  assert.equal(wallet.caps.whatsapp, 50);

  await reputation.promoteRamp(prisma, 'org-1');
  await reputation.promoteRamp(prisma, 'org-1');
  await reputation.promoteRamp(prisma, 'org-1');
  row = prisma.studioReputationAccount.rows[0];
  assert.equal(row.rampStage, 3, 'estágio máximo');
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.caps.whatsapp, 80, 'cap do WA para no último estágio da rampa dele');
});

test('ensureAccount: org nova começa com a carteira conservadora (FR-17) e é idempotente', async () => {
  const prisma = createFakePrisma();
  const first = await reputation.ensureAccount(prisma, 'org-9');
  const second = await reputation.ensureAccount(prisma, 'org-9');
  assert.equal(first.balance, reputation.WALLET_POLICY.startBalance);
  assert.equal(first.channel, 'unified');
  assert.equal(second.id, first.id, 'mesma account (unique orgId+channel)');
  assert.equal(prisma.studioReputationAccount.rows.length, 1);
});

test('canal de disparo inválido: débito rejeita explícito (caps só existem p/ email e whatsapp)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma);
  await assert.rejects(() => reputation.debit(prisma, { orgId: 'org-1', channel: 'tiktok', amount: 1, refId: 'b-1' }), /não suportado/i);
  assert.equal(prisma.studioReputationAccount.rows.length, 1);
});

test('piso configurável: STUDIO_REP_FLOOR=0 deixa o saldo efetivo = saldo (AC 30/100)', () => {
  const account = { channel: 'unified', balance: 30, floor: 0, domainAuthStatus: 'verified' };
  assert.equal(reputation.effectiveBalance(account), 30, 'floor 0 não drena a fatia');
});

test('recordDomainAuth aceita estado prewarmed (FR-17/FR-28) na account única', async () => {
  const prisma = createFakePrisma();
  await reputation.ensureAccount(prisma, 'org-1');
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'prewarmed', detail: { declared: true } });
  assert.equal(prisma.studioReputationAccount.rows[0].domainAuthStatus, 'prewarmed');
  const wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.available, wallet.balance - wallet.floor, 'prewarmed não toca o saldo');
});

test('recordDomainAuth com history responde o piso do POOL: penalizado mínimo, pré-aquecido elevado (FR-28)', async () => {
  const prisma = createFakePrisma();
  await reputation.ensureAccount(prisma, 'org-1');
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'unverified', history: 'penalizado' });
  assert.equal(prisma.studioReputationAccount.rows[0].floor, 0, 'penalizado → piso mínimo');
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'unverified', history: 'pre-aquecido' });
  assert.equal(
    prisma.studioReputationAccount.rows[0].floor,
    reputation.WALLET_POLICY.floor * 4,
    'pré-aquecido → piso elevado (override sob responsabilidade do cliente)'
  );
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'unverified', history: 'novo' });
  assert.equal(prisma.studioReputationAccount.rows[0].floor, reputation.WALLET_POLICY.floor);
});

test('getWallet: sinal de saldo baixo = ≤ 25% do teto (pop-up do dono, 2026-10-08)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 90, ceiling: 100 });
  let wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.lowBalance, false, '90 > 25% de 100');
  assert.equal(wallet.threshold, 25);

  await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 70, refId: 'b-low' });
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 20);
  assert.equal(wallet.lowBalance, true, '20 ≤ 25 → pop-up de compra aparece');
});

test('painel de saldo: cada variação é atribuível a um evento listado (FR-20)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma);
  await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 5, refId: 'b-1', reason: 'lote da campanha X' });
  await reputation.credit(prisma, { orgId: 'org-1', channel: 'unified', amount: 5, refType: 'ramp', refId: 'ramp:dia', reason: 'reposição' });

  const events = await reputation.listEvents(prisma, 'org-1');
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.reason), 'todo evento tem explicação');
  const wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 100);
});
