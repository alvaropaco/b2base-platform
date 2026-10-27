'use strict';

/**
 * test/gmail-photos.test.js — envio de FOTOS por Gmail (2026-10-27).
 * Validações TODAS no servidor; "enviado" só com messageId da API.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const photos = require('../gmail-photos');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');

const makePhoto = (name, mimetype, buffer = PNG) => ({
  originalname: name,
  mimetype,
  size: buffer.length,
  buffer,
});

// ── validatePhotoPayload ─────────────────────────────────────────────────────

test('payload válido → anexos base64 prontos e total contabilizado', () => {
  const check = photos.validatePhotoPayload({
    to: 'cliente@empresa.com',
    photos: [makePhoto('foto1.png', 'image/png'), makePhoto('foto2.jpg', 'image/jpeg')],
  });
  assert.equal(check.ok, true);
  assert.equal(check.recipient, 'cliente@empresa.com');
  assert.equal(check.attachments.length, 2);
  assert.ok(check.attachments[0].content.length > 0, 'bytes base64 presentes');
  assert.equal(check.attachments[0].contentType, 'image/png');
  assert.ok(check.totalBytes > 0);
});

test('destinatário inválido → 400 com mensagem clara', () => {
  const check = photos.validatePhotoPayload({ to: 'nao-e-email', photos: [makePhoto('a.png', 'image/png')] });
  assert.equal(check.ok, false);
  assert.equal(check.status, 400);
  assert.match(check.error, /Destinatário inválido/);
});

test('sem fotos / excesso de fotos → 400', () => {
  assert.equal(photos.validatePhotoPayload({ to: 'a@b.com', photos: [] }).status, 400);
  const many = Array.from({ length: photos.MAX_PHOTOS + 1 }, (_, i) => makePhoto(`f${i}.png`, 'image/png'));
  assert.equal(photos.validatePhotoPayload({ to: 'a@b.com', photos: many }).status, 400);
});

test('extensão ou mime fora da lista → 400 nomeando o arquivo', () => {
  const pdf = photos.validatePhotoPayload({ to: 'a@b.com', photos: [makePhoto('doc.pdf', 'application/pdf')] });
  assert.equal(pdf.ok, false);
  assert.match(pdf.error, /doc\.pdf/);
  const mime = photos.validatePhotoPayload({ to: 'a@b.com', photos: [makePhoto('gato.png', 'application/octet-stream')] });
  assert.equal(mime.ok, false, 'mime não confiável é recusado mesmo com extensão ok');
});

test('foto maior que 10 MB e conjunto acima do teto → 413 ANTES do envio', () => {
  const big = Buffer.alloc(photos.MAX_FILE_BYTES + 1, 1);
  const over = photos.validatePhotoPayload({ to: 'a@b.com', photos: [makePhoto('grande.png', 'image/png', big)] });
  assert.equal(over.status, 413);
  const parts = Array.from({ length: 5 }, (_, i) => makePhoto(`p${i}.png`, 'image/png', Buffer.alloc(4 * 1024 * 1024, 2)));
  const total = photos.validatePhotoPayload({ to: 'a@b.com', photos: parts });
  assert.equal(total.status, 413, 'total acumulado acima do teto é recusado');
});

// ── sendPhotos (orquestração) ────────────────────────────────────────────────

test('sendPhotos: usa a conta Gmail conectada do usuário e confirma com messageId', async () => {
  const prisma = createFakePrisma();
  prisma.emailAccount.rows.push({
    id: 'ea-1', userId: 'user-1', provider: 'gmail', status: 'connected', email: 'eu@gmail.com',
  });
  const calls = [];
  const emailProvider = {
    sendEmailForAccount: async (_p, accountId, payload) => {
      calls.push({ accountId, payload });
      return { messageId: '<fotos-1@gmail.com>', threadId: null };
    },
  };
  const result = await photos.sendPhotos(
    { prisma, emailProvider },
    { userId: 'user-1', to: 'cliente@empresa.com', subject: 'Fotos', message: 'Segue', photos: [makePhoto('f.png', 'image/png')] }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountId, 'ea-1');
  assert.equal(calls[0].payload.attachments.length, 1);
  assert.equal(result.messageId, '<fotos-1@gmail.com>');
  assert.equal(result.from, 'eu@gmail.com');
  assert.equal(result.count, 1);
});

test('sendPhotos: sem conta Gmail conectada → 409 pedindo conexão', async () => {
  const prisma = createFakePrisma();
  let called = false;
  const emailProvider = { sendEmailForAccount: async () => { called = true; } };
  await assert.rejects(
    photos.sendPhotos({ prisma, emailProvider }, { userId: 'user-2', to: 'a@b.com', photos: [makePhoto('f.png', 'image/png')] }),
    (err) => err.status === 409 && /Conectar com Google/.test(err.message)
  );
  assert.equal(called, false, 'nada é enviado sem conta');
});

test('sendPhotos: falha da Gmail API NÃO é "enviado" (erro propaga)', async () => {
  const prisma = createFakePrisma();
  prisma.emailAccount.rows.push({ id: 'ea-3', userId: 'user-1', provider: 'gmail', status: 'connected', email: 'eu@gmail.com' });
  const emailProvider = {
    sendEmailForAccount: async () => {
      const err = new Error('Gmail API 500 backend error');
      err.status = 500;
      throw err;
    },
  };
  await assert.rejects(
    photos.sendPhotos({ prisma, emailProvider }, { userId: 'user-1', to: 'a@b.com', photos: [makePhoto('f.png', 'image/png')] }),
    /Gmail API 500/
  );
});

test('pickGmailAccount: só contas do PRÓPRIO usuário (escopo)', async () => {
  const prisma = createFakePrisma();
  prisma.emailAccount.rows.push({ id: 'ea-9', userId: 'outro-user', provider: 'gmail', status: 'connected', email: 'outro@gmail.com' });
  const account = await photos.pickGmailAccount(prisma, 'user-1');
  assert.equal(account, null, 'conta de outro usuário não é usada');
});
