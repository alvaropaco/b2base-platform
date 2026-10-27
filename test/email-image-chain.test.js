'use strict';

/**
 * test/email-image-chain.test.js — CADEIA COMPLETA da imagem (2026-10-27,
 * auditoria do dono): storage → emailDoc → render → inline → MIME.
 *
 * Comprova, com BYTES, que a mesma imagem criada/anexada no Cockpit chega
 * dentro da mensagem (CID), com o botão clicável e a URL do CTA íntegra —
 * sem nova geração e sem depender de URL pública.
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'email-image-chain-'));
process.env.STUDIO_STORAGE_DIR = TMP;

const storage = require('../studio/storage');
const { emailDocToHtml } = require('../studio/channel-bridge');
const { extractInlineImages, applyCid } = require('../studio/email-inline');
const { buildMimeMessage } = require('../gmail-api');

const LEAD = { contactName: 'Ana Souza', companyName: 'Construtora Angular', city: 'São José' };
const WA = 'https://wa.me/5512996399943';

// Bytes REAIS do banner que o dono gerou no Cockpit (sobrevive no storage
// local desde 2026-10-22 — a prova de que NÃO é nova geração).
const REAL_BANNER_PATH = path.join(process.cwd(), '.data', 'studio', 'generated', '6dc5b6076e98b16174982db4fe01fe6a.png');
const HAS_REAL_BANNER = fs.existsSync(REAL_BANNER_PATH);
const REAL_BANNER = HAS_REAL_BANNER ? fs.readFileSync(REAL_BANNER_PATH) : null;

test('imagem GERADA no disco: bytes → emailDoc → render → inline → MIME', () => {
  // 1) A imagem EXISTE antes da renderização (storage público do Studio).
  const name = storage.saveGenerated(PNG_BYTES, 'png');
  assert.ok(storage.generatedExists(name), 'imagem existe no storage ANTES do render');

  // 2) "Campanha recuperada do banco" — emailDoc como JSONB (roundtrip real
  //    de StudioContent.emailDoc, incluindo o banner clicável e o botão).
  const emailDoc = JSON.parse(
    JSON.stringify({
      blocks: [
        { type: 'image', src: `https://qualquer-origem.com/media/${name}`, href: WA },
        { type: 'text', text: 'Olá {{firstName}}, tudo bem?' },
        { type: 'button', label: 'Falar com a gente no WhatsApp', url: WA, color: '#25D366' },
      ],
    })
  );

  // 3) Render POR LEAD — o MESMO renderizador da prévia do painel (SC-006).
  const html = emailDocToHtml(emailDoc, LEAD, {});
  assert.ok(html.includes(`<a href="${WA}"`), 'banner clicável para o WhatsApp');
  assert.ok(html.includes(`src="https://qualquer-origem.com/media/${name}"`), 'img referencia o arquivo REAL do storage');
  assert.ok(html.includes('background:#25d366'), 'botão verde do CTA no HTML');
  assert.ok(html.includes('Olá Ana'), 'variável resolvida por lead');

  // 4) Inline: bytes REAIS recuperados do storage (não URL inventada).
  const { inlineImages } = extractInlineImages(html, { readGenerated: storage.readGenerated });
  assert.equal(inlineImages.length, 1, 'banner único na lista');
  assert.deepEqual(Buffer.from(inlineImages[0].content, 'base64'), PNG_BYTES, 'bytes idênticos ao arquivo do storage');
  const cid = inlineImages[0].cid;

  // 5) MIME (Gmail API): html com cid aplicado + parte related com o MESMO cid.
  const htmlCid = applyCid(html, inlineImages);
  assert.ok(htmlCid.includes(`src="cid:${cid}"`), 'HTML final aponta para o cid');
  assert.ok(!htmlCid.includes(`/media/${name}`), 'nenhum src remoto sobra');
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@e.com',
    subject: 'S',
    messageIdHeader: '<m@e.com>',
    body: 'texto',
    htmlBody: htmlCid,
    attachments: [],
    inlineImages,
  });
  assert.ok(mime.includes('multipart/related'), 'estrutura related (imagem inline)');
  assert.ok(mime.includes(`Content-ID: <${cid}>`), 'Content-ID idêntico ao do HTML');
  assert.ok(mime.includes(PNG_BYTES.toString('base64').slice(0, 40)), 'bytes da imagem na mensagem');
  assert.ok(!mime.includes(`/media/${name}`), 'nenhum src remoto na mensagem');
  assert.ok(mime.includes(`href="${WA}"`), 'URL do botão preservada e não-escapada');
});

test('imagem ANEXADA promovida segue a MESMA cadeia (mesmo mecanismo saveGenerated)', () => {
  const name = storage.saveGenerated(PNG_BYTES, 'png');
  const html = emailDocToHtml({ blocks: [{ type: 'image', src: `https://x.com/media/${name}` }] }, LEAD, {});
  const { inlineImages } = extractInlineImages(html, { readGenerated: storage.readGenerated });
  assert.equal(inlineImages.length, 1);
  assert.deepEqual(Buffer.from(inlineImages[0].content, 'base64'), PNG_BYTES, 'mesmo arquivo, mesmos bytes');
});

test('WEBP e GIF também entram na cadeia (o regex antigo só via png/jpg)', () => {
  const webp = storage.saveGenerated(Buffer.from('RIFF0000WEBPVP8 ', 'binary'), 'webp');
  const gif = storage.saveGenerated(Buffer.from('GIF89a', 'binary'), 'gif');
  const html = `<img src="https://x.com/media/${webp}" /><img src="https://x.com/media/${gif}" />`;
  const { inlineImages } = extractInlineImages(html, { readGenerated: storage.readGenerated });
  assert.equal(inlineImages.length, 2, 'webp+gif extraídos');
  assert.ok(inlineImages.some((i) => i.contentType === 'image/webp'));
  assert.ok(inlineImages.some((i) => i.contentType === 'image/gif'));
});

test('BANNER REAL do dono (bytes do disco, sem regeração) atravessa a cadeia', (t) => {
  if (!HAS_REAL_BANNER) {
    t.skip('banner real ausente neste storage');
    return;
  }
  const name = storage.saveGenerated(REAL_BANNER, 'png');
  const html = emailDocToHtml(
    {
      blocks: [
        { type: 'image', src: `https://app.b2base.net/media/${name}`, href: WA },
        { type: 'button', label: 'Falar com a gente no WhatsApp', url: WA, color: '#25D366' },
      ],
    },
    LEAD,
    {}
  );
  const { inlineImages } = extractInlineImages(html, { readGenerated: storage.readGenerated });
  const htmlCid = applyCid(html, inlineImages);
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@e.com',
    subject: 'S',
    messageIdHeader: '<m@e.com>',
    body: 'texto',
    htmlBody: htmlCid,
    attachments: [],
    inlineImages,
  });
  assert.deepEqual(Buffer.from(inlineImages[0].content, 'base64'), REAL_BANNER, 'bytes do banner ORIGINAL intactos');
  assert.ok(mime.includes(`Content-ID: <${inlineImages[0].cid}>`));
  assert.ok(mime.includes(`src="cid:${inlineImages[0].cid}"`));
  assert.ok(mime.includes(WA), 'link do WhatsApp intacto');
});

// PNG 1×1 válido (mesmo fixture dos outros testes de imagem).
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082',
  'hex'
);

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('BANNER do USUÁRIO (Downloads, 1248×832 — o baixado da prévia) atravessa a cadeia', (t) => {
  const userBanner = '/Users/arthur/Downloads/b1b48a6db287959f651fe012ccf57942.png';
  if (!fs.existsSync(userBanner)) {
    t.skip('banner do usuário ausente');
    return;
  }
  const bytes = fs.readFileSync(userBanner);
  const name = storage.saveGenerated(bytes, 'png');
  const html = emailDocToHtml(
    {
      blocks: [
        { type: 'image', src: `https://app.b2base.net/media/${name}`, href: WA },
        { type: 'button', label: 'Falar com a gente no WhatsApp', url: WA, color: '#25D366' },
      ],
    },
    LEAD,
    {}
  );
  const { inlineImages } = extractInlineImages(html, { readGenerated: storage.readGenerated });
  const htmlCid = applyCid(html, inlineImages);
  const mime = buildMimeMessage({
    from: 'eu@gmail.com',
    to: 'lead@e.com',
    subject: 'S',
    messageIdHeader: '<m@e.com>',
    body: 'texto',
    htmlBody: htmlCid,
    attachments: [],
    inlineImages,
  });
  assert.deepEqual(Buffer.from(inlineImages[0].content, 'base64'), bytes, 'bytes do banner ORIGINAL (1.2MB) intactos');
  assert.ok(bytes.length > 1000000, 'é o banner real (não placeholder)');
  assert.ok(mime.includes(`Content-ID: <${inlineImages[0].cid}>`));
  assert.ok(mime.includes(`src="cid:${inlineImages[0].cid}"`));
  assert.ok(mime.includes(WA), 'link do WhatsApp intacto');
});
