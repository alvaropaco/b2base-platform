'use strict';

/**
 * test/compose-placeholder-guard.test.js — LINK INVENTADO PELO MODELO
 * (2026-10-29, caso real: e-mail gerado com botão apontando para domínio de
 * exemplo): generateAndStorePackage NÃO persiste bloco button com URL
 * placeholder — e-mail sem botão é melhor que botão levando o lead a
 * domínio fictício. O link real entra pelo edit_content (ctaUrl).
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { generateAndStorePackage } = require('../studio/compose-service');

function stubComposer(pack) {
  return { composeForTone: async () => pack };
}

function stubPrisma() {
  const created = [];
  return {
    created,
    studioContent: {
      create: async ({ data }) => { created.push(data); return { id: 'ce-1', ...data }; },
    },
  };
}

const CAMPAIGN = { id: 'camp-1', channels: ['email'], objective: 'vender', offer: null };

test('compose: botão com URL de exemplo NÃO é persistido; botão com link real fica', async () => {
  const pack = {
    title: 'Oferta',
    email: {
      subject: 'Olá {{companyName}}',
      preheader: 'pré',
      blocks: [
        { type: 'text', text: 'Oi {{firstName}}' },
        { type: 'button', label: 'Fale conosco', url: 'https://www.exemplo.com.br', color: '#25D366' },
        { type: 'button', label: 'WhatsApp real', url: 'https://wa.me/5512996399943', color: '#25D366' },
      ],
    },
    whatsapp: { text: 'Oi {{firstName}}' },
  };
  const prisma = stubPrisma();
  const created = await generateAndStorePackage(prisma, stubComposer(pack), {
    campaign: CAMPAIGN, sourceText: 'base', tones: ['comercial'], orgId: 'org-1',
  });
  assert.equal(created.length, 1);
  const data = prisma.created[0];
  const buttons = data.emailDoc.blocks.filter((b) => b.type === 'button');
  assert.equal(buttons.length, 1, 'só o botão com link REAL sobra');
  assert.equal(buttons[0].url, 'https://wa.me/5512996399943');
  assert.equal(data.ctaUrl, 'https://wa.me/5512996399943', 'ctaUrl vem do botão válido');
  assert.ok(data.emailDoc.blocks.some((b) => b.type === 'text'), 'texto intacto');
});

test('compose: botão placeholder SEM outro válido → normaliza para o DESTINO CANÔNICO', async () => {
  const pack = {
    title: 'Oferta',
    email: {
      subject: 'S',
      preheader: null,
      blocks: [
        { type: 'text', text: 'Oi' },
        { type: 'button', label: 'Saiba mais', url: 'https://example.com/promo' },
      ],
    },
    whatsapp: null,
  };
  const prisma = stubPrisma();
  await generateAndStorePackage(prisma, stubComposer(pack), {
    campaign: CAMPAIGN, sourceText: 'base', tones: ['formal'], orgId: 'org-1',
  });
  const data = prisma.created[0];
  const buttons = data.emailDoc.blocks.filter((b) => b.type === 'button');
  assert.equal(buttons.length, 1, 'um botão (normalizado)');
  assert.equal(buttons[0].url, 'https://wa.me/5512996399943', 'placeholder virou o WhatsApp canônico');
  assert.equal(buttons[0].label, 'Saiba mais', 'rótulo preservado');
  assert.equal(data.ctaUrl, 'https://wa.me/5512996399943', 'ctaUrl canônico');
});

test('compose: botão SEM url nenhuma → também sai com o destino canônico', async () => {
  const pack = {
    title: 'Oferta',
    email: {
      subject: 'S',
      preheader: null,
      blocks: [
        { type: 'text', text: 'Oi' },
        { type: 'button', label: 'Fale com a empresa' },
      ],
    },
    whatsapp: null,
  };
  const prisma = stubPrisma();
  await generateAndStorePackage(prisma, stubComposer(pack), {
    campaign: CAMPAIGN, sourceText: 'base', tones: ['comercial'], orgId: 'org-1',
  });
  const data = prisma.created[0];
  const btn = data.emailDoc.blocks.find((b) => b.type === 'button');
  assert.equal(btn.url, 'https://wa.me/5512996399943', 'botão nasce clicável apontando para o WhatsApp');
});
