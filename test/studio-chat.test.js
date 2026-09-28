'use strict';

/**
 * test/studio-chat.test.js — experiência chat-first (iteração UX specs/010).
 * O bot pergunta preferências e executa ações reais: objetivo, audiência via
 * NL, material por URL colada com extração, conteúdo em revisão e agenda.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');

const EXTRACTION = {
  product: 'ERP industrial', offer: 'implantação em 30 dias',
  benefits: ['fiscal'], audience: 'indústrias de médio porte',
  cta: 'demo', confidence: 0.9,
};

// LLM roteado por marcador de prompt (orquestrador / segmento / pacote / extração).
function llm() {
  return async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      // Orquestrador: script por conteúdo da mensagem do usuário.
      if (user.includes('ERP para indústrias')) {
        return {
          content: JSON.stringify({
            reply: 'Entendi! Vou montar a audiência de indústrias e definir o objetivo. Já quero gerar o conteúdo?',
            actions: [
              { type: 'set_objective', objective: 'vender ERP para indústrias' },
              { type: 'set_audience', description: 'indústrias com score alto' },
            ],
          }),
        };
      }
      if (user.includes('gera o conteúdo')) {
        return {
          content: JSON.stringify({
            reply: 'Conteúdo gerado em 2 tons — está em revisão para você aprovar.',
            actions: [{ type: 'generate_content', tones: ['formal', 'urgente'] }],
          }),
        };
      }
      if (user.includes('confirma')) {
        return {
          content: JSON.stringify({
            reply: 'Extração confirmada. Quer que eu gere o conteúdo agora?',
            actions: [],
          }),
        };
      }
      if (user.includes('dispara 20 por hora')) {
        return {
          content: JSON.stringify({
            reply: 'Agenda configurada: 20/h em horário comercial.',
            actions: [{
              type: 'set_schedule', mode: 'scheduled',
              windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }],
              hourlyLimit: 20, dailyLimit: 100, timezone: 'America/Sao_Paulo',
            }],
          }),
        };
      }
      return { content: JSON.stringify({ reply: 'Me conta mais?', actions: [{ type: 'none' }] }) };
    }
    if (user.includes('extração estruturada')) return { content: JSON.stringify(EXTRACTION) };
    if (user.includes('critérios de segmento')) {
      return {
        content: JSON.stringify({
          criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'indústria' }, { field: 'opportunityScore', op: 'gte', value: 70 }] }] },
          rationale: 'indústrias com score alto',
        }),
      };
    }
    if (user.includes('pacote de campanha')) {
      return {
        content: JSON.stringify({
          title: 'ERP',
          email: { subject: 'ERP para {{companyName}}', preheader: 'p', blocks: [{ type: 'text', text: 'Olá {{firstName}} — descadastro aqui.' }] },
          whatsapp: { text: 'Oi {{firstName}}, ERP?' },
          linkedinText: 'texto',
          timing: 'terça 10h',
        }),
      };
    }
    return { content: '{}' };
  };
}

async function startServer({ orgPlan = 'premium', llmImpl } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: orgPlan });
  prisma.commercialSettings.rows.push({ orgId: 'org-1', productDescription: 'software de prospecção B2B' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma, {
    overrides: {
      aiDeps: {
        callLlm: llmImpl || llm(),
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => '<html><body><h1>ERP industrial</h1><p>implantação em 30 dias</p></body></html>',
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

test('chat: objetivo + audiência montados por conversa, com contagem real de leads', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Chat', channels: ['email', 'whatsapp'] });
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'indústria', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' },
      { id: 'l2', orgId: 'org-1', companyName: 'B', industry: 'indústria', opportunityScore: 80, status: 'qualified', state: 'RJ', cnpjEmail: 'b@b.com' },
      { id: 'l3', orgId: 'org-1', companyName: 'C', industry: 'varejo', opportunityScore: 10, status: 'prospect', state: 'BA', cnpjEmail: 'c@c.com' }
    );

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'Quero vender ERP para indústrias',
    });
    assert.equal(res.status, 200);
    assert.ok(body.data.reply);
    const types = body.data.cards.map((card) => card.type);
    assert.ok(types.includes('objective'), 'card de objetivo');
    assert.ok(types.includes('audience'), 'card de audiência');
    const audienceCard = body.data.cards.find((card) => card.type === 'audience');
    assert.ok(audienceCard.detail.includes('2 leads'), 'contagem real (l1+l2)');

    // Conversa persistida (user + assistant).
    const history = (await api('GET', `/campaigns/${c.data.id}/chat`)).body.data;
    assert.equal(history.length, 2);
    assert.equal(history[0].role, 'user');
    assert.equal(history[1].role, 'assistant');

    // Estado consolidado para o painel lateral.
    const state = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.equal(state.extras.audienceCount, 2);
    assert.equal(state.campaign.objective, 'vender ERP para indústrias');
  } finally {
    server.close();
  }
});

test('chat: URL colada vira material com extração; confirmação no chat; conteúdo em revisão', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Com material', channels: ['email'] });

    // 1) Usuário cola a URL do produto.
    const first = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'Use https://exemplo.com/produto como referência',
    });
    assert.equal(first.res.status, 200);
    const materialCard = first.body.data.cards.find((card) => card.type === 'material');
    assert.ok(materialCard, 'material criado automaticamente pela URL');
    assert.ok(materialCard.detail.includes('ERP industrial'), 'extração no card');
    const material = prisma.studioMaterial.rows[0];
    assert.equal(material.kind, 'url');
    assert.equal(material.extractionStatus, 'extracted');
    assert.equal(material.confirmedAt, null, 'aguarda confirmação humana (FR-024)');

    // 2) Usuário confirma no chat.
    const confirm = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'confirma a extração',
    });
    assert.equal(confirm.res.status, 200);
    // (sem ação no script desse turno; confirmação direta via materialId)
    await api('POST', `/materials/${material.id}/confirm`, {});

    // 3) Gerar conteúdo pelo chat — cai em revisão, nunca dispara (FR-002).
    const gen = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'gera o conteúdo' });
    assert.equal(gen.res.status, 200);
    const contentCard = gen.body.data.cards.find((card) => card.type === 'content');
    assert.ok(contentCard, 'card de conteúdo');
    const contents = prisma.studioContent.rows.filter((row) => row.campaignId === c.data.id);
    assert.ok(contents.length >= 2, '2 tons gerados');
    assert.equal(prisma.studioCampaign.rows.find((row) => row.id === c.data.id).status, 'in_review');
    assert.equal(prisma.outreachContact.rows.length, 0, 'nada enfileirado');
  } finally {
    server.close();
  }
});

test('chat: agendamento configurado por conversa com previsão de conclusão', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Agenda', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'dispara 20 por hora em horário comercial',
    });
    assert.equal(res.status, 200);
    const scheduleCard = body.data.cards.find((card) => card.type === 'schedule');
    assert.ok(scheduleCard, 'card de agenda');
    assert.ok(scheduleCard.detail.includes('20/h'));
    const campaign = prisma.studioCampaign.rows.find((row) => row.id === c.data.id);
    assert.equal(campaign.schedule.hourlyLimit, 20);
    assert.equal(campaign.schedule.windows[0].startHour, 9);
  } finally {
    server.close();
  }
});

// ── F1 (QA 2026-09-28): JSON quebrado do modelo não vira "Não entendi" ──────

test('chat: JSON inválido do modelo é reparado no retry e executa as ações', async () => {
  let orchestratorCalls = 0;
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      orchestratorCalls += 1;
      if (orchestratorCalls === 1) {
        // 1ª tentativa: JSON truncado (o modelo "sumiu" no meio) — era isso
        // que disparava o fallback "Não entendi completamente" na produção.
        return { content: '{"reply":"Quase pronto, deixa eu' };
      }
      // Retry (com a resposta anterior no prompt): decisão válida.
      return {
        content: JSON.stringify({
          reply: 'demonstração anotada como oferta! ✅',
          actions: [{ type: 'set_objective', objective: 'vender ERP', offer: 'demonstração' }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Retry', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'demonstração' });
    assert.equal(res.status, 200);
    assert.equal(orchestratorCalls, 2, 'retry aconteceu');
    assert.equal(body.data.reply, 'demonstração anotada como oferta! ✅', 'resposta do modelo, não fallback');
    assert.ok(!body.data.reply.includes('Não entendi'), 'não culpa o usuário');
    assert.ok(
      body.data.cards.some((card) => card.type === 'objective'),
      'ação do retry foi executada de verdade'
    );
    assert.equal(prisma.studioCampaign.rows.find((row) => row.id === c.data.id).offer, 'demonstração');
  } finally {
    server.close();
  }
});

test('chat: falha persistente de JSON vira fallback honesto (problema técnico, não culpa do usuário)', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) return { content: 'isto definitivamente não é json' };
    return { content: '{}' };
  };
  const { server, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Fallback', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'pode sim!' });
    assert.equal(res.status, 200);
    assert.ok(body.data.reply.includes('problema técnico'), 'assume a falha do sistema');
    assert.ok(!body.data.reply.includes('Não entendi completamente'), 'não pede reformular como se o usuário errasse');
    assert.equal(body.data.cards.length, 0, 'nenhuma ação executada');
  } finally {
    server.close();
  }
});

// ── F3 (QA 2026-09-28): audiência 0 leads com base populada avisa ───────────

test('chat: audiência sem nenhum match avisa com o total da base no card e no reply', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          // O modelo otimista diz que "cai como uma luva" — é exatamente a
          // contradição que o aviso determinístico precisa corrigir.
          reply: 'Montei a audiência perfeita — cai como uma luva no seu objetivo!',
          actions: [{ type: 'set_audience', description: 'empresas de logística' }],
        }),
      };
    }
    if (user.includes('critérios de segmento')) {
      return {
        content: JSON.stringify({
          criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'logística' }] }] },
          rationale: 'empresas do setor de logística',
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Vazia', channels: ['email'] });
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'tecnologia', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' },
      { id: 'l2', orgId: 'org-1', companyName: 'B', industry: 'tecnologia', opportunityScore: 80, status: 'qualified', state: 'SP', cnpjEmail: 'b@b.com' },
      { id: 'l3', orgId: 'org-1', companyName: 'C', industry: 'alimentos', opportunityScore: 82, status: 'qualified', state: 'SP', cnpjEmail: 'c@c.com' }
    );

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'Quero vender ERP para logística',
    });
    assert.equal(res.status, 200);
    const audienceCard = body.data.cards.find((card) => card.type === 'audience');
    assert.ok(audienceCard, 'card de audiência');
    assert.equal(audienceCard.emptyMatch, true, 'marca audiência vazia');
    assert.equal(audienceCard.baseCount, 3, 'total da base informado');
    assert.ok(audienceCard.label.includes('nenhum lead casou'), 'label explícito');
    assert.ok(audienceCard.detail.includes('sua base tem 3 lead(s)'), 'contraste 0 × base no detail');

    // O reply do turno carrega o aviso determinístico por cima do texto
    // otimista do modelo — a contradição some do histórico.
    const history = (await api('GET', `/campaigns/${c.data.id}/chat`)).body.data;
    const assistant = history[history.length - 1];
    assert.equal(assistant.role, 'assistant');
    assert.ok(assistant.text.includes('0 leads'), 'aviso de audiência vazia no reply persistido');
    assert.ok(assistant.text.includes('ajuste o segmento'), 'sugestão de correção no reply');

    // Estado do painel continua coerente (0 incluídos).
    const state = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.equal(state.extras.audienceCount, 0);
  } finally {
    server.close();
  }
});

// ── SSE (streaming de progresso — iteração UX chat fluido) ─────────────────

test('chat/stream: emite pensando → status das etapas → cards → done via SSE', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'SSE', channels: ['email'] });
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'indústria', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' }
    );

    const res = await fetch(`${`http://127.0.0.1:${server.address().port}`}/api/studio/campaigns/${c.data.id}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Quero vender ERP para indústrias' }),
    });
    assert.equal(res.headers.get('content-type').includes('text/event-stream'), true, 'resposta é SSE');

    // Lê o stream até o evento done.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const events = [];
    while (events.filter((e) => e.event === 'done' || e.event === 'error').length === 0) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (event) events.push({ event, data: data ? JSON.parse(data) : null });
      }
    }

    const types = events.map((e) => e.event);
    assert.ok(types.includes('status'), 'tem status (pensando/etapas)');
    assert.ok(types.includes('reply'), 'tem a resposta do bot');
    assert.ok(types.includes('done'), 'termina com done');
    // Ordem: primeiro "pensando", depois reply, depois cards.
    const firstStatus = events.find((e) => e.event === 'status');
    assert.equal(firstStatus.data.phase, 'thinking', 'abre com pensando');
    const thinkingIdx = events.findIndex((e) => e.event === 'status');
    const replyIdx = events.findIndex((e) => e.event === 'reply');
    assert.ok(thinkingIdx < replyIdx, 'pensando vem antes da resposta');

    // Etapas ao vivo: card de audiência anunciado por status "Criando audiência…".
    const statuses = events.filter((e) => e.event === 'status').map((e) => e.data.label);
    assert.ok(statuses.some((l) => l && l.includes('Criando audiência')), 'etapa audiência anunciada');
    const cards = events.filter((e) => e.event === 'card').map((e) => e.data.card);
    assert.ok(cards.some((card) => card.type === 'audience'), 'card de audiência no stream');

    // Turno persistido como no síncrono.
    const history = (await api('GET', `/campaigns/${c.data.id}/chat`)).body.data;
    assert.equal(history.length, 2);
  } finally {
    server.close();
  }
});


test('chat telemetry: persiste duração, turno e actions sem persistir conteúdo do prompt', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Telemetry', channels: ['email'] });
    const { res } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'Quero vender ERP para indústrias',
    });
    assert.equal(res.status, 200);

    assert.equal(prisma.studioChatTrace.rows.length, 1);
    const trace = prisma.studioChatTrace.rows[0];
    assert.equal(trace.campaignId, c.data.id);
    assert.equal(trace.orgId, 'org-1');
    assert.equal(trace.turnIndex, 1);
    assert.ok(trace.durationMs >= 0);
    assert.ok(Array.isArray(trace.actionTypes));
    assert.ok(trace.actionTypes.includes('set_objective') || trace.actionTypes.includes('set_audience'));
    assert.ok(!Object.prototype.hasOwnProperty.call(trace, 'prompt'));
    assert.ok(!Object.prototype.hasOwnProperty.call(trace, 'response'));

    const traces = await api('GET', `/campaigns/${c.data.id}/traces`);
    assert.equal(traces.res.status, 200);
    assert.equal(traces.body.data.length, 1);
    assert.equal(traces.body.data[0].turnIndex, 1);
  } finally {
    server.close();
  }
});
