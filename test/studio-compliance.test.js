'use strict';

/**
 * test/studio-compliance.test.js + studio-brand.test.js — US12 (T113).
 * Compliance Guard completo (LGPD/consentimento/descadastro/spam/dados
 * sensíveis) com níveis e bloqueio real; Brand Voice aprendida e verificador
 * de consistência.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const compliance = require('../studio/compliance-service');
const brandService = require('../studio/brand-service');

function contentFixture(overrides = {}) {
  return {
    id: 'content-c', orgId: 'org-1', campaignId: 'camp-c', channel: 'email',
    subject: 'Proposta comercial', preheader: null, whatsappText: null, linkedinText: null,
    emailDoc: { blocks: [{ type: 'text', text: 'Apresentação da solução. Descadastro no rodapé.' }] },
    origin: 'manual', variantLabel: 'A', kind: 'base', stepIndex: 1,
    editHistory: [], ctaUrl: null, tone: null,
    ...overrides,
  };
}

test('compliance completo: LGPD/consentimento, spam e bloqueio real (FR-073)', async () => {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push({ id: 'camp-c', orgId: 'org-1', channels: ['email'], status: 'in_review', approval: {} });
  prisma.studioContent.rows.push(contentFixture());
  // 1 lead sem base legal identificável (sem e-mail, sem engajamento).
  prisma.prospect.rows.push({ id: 'lead-x', orgId: 'org-1', companyName: 'Sem Base', cnpjEmail: null });

  const campaign = prisma.studioCampaign.rows[0];
  const review = await compliance.runFullCompliance(prisma, campaign);

  // Campanha com conteúdo válido e descadastro — nível ok/attention.
  assert.ok(['ok', 'attention'].includes(review.level));
  // E-mail sem descadastro NO CONTEÚDO → não bloqueia mais: a garantia vive
  // no compile (FR-37/AD-2 — headers List-Unsubscribe injetados em todo e-mail).
  prisma.studioContent.rows[0].emailDoc = { blocks: [{ type: 'text', text: 'Compre agora sem compromisso!!!' }] };
  const hard = await compliance.runFullCompliance(prisma, prisma.studioCampaign.rows[0]);
  const desc = hard.items.find((i) => i.check === 'descadastro_email');
  assert.equal(desc.level, 'ok', 'descadastro é garantido no compile (FR-37) — nunca bloqueia');
  assert.notEqual(hard.level, 'block', 'ausência no conteúdo não é mais bloqueio');
});

test('brand voice aprendida de samples e verificador de consistência aponta desvio', async () => {
  const prisma = createFakePrisma();
  const brand = brandService.createBrandService(prisma, {
    callLlm: async ({ user }) => {
      if (user.includes('aprenda')) {
        return { content: JSON.stringify({ toneNotes: 'direto, técnico, sem girias', doExamples: ['Vamos resolver isso'], dontExamples: ['Oi amigão!!!'] }) };
      }
      if (user.includes('consistência')) {
        return { content: JSON.stringify({ deviations: [{ excerpt: 'Oi amigão!!!', reason: 'giria e exclamações fora do tom', suggestion: 'Olá, tudo bem?' }] }) };
      }
      return { content: '{}' };
    },
  });

  const learned = await brand.learn('org-1', { samples: ['Somos diretos e técnicos em cada resposta.'] });
  assert.equal(learned.voice.toneNotes, 'direto, técnico, sem girias');
  assert.ok(learned.voice.doExamples.length > 0);

  const check = await brand.checkConsistency('org-1', { text: 'Oi amigão!!! Fechou?' });
  assert.equal(check.deviations.length, 1);
  assert.ok(check.deviations[0].suggestion);
});
