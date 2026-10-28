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

test('media-backfill: resolução bloqueada NÃO derruba o sweep — linha fica para o próximo', async () => {
  const { registerMediaBackfill } = require('../studio/media-backfill');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-backfill-block-'));
  const prevStorageDir = process.env.STUDIO_STORAGE_DIR;
  process.env.STUDIO_STORAGE_DIR = tmpDir;
  const realFetch = global.fetch;
  const rows = [
    {
      id: 'row-bloqueada',
      channel: 'email',
      emailDoc: { blocks: [{ type: 'image', src: 'https://galeria.exemplo.com/a/fracasso' }] },
    },
  ];
  const updates = [];
  const prisma = {
    studioContent: {
      findMany: async () => rows,
      update: async ({ where, data }) => { updates.push({ id: where.id }); return { count: 1 }; },
    },
  };
  global.fetch = async () => ({ ok: false, status: 429, text: async () => '' });
  try {
    const { sweep } = registerMediaBackfill(prisma, { bootDelayMs: 1, intervalMs: 1 });
    const out = await sweep('test');
    assert.equal(out.checked, 1);
    assert.equal(out.healed, 0, 'nada curado com o host bloqueado (sem relay configurado)');
    assert.equal(updates.length, 0, 'nada persistido');
    assert.equal(rows[0].emailDoc.blocks[0].src, 'https://galeria.exemplo.com/a/fracasso', 'src intocado');
  } finally {
    global.fetch = realFetch;
    if (prevStorageDir === undefined) delete process.env.STUDIO_STORAGE_DIR;
    else process.env.STUDIO_STORAGE_DIR = prevStorageDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
