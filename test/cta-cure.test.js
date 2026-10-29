'use strict';

/**
 * test/cta-cure.test.js — CURA do CTA do e-mail (2026-10-29): botão sem
 * destino válido (placeholder/ausente) + EXATAMENTE UM WhatsApp nos materiais
 * da org → o botão aponta para ele e o doc é persistido. Vários WhatsApps
 * diferentes → NÃO adivinha. Botão com destino válido → intocado.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { cureCta, isUsableCtaUrl } = require('../studio/cta-cure');

function stubPrisma(materials, updates = []) {
  return {
    materials,
    updates,
    studioMaterial: { findMany: async () => materials },
    studioContent: {
      update: async ({ where, data }) => { updates.push({ id: where.id, emailDoc: data.emailDoc }); return {}; },
      updateMany: async ({ data }) => { updates.push({ emailDoc: data.emailDoc }); return { count: 1 }; },
    },
  };
}

const CAMP = { orgId: 'org-1' };
const WA = 'https://wa.me/5512996399943';

test('cta-cure: botão placeholder + WhatsApp único no material → curado e persistido', async () => {
  const doc = { blocks: [
    { type: 'text', text: 'Olá' },
    { type: 'button', label: 'Falar com o time comercial', url: 'https://www.exemplo.com.br' },
  ] };
  const updates = [];
  const prisma = stubPrisma([
    { sourceRef: null, extraction: { cta: WA, sourceText: 'fale no whatsapp' } },
  ], updates);
  const out = await cureCta(prisma, { campaign: CAMP, emailDoc: doc, persist: (d) => prisma.studioContent.update({ where: { id: 'ce-1' }, data: { emailDoc: d } }) });
  assert.equal(out.cured, true);
  assert.equal(out.url, WA);
  const btn = doc.blocks.find((b) => b.type === 'button');
  assert.equal(btn.url, WA, 'botão aponta para o WhatsApp REAL');
  assert.equal(btn.label, 'Falar com o time comercial', 'rótulo preservado');
  assert.equal(updates.length, 1, 'doc persistido na origem');
});

test('cta-cure: SEM botão → cria o botão verde no fim com o WhatsApp dos materiais', async () => {
  const doc = { blocks: [{ type: 'text', text: 'Olá' }] };
  const prisma = stubPrisma([
    { sourceRef: 'https://wa.me/5512996399943', extraction: null },
  ]);
  const out = await cureCta(prisma, { campaign: CAMP, emailDoc: doc });
  assert.equal(out.cured, true);
  const btn = doc.blocks.find((b) => b.type === 'button');
  assert.equal(btn.url, WA);
  assert.equal(btn.color, '#25D366', 'verde WhatsApp');
});

test('cta-cure: botão com destino VÁLIDO → intocado (não consulta materiais)', async () => {
  const doc = { blocks: [{ type: 'button', label: 'B', url: WA }] };
  let queried = false;
  const prisma = stubPrisma([]);
  prisma.studioMaterial.findMany = async () => { queried = true; return []; };
  const out = await cureCta(prisma, { campaign: CAMP, emailDoc: doc, persist: async () => { throw new Error('não deveria persistir'); } });
  assert.equal(out.cured, false);
  assert.equal(out.reason, 'cta_ok');
  assert.equal(queried, false, 'materiais nem foram consultados');
});

test('cta-cure: sem WhatsApp nos materiais → não inventa destino', async () => {
  const doc = { blocks: [{ type: 'button', label: 'B', url: 'https://www.exemplo.com.br' }] };
  const prisma = stubPrisma([{ sourceRef: null, extraction: { product: 'máquinas' } }]);
  const out = await cureCta(prisma, { campaign: CAMP, emailDoc: doc });
  assert.equal(out.cured, false);
  assert.equal(out.reason, 'sem_whatsapp_nos_materiais');
  assert.equal(doc.blocks[0].url, 'https://www.exemplo.com.br', 'doc intocado (o renderer bloqueia o link no HTML)');
});

test('cta-cure: DOIS WhatsApps diferentes nos materiais → não adivinha', async () => {
  const doc = { blocks: [{ type: 'button', label: 'B', url: 'https://www.exemplo.com.br' }] };
  const prisma = stubPrisma([
    { sourceRef: 'https://wa.me/5512996399943', extraction: null },
    { sourceRef: 'https://wa.me/5511888888888', extraction: null },
  ]);
  const out = await cureCta(prisma, { campaign: CAMP, emailDoc: doc });
  assert.equal(out.cured, false);
  assert.equal(out.reason, 'varios_whatsapps_nos_materiais');
});

test('cta-cure: OutreachCampaign usa tenantId como org', async () => {
  const doc = { blocks: [{ type: 'button', label: 'B', url: 'https://www.exemplo.com.br' }] };
  let seenWhere = null;
  const prisma = stubPrisma([{ sourceRef: WA, extraction: null }]);
  prisma.studioMaterial.findMany = async ({ where }) => { seenWhere = where; return prisma.materials; };
  const out = await cureCta(prisma, { campaign: { tenantId: 'tenant-9' }, emailDoc: doc, persist: async () => {} });
  assert.equal(out.cured, true);
  assert.deepEqual(seenWhere, { orgId: 'tenant-9' });
});

test('isUsableCtaUrl: wa.me é utilizável; placeholder e vazio não', () => {
  assert.equal(isUsableCtaUrl(WA), true);
  assert.equal(isUsableCtaUrl('https://www.exemplo.com.br'), false);
  assert.equal(isUsableCtaUrl(''), false);
  assert.equal(isUsableCtaUrl(null), false);
});
