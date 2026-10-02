'use strict';

/**
 * test/studio-chat-reliability.test.js — fixes da bateria de QA do dono
 * (2026-10-02): mensagem rica de abertura re-perguntava o que já fora dito
 * (bugs 1/2), o conteúdo gerado não aparecia no chat quando pediam para ver
 * (bug 5) e um tom falhando derrubava o pacote inteiro de conteúdo (bug 3).
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');

async function startServer({ llmImpl } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  prisma.commercialSettings.rows.push({ orgId: 'org-1', productDescription: 'software de prospecção B2B' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma, {
    overrides: {
      aiDeps: {
        callLlm: llmImpl,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => '<html><body><h1>ERP industrial</h1></body></html>',
        }),
      },
    },
  }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(`${base}/api/studio${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { res, body: await res.json() };
  };
  return { server, prisma, api };
}

const SEGMENT_CRITERIA = {
  content: JSON.stringify({
    criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'indústria' }] }] },
    rationale: 'indústrias',
  }),
};

test('bug 1/2: mensagem rica de abertura materializa objetivo+audiência sem re-perguntar', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('PRIMEIRA EXTRAÇÃO DE INTENÇÃO')) {
      return {
        content: JSON.stringify({
          objective: 'vender ERP de gestão fiscal',
          offer: 'implantação em 30 dias',
          audience: 'indústrias de médio porte',
        }),
      };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      // O modelo "preguiçoso" do bug: responde SEM emitir actions — a
      // materialização tem que vir da extração determinística.
      return {
        content: JSON.stringify({
          reply: 'Fechado! Objetivo anotado e audiência montada. Quer que eu gere o conteúdo?',
          actions: [{ type: 'none' }],
        }),
      };
    }
    if (user.includes('critérios de segmento')) return SEGMENT_CRITERIA;
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Abertura rica', channels: ['email', 'whatsapp'] });
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'indústria', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' },
      { id: 'l2', orgId: 'org-1', companyName: 'B', industry: 'indústria', opportunityScore: 80, status: 'qualified', state: 'RJ', cnpjEmail: 'b@b.com' }
    );

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'Oi! Quero vender meu ERP de gestão fiscal com implantação em 30 dias para indústrias de médio porte',
    });
    assert.equal(res.status, 200);

    // A extração materializou os DOIS fatos mesmo com o modelo sem actions.
    const types = body.data.cards.map((card) => card.type);
    assert.ok(types.includes('objective'), 'card de objetivo pela extração');
    assert.ok(types.includes('audience'), 'card de audiência pela extração');
    const audienceCard = body.data.cards.find((card) => card.type === 'audience');
    assert.ok(audienceCard.detail.includes('2 leads'), 'audiência materializou com contagem real');

    // Estado pós-turno: objetivo e audiência decididos — a resposta do modelo
    // confirma, NUNCA re-pergunta o que a 1ª mensagem já disse.
    const state = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.equal(state.campaign.objective, 'vender ERP de gestão fiscal');
    assert.equal(state.extras.audienceCount, 2);
    assert.ok(state.extras.audienceCriteria, 'decisão fechada FR2 visível no estado');
    assert.ok(!body.data.reply.includes('o que você vende'), 'não re-pergunta o que foi dito');
    assert.ok(!body.data.reply.includes('qual o segmento'), 'não re-pergunta o segmento');

    // Telemetria: a extração ficou registrada como etapa do turno.
    const traces = (await api('GET', `/campaigns/${c.data.id}/traces`)).body.data;
    assert.ok(traces[0].actionTypes.includes('extract_intent'));
    assert.equal(traces[0].status, 'succeeded');
  } finally {
    server.close();
  }
});

test('bug 5: show_content devolve o texto COMPLETO dos conteúdos no chat', async () => {
  const { server, prisma, api } = await startServer({
    llmImpl: async () => ({ content: JSON.stringify({ reply: 'Aqui está.', actions: [{ type: 'none' }] }) }),
  });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Revisão', channels: ['email', 'whatsapp'] });
    await prisma.studioContent.create({
      data: {
        orgId: 'org-1', campaignId: c.data.id, channel: 'email', variantLabel: 'formal',
        kind: 'base', stepIndex: 1, title: 'ERP', subject: 'ERP para {{companyName}}',
        preheader: 'implantação em 30 dias',
        emailDoc: { blocks: [{ type: 'text', text: 'Olá {{firstName}}, tudo bem?' }, { type: 'button', label: 'Ver demo', url: 'https://x.com/demo' }] },
        tone: 'formal', origin: 'ai_from_material',
      },
    });
    await prisma.studioContent.create({
      data: {
        orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp', variantLabel: 'formal',
        kind: 'base', stepIndex: 1, whatsappText: 'Oi {{firstName}}! Posso te mostrar o ERP em 15 min?',
        tone: 'formal', origin: 'ai_from_material',
      },
    });

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'show_content' });
    assert.equal(res.status, 200);
    const card = body.data.card;
    assert.equal(card.type, 'content_review');
    assert.ok(card.detail.includes('ERP para {{companyName}}'), 'assunto no card');
    assert.ok(card.detail.includes('Olá {{firstName}}, tudo bem?'), 'corpo do e-mail no card');
    assert.ok(card.detail.includes('Ver demo'), 'CTA do e-mail no card');
    assert.ok(card.detail.includes('Oi {{firstName}}! Posso te mostrar o ERP em 15 min?'), 'WhatsApp no card');

    // Campanha sem conteúdo: recusa honesta e explicável (nunca card vazio).
    const { body: c2 } = await api('POST', '/campaigns', { name: 'Sem conteúdo', channels: ['email'] });
    const empty = await api('POST', `/campaigns/${c2.data.id}/actions`, { type: 'show_content' });
    assert.equal(empty.res.status, 200);
    assert.equal(empty.body.data.card.type, 'content_empty');
    assert.ok(empty.body.data.card.detail.includes('Não gerei conteúdo'), 'explica por que não há o que mostrar');
  } finally {
    server.close();
  }
});

test('bug 3: tom falhando não derruba o pacote — o tom que deu certo persiste', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Gerando o conteúdo em dois tons.',
          actions: [{ type: 'generate_content', tones: ['formal', 'urgente'] }],
        }),
      };
    }
    if (user.includes('pacote de campanha')) {
      if (user.includes('tom "urgente"')) {
        // O modelo quebra no tom urgente: JSON truncado em TODAS as tentativas.
        return { content: '{"title":"ERP","email":{"subject":"Olá' };
      }
      return {
        content: JSON.stringify({
          title: 'ERP',
          email: { subject: 'ERP para {{companyName}}', preheader: 'p', blocks: [{ type: 'text', text: 'Olá {{firstName}}' }] },
          whatsapp: { text: 'Oi {{firstName}}, ERP?' },
          linkedinText: 'texto',
          timing: 'terça 10h',
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', {
      name: 'Dois tons', channels: ['email', 'whatsapp'], objective: 'vender ERP',
    });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'gera o conteúdo em dois tons' });
    assert.equal(res.status, 200);

    const contentCard = body.data.cards.find((card) => card.type === 'content');
    assert.ok(contentCard, 'card de sucesso (não degraded)');
    assert.ok(contentCard.detail.includes('formal'), 'tom que funcionou é citado');
    assert.ok(contentCard.detail.includes('urgente'), 'tom que falhou é dito com honestidade');
    assert.ok(!body.data.cards.some((card) => card.type === 'degraded'), 'turno NÃO degrada quando há sucesso parcial');

    const rows = prisma.studioContent.rows.filter((row) => row.campaignId === c.data.id);
    assert.equal(rows.length, 2, 'e-mail + WhatsApp do tom formal persistidos');
    assert.ok(rows.every((row) => row.tone === 'formal'));
  } finally {
    server.close();
  }
});
