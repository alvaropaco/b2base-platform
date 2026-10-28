'use strict';

/**
 * test/studio-email-inline.test.js — banner EMBUTIDO (2026-10-27): as
 * imagens /media do HTML viram anexo inline (CID) para o banner abrir em
 * qualquer cliente de e-mail, mesmo sem APP_URL público (localhost nunca é
 * alcançável pelo cliente do lead). Falha segura: arquivo ausente → src
 * remoto permanece.
 */

const test = require('node:test');
const assert = require('node:assert');
const { extractInlineImages, applyCid } = require('../studio/email-inline');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');

const FILES = {
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png': PNG,
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg': JPG,
};

const io = { readGenerated: (name) => FILES[name] };

test('extrai imagens /media únicas com bytes e content-type certos', () => {
  const html = `<p>x</p>
    <img src="https://app.b2base.net/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" alt="a" />
    <img src="https://app.b2base.net/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" alt="a de novo" />
    <img src="https://app.b2base.net/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.jpg" alt="b" />`;
  const { html: out, inlineImages } = extractInlineImages(html, io);
  assert.equal(out, html, 'html volta INTACTO (troca por cid é do provider)');
  assert.equal(inlineImages.length, 2, 'dedupe por arquivo');
  assert.equal(inlineImages[0].contentType, 'image/png');
  assert.equal(inlineImages[1].contentType, 'image/jpeg');
  assert.deepEqual(Buffer.from(inlineImages[0].content, 'base64'), PNG, 'bytes do png');
  assert.ok(inlineImages[0].cid.startsWith('banner-'), 'cid determinístico');
  assert.ok(inlineImages[0].originalSrc.includes('/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'), 'src original para a troca');
});

test('arquivo AUSENTE → sai da lista (src remoto permanece, nada quebra)', () => {
  const html = '<img src="https://app.b2base.net/media/cccccccccccccccccccccccccccccccc.png" />';
  const { inlineImages } = extractInlineImages(html, io);
  assert.equal(inlineImages.length, 0, 'arquivo ausente não embarca');
});

test('html sem /media e entrada inválida → lista vazia', () => {
  assert.deepEqual(extractInlineImages('<p>sem imagem</p>', io).inlineImages, []);
  assert.deepEqual(extractInlineImages('', io).inlineImages, []);
  assert.deepEqual(extractInlineImages(HTML_FIXTURE, null).inlineImages, [], 'sem readGenerated não explode');
});
const HTML_FIXTURE = '<img src="https://app.b2base.net/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" />';

test('applyCid: troca TODAS as ocorrências do mesmo src pelo cid', () => {
  const html = `<img src="https://app.b2base.net/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" />
    <a href="https://app.b2base.net/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png">link</a>`;
  const { inlineImages } = extractInlineImages(html, io);
  const out = applyCid(html, inlineImages);
  assert.ok(out.includes('cid:banner-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaapng'.slice(0, 41) + 'png') || out.includes('cid:'), 'src virou cid');
  assert.ok(!out.includes('/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'), 'nenhum src remoto sobra');
  // applyCid SEM inline não altera nada (Gmail API mantém o src remoto).
  assert.equal(applyCid(html, []), html);
});

// ── src RELATIVO também embute (ambiente sem APP_URL) ────────────────────────
test('src relativo /media/<hash> é extraído igualmente (sem depender de host)', () => {
  const html = '<img src="/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" />';
  const { inlineImages } = extractInlineImages(html, io);
  assert.equal(inlineImages.length, 1);
  assert.deepEqual(Buffer.from(inlineImages[0].content, 'base64'), PNG);
  assert.match(inlineImages[0].originalSrc, /^\/media\//);
});
