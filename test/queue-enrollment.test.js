'use strict';

/**
 * Epic 3 (Story 3.2/D4) — fila sincroniza com a seleção (suíte L0 da
 * eval-matrix). Comportamento determinístico: encolher a seleção após a
 * matrícula cancela os contatos removidos ANTES do envio, estorna exatamente
 * o que foi debitado (débito = liberação do lote; contato com mensagem
 * própria é estornado pelo worker via messageId) e nunca envia a quem saiu.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const campaignService = require('../studio/campaign-service');

function campaignRow(over = {}) {
  return {
    id: 'camp-1',
    orgId: 'org-1',
    name: 'Campanha QA',
    status: 'running',
    channels: ['email'],
    emailExecutionId: 'exec-email-1',
    whatsappExecutionId: null,
    schedule: { hourlyLimit: 20 },
    ...over,
  };
}

function contactRow(id, prospectId, over = {}) {
  return {
    id,
    campaignId: 'exec-email-1',
    prospectId,
    status: 'QUEUED',
    scheduledAt: null,
    cancelReason: null,
    ...over,
  };
}

function seedQueue(prisma) {
  // A: inscrito, NUNCA liberado (scheduledAt null — débito ainda não aconteceu).
  // B: liberado (débito feito), sem mensagem própria.
  // C: liberado COM mensagem (o estorno dele é do worker, por messageId).
  prisma.outreachContact.rows.push(
    contactRow('ct-a', 'lead-a'),
    contactRow('ct-b', 'lead-b', { scheduledAt: new Date('2026-10-01T10:00:00Z') }),
    contactRow('ct-c', 'lead-c', { status: 'SCHEDULED', scheduledAt: new Date('2026-10-01T10:00:00Z') })
  );
  prisma.outreachMessage.rows.push({ id: 'msg-c', contactId: 'ct-c', campaignId: 'exec-email-1', status: 'SCHEDULED' });
}

test('syncQueueWithAudience: removido sai da fila; liberado sem mensagem é estornado 1×', async () => {
  const prisma = createFakePrisma();
  seedQueue(prisma);
  const campaign = campaignRow();
  // Nova seleção mantém só o lead-a: B e C saíram.
  const out = await campaignService.flow.syncQueueWithAudience(prisma, campaign, ['lead-a']);
  assert.equal(out.email.cancelled, 2);

  const byProspect = new Map(prisma.outreachContact.rows.map((r) => [r.prospectId, r]));
  // Zero contatos removidos recebem envio: cancelados com motivo próprio.
  assert.equal(byProspect.get('lead-b').status, 'CANCELLED');
  assert.equal(byProspect.get('lead-b').cancelReason, 'removido_da_selecao');
  assert.equal(byProspect.get('lead-c').status, 'CANCELLED');
  // Quem ficou na seleção não é tocado.
  assert.equal(byProspect.get('lead-a').status, 'QUEUED');
  assert.equal(byProspect.get('lead-a').cancelReason, null);

  // Ledger íntegro: estorno SÓ do liberado sem mensagem (B). C tem mensagem —
  // o worker estorna por messageId ao ver contato terminal.
  assert.equal(out.email.refunded, 1);
  const credits = prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit');
  assert.equal(credits.length, 1);
  assert.equal(credits[0].refId, 'sync:camp-1:email:ct-b');
  // messageId estável: a mensagem de C não é apagada nem recriada.
  assert.equal(prisma.outreachMessage.rows.filter((m) => m.id === 'msg-c').length, 1);
});

test('syncQueueWithAudience: replay não duplica estorno (unique type+refId)', async () => {
  const prisma = createFakePrisma();
  seedQueue(prisma);
  const campaign = campaignRow();
  await campaignService.flow.syncQueueWithAudience(prisma, campaign, ['lead-a']);
  await campaignService.flow.syncQueueWithAudience(prisma, campaign, ['lead-a']);
  const credits = prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit');
  assert.equal(credits.length, 1, 'estorno idempotente por refId determinístico');
});

test('syncQueueWithAudience: contato nunca liberado é cancelado SEM estorno (nunca foi debitado)', async () => {
  const prisma = createFakePrisma();
  // Só o lead-a (não liberado) sai da seleção.
  prisma.outreachContact.rows.push(contactRow('ct-a', 'lead-a'));
  const campaign = campaignRow();
  const out = await campaignService.flow.syncQueueWithAudience(prisma, campaign, ['lead-x']);
  assert.equal(out.email.cancelled, 1);
  assert.equal(out.email.refunded, 0, 'sem débito prévio, não há estorno — saldo não infla');
  assert.equal(prisma.studioReputationEvent.rows.filter((e) => e.type === 'credit').length, 0);
});

test('syncQueueWithAudience: sem execução criada é no-op (audiência mudou antes da matrícula)', async () => {
  const prisma = createFakePrisma();
  const campaign = campaignRow({ emailExecutionId: null, whatsappExecutionId: null });
  const out = await campaignService.flow.syncQueueWithAudience(prisma, campaign, []);
  assert.deepEqual(out, {});
  assert.equal(prisma.studioReputationEvent.rows.length, 0);
});

test('syncQueueWithAudience: sincroniza os DOIS canais (email + whatsapp)', async () => {
  const prisma = createFakePrisma();
  prisma.outreachContact.rows.push(contactRow('ct-a', 'lead-a'));
  prisma.whatsappCampaignContact.rows.push({
    id: 'wa-1', campaignId: 'exec-wa-1', prospectId: 'lead-wa', status: 'QUEUED', nextSendAt: new Date('2026-10-01T10:00:00Z'), cancelReason: null,
  });
  const campaign = campaignRow({ whatsappExecutionId: 'exec-wa-1' });
  const out = await campaignService.flow.syncQueueWithAudience(prisma, campaign, ['lead-a', 'lead-keep']);
  assert.equal(out.email.cancelled, 0, 'lead-a continua na seleção');
  assert.equal(out.whatsapp.cancelled, 1);
  assert.equal(out.whatsapp.refunded, 1, 'WA liberado sem mensagem: estorno do canal whatsapp');
  assert.equal(prisma.whatsappCampaignContact.rows[0].status, 'CANCELLED');
});

test('materializeAudience: encolher a seleção sincroniza a fila na mesma request', async () => {
  const prisma = createFakePrisma();
  seedQueue(prisma);
  prisma.prospect.rows.push(
    { id: 'lead-a', orgId: 'org-1', status: 'active' },
    { id: 'lead-b', orgId: 'org-1', status: 'active' }
  );
  // Snapshot ativo anterior com 3 leads (a matrícula usou estes).
  const oldSnapshot = { id: 'snap-0', orgId: 'org-1', campaignId: 'camp-1', status: 'active', totalCount: 3, includedCount: 3, excludedCount: 0, criteriaVersion: {} };
  prisma.studioAudienceSnapshot.rows.push(oldSnapshot);
  for (const pid of ['lead-a', 'lead-b', 'lead-c']) {
    prisma.studioAudienceMember.rows.push({ id: `m-${pid}`, snapshotId: 'snap-0', prospectId: pid, included: true, excludeReason: null });
  }
  const campaign = campaignRow();
  const { snapshot, queueSync } = await campaignService.flow.materializeAudience(prisma, {
    campaign,
    prospectIds: ['lead-a', 'lead-b'],
  });
  assert.equal(snapshot.includedCount, 2);
  assert.equal(oldSnapshot.status, 'superseded');
  // A fila sincronizou: lead-c (removido, liberado, com mensagem) cancelado.
  assert.equal(queueSync.email.cancelled, 1);
  assert.equal(prisma.outreachContact.rows.find((r) => r.prospectId === 'lead-c').status, 'CANCELLED');
});

test('GET /queue: divergência expõe contatos em voo fora da seleção vigente', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  prisma.studioCampaign.rows.push(campaignRow());
  prisma.outreachContact.rows.push(
    contactRow('ct-a', 'lead-a'),
    // SCHEDULED (não SENDING): a divergência é o que o sync VAI remover —
    // quem está em envio neste instante vai receber (review E3-L4).
    contactRow('ct-z', 'lead-z', { status: 'SCHEDULED', scheduledAt: new Date() }) // fora da seleção
  );
  prisma.studioAudienceSnapshot.rows.push({ id: 'snap-1', orgId: 'org-1', campaignId: 'camp-1', status: 'active', totalCount: 1, includedCount: 1, excludedCount: 0, criteriaVersion: {} });
  prisma.studioAudienceMember.rows.push({ id: 'm-a', snapshotId: 'snap-1', prospectId: 'lead-a', included: true, excludeReason: null });
  prisma.prospect.rows.push(
    { id: 'lead-a', orgId: 'org-1', companyName: 'Repro Alimentos' },
    { id: 'lead-z', orgId: 'org-1', companyName: 'Fora da Seleção' }
  );
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    req.studio = { orgId: 'org-1', userId: 'user-1' };
    next();
  });
  const router = express.Router();
  require('../studio/campaign-routes').registerCampaignRoutes(router, { prisma, overrides: {} });
  app.use('/api/studio', router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/studio/campaigns/camp-1/queue`);
  const body = await res.json();
  assert.ok(body.success);
  assert.equal(body.divergence.count, 1, 'lead-z está na fila mas saiu da seleção');
  assert.equal(body.divergence.byChannel.email, 1);
  assert.ok(String(body.divergence.reason || '').includes('seleção'), 'explicável sem jargão');
  server.close();
});
