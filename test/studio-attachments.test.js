'use strict';

/**
 * test/studio-attachments.test.js — anexos que saem JUNTO na mensagem
 * (Epic 2 da onda "criação de campanha sem bloqueios"):
 *
 *  - Story 2.1 (FR6): upload com canal destino, limites do plano explicáveis,
 *    B9 (DELETE escopado pela campanha), B14 (attach_files 404 sem sucesso
 *    parcial) e B18 (ids ordenados na chave — replay por ordem diferente).
 *  - Story 2.2 (V2/D6/D8): anexo resolvido NA LIBERAÇÃO do lote (enqueueBatch),
 *    execução guarda REFERÊNCIA, bytes lidos no send com fail-safe (teto por
 *    chamada, ilegível fora com `skipped`), provider degrada explicável (Gmail).
 *  - Story 2.3 (V3/D8): mídia no processSend do WhatsApp — sendImage/
 *    sendFile com legenda = texto da peça; arquivo ausente → falha segura.
 *
 * B16: storage de teste SEMPRE em `mkdtemp` (nunca o `.data` do dev).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const bridge = require('../studio/channel-bridge');

function useTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-att-'));
  process.env.STUDIO_STORAGE_DIR = dir;
  return dir;
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
  return name;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function seedOrg(prisma, { plan = 'premium' } = {}) {
  prisma.organization.rows.push({ id: 'org-1', plan, studioSendPaused: false });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  return prisma;
}

function seedCampaignWithExecution(prisma, { withExecution = true } = {}) {
  prisma.studioCampaign.rows.push({
    id: 'camp-1', orgId: 'org-1', name: 'Campanha', status: 'approved',
    channels: ['email'], schedule: {}, approval: {},
    emailExecutionId: withExecution ? 'exec-1' : null,
    whatsappExecutionId: null,
  });
  if (withExecution) {
    prisma.outreachCampaign.rows.push({ id: 'exec-1', tenantId: 'org-1', status: 'draft', studioAttachments: [] });
    prisma.studioAudienceSnapshot.rows.push({ id: 'snap-1', orgId: 'org-1', campaignId: 'camp-1', criteriaVersion: {}, totalCount: 1, includedCount: 1, excludedCount: 0, status: 'active' });
    prisma.studioAudienceMember.rows.push({ id: 'm-1', snapshotId: 'snap-1', orgId: 'org-1', prospectId: 'lead-1', included: true, excludeReason: null });
    prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-1', prospectId: 'lead-1', status: 'QUEUED', scheduledAt: null });
  }
  prisma.studioContent.rows.push({
    id: 'content-email', orgId: 'org-1', campaignId: 'camp-1', channel: 'email',
    kind: 'base', stepIndex: 1, variantLabel: 'A',
    subject: 'Olá {{firstName}}', emailDoc: { blocks: [{ type: 'text', text: 'Corpo.' }] },
  });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 50, floor: 0, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
  return prisma.studioCampaign.rows[0];
}

async function startServer(prisma) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(`${base}/api/studio${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { res, body: await res.json() };
  };
  const upload = async (path, fileName, bytes, fields = {}) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), fileName);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`${base}/api/studio${path}`, { method: 'POST', body: form });
    return { res, body: await res.json().catch(() => ({})) };
  };
  return { server, api, upload };
}

// ── Story 2.1: modelo, upload e canal destino ───────────────────────────────

test('upload de anexo: persiste com canal destino e nome original; listagem por campanha (FR6)', async () => {
  const dir = useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  seedCampaignWithExecution(prisma);
  const { server, upload, api } = await startServer(prisma);
  try {
    const { res, body } = await upload('/campaigns/camp-1/attachments', 'proposta.pdf', Buffer.from('%PDF-anexo'), { channels: 'email' });
    assert.equal(res.status, 201, 'upload criado');
    assert.equal(body.data.channels, 'email');
    assert.equal(body.data.originalName, 'proposta.pdf');
    assert.equal(body.data.campaignId, 'camp-1');
    assert.ok(fs.existsSync(path.join(dir, body.data.fileName)), 'arquivo no storage do Studio (SHA-256)');

    const list = await api('GET', '/campaigns/camp-1/attachments');
    assert.equal(list.body.data.length, 1);

    // Extensão fora da whitelist → recusa explicável (NFR5).
    const bad = await upload('/campaigns/camp-1/attachments', 'virus.exe', Buffer.from('MZ'), {});
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error, 'INVALID_FILE_TYPE');

    // B9: DELETE escopado pela campanha — anexo de OUTRA campanha → 404.
    prisma.studioAttachment.rows.push({ id: 'att-other', orgId: 'org-1', campaignId: 'camp-2', fileName: 'x.pdf', originalName: 'x.pdf', sizeBytes: 1, channels: 'both' });
    const wrongCampaign = await api('DELETE', '/campaigns/camp-1/attachments/att-other');
    assert.equal(wrongCampaign.res.status, 404, 'anexo de outra campanha não é alcançável');
    const crossOrg = await api('DELETE', '/campaigns/camp-2/attachments/att-other');
    assert.equal(crossOrg.res.status, 404, 'campanha de outra org nem existe para mim');

    // E10: remoção remove registro E arquivo.
    const del = await api('DELETE', `/campaigns/camp-1/attachments/${body.data.id}`);
    assert.equal(del.res.status, 200);
    assert.equal(prisma.studioAttachment.rows.length, 1, 'registro saiu primeiro');
    assert.ok(!fs.existsSync(path.join(dir, body.data.fileName)), 'arquivo removido depois (E10)');
  } finally {
    server.close();
  }
});

test('anexo acima do limite do plano → 400 explicável (trial 5MB); multer estourado → 400, nunca 500 (E4)', async () => {
  useTempStorage();
  const prisma = seedOrg(createFakePrisma(), { plan: 'trial' });
  seedCampaignWithExecution(prisma);
  const { server, upload } = await startServer(prisma);
  try {
    const over = await upload('/campaigns/camp-1/attachments', 'grande.png', Buffer.alloc(6 * 1024 * 1024, 1), { channels: 'both' });
    assert.equal(over.res.status, 400);
    assert.equal(over.body.error, 'ATTACHMENT_TOO_LARGE');

    // Acima do teto multer (25MB): LIMIT_FILE_SIZE vira 400 explicável (E4).
    const huge = await upload('/campaigns/camp-1/attachments', 'enorme.bin', Buffer.alloc(26 * 1024 * 1024, 1), {});
    assert.equal(huge.res.status, 400, 'nunca 500');
    assert.equal(huge.body.error, 'MATERIAL_TOO_LARGE');
  } finally {
    server.close();
  }
});

test('attach_files: vincula à campanha; id ausente → 404 SEM sucesso parcial (B14); ordem não muda a chave (B18)', async () => {
  useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  seedCampaignWithExecution(prisma);
  prisma.studioAttachment.rows.push(
    { id: 'att-1', orgId: 'org-1', campaignId: null, fileName: 'a.pdf', originalName: 'a.pdf', sizeBytes: 10, channels: 'both' },
    { id: 'att-2', orgId: 'org-1', campaignId: null, fileName: 'b.png', originalName: 'b.png', sizeBytes: 20, channels: 'whatsapp' }
  );
  const { server, api } = await startServer(prisma);
  try {
    // B14: um id que não casou → 404 e NENHUM vínculo parcial.
    const partial = await api('POST', '/campaigns/camp-1/actions', {
      type: 'attach_files',
      actionId: 'tap-att-partial',
      params: { attachmentIds: ['att-1', 'att-404'] },
    });
    assert.equal(partial.res.status, 404);
    assert.equal(prisma.studioAttachment.rows.find((a) => a.id === 'att-1').campaignId, null, 'nada vinculado no erro');

    const first = await api('POST', '/campaigns/camp-1/actions', {
      type: 'attach_files',
      actionId: 'tap-att-1',
      params: { attachmentIds: ['att-1', 'att-2'] },
    });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.data.card.type, 'attachments');
    assert.deepEqual(prisma.studioAttachment.rows.map((a) => a.campaignId), ['camp-1', 'camp-1'], 'ambos vinculados');

    // B18: mesmos ids em ordem trocada SEM actionId → mesma chave (replay).
    const a = await api('POST', '/campaigns/camp-1/actions', { type: 'attach_files', params: { attachmentIds: ['att-1', 'att-2'] } });
    const b = await api('POST', '/campaigns/camp-1/actions', { type: 'attach_files', params: { attachmentIds: ['att-2', 'att-1'] } });
    assert.equal(a.body.data.card.replayed, undefined, '1ª execução executa');
    assert.equal(b.body.data.card.replayed, true, 'ordem diferente da MESMA intenção é replay');
  } finally {
    server.close();
  }
});

// ── Story 2.2 (V2/D6/D8): anexo resolve NA LIBERAÇÃO e chega ao provider ────

test('enqueueBatch resolve anexos de e-mail na liberação: teto por chamada, ordem estável, skipped registrado', async () => {
  const dir = useTempStorage();
  process.env.STUDIO_EMAIL_ATTACHMENT_MAX_BYTES = '100'; // teto minúsculo p/ teste
  try {
    const prisma = seedOrg(createFakePrisma());
    const campaign = seedCampaignWithExecution(prisma);
    // Ordem estável: att-1 é o mais antigo e cabe; att-2 excede o teto; att-3 sem arquivo.
    prisma.studioAttachment.rows.push(
      { id: 'att-1', orgId: 'org-1', campaignId: 'camp-1', fileName: writeFile(dir, 'um.pdf', 'A'.repeat(60)), originalName: 'um.pdf', mimeType: 'application/pdf', sizeBytes: 60, channels: 'email', createdAt: new Date('2026-09-30T10:00:00Z') },
      { id: 'att-2', orgId: 'org-1', campaignId: 'camp-1', fileName: writeFile(dir, 'dois.pdf', 'B'.repeat(80)), originalName: 'dois.pdf', mimeType: 'application/pdf', sizeBytes: 80, channels: 'email', createdAt: new Date('2026-09-30T10:01:00Z') },
      { id: 'att-3', orgId: 'org-1', campaignId: 'camp-1', fileName: 'sumiu.pdf', originalName: 'sumiu.pdf', mimeType: 'application/pdf', sizeBytes: 10, channels: 'email', createdAt: new Date('2026-09-30T09:59:00Z') }
    );
    const enqueued = [];
    const result = await bridge.enqueueBatch(prisma, {
      campaign,
      channel: 'email',
      prospectIds: ['lead-1'],
      now: new Date('2026-09-30T12:00:00Z'),
      enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
    });
    assert.equal(result.enqueued.length, 1, 'lote liberado');
    assert.equal(result.attachments.included.length, 1, 'só o que cabe no teto');
    assert.equal(result.attachments.included[0].attachmentId, 'att-1', 'ordem estável por createdAt (mais antigo primeiro)');
    assert.deepEqual(
      result.attachments.skipped.map((s) => s.attachmentId).sort(),
      ['att-2', 'att-3'],
      'excedente (E6) e ilegível (E7) fora, com skipped'
    );
    // D8: a execução guarda a REFERÊNCIA (nunca bytes/base64).
    const execution = prisma.outreachCampaign.rows.find((r) => r.id === 'exec-1');
    assert.equal(execution.studioAttachments[0].fileName, 'um.pdf');
    assert.equal(execution.studioAttachments[0].sizeBytes, 60);
    assert.ok(!JSON.stringify(execution.studioAttachments).includes('AAAA'), 'nada de base64 no JSONB');
  } finally {
    delete process.env.STUDIO_EMAIL_ATTACHMENT_MAX_BYTES;
  }
});

test('V2: bytes chegam ao provider no send; Gmail (sem suporte) degrada explicável', async () => {
  const dir = useTempStorage();
  // Janela de envio aberta o dia todo — o processSend real passa pelo rate limiter.
  process.env.OUTREACH_ALLOWED_HOURS_START = '0';
  process.env.OUTREACH_ALLOWED_HOURS_END = '24';
  // API key do Resend via ambiente (sem segredo criptografado na conta fake).
  process.env.RESEND_API_KEY = 'test-key';
  const fileContent = Buffer.from('%PDF-conteudo-real-do-anexo');
  const prisma = seedOrg(createFakePrisma());
  prisma.outreachCampaign.rows.push({ id: 'camp-1', tenantId: 'org-1', status: 'active', studioAttachments: [] });
  prisma.emailAccount.rows.length = 0;
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'resend', email: 'venda@empresa.com', status: 'connected' });
  prisma.outreachContact.rows.push({ id: 'ct-1', campaignId: 'camp-1', prospectId: 'lead-1', status: 'SCHEDULED', emailAccount_id: 'ea-1' });
  prisma.outreachMessage.rows.push({
    id: 'msg-1', contactId: 'ct-1', status: 'SCHEDULED', subject: 'Oi', body: 'corpo',
    contact: { prospectId: 'lead-1', status: 'SCHEDULED', campaign: { tenantId: 'org-1', status: 'active', studioAttachments: [{ attachmentId: 'att-1', fileName: writeFile(dir, 'um.pdf', fileContent), originalName: 'um.pdf', mimeType: 'application/pdf', sizeBytes: fileContent.length }, { attachmentId: 'att-2', fileName: 'sumiu.pdf', originalName: 'sumiu.pdf', mimeType: 'application/pdf', sizeBytes: 5 }] }, emailAccount_id: 'ea-1' },
  });
  prisma.prospect.rows.push({ id: 'lead-1', orgId: 'org-1', cnpjEmail: 'lead@e.com' });

  // Captura o payload do Resend (global fetch).
  const realFetch = global.fetch;
  let resendPayload = null;
  global.fetch = async (_url, opts) => {
    resendPayload = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ id: 're-1' }) };
  };
  const workers = require('../outreach-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(() => ({ add: async () => ({ id: 'j' }), getJob: async () => null }));
  try {
    const result = await workers.processSend({ data: { messageId: 'msg-1' }, attemptsMade: 0, opts: { attempts: 3 }, id: 'j1' });
    assert.equal(result.messageId, 're-1', 'envio concluído via provider');
    assert.ok(resendPayload, 'provider chamado');
    assert.equal(resendPayload.attachments.length, 1, 'anexo ilegível ficou fora (fail-safe)');
    assert.equal(resendPayload.attachments[0].filename, 'um.pdf');
    assert.equal(Buffer.from(resendPayload.attachments[0].content, 'base64').toString(), fileContent.toString(), 'bytes reais do storage');
    assert.equal(resendPayload.attachments[0].content_type, 'application/pdf');

    // Gmail não monta MIME multipart → degrada EXPLICÁVEL (mensagem sai sem anexo).
    const gmailAccount = { ...prisma.emailAccount.rows[0], provider: 'gmail' };
    const gmailPrisma = { emailAccount: { findUnique: async () => gmailAccount, update: async () => {} } };
    const gmailApi = require('../gmail-api');
    const originalSendEmail = gmailApi.sendEmail;
    let gmailParams = null;
    gmailApi.sendEmail = async (_prisma, _accountId, params) => {
      gmailParams = params;
      return { gmailMessageId: 'g-1', gmailThreadId: null };
    };
    try {
      const degraded = await require('../email-provider').sendEmailForAccount(gmailPrisma, 'ea-1', {
        to: 'lead@e.com', subject: 'Oi', body: 'corpo', messageId: 'mid-1',
        attachments: [{ fileName: 'um.pdf', content: Buffer.from('x').toString('base64'), contentType: 'application/pdf' }],
      });
      assert.ok(gmailParams, 'gmail sendEmail chamado');
      assert.equal(gmailParams.attachments, undefined, 'anexo NÃO passado ao transport sem suporte');
      assert.deepEqual(degraded.attachmentsSkipped, [{ fileName: 'um.pdf', reason: 'provider_sem_suporte' }], 'fato registrado');
    } finally {
      gmailApi.sendEmail = originalSendEmail;
    }
    void gmailAccount; void gmailPrisma;
  } finally {
    global.fetch = realFetch;
    delete process.env.OUTREACH_ALLOWED_HOURS_START;
    delete process.env.OUTREACH_ALLOWED_HOURS_END;
    delete process.env.RESEND_API_KEY;
  }
});

// ── Story 2.3 (V3/D8): mídia no processSend do WhatsApp ──────────────────────

function seedWhatsAppMotor(prisma, studioAttachments) {
  prisma.whatsAppCampaignContact = {
    rows: [{ id: 'cc-1', campaignId: 'wcamp-1', prospectId: 'lead-1', status: 'SENDING', currentStepIndex: 0 }],
    async findUnique({ where }) {
      return this.rows.find((r) => r.id === where.id) || null;
    },
    async update({ where, data }) {
      const row = this.rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
    async count() {
      return 1; // há contatos ativos — campanha não completa
    },
  };
  // O motor lê os steps por este nome (whatsAppSequenceStep) — vazio: fim da
  // sequência após o envio.
  prisma.whatsAppSequenceStep = { findMany: async () => [] };
  prisma.whatsappCampaign.rows.push({ id: 'wcamp-1', orgId: 'org-1', status: 'RUNNING', studioAttachments });
  prisma.whatsAppMessage = {
    rows: [{
      id: 'wmsg-1', orgId: 'org-1', campaignContactId: 'cc-1', conversationId: 'conv-1',
      status: 'PENDING', content: 'Oi! Olha o material', stepIndex: 0,
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
}

test('V3: mídia no processSend — imagem via sendMedia com legenda da peça (D8)', async () => {
  const dir = useTempStorage();
  const png = Buffer.from('PNG-dados-da-imagem');
  const prisma = seedOrg(createFakePrisma());
  seedWhatsAppMotor(prisma, [{ attachmentId: 'att-1', fileName: writeFile(dir, 'img.png', png), originalName: 'material.png', mimeType: 'image/png', sizeBytes: png.length }]);
  prisma.whatsAppMessage.rows[0].stepIndex = null; // mensagem de 1º toque sem step de sequência

  const workers = require('../whatsapp-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests({ sequence: { add: async () => ({ id: 'j' }) }, send: { add: async () => ({ id: 'j' }) } });
  const waha = require('../waha-provider');
  const originalSendMedia = waha.WAHAWhatsAppProvider.sendMedia;
  const originalSendText = waha.WAHAWhatsAppProvider.sendText;
  const calls = { media: [], text: 0 };
  waha.WAHAWhatsAppProvider.sendMedia = async (session, chatId, media) => {
    calls.media.push({ session, chatId, media });
    return { providerMessageId: 'wa-1' };
  };
  waha.WAHAWhatsAppProvider.sendText = async () => {
    calls.text += 1;
    return { providerMessageId: 'wa-text' };
  };
  try {
    await workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 0, opts: { attempts: 5 }, id: 'j1' });
    assert.equal(calls.media.length, 1, 'sendMedia usado (não sendText)');
    assert.equal(calls.text, 0, 'sem mensagem de texto duplicada');
    const call = calls.media[0];
    assert.equal(call.media.kind, 'image', 'imagem → sendImage');
    assert.equal(call.media.fileName, 'material.png');
    assert.equal(call.media.caption, 'Oi! Olha o material', 'texto da peça como legenda');
    assert.equal(Buffer.from(call.media.data, 'base64').toString(), png.toString(), 'bytes lidos do storage no send');
    assert.equal(prisma.whatsAppMessage.rows[0].status, 'SENT');

    // Documento (mime não-imagem) → sendFile.
    calls.media.length = 0;
    prisma.whatsAppMessage.rows[0].status = 'PENDING';
    prisma.whatsappCampaign.rows[0].studioAttachments = [{ attachmentId: 'att-2', fileName: writeFile(dir, 'rel.pdf', 'PDF'), originalName: 'rel.pdf', mimeType: 'application/pdf', sizeBytes: 3 }];
    await workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 0, opts: { attempts: 5 }, id: 'j2' });
    assert.equal(calls.media[0].media.kind, 'document', 'documento → sendFile');
  } finally {
    waha.WAHAWhatsAppProvider.sendMedia = originalSendMedia;
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }
});

test('V3: follow-up (stepIndex > 0) NUNCA leva mídia — sai como texto (guard do 1º toque)', async () => {
  const dir = useTempStorage();
  const png = Buffer.from('PNG-followup');
  const prisma = seedOrg(createFakePrisma());
  seedWhatsAppMotor(prisma, [{ attachmentId: 'att-1', fileName: writeFile(dir, 'img.png', png), originalName: 'img.png', mimeType: 'image/png', sizeBytes: png.length }]);
  // Follow-up: step do motor 1 (2º toque).
  prisma.whatsAppMessage.rows[0].stepIndex = 1;
  prisma.whatsAppMessage.rows[0].content = 'Follow-up sem mídia';

  const workers = require('../whatsapp-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests({ sequence: { add: async () => ({ id: 'j' }) }, send: { add: async () => ({ id: 'j' }) } });
  const waha = require('../waha-provider');
  const originalSendMedia = waha.WAHAWhatsAppProvider.sendMedia;
  const originalSendText = waha.WAHAWhatsAppProvider.sendText;
  const calls = { media: 0, text: [] };
  waha.WAHAWhatsAppProvider.sendMedia = async (_s, _c, media) => {
    calls.media += 1;
    return { providerMessageId: 'wa-media' };
  };
  waha.WAHAWhatsAppProvider.sendText = async (_s, _c, text) => {
    calls.text.push(text);
    return { providerMessageId: 'wa-text' };
  };
  try {
    await workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 0, opts: { attempts: 5 }, id: 'j1' });
    assert.equal(calls.media, 0, 'follow-up não anexa mídia');
    assert.deepEqual(calls.text, ['Follow-up sem mídia'], 'sai como texto puro');
    assert.equal(prisma.whatsAppMessage.rows[0].status, 'SENT');
  } finally {
    waha.WAHAWhatsAppProvider.sendMedia = originalSendMedia;
    waha.WAHAWhatsAppProvider.sendText = originalSendText;
  }
});

test('V3: arquivo de mídia ausente → falha segura (FAILED + estorno idempotente, E11)', async () => {
  useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'unified', balance: 19, floor: 0, ceiling: 30, rampStage: 0, domainAuthStatus: 'unverified' });
  prisma.studioReputationEvent.rows.push({ id: 'ev-1', orgId: 'org-1', channel: 'whatsapp', type: 'debit', amount: 1, balanceAfter: 19, refType: 'batch', refId: 'batch-1' });
  seedWhatsAppMotor(prisma, [{ attachmentId: 'att-x', fileName: 'sumiu.png', originalName: 'sumiu.png', mimeType: 'image/png', sizeBytes: 5 }]);
  prisma.whatsAppMessage.rows[0].stepIndex = null;
  const workers = require('../whatsapp-workers');
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests({ sequence: { add: async () => ({ id: 'j' }) }, send: { add: async () => ({ id: 'j' }) } });
  await assert.rejects(
    workers.processSend({ data: { messageId: 'wmsg-1' }, attemptsMade: 4, opts: { attempts: 5 }, id: 'j1' }),
    /ilegível/
  );
  assert.equal(prisma.whatsAppMessage.rows[0].status, 'FAILED');
  assert.ok(prisma.studioReputationEvent.rows.find((e) => e.type === 'credit' && e.refId === 'wmsg-1'), 'estorno idempotente (AD-13)');
});

test('erro na resolução de anexos NUNCA falha o lote — segue sem anexo, com log (fail-safe)', async () => {
  useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  const campaign = seedCampaignWithExecution(prisma);
  // Storage/leitura de anexos indisponível: o lote ainda entra em voo.
  prisma.studioAttachment = {
    findMany: async () => {
      throw new Error('storage indisponível');
    },
  };
  const enqueued = [];
  const result = await bridge.enqueueBatch(prisma, {
    campaign,
    channel: 'email',
    prospectIds: ['lead-1'],
    now: new Date('2026-09-30T12:00:00Z'),
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.enqueued.length, 1, 'lote liberado mesmo com erro na resolução');
  assert.deepEqual(result.attachments.included, [], 'segue SEM anexo');
  const execution = prisma.outreachCampaign.rows.find((r) => r.id === 'exec-1');
  assert.deepEqual(execution.studioAttachments, [], 'execução intacta (nada persistido do erro)');
});

test('remoção com dedup SHA-256: arquivo só sai quando o ÚLTIMO anexo irmão sai', async () => {
  const dir = useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  seedCampaignWithExecution(prisma);
  const { server, upload, api } = await startServer(prisma);
  try {
    // Mesmo conteúdo → mesmo SHA-256 → mesmo fileName no storage.
    const bytes = Buffer.from('%PDF-identico');
    const first = await upload('/campaigns/camp-1/attachments', 'a.pdf', bytes, {});
    const second = await upload('/campaigns/camp-1/attachments', 'b.pdf', bytes, {});
    assert.equal(first.res.status, 201);
    assert.equal(second.res.status, 201);
    assert.equal(first.body.data.fileName, second.body.data.fileName, 'dedup por conteúdo');

    const del1 = await api('DELETE', `/campaigns/camp-1/attachments/${first.body.data.id}`);
    assert.equal(del1.res.status, 200);
    assert.equal(del1.body.data.fileKept, true, 'irmão mantém o arquivo vivo');
    assert.ok(fs.existsSync(path.join(dir, first.body.data.fileName)), 'arquivo NÃO apagado com irmão');

    const del2 = await api('DELETE', `/campaigns/camp-1/attachments/${second.body.data.id}`);
    assert.equal(del2.res.status, 200);
    assert.equal(del2.body.data.fileKept, false, 'último da fila remove o arquivo');
    assert.ok(!fs.existsSync(path.join(dir, first.body.data.fileName)));
  } finally {
    server.close();
  }
});

test('attach_files em anexo de OUTRA campanha → 409 (nunca re-parenta silenciosamente)', async () => {
  useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  seedCampaignWithExecution(prisma);
  prisma.studioAttachment.rows.push({ id: 'att-outro', orgId: 'org-1', campaignId: 'camp-2', fileName: 'x.pdf', originalName: 'x.pdf', sizeBytes: 1, channels: 'both' });
  const { server, api } = await startServer(prisma);
  try {
    const { res, body } = await api('POST', '/campaigns/camp-1/actions', {
      type: 'attach_files',
      actionId: 'tap-reparent',
      params: { attachmentIds: ['att-outro'] },
    });
    assert.equal(res.status, 409);
    assert.equal(body.error, 'ATTACHMENT_IN_OTHER_CAMPAIGN');
    assert.equal(prisma.studioAttachment.rows.find((a) => a.id === 'att-outro').campaignId, 'camp-2', 'vínculo intacto');
  } finally {
    server.close();
  }
});

test('canal destino inválido no upload → 400 INVALID_ATTACHMENT_CHANNEL (nunca coerção silenciosa)', async () => {
  useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  seedCampaignWithExecution(prisma);
  const { server, upload } = await startServer(prisma);
  try {
    const { res, body } = await upload('/campaigns/camp-1/attachments', 'f.png', Buffer.from('png'), { channels: 'tiktok' });
    assert.equal(res.status, 400);
    assert.equal(body.error, 'INVALID_ATTACHMENT_CHANNEL');
  } finally {
    server.close();
  }
});

// ── Story 2.4 (D7): materiais por campanha ───────────────────────────────────

test('materiais por campanha: listagem separa os da campanha, anexos e os da org (D7/FR7)', async () => {
  useTempStorage();
  const prisma = seedOrg(createFakePrisma());
  seedCampaignWithExecution(prisma);
  prisma.studioMaterial.rows.push(
    { id: 'mat-1', orgId: 'org-1', campaignId: 'camp-1', kind: 'pdf', sourceRef: 'a.pdf', extractionStatus: 'extracted', extractionError: null, confirmedAt: new Date(), uploadedById: 'user-1' },
    { id: 'mat-2', orgId: 'org-1', campaignId: 'camp-1', kind: 'video', sourceRef: null, extractionStatus: 'failed', extractionError: 'Transcrição indisponível', uploadedById: 'user-1' },
    { id: 'mat-3', orgId: 'org-1', campaignId: null, kind: 'url', sourceRef: 'https://exemplo.com', extractionStatus: 'extracted', uploadedById: 'user-1' }
  );
  prisma.studioAttachment.rows.push({ id: 'att-1', orgId: 'org-1', campaignId: 'camp-1', fileName: 'f.png', originalName: 'folder.png', mimeType: 'image/png', sizeBytes: 3, channels: 'both' });
  const { server, api } = await startServer(prisma);
  try {
    const { res, body } = await api('GET', '/campaigns/camp-1/materials');
    assert.equal(res.status, 200);
    assert.deepEqual(body.data.campaignMaterials.map((m) => m.id), ['mat-1', 'mat-2'], 'só os da campanha');
    assert.deepEqual(body.data.attachments.map((a) => a.id), ['att-1'], 'anexos prontos à parte');
    assert.deepEqual(body.data.orgMaterials.map((m) => m.id), ['mat-3'], 'materiais da org rotulados à parte');
    assert.equal(body.data.scope, undefined);
    assert.equal(body.data.campaignMaterials.find((m) => m.id === 'mat-2').extractionError, 'Transcrição indisponível', 'falha de extração NUNCA some (PS1)');
  } finally {
    server.close();
  }
});
