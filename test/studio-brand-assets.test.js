'use strict';

/**
 * test/studio-brand-assets.test.js — Marca: persistência (regressão do bug
 * "salva e não persiste"), merge de kit sem apagar assets, upload/serve/delete
 * de assets (logo/material/contexto) e DELETE de campanha (rascunho ok,
 * campanha em voo 409).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');

// Storage em tmpdir: testes não poluem .data/studio do repo.
process.env.STUDIO_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-assets-'));

async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, prisma };
}

test('PUT /brand persiste e sobrevive a um GET posterior (regressão)', async () => {
  const { server, base } = await startServer();
  try {
    const put = await fetch(`${base}/api/studio/brand`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice: { toneNotes: 'direto e técnico' },
        kit: { logoUrl: '', colors: { primary: '#8B5CF6' } },
      }),
    });
    if (put.status !== 200) throw new Error(await put.text());
    const get = await fetch(`${base}/api/studio/brand`);
    const body = await get.json();
    assert.equal(body.data.voice.toneNotes, 'direto e técnico', 'voz persistiu');
    assert.equal(body.data.kit.colors.primary, '#8B5CF6', 'kit persistiu');
  } finally {
    server.close();
  }
});

test('PUT /brand sem assets NÃO apaga assets existentes (merge)', async () => {
  const { server, base } = await startServer();
  try {
    const form = new FormData();
    form.append('kind', 'logo');
    form.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'logo.png');
    const up = await fetch(`${base}/api/studio/brand/assets`, { method: 'POST', body: form });
    if (up.status !== 200) throw new Error(await up.text());
    const uploaded = (await up.json()).asset;
    assert.ok(uploaded.url.startsWith('/api/studio/brand/assets/'), 'asset tem url');

    // Cliente que não conhece assets salva kit sem o campo:
    await fetch(`${base}/api/studio/brand`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kit: { colors: { primary: '#A78BFA' } } }),
    });
    const after = await (await fetch(`${base}/api/studio/brand`)).json();
    assert.equal(after.data.kit.assets.length, 1, 'assets sobreviveram ao PUT');
    assert.equal(after.data.kit.logoUrl, uploaded.url, 'logoUrl preservado');

    // Serviço do arquivo respeita escopo da org (listado no kit):
    const file = await fetch(`${base}${uploaded.url}`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');

    // Delete remove metadado e arquivo vira 404:
    const del = await fetch(`${base}/api/studio/brand/assets/${uploaded.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const afterDel = await (await fetch(`${base}/api/studio/brand`)).json();
    assert.equal(afterDel.data.kit.assets.length, 0, 'asset removido do kit');
    assert.equal((await fetch(`${base}${uploaded.url}`)).status, 404, 'binário fora do ar');
  } finally {
    server.close();
  }
});

test('kind inválido e arquivo incompatível → 400', async () => {
  const { server, base } = await startServer();
  try {
    const bad1 = new FormData();
    bad1.append('kind', 'bananas');
    bad1.append('file', new Blob(['x'], { type: 'text/plain' }), 'a.txt');
    assert.equal((await fetch(`${base}/api/studio/brand/assets`, { method: 'POST', body: bad1 })).status, 400);

    const bad2 = new FormData();
    bad2.append('kind', 'logo');
    bad2.append('file', new Blob(['%PDF'], { type: 'application/pdf' }), 'a.pdf'); // logo exige imagem
    assert.equal((await fetch(`${base}/api/studio/brand/assets`, { method: 'POST', body: bad2 })).status, 400);
  } finally {
    server.close();
  }
});

test('DELETE /campaigns/:id remove rascunho (com filhos) e bloqueia campanha em voo', async () => {
  const { server, base, prisma } = await startServer();
  try {
    prisma.studioCampaign.rows.push({ id: 'c-draft', orgId: 'org-1', name: 'Rascunho', status: 'draft', channels: ['email'] });
    prisma.studioContent.rows.push({ id: 'ct-1', campaignId: 'c-draft', channel: 'email', kind: 'base', stepIndex: 1 });
    prisma.studioChatMessage.rows.push({ id: 'm-1', orgId: 'org-1', campaignId: 'c-draft', role: 'user', text: 'oi' });

    const ok = await fetch(`${base}/api/studio/campaigns/c-draft`, { method: 'DELETE' });
    if (ok.status !== 200) throw new Error(await ok.text());
    assert.equal(prisma.studioCampaign.rows.length, 0, 'campanha removida');
    assert.equal(prisma.studioContent.rows.length, 0, 'conteúdo removido');
    assert.equal(prisma.studioChatMessage.rows.length, 0, 'histórico removido');

    prisma.studioCampaign.rows.push({ id: 'c-run', orgId: 'org-1', name: 'Em voo', status: 'running', channels: ['email'] });
    const conflict = await fetch(`${base}/api/studio/campaigns/c-run`, { method: 'DELETE' });
    assert.equal(conflict.status, 409, 'campanha em voo não é removível');
  } finally {
    server.close();
  }
});

