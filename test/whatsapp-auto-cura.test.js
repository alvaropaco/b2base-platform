'use strict';

/**
 * test/whatsapp-auto-cura.test.js — auto-cura da sessão WhatsApp e contabi-
 * lidade honesta do cap (spec 2026-10-19 "WhatsApp caiu sem disparo"):
 *
 *  - Envio DEBITADO que falha por CANAL caído (conta ausente/não conectada,
 *    WAHA 5xx, mídia ilegível) estorna saldo E fatia do cap na tentativa
 *    final — SEM penalizar (FR-18: penalização é só sinal do destinatário).
 *  - Rejeição do destinatário (allowlist) continua estornando E penalizando.
 *  - reconcileAllSessions: verdade no banco, cura FAILED/STOPPED/DISCONNECTED,
 *    QR_REQUIRED intocado, WAHA inalcançável não muda nada, transições
 *    de/para CONNECTED despertam o dono (FR-31).
 *  - resumeSessions não envenena status por erro de rede no boot.
 *  - refundUnsentOnCancel devolve o cap do dia (AD-13).
 *
 * Padrão do harness: test/studio-attachments.test.js (seedWhatsAppMotor,
 * _setPrismaForTests, _setQueuesForTests, monkey-patch do waha-provider).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFakePrisma } = require('./helpers/fake-prisma');
const workers = require('../whatsapp-workers');
const engine = require('../whatsapp-engine');
const waha = require('../waha-provider');

function useTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-cura-'));
  process.env.STUDIO_STORAGE_DIR = dir;
  return dir;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Carteira com 1 envio WhatsApp já DEBITADO hoje (o cenário do bug real). */
function seedWalletDebit(prisma, { balance = 20 } = {}) {
  prisma.studioReputationAccount.rows.push({
    id: 'acc-wa', orgId: 'org-1', channel: 'unified',
    balance: balance - 1, floor: 0, ceiling: 30, rampStage: 0,
    emailSentToday: 0, whatsappSentToday: 1, usageDay: todayKey(),
    domainAuthStatus: 'unverified',
  });
  prisma.studioReputationEvent.rows.push({
    id: 'ev-debit', orgId: 'org-1', channel: 'whatsapp', type: 'debit',
    amount: 1, balanceAfter: balance - 1, refType: 'batch', refId: 'batch-wa',
  });
}

/** Motor WhatsApp no formato do processSend (conversa + conta embutidas). */
function seedMotor(prisma, { accountStatus = 'CONNECTED', withAccount = true } = {}) {
  prisma.organization.rows.push({ id: 'org-1', studioSendPaused: false });
  prisma.whatsappCampaign.rows.push({ id: 'wcamp-1', orgId: 'org-1', status: 'RUNNING', studioAttachments: [] });
  prisma.whatsappCampaignContact.rows.push({
    id: 'cc-1', campaignId: 'wcamp-1', prospectId: 'lead-1', status: 'SENDING', currentStepIndex: 0,
  });
  prisma.whatsAppConversation = { async update() {} };
  if (withAccount) {
    prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: accountStatus });
  }
  prisma.whatsAppMessage.rows.push({
    id: 'wmsg-1', orgId: 'org-1', campaignContactId: 'cc-1', conversationId: 'conv-1',
    status: 'PENDING', content: 'oi', stepIndex: 0,
    conversation: {
      id: 'conv-1', chatId: '55119999@c.us', whatsappAccountId: withAccount ? 'wacc-1' : null,
      whatsappAccount: withAccount ? { id: 'wacc-1', status: accountStatus, sessionName: 'sess' } : null,
    },
  });
}

function fakeQueues() {
  return {
    sequence: { adds: [], async add(job, opts) { this.adds.push({ job, opts }); return { id: 'j' }; } },
    send: { adds: [], async add(job, opts) { this.adds.push({ job, opts }); return { id: 'j' }; } },
  };
}

/** Roda processSend na ÚLTIMA tentativa (falha definitiva — AD-13). */
function finalAttempt(messageId = 'wmsg-1') {
  return workers.processSend({ data: { messageId }, attemptsMade: 4, opts: { attempts: 5 }, id: 'j-final' });
}

// ── Worker: envio debitado × canal caído ─────────────────────────────────────

test('conta AUSENTE na tentativa final: FAILED + estorno de saldo E cap, SEM penalização', async () => {
  const prisma = createFakePrisma();
  seedWalletDebit(prisma);
  seedMotor(prisma, { withAccount: false }); // conversa órfã, nenhuma conta conectada
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(fakeQueues());

  await assert.rejects(finalAttempt(), /CONECTADA/);
  const message = prisma.whatsAppMessage.rows[0];
  assert.equal(message.status, 'FAILED', 'mensagem marcada com o erro do canal');
  assert.ok(/CONECTADA/.test(message.error));
  const credit = prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1');
  assert.ok(credit, 'estorno idempotente presente (AD-13)');
  assert.equal(credit.refType, 'send');
  const account = prisma.studioReputationAccount.rows[0];
  assert.equal(account.balance, 20, 'saldo restaurado ao pré-débito');
  assert.equal(account.whatsappSentToday, 0, 'fatia do cap devolvida (não fica 1/30 fantasma)');
  assert.equal(prisma.studioReputationEvent.rows.some((e) => e.type === 'block'), 0, 'canal caído NUNCA penaliza');
});

test('conta NÃO CONECTADA após reconcile na tentativa final: idem — saldo e cap voltam', async () => {
  const prisma = createFakePrisma();
  seedWalletDebit(prisma);
  seedMotor(prisma, { accountStatus: 'ERROR' }); // sessão caiu (caso real de produção)
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(fakeQueues());
  const originalGet = waha.WAHAWhatsAppProvider.getSessionStatus;
  waha.WAHAWhatsAppProvider.getSessionStatus = async () => ({ status: 'DISCONNECTED' }); // WAHA confirma: caída
  try {
    await assert.rejects(finalAttempt(), /não conectada/);
    const account = prisma.studioReputationAccount.rows[0];
    assert.equal(prisma.whatsAppMessage.rows[0].status, 'FAILED');
    assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno presente');
    assert.equal(account.balance, 20);
    assert.equal(account.whatsappSentToday, 0, 'cap devolvido');
    assert.equal(prisma.studioReputationEvent.rows.some((e) => e.type === 'block'), 0, 'sem drenagem do pool');
  } finally {
    waha.WAHAWhatsAppProvider.getSessionStatus = originalGet;
  }
});

test('tentativa NÃO-final de canal caído: só relança — Bull re-tenta sem estornar', async () => {
  const prisma = createFakePrisma();
  seedWalletDebit(prisma);
  seedMotor(prisma, { withAccount: false });
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(fakeQueues());

  await assert.rejects(
    workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 0, opts: { attempts: 5 }, id: 'j-1' }),
    /CONECTADA/
  );
  assert.equal(prisma.whatsAppMessage.rows[0].status, 'PENDING', 'transitória não marca FAILED aqui');
  assert.equal(prisma.studioReputationEvent.rows.some((e) => e.type === 'credit'), 0, 'falha transitória não estorna');
});

test('WAHA 5xx na tentativa final: estorno SEM penalização (canal ≠ destinatário)', async () => {
  useTempStorage();
  const prisma = createFakePrisma();
  seedWalletDebit(prisma);
  seedMotor(prisma);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(fakeQueues());
  const originalSendText = waha.WAHAWhatsAppProvider.sendText;
  const transportErr = new Error('WAHA HTTP 502 Bad Gateway');
  transportErr.status = 502; // erros do provider carregam err.status — transporte nunca penaliza
  waha.WAHAWhatsAppProvider.sendText = async () => { throw transportErr; };
  try {
    await assert.rejects(finalAttempt(), /502/);
    const account = prisma.studioReputationAccount.rows[0];
    assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno presente');
    assert.equal(account.balance, 20, 'saldo não drena');
    assert.equal(account.whatsappSentToday, 0, 'cap devolvido');
    assert.equal(prisma.studioReputationEvent.rows.some((e) => e.type === 'block'), 0, 'queda de WAHA não penaliza');
    assert.equal(prisma.opsNotification.rows.some((n) => n.payload && n.payload.type === 'studio.whatsapp.rejected'), 0, 'nem desperta rejeição');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }
});

test('allowlist apertada: 4xx com not_on_whatsapp (underscore) penaliza; 5xx com texto de rejeição NÃO penaliza', async () => {
  // (a) 5xx com texto que JÁ FOI falso-positivo do regex frouxo → sem penalização.
  const queda = createFakePrisma();
  seedWalletDebit(queda);
  seedMotor(queda);
  workers._setPrismaForTests(queda);
  workers._setQueuesForTests(fakeQueues());
  const originalSendText = waha.WAHAWhatsAppProvider.sendText;
  const stuck = new Error('Session is not running (whatsapp): sessão parada no provider');
  stuck.status = 503;
  waha.WAHAWhatsAppProvider.sendText = async () => { throw stuck; };
  try {
    await assert.rejects(finalAttempt(), /not running/);
    assert.equal(queda.studioReputationEvent.rows.some((e) => e.type === 'block'), 0, '5xx nunca penaliza (antes do texto)');
    assert.ok(queda.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno segue');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }

  // (b) 4xx com variante underscore → rejeição real do destinatário: penaliza.
  const rejeicao = createFakePrisma();
  seedWalletDebit(rejeicao);
  seedMotor(rejeicao);
  workers._setPrismaForTests(rejeicao);
  workers._setQueuesForTests(fakeQueues());
  const notOnWa = new Error('WAHA HTTP 404: number not_on_whatsapp');
  notOnWa.status = 404;
  waha.WAHAWhatsAppProvider.sendText = async () => { throw notOnWa; };
  try {
    await assert.rejects(finalAttempt(), /not_on_whatsapp/);
    const block = rejeicao.studioReputationEvent.rows.find((e) => e.type === 'block');
    assert.ok(block, '4xx com texto de rejeição penaliza (FR-18)');
    assert.equal(block.refId, 'wmsg-1');
    assert.ok(rejeicao.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno presente');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }
});

test('REJEIÇÃO do destinatário na tentativa final: estorno + penalização + Despertar (comportamento preservado)', async () => {
  useTempStorage();
  const prisma = createFakePrisma();
  seedWalletDebit(prisma);
  seedMotor(prisma);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(fakeQueues());
  const originalSendText = waha.WAHAWhatsAppProvider.sendText;
  waha.WAHAWhatsAppProvider.sendText = async () => { throw new Error('no_recipient: número não registrado no WhatsApp'); };
  try {
    await assert.rejects(finalAttempt(), /no_recipient/);
    const account = prisma.studioReputationAccount.rows[0];
    assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno presente');
    const block = prisma.studioReputationEvent.rows.find((e) => e.type === 'block');
    assert.ok(block, 'penalização do destinatário (FR-18)');
    assert.equal(block.refId, 'wmsg-1');
    assert.equal(account.balance, 19, 'estorno +1 e penalização −1');
    const wake = prisma.opsNotification.rows.find((n) => n.kind === 'wake');
    assert.ok(wake, 'Despertar de rejeição (FR-31)');
    assert.equal(wake.payload.type, 'studio.whatsapp.rejected');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }
});

test('erro de TRANSPORTE com cara de "not" na tentativa final: estorno sem penalização (allowlist não pega rede)', async () => {
  useTempStorage();
  const prisma = createFakePrisma();
  seedWalletDebit(prisma);
  seedMotor(prisma);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(fakeQueues());
  const originalSendText = waha.WAHAWhatsAppProvider.sendText;
  waha.WAHAWhatsAppProvider.sendText = async () => { throw new Error('WAHA HTTP 500: session not running (whatsapp)'); };
  try {
    await assert.rejects(finalAttempt(), /not running/);
    assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno presente');
    assert.equal(prisma.studioReputationEvent.rows.some((e) => e.type === 'block'), 0, 'transporte ≠ rejeição do destinatário');
    assert.equal(prisma.studioReputationAccount.rows[0].balance, 20, 'pool não drena');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }
});

test('MÍDIA ilegível na tentativa final: estorno sem penalização (canal, não destinatário)', async () => {
  const dir = useTempStorage();
  const prisma = createFakePrisma();
  seedWalletDebit(prisma);
  seedMotor(prisma);
  prisma.whatsappCampaign.rows[0].studioAttachments = [{
    attachmentId: 'att-x', fileName: 'sumiu.png', originalName: 'sumiu.png', mimeType: 'image/png', sizeBytes: 5,
  }];
  prisma.whatsAppMessage.rows[0].stepIndex = null; // 1º toque leva mídia
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(fakeQueues());
  assert.ok(!fs.existsSync(path.join(dir, 'sumiu.png')), 'arquivo ausente no storage');
  void dir;

  await assert.rejects(finalAttempt(), /ilegível/);
  const account = prisma.studioReputationAccount.rows[0];
  assert.equal(prisma.whatsAppMessage.rows[0].status, 'FAILED');
  assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno presente');
  assert.equal(account.balance, 20);
  assert.equal(account.whatsappSentToday, 0, 'cap devolvido');
  assert.equal(prisma.studioReputationEvent.rows.some((e) => e.type === 'block'), 0, 'mídia ilegível não penaliza');
});

// ── Engine: boot não envenena status ─────────────────────────────────────────

function fakeWahaProvider({ status = null, failLookup = false } = {}) {
  const calls = { lookup: [], restart: [], start: [] };
  return {
    calls,
    async getSessionStatus(sessionName) {
      calls.lookup.push(sessionName);
      if (failLookup) throw new Error('rede indisponível (timeout)');
      return { status };
    },
    async restartSession(sessionName) { calls.restart.push(sessionName); return { ok: true }; },
    async startSession(sessionName) { calls.start.push(sessionName); return { ok: true }; },
  };
}

test('resumeSessions com WAHA lento: status PRESERVADO — boot não vira CONNECTED em DISCONNECTED à toa', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'CONNECTED' });
  const provider = fakeWahaProvider({ failLookup: true }); // rede cai no boot
  provider.startSession = async () => { throw new Error('WAHA HTTP 504 Gateway Timeout'); };

  const resumed = await engine.resumeSessions(prisma, provider);

  assert.equal(resumed, 1);
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'CONNECTED', 'status intacto — o sweep reconcilia depois');
});

// ── Engine: reconcileAllSessions (sweep de auto-cura) ────────────────────────

test('sweep reflete o status real: banco velho (DISCONNECTED) + WAHA WORKING → CONNECTED + session_recovered', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'DISCONNECTED' });
  const provider = fakeWahaProvider({ status: 'WORKING' });

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.equal(stats.checked, 1);
  assert.equal(stats.updated, 1);
  assert.equal(stats.recovered, 1);
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'CONNECTED', 'banco reflete o WAHA em ≤ 1 intervalo');
  const wake = prisma.opsNotification.rows.find((n) => n.kind === 'wake');
  assert.ok(wake, 'dono fica sabendo que voltou');
  assert.equal(wake.payload.type, 'studio.whatsapp.session_recovered');
  assert.equal(wake.payload.priority, 3);
});

test('sweep cura FAILED: restartSession chamado, banco marca ERROR e session_lost desperta (prioridade 1)', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'CONNECTED' });
  const provider = fakeWahaProvider({ status: 'FAILED' });

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.deepEqual(provider.calls.restart, ['sess'], 'sessão travada em FAILED só volta por restart');
  assert.deepEqual(provider.calls.start, [], 'restart ≠ start');
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'ERROR', 'verdade no painel/gate');
  assert.equal(stats.restarted, 1);
  assert.equal(stats.lost, 1);
  const wake = prisma.opsNotification.rows.find((n) => n.kind === 'wake');
  assert.ok(wake, 'dono fica sabendo que caiu');
  assert.equal(wake.payload.type, 'studio.whatsapp.session_lost');
  assert.equal(wake.payload.priority, 1);
});

test('sweep religa STOPPED/DISCONNECTED autenticados: startSession chamado', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'CONNECTED' });
  const provider = fakeWahaProvider({ status: 'STOPPED' });

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.deepEqual(provider.calls.start, ['sess']);
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'STOPPED');
  assert.equal(stats.started, 1);
  assert.equal(stats.lost, 1);
});

test('PARADA DELIBERADA (banco STOPPED, botão Desconectar): o sweep NUNCA religa', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'STOPPED' });
  const provider = fakeWahaProvider({ status: 'STOPPED' });

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.deepEqual(provider.calls.start, [], 'desconexão a pedido do dono não é cura — sweep não desfaz');
  assert.deepEqual(provider.calls.restart, []);
  assert.equal(stats.started, 0);
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'STOPPED', 'status segue autêntico');
});

test('QR_REQUIRED intocado: banco reflete, mas NADA de start/restart (re-pareamento é do dono)', async () => {
  const prisma = createFakePrisma();
  // STARTING (elegível ao sweep; CREATED nem é visitado — nunca pareada).
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'STARTING' });
  const provider = fakeWahaProvider({ status: 'SCAN_QR_CODE' });

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.deepEqual(provider.calls.start, [], 'nunca restarta em QR_REQUIRED');
  assert.deepEqual(provider.calls.restart, []);
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'QR_REQUIRED', 'status autenticado refletido');
  assert.equal(stats.updated, 1);
  assert.equal(prisma.opsNotification.rows.length, 0, 'QR não é transição de/para CONNECTED');
});

test('WAHA inalcançável: NADA muda no banco — nem status, nem cura, nem despertar', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'CONNECTED' });
  const provider = fakeWahaProvider({ failLookup: true });

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.equal(stats.unreachable, 1);
  assert.equal(stats.updated, 0);
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'CONNECTED', 'inalcançabilidade não é verdade sobre a sessão');
  assert.deepEqual(provider.calls.restart, []);
  assert.deepEqual(provider.calls.start, []);
  assert.equal(prisma.opsNotification.rows.length, 0);
});

test('cura é chave no status AUTENTICADO: banco ERROR + WAHA FAILED → restart mesmo sem divergência', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'ERROR' });
  const provider = fakeWahaProvider({ status: 'FAILED' });

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.deepEqual(provider.calls.restart, ['sess'], 'sessão em qualquer status com WAHA FAILED é reiniciada');
  assert.equal(stats.updated, 0, 'sem divergência, sem update');
  assert.equal(stats.lost, 0, 'sem transição, sem despertar');
});

test('falha no report NUNCA quebra o sweep (autonomy degrade silencioso)', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'CONNECTED' });
  const provider = fakeWahaProvider({ status: 'DISCONNECTED' });
  prisma.opsNotification.create = async () => { throw new Error('db down'); };

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.equal(stats.updated, 1, 'status persistiu mesmo com o report falhando');
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'DISCONNECTED');
  assert.equal(stats.lost, 1);
  assert.deepEqual(provider.calls.start, ['sess'], 'cura seguiu após o report falhar');
});

test('falha de ESCRITA no sweep: status preservado — sem cura, sem relatório na rodada', async () => {
  const prisma = createFakePrisma();
  prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'CONNECTED' });
  const provider = fakeWahaProvider({ status: 'FAILED' });
  prisma.whatsAppAccount.updateMany = async () => { throw new Error('db down'); };

  const stats = await engine.reconcileAllSessions(prisma, provider);

  assert.equal(stats.updated, 0, 'escrita rejeitada não conta como update');
  assert.equal(prisma.whatsAppAccount.rows[0].status, 'CONNECTED', 'status preservado');
  assert.deepEqual(provider.calls.restart, [], 'sem cura na rodada sem escrita autenticada');
  assert.deepEqual(provider.calls.start, []);
  assert.equal(prisma.opsNotification.rows.length, 0, 'sem despertar');
});

test('ruído NÃO desperta: 1º pareamento (STARTING → CONNECTED) e blip (CONNECTED → STARTING) são silenciosos', async () => {
  // (a) 1º pareamento não é "recuperação" — sem session_recovered.
  const pairing = createFakePrisma();
  pairing.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'STARTING' });
  const statsPairing = await engine.reconcileAllSessions(pairing, fakeWahaProvider({ status: 'WORKING' }));
  assert.equal(pairing.whatsAppAccount.rows[0].status, 'CONNECTED');
  assert.equal(statsPairing.updated, 1);
  assert.equal(statsPairing.recovered, 0, '1º pareamento não desperta');
  assert.equal(pairing.opsNotification.rows.length, 0);

  // (b) blip transitório CONNECTED → STARTING não dispara session_lost (p1).
  const blip = createFakePrisma();
  blip.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess', status: 'CONNECTED' });
  const statsBlip = await engine.reconcileAllSessions(blip, fakeWahaProvider({ status: 'STARTING' }));
  assert.equal(blip.whatsAppAccount.rows[0].status, 'STARTING');
  assert.equal(statsBlip.updated, 1);
  assert.equal(statsBlip.lost, 0, 'blip de STARTING não desperta');
  assert.equal(blip.opsNotification.rows.length, 0);
});

// ── Integração: cancelamento devolve o cap do dia (AD-13 × cap fantasma) ─────

test('refundUnsentOnCancel: fila restante estornada credita saldo E devolve a fatia do cap do dia', async () => {
  const campaignService = require('../studio/campaign-service');
  const prisma = createFakePrisma();
  const today = todayKey();
  prisma.studioCampaign.rows.push({
    id: 'camp-1', orgId: 'org-1', name: 'Campanha', status: 'cancelled',
    channels: ['whatsapp'], emailExecutionId: null, whatsappExecutionId: 'wexec-1',
  });
  prisma.whatsappCampaignContact.rows.push(
    { id: 'cc-1', campaignId: 'wexec-1', status: 'QUEUED' },
    { id: 'cc-2', campaignId: 'wexec-1', status: 'QUEUED' }
  );
  prisma.studioReputationAccount.rows.push({
    id: 'acc-wa', orgId: 'org-1', channel: 'unified', balance: 24, floor: 0, ceiling: 30,
    rampStage: 0, emailSentToday: 0, whatsappSentToday: 3, usageDay: today, domainAuthStatus: 'verified',
  });

  const out = await campaignService.flow.refundUnsentOnCancel(prisma, prisma.studioCampaign.rows[0]);

  assert.equal(out.whatsapp.credited, 2, '2 unidades da fila restante');
  const account = prisma.studioReputationAccount.rows[0];
  assert.equal(account.balance, 26, 'saldo devolvido ao pool');
  assert.equal(account.whatsappSentToday, 1, 'cap do dia devolve as unidades estornadas no MESMO dia');
});
