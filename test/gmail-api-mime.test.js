'use strict';

/**
 * test/gmail-api-mime.test.js — mensagem MIME da Gmail API com anexos REAIS
 * (2026-10-27): multipart/mixed com as partes base64 — as fotos chegam
 * BAIXÁVEIS no destinatário (não links, não imagens no texto).
 */

const test = require('node:test');
const assert = require('node:assert');
const { buildMimeMessage } = require('../gmail-api');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('com anexos: multipart/mixed com alternative + partes base64 nomeadas', () => {
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@empresa.com',
    subject: 'Fotos do produto',
    messageIdHeader: '<fotos-1@gmail.com>',
    body: 'Seguem as fotos.',
    htmlBody: '<p>Seguem as fotos.</p>',
    attachments: [
      { fileName: 'foto-1.png', content: PNG_B64, contentType: 'image/png' },
      { fileName: 'foto-2.jpg', content: PNG_B64, contentType: 'image/jpeg' },
    ],
  });

  assert.ok(mime.includes('Content-Type: multipart/mixed'), 'raiz é mixed (tem anexo)');
  assert.ok(mime.includes('Content-Disposition: attachment; filename="foto-1.png"'), 'foto-1 como anexo baixável');
  assert.ok(mime.includes('filename="foto-2.jpg"'), 'foto-2 presente');
  assert.ok(mime.includes('Content-Transfer-Encoding: base64'), 'anexos em base64');
  assert.ok(mime.includes('multipart/alternative'), 'corpo texto+html preservado');
  assert.ok(mime.includes('Message-ID: <fotos-1@gmail.com>'), 'header Message-ID');
  // O conteúdo base64 das fotos está na mensagem.
  assert.ok(mime.includes(PNG_B64.slice(0, 40)), 'bytes das fotos na mensagem');
});

test('sem anexos: mantém o formato simples de sempre (sem mixed)', () => {
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@empresa.com',
    subject: 'S',
    messageIdHeader: '<m@gmail.com>',
    body: 'texto',
    htmlBody: '<p>html</p>',
    attachments: [],
  });
  assert.ok(!mime.includes('multipart/mixed'), 'sem anexo, sem mixed');
  assert.ok(mime.includes('multipart/alternative'));
});

test('sem html: alternativa vira só text/plain dentro do mixed', () => {
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@empresa.com',
    subject: 'S',
    body: 'texto',
    htmlBody: null,
    attachments: [{ fileName: 'f.png', content: PNG_B64, contentType: 'image/png' }],
  });
  assert.ok(mime.includes('multipart/mixed'));
  assert.ok(mime.includes('Content-Type: text/plain; charset=UTF-8'));
  assert.ok(!mime.includes('multipart/alternative'), 'sem html não abre alternative');
});

test('filename com CR/LF não injeta headers (linhas do MIME permanecem íntegras)', () => {
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'a@b.com',
    subject: 'S',
    body: 'x',
    attachments: [{ fileName: 'mau\r\nBcc: vitima@x.com.png', content: PNG_B64, contentType: 'image/png' }],
  });
  // Nenhuma linha do MIME pode ter virado header injetado pelo filename.
  const lines = mime.split('\r\n');
  assert.ok(lines.every((line) => !line.startsWith('Bcc:')), 'nenhuma linha Bcc injetada');
  assert.ok(lines.every((line) => !line.startsWith('To: vitima@x.com')), 'nenhum destinatário injetado');
  // Aspas duplas removidas do filename (não fecha o quoted-string cedo).
  assert.ok(!mime.includes('""'), 'sem aspas duplas de filename');
  const disposition = lines.find((line) => line.startsWith('Content-Disposition: attachment'));
  assert.ok(disposition && disposition.includes('mau'), 'filename preservado (com CR/LF virados espaço)');
});

// ── 2026-10-27: imagens INLINE (banner embutido por CID) — multipart/related ─

test('com imagem INLINE: multipart/related com Content-ID batendo com o cid do HTML', () => {
  const cid = 'banner-abcdefabcdefabcdefabcdefabcdef12';
  const html = `<html><body><img src="cid:${cid}" alt="banner" /><a href="https://wa.me/5512996399943">Fale</a></body></html>`;
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@empresa.com',
    subject: 'S',
    messageIdHeader: '<m@gmail.com>',
    body: 'texto',
    htmlBody: html,
    attachments: [],
    inlineImages: [
      { cid, fileName: 'banner.png', embedFileName: 'banner.png', content: PNG_B64, contentType: 'image/png' },
    ],
  });
  assert.ok(mime.includes('multipart/related'), 'related direto (sem anexos comuns)');
  assert.ok(mime.includes(`Content-ID: <${cid}>`), 'Content-ID da imagem');
  assert.ok(mime.includes(`src="cid:${cid}"`), 'HTML referencia o MESMO cid');
  assert.ok(mime.includes('Content-Disposition: inline'), 'disposição inline');
  assert.ok(!mime.includes('multipart/mixed'), 'sem anexos comuns, sem mixed');
  assert.ok(mime.includes('https://wa.me/5512996399943'), 'CTA preservado no html');
});

test('imagem inline + anexo comum → mixed contendo related (os dois convivem)', () => {
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@empresa.com',
    subject: 'S',
    body: 'texto',
    htmlBody: '<img src="cid:banner-x" />',
    attachments: [{ fileName: 'catalogo.pdf', content: PNG_B64, contentType: 'application/pdf' }],
    inlineImages: [{ cid: 'banner-x', fileName: 'b.png', embedFileName: 'b.png', content: PNG_B64, contentType: 'image/png' }],
  });
  assert.ok(mime.includes('multipart/mixed'));
  assert.ok(mime.includes('multipart/related'), 'related dentro do mixed');
  assert.ok(mime.includes('Content-ID: <banner-x>'));
  assert.ok(mime.includes('filename="catalogo.pdf"'), 'anexo comum preservado');
});

test('Content-ID do MIME corresponde 1:1 aos src cid: do HTML (contra desencontro)', () => {
  const cid = 'banner-11112222333344445555666677778888';
  const html = `<img src="cid:${cid}" /><img src="cid:outro-id" />`;
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'a@b.com',
    subject: 'S',
    body: 'x',
    htmlBody: html,
    attachments: [],
    inlineImages: [
      { cid, fileName: 'a.png', embedFileName: 'a.png', content: PNG_B64, contentType: 'image/png' },
      { cid: 'outro-id', fileName: 'b.png', embedFileName: 'b.png', content: PNG_B64, contentType: 'image/png' },
    ],
  });
  const idsNoMime = (mime.match(/Content-ID: <([^>]+)>/g) || []).sort();
  assert.deepEqual(idsNoMime, [`Content-ID: <${cid}>`, 'Content-ID: <outro-id>'], 'todo cid do HTML tem parte related');
});
