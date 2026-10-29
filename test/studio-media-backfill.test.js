'use strict';

/**
 * test/studio-media-backfill.test.js — AUTO-CURA de banners presos em src de
 * PÁGINA no emailDoc (studio/media-backfill.js): sweep resolve a imagem
 * direta, baixa os bytes para o NOSSO storage e PERSISTE o emailDoc curado.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');

test('media-backfill: src de PÁGINA no emailDoc é curado e PERSISTIDO; src nosso fica intocado', async () => {
  const { registerMediaBackfill } = require('../studio/media-backfill');
  const storage = require('../studio/storage');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-backfill-'));
  const prevStorageDir = process.env.STUDIO_STORAGE_DIR;
  process.env.STUDIO_STORAGE_DIR = tmpDir;
  const realFetch = global.fetch;

  const rows = [
    {
      id: 'row-album',
      channel: 'email',
      emailDoc: { blocks: [
        { type: 'image', src: 'https://galeria.exemplo.com/a/test123', href: 'https://wa.me/1' },
        { type: 'text', text: 'Olá' },
      ] },
    },
    { // já nosso: nada a fazer
      id: 'row-ok',
      channel: 'email',
      emailDoc: { blocks: [{ type: 'image', src: '/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png' }] },
    },
    { // canal diferente: fora do sweep
      id: 'row-wa',
      channel: 'whatsapp',
      emailDoc: { blocks: [{ type: 'image', src: 'https://galeria.exemplo.com/a/outro' }] },
    },
  ];
  const updates = [];
  const prisma = {
    studioContent: {
      findMany: async ({ where } = {}) => rows.filter((r) => !where || !where.channel || r.channel === where.channel),
      update: async ({ where, data }) => { updates.push({ id: where.id, emailDoc: data.emailDoc }); return { count: 1 }; },
    },
  };
  global.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://galeria.exemplo.com/a/test123') {
      return { ok: true, status: 200, text: async () => '<meta property="og:image" content="https://cdn.exemplo.com/arte.jpg" />' };
    }
    if (u === 'https://cdn.exemplo.com/arte.jpg') {
      return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) };
    }
    throw new Error('fetch inesperado: ' + u);
  };

  try {
    const { sweep } = registerMediaBackfill(prisma, { bootDelayMs: 1, intervalMs: 1 });
    const out = await sweep('test');
    assert.equal(out.checked, 1, 'só a linha com src de página conta como verificado');
    assert.equal(out.healed, 1, 'um emailDoc curado');
    assert.equal(updates.length, 1, 'persistiu uma vez');
    assert.equal(updates[0].id, 'row-album');
    const [img] = updates[0].emailDoc.blocks;
    assert.equal(img.type, 'image');
    assert.match(img.src, /^\/media\/[a-f0-9]{32}\.(png|jpe?g)/, 'src virou o ARQUIVO promovido no nosso storage');
    assert.ok(storage.generatedExists(img.src.split('/media/')[1]), 'bytes servíveis no storage');
    assert.deepEqual(storage.readGenerated(img.src.split('/media/')[1]), PNG, 'bytes preservados');
    // A linha em memória foi mutada (próximo sweep não vê mais página):
    assert.match(rows[0].emailDoc.blocks[0].src, /^\/media\//, 'emailDoc na origem atualizado');
    // Segundo sweep: nada mais a curar.
    const again = await sweep('test');
    assert.equal(again.checked, 0, 'sem src de página sobrando');
    assert.equal(again.healed, 0);
  } finally {
    global.fetch = realFetch;
    if (prevStorageDir === undefined) delete process.env.STUDIO_STORAGE_DIR;
    else process.env.STUDIO_STORAGE_DIR = prevStorageDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('media-backfill: src que NÃO resolve é REMOVIDO do doc (nada preso em página) e persistido', async () => {
  const { registerMediaBackfill } = require('../studio/media-backfill');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-backfill-block-'));
  const prevStorageDir = process.env.STUDIO_STORAGE_DIR;
  process.env.STUDIO_STORAGE_DIR = tmpDir;
  const realFetch = global.fetch;
  const rows = [
    {
      id: 'row-bloqueada',
      channel: 'email',
      emailDoc: {
        blocks: [
          { type: 'image', src: 'https://galeria.exemplo.com/a/fracasso' },
          { type: 'text', text: 'Olá' },
        ],
      },
    },
  ];
  const updates = [];
  const prisma = {
    studioContent: {
      findMany: async ({ where } = {}) => rows.filter((r) => !where || !where.channel || r.channel === where.channel),
      update: async ({ where, data }) => { updates.push({ id: where.id, emailDoc: data.emailDoc }); return { count: 1 }; },
    },
  };
  global.fetch = async () => ({ ok: false, status: 429, text: async () => '' });
  try {
    const { sweep } = registerMediaBackfill(prisma, { bootDelayMs: 1, intervalMs: 1 });
    const out = await sweep('test');
    assert.equal(out.checked, 1);
    assert.equal(out.healed, 1, 'o doc mudou (banner quebrado removido) — conta como curado');
    assert.equal(updates.length, 1, 'doc curado persistido na origem');
    const blocks = updates[0].emailDoc.blocks;
    assert.ok(!blocks.some((b) => b.type === 'image'), 'banner com src de página quebrado SAIU do doc');
    assert.ok(blocks.some((b) => b.type === 'text'), 'resto do conteúdo intacto');
    // Nada com src de página sobra — nem no doc em memória (o chat não vê mais).
    assert.ok(!rows[0].emailDoc.blocks.some((b) => b.type === 'image' && String(b.src || '').includes('galeria.exemplo.com')));
  } finally {
    global.fetch = realFetch;
    if (prevStorageDir === undefined) delete process.env.STUDIO_STORAGE_DIR;
    else process.env.STUDIO_STORAGE_DIR = prevStorageDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('media-backfill: banner VÁLIDO no doc sobra intacto quando outro é removido', async () => {
  const { registerMediaBackfill } = require('../studio/media-backfill');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-backfill-keep-'));
  const prevStorageDir = process.env.STUDIO_STORAGE_DIR;
  process.env.STUDIO_STORAGE_DIR = tmpDir;
  const realFetch = global.fetch;
  const rows = [
    {
      id: 'row-mista',
      channel: 'email',
      emailDoc: {
        blocks: [
          { type: 'image', src: 'https://galeria.exemplo.com/a/morta' },
          { type: 'image', src: '/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' },
          { type: 'text', text: 'Oi' },
        ],
      },
    },
  ];
  const updates = [];
  const prisma = {
    studioContent: {
      findMany: async ({ where } = {}) => rows.filter((r) => !where || !where.channel || r.channel === where.channel),
      update: async ({ where, data }) => { updates.push({ id: where.id, emailDoc: data.emailDoc }); return { count: 1 }; },
    },
  };
  global.fetch = async () => ({ ok: false, status: 429, text: async () => '' });
  try {
    const { sweep } = registerMediaBackfill(prisma, { bootDelayMs: 1, intervalMs: 1 });
    const out = await sweep('test');
    assert.equal(out.healed, 1);
    const blocks = updates[0].emailDoc.blocks;
    assert.equal(blocks.length, 2, 'só o banner quebrado saiu');
    assert.equal(blocks[0].src, '/media/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png', 'banner válido preservado');
    assert.equal(blocks[1].type, 'text');
  } finally {
    global.fetch = realFetch;
    if (prevStorageDir === undefined) delete process.env.STUDIO_STORAGE_DIR;
    else process.env.STUDIO_STORAGE_DIR = prevStorageDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('media-backfill: botão com link morto → cura para o WhatsApp canônico e persiste', async () => {
  const { registerMediaBackfill } = require('../studio/media-backfill');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-backfill-cta-'));
  const prevStorageDir = process.env.STUDIO_STORAGE_DIR;
  process.env.STUDIO_STORAGE_DIR = tmpDir;
  const realFetch = global.fetch;
  const rows = [
    {
      id: 'row-cta-morto', orgId: 'org-1', channel: 'email',
      emailDoc: {
        blocks: [
          { type: 'text', text: 'Olá' },
          { type: 'button', label: 'Fale com a empresa', url: 'https://www.exemplo.com.br/contato' },
        ],
      },
    },
  ];
  const updates = [];
  const prisma = {
    studioMaterial: { findMany: async () => [] },
    studioContent: {
      findMany: async ({ where } = {}) => rows.filter((r) => !where || !where.channel || r.channel === where.channel),
      update: async ({ where, data }) => { updates.push({ id: where.id, emailDoc: data.emailDoc }); return { count: 1 }; },
    },
  };
  global.fetch = async () => { throw new Error('sem fetch esperado'); };
  try {
    const { sweep } = registerMediaBackfill(prisma, { bootDelayMs: 1, intervalMs: 1 });
    const out = await sweep('test');
    assert.equal(out.checked, 1, 'linha com CTA morto entra na varredura');
    assert.equal(out.healed, 1);
    assert.equal(updates.length, 1, 'doc persistido');
    const btn = updates[0].emailDoc.blocks.find((b) => b.type === 'button');
    assert.equal(btn.url, 'https://wa.me/5512996399943', 'botão aponta para o WhatsApp canônico');
    assert.equal(btn.label, 'Fale com a empresa', 'rótulo preservado');
    // Sem fetch: a cura do CTA não depende de rede.
  } finally {
    global.fetch = realFetch;
    if (prevStorageDir === undefined) delete process.env.STUDIO_STORAGE_DIR;
    else process.env.STUDIO_STORAGE_DIR = prevStorageDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
