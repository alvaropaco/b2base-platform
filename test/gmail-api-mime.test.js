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
