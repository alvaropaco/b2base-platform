'use strict';

/**
 * test/studio-image-vision.test.js — ABRIR e GERAR imagem (2026-10-16):
 *   1. visão: material de imagem anexado é LIDO (produto/oferta/público) via
 *      gateway LiteLLM — o confirm_material extrai antes de confirmar;
 *   2. geração: generate_image cria o banner por IA, salva no storage e
 *      devolve o link PÚBLICO (/media/:hash) — attachToEmail insere no topo.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.STUDIO_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-image-vision-'));
process.env.LITELLM_URL = 'http://litellm.test';
process.env.LITELLM_MODEL = 'test-model';
process.env.STUDIO_IMAGE_MODEL = 'test-image-model';
process.env.APP_URL = 'https://www.b2base.net';
delete process.env.GOOGLE_PLACES_API_KEY;

const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const storage = require('../studio/storage');
const vision = require('../studio/ai/vision');
const imageGen = require('../studio/ai/image-gen');
const { editContentHint, imageGenHint } = require('../studio/ai/chat-agent');

const LOGGER = { info() {}, warn() {}, error() {}, child() { return this; } };

// PNG 1x1 válido (assinatura real para os testes de storage).
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');

// ── storage gerado ──────────────────────────────────────────────────────────

test('storage gerado: salva, lê pelo hash e RECUSA nome estranho (traversal)', () => {
  const name = storage.saveGenerated(PNG, 'png');
  assert.match(name, /^[a-f0-9]{32}\.png$/);
  const buf = storage.readGenerated(name);
  assert.deepEqual([...buf.slice(0, 4)], [...PNG.slice(0, 4)], 'bytes do PNG voltam intactos');
  assert.ok(storage.generatedExists(name));
  assert.throws(() => storage.readGenerated('../ organization.secret'), /inválido/);
  assert.throws(() => storage.readGenerated('qualquer-coisa.png'), /inválido|no such file/i);
});

// ── visão (abrir a imagem) ──────────────────────────────────────────────────

test('vision: descreve a imagem via gateway (content parts com data-url)', async () => {
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Banner de DOBRADEIRA industrial azul. Oferta: orçamento em 24h. Público: indústrias.' } }] }) };
  };
  try {
    const desc = await vision.describeImage({ buffer: PNG, mimeType: 'image/png' });
    assert.match(desc, /DOBRADEIRA/);
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.includes('/v1/chat/completions'));
    const part = seen[0].body.messages[0].content.find((p) => p.type === 'image_url');
    assert.match(part.image_url.url, /^data:image\/png;base64,/, 'imagem vai como data-url');
    assert.equal(seen[0].body.model, 'test-model');
  } finally { global.fetch = orig; }
});

test('vision: gateway fora → erro VISION_UNAVAILABLE (material degrada honesto)', async () => {
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'modelo sem visão' } }) });
  try {
    await assert.rejects(() => vision.describeImage({ buffer: PNG }), /VISION_HTTP_503|vision/i);
    assert.equal(vision.isConfigured(), true, 'configuração existe — a falha é do motor do momento');
  } finally { global.fetch = orig; }
});

// ── confirm_material extrai a imagem pendente ANTES de confirmar ───────────

async function startServer({ fetchImpl } = {}) {
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('127.0.0.1')) return orig(url, opts);
    if (fetchImpl) return fetchImpl(u, opts);
    throw new Error('fetch inesperado: ' + u);
  };
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  prisma.commercialSettings.rows.push({ orgId: 'org-1', productDescription: 'software B2B' });
  app.use((req, _res, next) => { req.user = { id: 'user-1', orgId: 'org-1' }; next(); });
  app.use('/api/studio', createStudioRouter(prisma, {
    overrides: { aiDeps: { callLlm: async () => ({ content: JSON.stringify({ reply: 'ok', actions: [] }) }), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>x</html>' }) } },
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => {
    const res = await fetch(`${base}/api/studio${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { res, body: await res.json().catch(() => ({})) };
  };
  return { prisma, api, base, restore: () => { global.fetch = orig; }, close: () => server.close() };
}

test('confirm_material: imagem PENDENTE é lida (visão) e confirmada COM a extração', async () => {
  const world = await startServer({
    fetchImpl: async (u) => {
      if (u.includes('/v1/chat/completions')) {
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Banner: DOBRADEIRA MB Máquinas. Oferta: orçamento em 24h. Público: indústrias metalúrgicas. Texto: QUAL DOBRADEIRA SUA PRODUÇÃO PRECISA?' } }] }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  const { prisma, api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Material IMG', channels: ['email'] });
    const fileName = storage.saveGenerated(PNG, 'png');
    prisma.studioMaterial.rows.push({
      id: 'mat-1', orgId: 'org-1', campaignId: c.data.id, kind: 'image',
      sourceRef: fileName, mimeType: 'image/png', extractionStatus: 'pending',
      origin: 'upload', variantLabel: null, confirmedAt: null,
    });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'confirm_material', params: { materialId: 'mat-1' } });
    assert.equal(out.res.status, 200);
    const mat = prisma.studioMaterial.rows.find((r) => r.id === 'mat-1');
    assert.equal(mat.extractionStatus, 'extracted', 'visão leu a imagem e a extração estruturada rodou');
    assert.ok(mat.extraction, 'extração estruturada preenchida');
    assert.equal(mat.confirmedAt != null, true, 'confirmada no mesmo gesto');
    assert.equal(out.body.data.card.type, 'material_confirmed');
  } finally {
    world.restore();
    world.close();
  }
});

test('confirm_material: imagem com visão FORA → needs_manual (degradação explícita, nunca vazia)', async () => {
  delete process.env.LITELLM_URL;
  const world = await startServer();
  const { prisma, api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Material sem visão', channels: ['email'] });
    const fileName = storage.saveGenerated(PNG, 'png');
    prisma.studioMaterial.rows.push({
      id: 'mat-2', orgId: 'org-1', campaignId: c.data.id, kind: 'image',
      sourceRef: fileName, mimeType: 'image/png', extractionStatus: 'pending',
      origin: 'upload', variantLabel: null, confirmedAt: null,
    });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'confirm_material', params: { materialId: 'mat-2' } });
    assert.equal(out.res.status, 200);
    const mat = prisma.studioMaterial.rows.find((r) => r.id === 'mat-2');
    assert.equal(mat.extractionStatus, 'needs_manual', 'sem visão: pede descrição manual (honesto — NÃO finge extracted)');
    assert.ok(mat.extractionError && mat.extractionError.length > 0, 'explica por que está manual');
    assert.equal(mat.confirmedAt == null, true, 'não confirma extração vazia');
    assert.equal(out.body.data.card.type, 'material_needs_manual');
  } finally {
    process.env.LITELLM_URL = 'http://litellm.test';
    world.restore();
    world.close();
  }
});

// ── generate_image ──────────────────────────────────────────────────────────

test('generate_image: gera por IA, salva no storage e devolve link PÚBLICO /media/:hash', async () => {
  const world = await startServer({
    fetchImpl: async (u, opts = {}) => {
      if (u.includes('/v1/images/generations')) {
        assert.equal(JSON.parse(opts.body).model, 'test-image-model');
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  const { prisma, api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner gerado', channels: ['email'] });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'generate_image',
      params: { prompt: 'banner de dobradeira industrial azul, texto QUAL DOBRADEIRA SUA PRODUÇÃO PRECISA?' },
    });
    assert.equal(out.res.status, 200);
    const card = out.body.data.card;
    assert.equal(card.type, 'image_generated');
    assert.match(card.imageUrl, /^https:\/\/www\.b2base\.net\/media\/[a-f0-9]{32}\.png$/, 'link público com hash');
    const served = storage.readGenerated(card.imageUrl.split('/').pop());
    assert.deepEqual([...served.slice(0, 4)], [...PNG.slice(0, 4)], 'arquivo servido é o PNG gerado');
  } finally {
    world.restore();
    world.close();
  }
});

test('generate_image: attachToEmail insere o banner NO TOPO do e-mail', async () => {
  const world = await startServer({
    fetchImpl: async (u) => {
      if (u.includes('/v1/images/generations')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: PNG.toString('base64') }] }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  const { prisma, api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Banner no topo', channels: ['email'] });
    await api('POST', `/campaigns/${c.data.id}/contents`, {
      channel: 'email',
      emailDoc: { blocks: [{ type: 'text', text: 'Olá {{firstName}}!' }] },
    });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'generate_image',
      params: { prompt: 'banner de pizza artesanal vermelho', attachToEmail: true },
    });
    assert.equal(out.res.status, 200);
    assert.equal(out.body.data.card.insertedIntoEmail, true);
    const row = prisma.studioContent.rows.find((r) => r.campaignId === c.data.id);
    assert.equal(row.emailDoc.blocks[0].type, 'image', 'banner no TOPO');
    assert.match(row.emailDoc.blocks[0].src, /^https:\/\/www\.b2base\.net\/media\//);
    assert.equal(row.emailDoc.blocks[1].type, 'text', 'conteúdo original preservado');
  } finally {
    world.restore();
    world.close();
  }
});

test('generate_image: sem STUDIO_IMAGE_MODEL → card honesto com o caminho (nada de geração fingida)', async () => {
  delete process.env.STUDIO_IMAGE_MODEL;
  const world = await startServer();
  const { api } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Sem motor', channels: ['email'] });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'generate_image', params: { prompt: 'banner qualquer' } });
    assert.equal(out.res.status, 200);
    assert.equal(out.body.data.card.type, 'image_generated');
    assert.match(out.body.data.card.label, /não configurada/i);
    assert.match(out.body.data.card.detail, /LINK/i);
  } finally {
    process.env.STUDIO_IMAGE_MODEL = 'test-image-model';
    world.restore();
    world.close();
  }
});

// ── hints determinísticos ───────────────────────────────────────────────────

test('hints: "gere uma imagem" → generate_image; "anexa essa imagem no email" → edit_content', () => {
  const gen = imageGenHint('gere uma imagem de dobradeira industrial azul para o email');
  assert.ok(gen && gen.includes('generate_image'), 'geração injeta generate_image');
  assert.ok(gen.includes('attachToEmail'), 'hint sugere inserir no e-mail');
  // Imagem que JÁ EXISTE (anexada) não é geração.
  assert.equal(imageGenHint('anexa essa imagem no email'), null, 'anexo segue o caminho do link/extração');
  // O hint de imagem por link agora ensina os DOIS caminhos.
  const linkHint = editContentHint('anexa essa imagem no email');
  assert.ok(linkHint.includes('imageUrl') && linkHint.includes('generate_image'), 'hint de anexo aponta a geração quando não há link');
});

// ── extração AUTOMÁTICA no upload (a imagem não fica pending para sempre) ───

async function startServerWithPlan(plan) {
  const visionCalls = { n: 0 };
  const world = await startServer({
    fetchImpl: async (u) => {
      if (u.includes('/v1/chat/completions')) {
        visionCalls.n += 1;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Banner EuroBLECH 2026 — MB Máquinas Industriais. Oferta: presença na feira. Público: indústrias metalúrgicas. Texto: É ESSE MÊS! EuroBLECH 2026.' } }] }) };
      }
      throw new Error('fetch inesperado: ' + u);
    },
  });
  world.prisma.organization.rows[0].plan = plan;
  world.visionCalls = visionCalls;
  return world;
}

test('upload de imagem: extração de visão roda SOZINHA em background (premium) — adeus pending eterno', async () => {
  const world = await startServerWithPlan('premium');
  const { prisma, api, base } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Arte EuroBLECH', channels: ['email'] });
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'euroblech.png');
    form.append('campaignId', c.data.id);
    const res = await fetch(`${base}/api/studio/materials`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    const material = (await res.json()).data;
    assert.equal(material.kind, 'image');
    assert.equal(material.extractionStatus, 'pending', 'o upload responde na hora (extração em background)');

    // A extração automática conclui sozinha (visão) em instantes.
    let row = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      row = prisma.studioMaterial.rows.find((r2) => r2.id === material.id);
      if (row && row.extractionStatus === 'extracted') break;
    }
    assert.equal(row.extractionStatus, 'extracted', 'a imagem NÃO fica pending: a visão leu sozinha');
    assert.ok(row.extraction && /EuroBLECH/.test(row.extraction.sourceText || ''), 'descrição da visão no material');
    assert.ok(world.visionCalls.n >= 1, 'leitor de visão chamado');
  } finally {
    world.restore();
    world.close();
  }
});

test('upload de imagem (trial): segue pending — extração é premium, como o /extract', async () => {
  const world = await startServerWithPlan('trial');
  const { prisma, api, base } = world;
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Arte trial', channels: ['email'] });
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'arte.png');
    form.append('campaignId', c.data.id);
    const res = await fetch(`${base}/api/studio/materials`, { method: 'POST', body: form });
    assert.equal(res.status, 201);
    await new Promise((r) => setTimeout(r, 400));
    const row = prisma.studioMaterial.rows.find((r2) => r2.kind === 'image');
    assert.equal(row.extractionStatus, 'pending', 'trial: nada de custo de visão sem o gate (igual ao /extract)');
    assert.equal(world.visionCalls.n, 0);
  } finally {
    world.restore();
    world.close();
  }
});
