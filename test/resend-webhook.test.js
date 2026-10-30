'use strict';

/**
 * test/resend-webhook.test.js — WEBHOOK DO RESEND (2026-10-30): eventos REAIS
 * do provedor (entrega, bounce, abertura, clique) com assinatura Svix,
 * idempotência e transições monótonicas de status. Entrega CONFIRMADA nunca
 * é confundida com "aceito pelo provider".
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifySvixSignature, applyResendEvent } = require('../studio/resend-webhook');

const SECRET = 'whsec_' + Buffer.from('segredo-de-teste-0123456789abcdef').toString('base64');

function svixHeaders(payload, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const id = 'msg_' + Math.random().toString(36).slice(2, 12);
  const signedContent = `${id}.${timestamp}.${payload}`;
  const sig = crypto.createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(signedContent).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(timestamp), 'svix-signature': `v1,${sig}` };
}

function fakePrisma({ message, events = [] } = {}) {
  const db = { events, contactUpdates: [] };
  return {
    db,
    outreachMessage: {
      async findUnique({ where }) {
        if (!message || where.gmailMessageId !== message.gmailMessageId) return null;
        const latest = db.contactUpdates.filter((u) => u.id === 'ct_1').pop();
        return {
          id: 'om_1', gmailMessageId: message.gmailMessageId,
          contact: { id: 'ct_1', status: latest ? latest.status : message.contactStatus, campaign: { tenantId: 'org_1' } },
        };
      },
    },
    outreachContact: {
      async update({ where, data }) { db.contactUpdates.push({ id: where.id, status: data.status }); return { id: where.id, status: data.status }; },
    },
    outreachEvent: {
      async findFirst({ where }) {
        return db.events.find((e) => e.contactId === where.contactId
          && e.type === where.type
          && e.details && where.details
          && where.details.equals !== undefined
          && e.details.providerEventId === where.details.equals
          ? e : null) || null;
      },
      async create({ data }) { db.events.push(data); return data; },
    },
  };
}

function deliveredPayload(emailId = 're_123', eventId = 'ev_' + Math.random().toString(36).slice(2)) {
  return { type: 'email.delivered', data: { email_id: emailId, id: eventId } };
}

test('svix: assinatura válida passa; inválida, replay e headers ausentes falham', () => {
  const payload = JSON.stringify(deliveredPayload());
  const headers = svixHeaders(payload);
  assert.equal(verifySvixSignature(payload, headers, SECRET).ok, true);
  assert.equal(verifySvixSignature(payload + ' ', headers, SECRET).ok, false, 'body alterado → falha');
  const err = svixHeaders(payload, 'whsec_' + Buffer.from('outra-chave').toString('base64'));
  assert.equal(verifySvixSignature(payload, err, SECRET).ok, false, 'chave diferente → falha');
  const replay = svixHeaders(payload, SECRET, Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifySvixSignature(payload, replay, SECRET).ok, false, 'timestamp fora da janela (replay) → falha');
  assert.equal(verifySvixSignature(payload, {}, SECRET).ok, false, 'headers ausentes → falha');
  assert.equal(verifySvixSignature(payload, svixHeaders(payload), null).ok, false, 'sem secret configurado → falha');
});

test('email.delivered → contato DELIVERED (confirmado) + evento; repetição é idempotente', async () => {
  const payload = deliveredPayload('re_abc', 'evt_1');
  const prisma = fakePrisma({ message: { gmailMessageId: 're_abc', contactStatus: 'SENT' } });
  const out = await applyResendEvent(prisma, payload);
  assert.equal(out.handled, true);
  assert.equal(out.status, 'DELIVERED', 'entrega CONFIRMADA (não inferida)');
  assert.equal(out.changed, true);
  assert.deepEqual(prisma.db.contactUpdates, [{ id: 'ct_1', status: 'DELIVERED' }]);
  // Mesmo evento de novo: status já avançado, evento duplicado não é gravado.
  const again = await applyResendEvent(prisma, payload);
  assert.equal(again.status, 'DELIVERED');
  assert.equal(prisma.db.contactUpdates.length, 1, 'não reatualiza');
  const deliveredEvents = prisma.db.events.filter((e) => e.type === 'email_delivered_confirmed');
  assert.equal(deliveredEvents.length, 1, 'um único evento de entrega');
});

test('email.bounced → status BOUNCED; contact em REPLIED nunca regride', async () => {
  const prisma = fakePrisma({ message: { gmailMessageId: 're_b', contactStatus: 'SENT' } });
  const out = await applyResendEvent(prisma, { type: 'email.bounced', data: { email_id: 're_b', id: 'evt_b' } });
  assert.equal(out.status, 'BOUNCED');
  assert.ok(prisma.db.events.some((e) => e.type === 'email_bounced'));

  const replied = fakePrisma({ message: { gmailMessageId: 're_r', contactStatus: 'REPLIED' } });
  const out2 = await applyResendEvent(replied, { type: 'email.bounced', data: { email_id: 're_r', id: 'evt_b2' } });
  assert.equal(out2.reason, 'status_ja_avancado', 'REPLIED é terminal — não regride');
});

test('email.opened/clicked/delayed: abertura confirma, clique é evento, delayed é info', async () => {
  const opened = fakePrisma({ message: { gmailMessageId: 're_o', contactStatus: 'DELIVERED' } });
  const out1 = await applyResendEvent(opened, { type: 'email.opened', data: { email_id: 're_o', id: 'evt_o' } });
  assert.equal(out1.status, 'OPENED', 'abertura CONFIRMADA (não inferida)');

  const clicked = fakePrisma({ message: { gmailMessageId: 're_c', contactStatus: 'DELIVERED' } });
  const out2 = await applyResendEvent(clicked, { type: 'email.clicked', data: { email_id: 're_c', id: 'evt_c' } });
  assert.equal(out2.status, 'DELIVERED', 'clique não muda status');
  assert.ok(clicked.db.events.some((e) => e.type === 'email_clicked'), 'clique registrado como evento (rollup conta)');

  const delayed = fakePrisma({ message: { gmailMessageId: 're_d', contactStatus: 'SENT' } });
  const out3 = await applyResendEvent(delayed, { type: 'email.delivery_delayed', data: { email_id: 're_d', id: 'evt_d' } });
  assert.equal(out3.handled, true);
  assert.equal(delayed.db.contactUpdates.length, 0, 'delayed não muda status');
});

test('email_id desconhecido → handled:false sem quebrar (200 para o provider)', async () => {
  const prisma = fakePrisma({ message: null });
  const out = await applyResendEvent(prisma, { type: 'email.delivered', data: { email_id: 're_outraconta', id: 'evt_x' } });
  assert.equal(out.handled, false);
  assert.equal(out.reason, 'mensagem_nao_encontrada');
});

test('rollup: DELIVERED/OPENED confirmados contam como entrega/abertura REAL (não estimada)', async () => {
  const analytics = require('../studio/analytics-service');
  const prisma = {
    studioCampaign: { async findUnique() { return { id: 'camp-a', orgId: 'org-1', emailExecutionId: 'exec-1', whatsappExecutionId: null }; } },
    outreachContact: { async findMany() { return [
      { id: 'c1', campaignId: 'exec-1', status: 'DELIVERED', sentAt: new Date('2026-10-30T12:00:00Z') },
      { id: 'c2', campaignId: 'exec-1', status: 'OPENED', sentAt: new Date('2026-10-30T12:00:00Z') },
      { id: 'c3', campaignId: 'exec-1', status: 'SENT', sentAt: new Date('2026-10-30T12:00:00Z') },
    ]; } },
    outreachEvent: { async findMany() { return []; } },
    studioMetricDaily: {
      rows: [],
      async findMany() { return this.rows.filter((r) => r.campaignId === 'camp-a'); },
      async update({ where, data }) { const r = this.rows.find((x) => x.id === where.id); Object.assign(r, data); return r; },
      async create({ data }) { const r = { id: 'm_' + (this.rows.length + 1), ...data }; this.rows.push(r); return r; },
    },
  };
  await analytics.rollupDaily(prisma, 'camp-a');
  const row = prisma.studioMetricDaily.rows[0];
  assert.equal(row.sent, 3);
  assert.equal(row.delivered, 3, 'SENT + DELIVERED + OPENED contam entrega');
  assert.equal(row.opens, 1, 'abertura confirmada conta 1');
  assert.ok(!row.deliveredEstimated && !row.opensEstimated, 'confirmado NÃO é estimado');
});
