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

test('CAP DIÁRIO (STUDIO_REP_DAILY_CAP): WhatsApp com cap fixo 30 bloqueia com saldo sobrando — LIMITE_DIARIO_CANAL', async () => {
  const savedCap = process.env.STUDIO_REP_DAILY_CAP;
  process.env.STUDIO_REP_DAILY_CAP = '30';
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
  assert.equal(email.ok, true, 'contador é POR CANAL — e-mail zera o dia dele');
  if (savedCap === undefined) delete process.env.STUDIO_REP_DAILY_CAP;
  else process.env.STUDIO_REP_DAILY_CAP = savedCap;
});

test('CAP DIÁRIO (STUDIO_REP_DAILY_CAP): partial grant na borda do cap (pedido 40, restam 30)', async () => {
  const savedCap = process.env.STUDIO_REP_DAILY_CAP;
  process.env.STUDIO_REP_DAILY_CAP = '30';
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 100 });

  const result = await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 40, refId: 'b-cap' });
  assert.equal(result.ok, true);
  assert.equal(result.granted, 30, 'concede até o cap');
  assert.equal(result.deficit, 10);
  assert.equal(result.limitBinding, 'cap');
  assert.equal(prisma.studioReputationAccount.rows[0].balance, 70);
  assert.equal(prisma.studioReputationAccount.rows[0].whatsappSentToday, 30);
  if (savedCap === undefined) delete process.env.STUDIO_REP_DAILY_CAP;
  else process.env.STUDIO_REP_DAILY_CAP = savedCap;
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

test('reset lazy ZERA TAMBÉM o contador do OUTRO canal — o cap fantasma 30/30 do WhatsApp (2026-10-19)', async () => {
  // Bug real de produção: 30 WhatsApp num dia antigo + débito de e-mail hoje
  // virava o usageDay SEM zerar whatsappSentToday → WhatsApp bloqueado 30/30
  // sem 1 envio real no dia (ledger sem nenhum débito de WhatsApp).
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 200, whatsappSentToday: 30, emailSentToday: 0, usageDay: '2026-10-16' });

  const nextDay = await reputation.debit(prisma, {
    orgId: 'org-1', channel: 'email', amount: 10, refId: 'b-email-hoje', now: new Date('2026-10-19T12:00:00Z'),
  });
  assert.equal(nextDay.ok, true, 'e-mail debita normal e vira o usageDay');
  const row = prisma.studioReputationAccount.rows[0];
  assert.equal(row.usageDay, '2026-10-19');
  assert.equal(row.emailSentToday, 10);
  assert.equal(row.whatsappSentToday, 0, 'contador do WhatsApp zerou junto — sem cap fantasma');

  // E o WhatsApp do dia volta a ter o teto inteiro.
  const wa = await reputation.debit(prisma, {
    orgId: 'org-1', channel: 'whatsapp', amount: 30, refId: 'b-wa-hoje', now: new Date('2026-10-19T12:05:00Z'),
  });
  assert.equal(wa.ok, true, 'WhatsApp consegue debitar o teto cheio do dia');
  assert.equal(wa.capUsed, 30);
});

test('DNS deixa de ser matemática de saldo: conta unverified debita o pool (o GATE bloqueia o e-mail)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { domainAuthStatus: 'unverified' });

  const result = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 5, refId: 'b-1' });
  assert.equal(result.ok, true, 'o writer não trava por domínio — quem bloqueia é o gate (com instrução)');
  const wallet = await reputation.getWallet(prisma, 'org-1');
  // Piso legado (10) é normalizado para 0 na leitura: o dono vê e gasta o
  // saldo CHEIO (2026-10-16 — "o valor ainda não está correto").
  assert.equal(wallet.available, 95, 'disponível = saldo cheio (piso legado normalizado)');
  assert.equal(wallet.floor, 0);
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

test('estorno DEVOLVE a fatia do cap diário — falha definitiva não consome o ritmo do dia', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 100 });
  const before = await reputation.getWallet(prisma, 'org-1');

  // Teto cheio de WhatsApp (30 no estágio 0)…
  const grant = await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 30, refId: 'b-cheio' });
  assert.equal(grant.ok, true);
  let wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.usedToday.whatsapp, 30, 'teto consumido');

  // …2 envios falham definitivamente → estorno devolve saldo E fatia do cap.
  await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'whatsapp', messageId: 'm-1', reason: 'provider falhou' });
  await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'whatsapp', messageId: 'm-2', reason: 'provider falhou' });
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.usedToday.whatsapp, 28, 'cap diário devolvido (não fica 30/30 fantasma)');

  // Retry do MESMO estorno (replay) não devolve 2×.
  await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'whatsapp', messageId: 'm-1', reason: 'retry' });
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.usedToday.whatsapp, 28, 'replay não devolve cap 2×');

  // Piso respeitado: nunca fica negativo.
  for (let i = 0; i < 40; i++) {
    await reputation.refundSend(prisma, { orgId: 'org-1', channel: 'whatsapp', messageId: `m-x${i}`, reason: 'estorno em massa' });
  }
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.usedToday.whatsapp, 0, 'contador para em 0 (nunca negativo)');
  assert.equal(before.usedToday.whatsapp, 0);
});

test('refundBatch devolve saldo E fatia do cap — sync/cancelamento fecha o cap fantasma (AD-13)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 100 });

  const grant = await reputation.debit(prisma, { orgId: 'org-1', channel: 'whatsapp', amount: 10, refId: 'b-1' });
  assert.equal(grant.ok, true);
  let wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.usedToday.whatsapp, 10, 'cap consumido pelo lote');

  // 4 unidades não enviadas estornadas na sincronização da fila…
  const first = await reputation.refundBatch(prisma, {
    orgId: 'org-1', channel: 'whatsapp', batchId: 'sync:camp-1:whatsapp:ct-1', units: 4, reason: 'saiu da seleção',
  });
  assert.equal(first.ok, true);
  assert.equal(first.credited, 4);
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 94, 'saldo devolvido ao pool');
  assert.equal(wallet.usedToday.whatsapp, 6, 'fatia do cap devolvida junto');

  // …replay do MESMO refId não credita nem devolve cap 2×.
  const replay = await reputation.refundBatch(prisma, {
    orgId: 'org-1', channel: 'whatsapp', batchId: 'sync:camp-1:whatsapp:ct-1', units: 4, reason: 'retry do sync',
  });
  assert.equal(replay.replayed, true);
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 94, 'replay não credita 2×');
  assert.equal(wallet.usedToday.whatsapp, 6, 'replay não devolve cap 2×');
});

test('refundBatch após a virada do dia: saldo credita, cap inerte (contador já zerou sozinho)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 50, whatsappSentToday: 10, usageDay: '2026-10-18' });

  const result = await reputation.refundBatch(prisma, {
    orgId: 'org-1', channel: 'whatsapp', batchId: 'cancel:camp-2:whatsapp', units: 5, reason: 'cancelamento com fila restante',
  });
  assert.equal(result.ok, true);
  assert.equal(result.credited, 5);
  const row = prisma.studioReputationAccount.rows[0];
  assert.equal(row.balance, 55, 'saldo do pool sempre credita');
  assert.equal(row.whatsappSentToday, 10, 'contador do dia velho intocado — _returnDailyCap inerte');
});

test('refundBatch devolve o cap do canal E-MAIL: emailSentToday devolvido, replay não devolve 2×', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma, { balance: 200 });

  const grant = await reputation.debit(prisma, { orgId: 'org-1', channel: 'email', amount: 10, refId: 'b-email-1' });
  assert.equal(grant.ok, true);
  let wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.usedToday.email, 10, 'cap de e-mail consumido pelo lote');

  const first = await reputation.refundBatch(prisma, {
    orgId: 'org-1', channel: 'email', batchId: 'cancel:camp-3:email', units: 4, reason: 'fila restante no cancelamento',
  });
  assert.equal(first.ok, true);
  assert.equal(first.credited, 4);
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 194, 'saldo devolvido ao pool');
  assert.equal(wallet.usedToday.email, 6, 'emailSentToday devolvido junto');

  const replay = await reputation.refundBatch(prisma, {
    orgId: 'org-1', channel: 'email', batchId: 'cancel:camp-3:email', units: 4, reason: 'retry do cancelamento',
  });
  assert.equal(replay.replayed, true);
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.balance, 194, 'replay não credita 2×');
  assert.equal(wallet.usedToday.email, 6, 'replay não devolve cap 2×');
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

test('CAPS: ILIMITADOS por padrão (diretriz do dono 2026-10-21); STUDIO_REP_DAILY_CAP fixa um teto único', () => {
  const savedCap = process.env.STUDIO_REP_DAILY_CAP;
  delete process.env.STUDIO_REP_DAILY_CAP;
  try {
    assert.equal(reputation.capsUnlimited(), true, 'padrão do produto: disparos ilimitados');
    assert.equal(reputation.capFor('whatsapp', 0), Number.MAX_SAFE_INTEGER, 'cap nunca é o eixo limitante');
    assert.equal(reputation.capFor('email', 3), Number.MAX_SAFE_INTEGER);
    assert.throws(() => reputation.capFor('sms', 0), /não suportado/i);

    process.env.STUDIO_REP_DAILY_CAP = '500';
    assert.equal(reputation.capsUnlimited(), false, 'operador reativou o teto');
    assert.equal(reputation.capFor('email', 0), 500, 'teto fixo vale para os DOIS canais');
    assert.equal(reputation.capFor('whatsapp', 2), 500);
  } finally {
    if (savedCap === undefined) delete process.env.STUDIO_REP_DAILY_CAP;
    else process.env.STUDIO_REP_DAILY_CAP = savedCap;
  }
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

test('promoteRamp: sobe estágio → teto da CARTEIRA cresce (caps ficam ilimitados — 2026-10-21)', async () => {
  const prisma = createFakePrisma();
  walletAccount(prisma);

  await reputation.promoteRamp(prisma, 'org-1');
  let row = prisma.studioReputationAccount.rows[0];
  assert.equal(row.rampStage, 1);
  assert.equal(row.ceiling, 200, 'o teto da REPOSIÇÃO diária segue a rampa');
  let wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.capsUnlimited, true, 'caps de disparo NÃO acompanham mais o estágio');

  await reputation.promoteRamp(prisma, 'org-1');
  await reputation.promoteRamp(prisma, 'org-1');
  await reputation.promoteRamp(prisma, 'org-1');
  row = prisma.studioReputationAccount.rows[0];
  assert.equal(row.rampStage, 3, 'estágio máximo');
  wallet = await reputation.getWallet(prisma, 'org-1');
  assert.equal(wallet.ceiling, 800, 'teto da carteira para no último estágio');
  assert.equal(wallet.capsUnlimited, true);
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
    reputation.WALLET_POLICY.prewarmFloor,
    'pré-aquecido → reserva explícita de reputação (40; override sob responsabilidade do cliente)'
  );
  await reputation.recordDomainAuth(prisma, 'org-1', { status: 'unverified', history: 'novo' });
  assert.equal(prisma.studioReputationAccount.rows[0].floor, reputation.WALLET_POLICY.floor, 'novo → sem reserva oculta (0)');
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
