'use strict';

/**
 * test/studio-autonomy.test.js — Contrato de Autonomia (specs/011, AD-10;
 * FR-31…FR-34). Lista fechada de Despertares, orçamento diário por org
 * (excedente agregado em resumo único) e decisão silenciosa registrada.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const autonomy = require('../studio/autonomy');

test('lista fechada: os 5 Despertares obrigatórios do FR-31 existem e despertam', () => {
  const obrigatórios = [
    'studio.campaign.first_batch',      // 1º lote de campanha nova
    'studio.anomaly.detected',         // anomalia de saldo/entrega
    'studio.content.error',            // erro em conteúdo agendado
    'studio.schedule.blocked_balance', // bloqueio de agendamento por saldo
    'studio.whatsapp.rejected',        // rejeição/bloqueio de WhatsApp
  ];
  for (const type of obrigatórios) {
    const decision = autonomy.decide(type);
    assert.equal(decision.wake, true, `${type} desperta`);
    assert.ok(decision.priority >= 1 && decision.priority <= 3);
  }
});

test('nada fora da lista desperta — decisão silenciosa e registrada (FR-31/FR-32)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1' });
  const before = console.log;
  let logged = '';
  console.log = (msg) => { logged = String(msg); };
  try {
    const decision = await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.campaign.progressed_normally' });
    assert.equal(decision.wake, false);
    assert.equal(decision.result, 'silent');
    assert.ok(logged.includes('[studio:autonomy]'), 'registro legível da decisão (FR-32)');
    assert.equal(prisma.opsNotification.rows.length, 0, 'nenhuma notificação');
  } finally {
    console.log = before;
  }
});

test('orçamento de notificações: teto de 5/dia, excedente agrega em resumo único (FR-33)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1' });

  for (let i = 1; i <= 5; i++) {
    const decision = await autonomy.report(prisma, {
      orgId: 'org-1',
      type: 'studio.anomaly.detected',
      campaignId: `c-${i}`,
      details: { bounceRate: '25%' },
    });
    assert.equal(decision.wake, true, `despertar ${i} dentro do orçamento`);
  }
  assert.equal(prisma.opsNotification.rows.filter((n) => n.kind === 'wake').length, 5);

  // 6º evento do dia: fora do teto → agrega no resumo, não cria wake novo.
  const sixth = await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.anomaly.detected', campaignId: 'c-6' });
  assert.equal(sixth.wake, false);
  assert.equal(sixth.result, 'aggregated');
  assert.equal(prisma.opsNotification.rows.filter((n) => n.kind === 'wake').length, 5, 'teto respeitado');

  // 7º evento: incrementa o MESMO resumo do dia (dedupe por org+dia).
  await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.anomaly.detected', campaignId: 'c-7' });
  const digests = prisma.opsNotification.rows.filter((n) => n.kind === 'digest');
  assert.equal(digests.length, 1, 'resumo único do dia');
  assert.equal(digests[0].payload.aggregated, 2, 'excedente agregado');
});

test('dedupKey determinística: retry do worker NÃO duplica o mesmo Despertar do dia', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1' });
  const now = new Date('2026-09-26T14:00:00Z');
  const first = await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.whatsapp.rejected', campaignId: 'c-1', now });
  const retry = await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.whatsapp.rejected', campaignId: 'c-1', now });
  assert.equal(first.wake, true);
  assert.equal(retry.wake, false, 'mesmo evento do dia não desperta 2×');
  assert.equal(retry.result, 'deduped');
  assert.equal(prisma.opsNotification.rows.filter((n) => n.kind === 'wake').length, 1);
});

test('mesmo tipo em campaigns diferentes desperta (dedupe é por evento, não por tipo)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1' });
  const now = new Date('2026-09-26T14:00:00Z');
  await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.whatsapp.rejected', campaignId: 'c-1', now });
  const other = await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.whatsapp.rejected', campaignId: 'c-2', now });
  assert.equal(other.wake, true);
});

test('orçamento é POR DIA: a virada reabre o orçamento (janela)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1' });
  const dia1 = new Date('2026-09-25T23:50:00Z');
  const dia2 = new Date('2026-09-26T00:10:00Z');
  for (let i = 0; i < 5; i++) {
    await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.content.error', campaignId: `c-${i}`, now: dia1 });
  }
  const decision = await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.content.error', campaignId: 'c-novo', now: dia2 });
  assert.equal(decision.wake, true, 'novo dia, novo orçamento');
});

test('Despertar tem prioridade e severidade proporcionais (FR-31)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1' });
  await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.whatsapp.rejected', campaignId: 'c-1' });
  const wake = prisma.opsNotification.rows.find((n) => n.kind === 'wake');
  assert.equal(wake.severity, 'critical', 'rejeição WhatsApp é prioridade 1');
  assert.ok(wake.title, 'título legível por humano');
});

test('pendingWakes: painel lê os Despertares da org, mais recentes primeiro', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1' });
  await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.anomaly.detected', campaignId: 'c-1' });
  await autonomy.report(prisma, { orgId: 'org-1', type: 'studio.content.error', campaignId: 'c-2' });
  // Notificação de OUTRA org não vaza (isolamento constituição IV).
  await autonomy.report(prisma, { orgId: 'org-2', type: 'studio.anomaly.detected', campaignId: 'c-3' });
  const wakes = await autonomy.pendingWakes(prisma, 'org-1');
  assert.equal(wakes.length, 2);
  assert.ok(wakes.every((w) => w.orgId === 'org-1'));
});
