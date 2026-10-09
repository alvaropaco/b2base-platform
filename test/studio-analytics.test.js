'use strict';

/**
 * test/studio-analytics.test.js — US11 do Campaign Studio (T105).
 *
 * Rollup diário idempotente (upsert por chave), funil com métricas
 * estimadas rotuladas (FR-067), cortes por segmento/canal (FR-065),
 * timeline multi-canal do lead (FR-066) e ROI declarado vs medido (FR-068).
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const analytics = require('../studio/analytics-service');

function basePrisma() {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push({
    id: 'camp-a', orgId: 'org-1', name: 'Campanha A', status: 'running',
    channels: ['email', 'whatsapp'], goalMetric: 'replies', convertedValue: 500_000,
  });
  return prisma;
}

test('rollup: agrega eventos por dia/canal/variante de forma idempotente', async () => {
  const prisma = basePrisma();
  prisma.studioCampaign.rows[0].emailExecutionId = 'exec-1';
  const day = new Date('2026-09-23T12:00:00Z');
  for (let i = 1; i <= 3; i++) {
    prisma.outreachContact.rows.push({
      id: `oc-${i}`, campaignId: 'exec-1', prospectId: `lead-${i}`, status: 'SENT', sentAt: day,
    });
  }
  prisma.outreachContact.rows.push({
    id: 'oc-4', campaignId: 'exec-1', prospectId: 'lead-1', status: 'SENT', sentAt: day,
  });
  // Eventos: 1 abertura (estimada), 1 clique, 1 resposta.
  prisma.outreachEvent.rows.push(
    { id: 'e1', contactId: 'oc-1', type: 'email_opened_inferred', status: 'estimated', details: {}, createdAt: day },
    { id: 'e2', contactId: 'oc-2', type: 'email_clicked', status: 'confirmed', details: {}, createdAt: day },
    { id: 'e3', contactId: 'oc-3', type: 'email_replied', status: 'confirmed', details: {}, createdAt: day }
  );

  await analytics.rollupDaily(prisma, 'camp-a');
  const rows = prisma.studioMetricDaily.rows;
  assert.equal(rows.length, 1, 'uma linha de rollup para o dia/canal/variante/toque');
  assert.equal(rows[0].sent, 4);
  assert.equal(rows[0].opens, 1);
  assert.ok(rows[0].opensEstimated === 1 || rows[0].opens === 1, 'abertura contabilizada');
  assert.equal(rows[0].replies, 1);

  // Re-executar NÃO duplica (idempotência — constituição II).
  await analytics.rollupDaily(prisma, 'camp-a');
  assert.equal(prisma.studioMetricDaily.rows.length, 1);
});

test('funil: taxas por etapa e flag estimated nas aberturas inferidas (FR-067)', async () => {
  const prisma = basePrisma();
  prisma.studioMetricDaily.rows.push({
    id: 'm1', orgId: 'org-1', campaignId: 'camp-a', day: new Date('2026-09-23T00:00:00Z'),
    channel: 'email', variantLabel: 'A', stepIndex: 1,
    sent: 100, delivered: 90, deliveredEstimated: 90, opens: 40, opensEstimated: 40,
    clicks: 10, replies: 3, conversions: 1, bounces: 5, unsubs: 2, whatsappReads: 0,
  });
  const funnel = analytics.buildFunnel([{ ...prisma.studioMetricDaily.rows[0] }]);
  assert.equal(funnel.sent, 100);
  assert.equal(funnel.opens, 40);
  assert.equal(funnel.estimated, true, 'aberturas inferidas → rotulada estimada');
  assert.ok(funnel.rates.openRate <= 1 && funnel.rates.openRate > 0);
});

test('ROI: valor declarado (conversões × convertedValue) distinto de métrica medida', () => {
  const roi = analytics.computeRoi({ conversions: 2, convertedValue: 500_000 }, { sent: 100 });
  assert.equal(roi.declaredRevenue, 1_000_000, '2 conversões × R$5.000,00 (centavos)');
  assert.equal(roi.revenuePerSend, 10_000);
});

// ── 2026-10-09: o Monitor tem que contar WHATSAPP (caso do dono: campanha
// WhatsApp em voo mostrava Enviados 0) ───────────────────────────────────────

test('rollup: canal WHATSAPP conta envio, entrega, leitura, resposta e descadastro', async () => {
  const prisma = basePrisma();
  prisma.studioCampaign.rows[0].channels = ['whatsapp'];
  prisma.studioCampaign.rows[0].whatsappExecutionId = 'wexec-1';
  const dia1 = new Date('2026-10-08T12:00:00Z');
  prisma.whatsAppCampaignContact.rows.push(
    { id: 'wcc-1', campaignId: 'wexec-1', prospectId: 'l1', status: 'COMPLETED', lastSentAt: dia1, phoneNumber: '5511987654321' },
    { id: 'wcc-2', campaignId: 'wexec-1', prospectId: 'l2', status: 'REPLIED', lastSentAt: dia1, phoneNumber: '5511987654322' },
    { id: 'wcc-3', campaignId: 'wexec-1', prospectId: 'l3', status: 'OPTED_OUT', updatedAt: dia1 },
    { id: 'wcc-4', campaignId: 'wexec-1', prospectId: 'l4', status: 'QUEUED' }
  );
  prisma.whatsAppMessage.rows.push(
    { id: 'wm-1', campaignContactId: 'wcc-1', status: 'DELIVERED', createdAt: dia1 },
    { id: 'wm-2', campaignContactId: 'wcc-1', status: 'READ', createdAt: dia1 },
    { id: 'wm-3', campaignContactId: 'wcc-2', status: 'FAILED', createdAt: dia1 }
  );

  await analytics.rollupDaily(prisma, 'camp-a');
  const row = prisma.studioMetricDaily.rows.find((r) => r.channel === 'whatsapp');
  assert.ok(row, 'linha de rollup do canal whatsapp');
  assert.equal(row.sent, 2, 'envio = contato com lastSentAt (QUEUED/OPTED_OUT sem envio não conta)');
  assert.equal(row.delivered, 2, 'entrega = mensagens DELIVERED/READ (por mensagem)');
  assert.equal(row.whatsappReads, 1, 'leitura contada no campo próprio');
  assert.equal(row.replies, 1, 'REPLIED conta resposta');
  assert.equal(row.unsubs, 1, 'OPTED_OUT conta descadastro');
  assert.equal(row.bounces, 1, 'FAILED conta como falha de entrega');
});

// ── P0 2026-10-09 (dono: "monitor em 0" com 2 mensagens COMPLETED na fila) ──
// O funil não pode depender do job de 5min (Bull/Redis morto = mentira para
// sempre): o GET da rota tem que RECALCULAR o rollup na própria leitura.

test('rota GET /analytics recalcula o rollup on-demand — sem job, Enviados reflete a fila', async () => {
  const express = require('express');
  const { registerAnalyticsRoutes: analyticsRoutes } = require('../studio/analytics-routes');

  const prisma = basePrisma();
  prisma.studioCampaign.rows[0].channels = ['whatsapp'];
  prisma.studioCampaign.rows[0].whatsappExecutionId = 'wexec-1';
  const dia = new Date('2026-10-09T18:56:00Z');
  prisma.whatsAppCampaignContact.rows.push(
    { id: 'wcc-ok1', campaignId: 'wexec-1', prospectId: 'l1', status: 'COMPLETED', lastSentAt: dia, phoneNumber: '5511987654321' },
    { id: 'wcc-ok2', campaignId: 'wexec-1', prospectId: 'l2', status: 'COMPLETED', lastSentAt: dia, phoneNumber: '5511987654322' },
    { id: 'wcc-np1', campaignId: 'wexec-1', prospectId: 'l3', status: 'CANCELLED', cancelReason: 'no_phone' }
  );
  prisma.whatsAppMessage.rows.push(
    { id: 'wm-ok1', campaignContactId: 'wcc-ok1', status: 'SENT', createdAt: dia },
    { id: 'wm-ok2', campaignContactId: 'wcc-ok2', status: 'SENT', createdAt: dia }
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.studio = { orgId: 'org-1', userId: 'u1' }; next(); });
  analyticsRoutes(app, { prisma });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/campaigns/camp-a/analytics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.funnel.sent, 2, 'Enviados 2 (antes: 0 para sempre até o job rodar)');
    // Nenhuma linha de rollup existia ANTES do GET — a rota materializou.
    assert.ok(prisma.studioMetricDaily.rows.length > 0, 'rollup materializado na leitura');
    // Idempotente: segunda leitura não duplica.
    await fetch(`http://127.0.0.1:${server.address().port}/campaigns/camp-a/analytics`);
    assert.equal(prisma.studioMetricDaily.rows.filter((r) => r.channel === 'whatsapp').length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
