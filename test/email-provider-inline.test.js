'use strict';

/**
 * test/email-provider-inline.test.js — banner do Studio EMBUTIDO no e-mail
 * (2026-10-27). O src das imagens /media no HTML vira `cid:` e os bytes vão
 * como anexo inline — a imagem chega DENTRO da mensagem, mesmo sem APP_URL
 * público (localhost nunca é alcançável pelo cliente de e-mail do lead).
 * Resend via fetch stub; SMTP via nodemailer capturado. Gmail API mantém o
 * src remoto (sem suporte a anexo — degradação explicável).
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');

process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || 'a'.repeat(64);

const emailProvider = require('../email-provider');
const { encrypt } = require('../gmail-auth');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SRC = 'https://app.b2base.net/media/abcdefabcdefabcdefabcdefabcdef12.png';
const HTML = `<html><body><p>Olá</p><img src="${SRC}" alt="Banner" /><p><a href="https://wa.me/5512996399943">Fale</a></p></body></html>`;
const INLINE = [{
  cid: 'banner-abcdefabcdefabcdefabcdefabcdef12',
  fileName: 'abcdefabcdefabcdefabcdefabcdef12.png',
  embedFileName: 'abcdefabcdefabcdefabcdefabcdef12.png',
  content: PNG_B64,
  contentType: 'image/png',
  originalSrc: SRC,
}];

function fakePrismaWithAccount(account) {
  const prisma = createFakePrisma();
  prisma.emailAccount.rows.push({ status: 'connected', ...account });
  return prisma;
}

test('Resend: banner /media sai EMBUTIDO — html com cid: e anexo com content_id', async () => {
  let captured = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/emails')) {
      captured = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ id: 'resend-1' }) };
    }
    throw new Error(`fetch inesperado no teste: ${url}`);
  };
  try {
    const prisma = fakePrismaWithAccount({
      id: 'ea-resend', provider: 'resend', email: 'vendas@empresa.com',
      encryptedSecret: encrypt('re_chave_teste'),
    });
    await emailProvider.sendEmailForAccount(prisma, 'ea-resend', {
      to: 'lead@angular.com',
      subject: 'S',
      body: 'texto',
      htmlBody: HTML,
      inlineImages: INLINE,
      messageId: 'teste-inline-1',
    });
    assert.ok(captured, 'payload capturado');
    assert.ok(captured.html.includes('cid:banner-abcdefabcdefabcdefabcdefabcdef12'), 'src virou cid:');
    assert.ok(!captured.html.includes(SRC), 'src remoto removido do html');
    const inline = (captured.attachments || []).find((a) => a.content_id);
    assert.ok(inline, 'anexo inline com content_id');
    assert.equal(inline.content_id, 'banner-abcdefabcdefabcdefabcdefabcdef12');
    assert.equal(inline.content, PNG_B64);
    assert.equal(inline.content_type, 'image/png');
    // O CTA do botão permanece link real (não é imagem).
    assert.ok(captured.html.includes('https://wa.me/5512996399943'));
  } finally {
    globalThis.fetch = original;
  }
});

test('SMTP: banner /media sai EMBUTIDO — attachment com cid + contentDisposition inline', async () => {
  const nodemailer = require('nodemailer');
  const originalCreate = nodemailer.createTransport;
  let sentMail = null;
  nodemailer.createTransport = () => ({
    async sendMail(mail) {
      sentMail = mail;
      return { messageId: '<smtp@teste>' };
    },
  });
  try {
    const prisma = fakePrismaWithAccount({
      id: 'ea-smtp', provider: 'smtp', email: 'vendas@empresa.com',
      encryptedSecret: encrypt('senha-de-app'),
      smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpSecure: false,
    });
    await emailProvider.sendEmailForAccount(prisma, 'ea-smtp', {
      to: 'lead@angular.com',
      subject: 'S',
      body: 'texto',
      htmlBody: HTML,
      inlineImages: INLINE,
      messageId: 'teste-inline-2',
    });
    assert.ok(sentMail, 'sendMail capturado');
    assert.ok(sentMail.html.includes('cid:banner-abcdefabcdefabcdefabcdefabcdef12'), 'src virou cid:');
    assert.ok(!sentMail.html.includes(SRC), 'src remoto removido do html');
    const inline = (sentMail.attachments || []).find((a) => a.cid);
    assert.ok(inline, 'attachment com cid');
    assert.equal(inline.contentDisposition, 'inline');
    assert.equal(inline.contentType, 'image/png');
    assert.ok(inline.content instanceof Buffer, 'bytes decodificados');
  } finally {
    nodemailer.createTransport = originalCreate;
  }
});

test('SEM banner no html: inlineImages vazio não muda nada (cta/link intactos)', async () => {
  let captured = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/emails')) {
      captured = JSON.parse(String(opts.body || '{}'));
      return { ok: true, status: 200, json: async () => ({ id: 'resend-2' }) };
    }
    throw new Error(`fetch inesperado no teste: ${url}`);
  };
  try {
    const prisma = fakePrismaWithAccount({
      id: 'ea-resend-2', provider: 'resend', email: 'vendas@empresa.com',
      encryptedSecret: encrypt('re_chave_teste'),
    });
    await emailProvider.sendEmailForAccount(prisma, 'ea-resend-2', {
      to: 'lead@angular.com',
      subject: 'S',
      body: 'texto',
      htmlBody: '<p>Sem imagem</p>',
      inlineImages: [],
      messageId: 'teste-inline-3',
    });
    assert.equal(captured.html, '<p>Sem imagem</p>', 'html intacto');
    assert.ok(!(captured.attachments || []).some((a) => a.content_id), 'nenhum inline');
  } finally {
    globalThis.fetch = original;
  }
});
