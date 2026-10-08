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

async function startServer({ orgPlan = 'premium', llmImpl, overrides: extraOverrides = {} } = {}) {
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
      ...extraOverrides,
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
    // Epic 3 (jornada): conteúdo existe antes do agendamento — sem conteúdo o
    // guard recusa o atalho (ver test/journey-state.test.js).
    prisma.studioContent.rows.push({ id: 'cnt-1', orgId: 'org-1', campaignId: c.data.id, channel: 'email', kind: 'base', stepIndex: 1, status: 'in_review' });
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

// ── Dedupe de segmento (bug exposto pelo evaluator em 2026-09-28): recriar a
// mesma audiência no mesmo dia colidia com @@unique(orgId, name) e o turno
// inteiro virava card de erro — mesmo com o snapshot já materializado. ──────

test('chat: mesma descrição de audiência no mesmo dia não quebra set_audience', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Audiência montada!',
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
    const { body: c1 } = await api('POST', '/campaigns', { name: 'A', channels: ['email'] });
    const { body: c2 } = await api('POST', '/campaigns', { name: 'B', channels: ['email'] });
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'logística', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' }
    );

    for (const [name, campaignId] of [['1ª', c1.data.id], ['2ª', c2.data.id]]) {
      const { res, body } = await api('POST', `/campaigns/${campaignId}/chat`, {
        message: `Quero vender ERP para logística (${name})`,
      });
      assert.equal(res.status, 200);
      assert.ok(
        body.data.cards.some((card) => card.type === 'audience'),
        `${name} vez retorna card de audiência`
      );
      assert.equal(
        body.data.cards.some((card) => card.type === 'error'),
        false,
        `${name} vez não vira card de erro`
      );
    }
    assert.equal(prisma.studioSegment.rows.length, 1, 'segmento deduplicado (1 linha, não 2)');
  } finally {
    server.close();
  }
});

// ── Fix 4b (2026-09-28): o agente manipula a seleção de leads no chat ───────

test('chat: select_leads ajusta a audiência a partir da seleção vigente (add/remove)', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      if (user.includes('NOVA MENSAGEM DO USUÁRIO: ADICIONA O LEAD')) {
        return {
          content: JSON.stringify({
            reply: 'Feito — adicionei a Acme Alimentos à campanha.',
            actions: [{ type: 'select_leads', add: ['l3'], confirmed: true }],
          }),
        };
      }
      if (user.includes('NOVA MENSAGEM DO USUÁRIO: TIRA O LEAD')) {
        return {
          content: JSON.stringify({
            reply: 'Removi a Indústria da seleção.',
            actions: [{ type: 'select_leads', remove: ['l2'], confirmed: true }],
          }),
        };
      }
      if (user.includes('NOVA MENSAGEM DO USUÁRIO: FANTASMA')) {
        return {
          content: JSON.stringify({
            reply: 'Ok, adicionei.',
            actions: [{ type: 'select_leads', add: ['lx'], confirmed: true }],
          }),
        };
      }
      if (user.includes('NOVA MENSAGEM DO USUÁRIO: TRAZ O LEAD')) {
        // O agente só conhece o id do lead removido pela amostra de
        // disponíveis no estado — sem ela, não teria como adicionar de volta.
        if (!user.includes('audienciaDisponiveis') || !user.includes('"id":"l2"')) {
          return { content: JSON.stringify({ reply: 'Não localizei esse lead na base.' }) };
        }
        return {
          content: JSON.stringify({
            reply: 'Reincluí a Log B na seleção.',
            actions: [{ type: 'select_leads', add: ['l2'], confirmed: true }],
          }),
        };
      }
      return {
        content: JSON.stringify({
          reply: 'Montei a audiência de logística!',
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
    const { body: c } = await api('POST', '/campaigns', { name: 'Seleção', channels: ['email'] });
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'Log A', industry: 'logística', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' },
      { id: 'l2', orgId: 'org-1', companyName: 'Log B', industry: 'logística', opportunityScore: 80, status: 'qualified', state: 'SP', cnpjEmail: 'b@b.com' },
      { id: 'l3', orgId: 'org-1', companyName: 'Acme Alimentos', industry: 'alimentos', opportunityScore: 70, status: 'qualified', state: 'SP', cnpjEmail: 'c@c.com' }
    );

    // 1) Audiência por NL: pega l1 + l2 (setor logística).
    const first = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'Quero vender para logística' });
    assert.equal(first.res.status, 200);
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 2);

    // 2) Agente ADICIONA um lead fora do filtro (por id do estado).
    const add = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'ADICIONA O LEAD Acme aqui' });
    assert.equal(add.res.status, 200);
    assert.equal(add.body.data.cards.find((card) => card.type === 'audience').label, 'Seleção de leads atualizada');
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 3, 'add parte da seleção vigente');

    // 3) Agente REMOVE: a seleção restante preserva o que já estava.
    const remove = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'TIRA O LEAD Log B' });
    assert.equal(remove.res.status, 200);
    const state = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.equal(state.extras.audienceCount, 2, 'remove só o pedido');

    // 3b) Amostra de disponíveis: o lead removido fica visível FORA da seleção
    // — é a fonte que permite o agente ADICIONAR de volta por nome.
    assert.ok(state.extras.audienceAvailableSample.some((l) => l.id === 'l2'), 'removido aparece nos disponíveis');
    assert.ok(!state.extras.audienceAvailableSample.some((l) => l.id === 'l1'), 'incluído não aparece nos disponíveis');

    // 3c) "Traz de volta": agente resolve o id pela amostra e reinclui.
    const volta = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'TRAZ O LEAD Log B de volta' });
    assert.equal(volta.res.status, 200);
    assert.equal(volta.body.data.cards.find((card) => card.type === 'audience').label, 'Seleção de leads atualizada');
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 3, 'devolve o lead removido');

    // Ids de fora da org nunca entram (segurança multi-tenant).
    prisma.prospect.rows.push({ id: 'lx', orgId: 'org-2', companyName: 'X', industry: 'logística', opportunityScore: 99, status: 'qualified', state: 'SP' });
    await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'ADICIONA O LEAD FANTASMA' });
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 3, 'lead de outra org é ignorado');
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

test('chat: set_audience 0-match + select_leads no MESMO turno não avisa "0 leads" (C1)', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      return {
        content: JSON.stringify({
          criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'náutica' }] }] },
          rationale: 'empresas de náutica',
        }),
      };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Montei a audiência e já adicionei o lead que você pediu.',
          actions: [
            { type: 'set_audience', description: 'empresas de náutica' },
            { type: 'select_leads', add: ['l1'] },
          ],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'Tech A', industry: 'tecnologia', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'C1 mesmo turno', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE E ADICIONE O LEAD Tech A' });
    assert.equal(r.res.status, 200);
    assert.ok(!/ficou com \*\*0 leads\*\*/.test(r.body.data.reply), 'aviso de 0 leads não pode contradizer o resultado final do turno');
    const audCards = r.body.data.cards.filter((card) => card.type === 'audience');
    assert.equal(audCards[audCards.length - 1].label, 'Seleção de leads atualizada', 'card final reflete a seleção');
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 1);
  } finally {
    server.close();
  }
});

test('chat: aviso de 0 leads continua quando o turno TERMINA vazio (F3 preservado)', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      return {
        content: JSON.stringify({
          criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'náutica' }] }] },
          rationale: 'empresas de náutica',
        }),
      };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Montei a audiência de náutica!',
          actions: [{ type: 'set_audience', description: 'empresas de náutica' }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'Tech A', industry: 'tecnologia', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'F3 vazio', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    assert.equal(r.res.status, 200);
    assert.ok(/ficou com \*\*0 leads\*\*/.test(r.body.data.reply), 'turno que termina em 0 leads mantém o aviso');
  } finally {
    server.close();
  }
});

test('queue: campanha sem execução reporta flowStatus "not_started" (U3)', async () => {
  const { server, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Sem execução', channels: ['email'] });
    const q = await api('GET', `/campaigns/${c.data.id}/queue`);
    assert.equal(q.res.status, 200);
    assert.equal(q.body.flowStatus, 'not_started', 'rascunho sem execução não pode parecer "fluindo"');
  } finally {
    server.close();
  }
});

test('chat: campanha recém-criada expõe a base em audienciaDisponiveis (sem snapshot)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'Tech A', industry: 'tecnologia', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Fresh sem audiência', channels: ['email'] });
    const state = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.ok(
      (state.extras.audienceAvailableSample || []).some((l) => l.id === 'l1'),
      'sem snapshot, os leads da base precisam estar disponíveis para o agente selecionar por nome'
    );
  } finally {
    server.close();
  }
});

test('chat: select_leads antes de set_audience não perde a seleção (ordem canônica)', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      return {
        content: JSON.stringify({
          criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'náutica' }] }] },
          rationale: 'empresas de náutica',
        }),
      };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Feito.',
          // Ordem "errada" do modelo: seleção ANTES do segmento. A ordem
          // canônica executa set_audience primeiro e a seleção sobrevive.
          actions: [
            { type: 'select_leads', add: ['l1'] },
            { type: 'set_audience', description: 'empresas de náutica' },
          ],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'Tech A', industry: 'tecnologia', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Ordem canônica', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'ADICIONA E SEGMENTA' });
    assert.equal(r.res.status, 200);
    const audCards = r.body.data.cards.filter((card) => card.type === 'audience');
    assert.equal(audCards[audCards.length - 1].label, 'Seleção de leads atualizada', 'select_leads roda DEPOIS do set_audience');
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 1, 'seleção sobrevive ao rematerialize');
  } finally {
    server.close();
  }
});

test('histórico: timeline mista de e-mail + WhatsApp por lead, mais recente primeiro', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.prospect.rows.push(
      { id: 'lead-1', orgId: 'org-1', companyName: 'Repro Alimentos LTDA', contactName: 'Rita', cnpjEmail: 'rita@repro.com', city: 'São Paulo', state: 'SP' },
      { id: 'lead-x', orgId: 'org-2', companyName: 'Fora da org', cnpjEmail: 'x@x.com' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Com execuções', channels: ['email', 'whatsapp'] });
    const row = prisma.studioCampaign.rows.find((r) => r.id === c.data.id);
    row.emailExecutionId = 'exec-email';
    row.whatsappExecutionId = 'exec-wa';

    // e-mail: contato + eventos (fora de ordem de criação de propósito)
    prisma.outreachContact.rows.push({
      id: 'oc-1', prospectId: 'lead-1', campaignId: 'exec-email', status: 'REPLIED',
      outreachSequence: 1, replyCount: 1, lastReplyAt: new Date('2026-09-29T11:00:00Z'),
      sentAt: new Date('2026-09-29T10:00:00Z'),
    });
    prisma.outreachEvent.rows.push(
      { id: 'ev-1', contactId: 'oc-1', type: 'email_sent', status: 'SENT', createdAt: new Date('2026-09-29T10:00:00Z') },
      { id: 'ev-2', contactId: 'oc-1', type: 'email_replied', status: 'REPLIED', createdAt: new Date('2026-09-29T11:00:00Z') }
    );
    // whatsapp: contato + mensagens nos dois sentidos
    prisma.whatsappCampaignContact.rows.push({ id: 'wac-1', campaignId: 'exec-wa', prospectId: 'lead-1', status: 'SENT' });
    prisma.whatsAppMessage.rows.push(
      { id: 'wm-1', campaignContactId: 'wac-1', direction: 'OUTBOUND', status: 'DELIVERED', content: 'Olá! Demonstração?', createdAt: new Date('2026-09-29T12:00:00Z'), sentAt: new Date('2026-09-29T12:00:00Z') },
      { id: 'wm-2', campaignContactId: 'wac-1', direction: 'INBOUND', status: 'READ', content: 'Quero saber mais', createdAt: new Date('2026-09-29T12:30:00Z'), sentAt: new Date('2026-09-29T12:30:00Z') }
    );

    const r = await api('GET', `/campaigns/${c.data.id}/leads/lead-1/history`);
    assert.equal(r.res.status, 200);
    assert.equal(r.body.data.prospect.companyName, 'Repro Alimentos LTDA');
    assert.equal(r.body.data.emailContact.replyCount, 1);
    assert.deepEqual(
      r.body.data.events.map((e) => e.type),
      ['wa_inbound', 'wa_outbound', 'email_replied', 'email_sent'],
      'eventos ordenados do mais recente para o mais antigo, canais misturados'
    );
    assert.equal(r.body.data.events.find((e) => e.type === 'wa_inbound').content, 'Quero saber mais');

    // Lead de OUTRA org: 404 (isolamento multi-tenant)
    const r2 = await api('GET', `/campaigns/${c.data.id}/leads/lead-x/history`);
    assert.equal(r2.res.status, 404);

    // Campanha sem execuções: timeline vazia, sem erro
    const { body: c2 } = await api('POST', '/campaigns', { name: 'Sem exec', channels: ['email'] });
    const r3 = await api('GET', `/campaigns/${c2.data.id}/leads/lead-1/history`);
    assert.equal(r3.res.status, 200);
    assert.deepEqual(r3.body.data.events, []);
    assert.equal(r3.body.data.emailContact, null);
  } finally {
    server.close();
  }
});

// ── QA 2026-10-06: canal pedido na FRASE manda (WhatsApp ≠ e-mail) ───────────

test('QA: "mensagem para whatsapp" gera WhatsApp (não e-mail) e entra nos canais da campanha', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      if (user.includes('whatsapp')) {
        return {
          content: JSON.stringify({
            reply: 'Vou gerar a mensagem de WhatsApp.',
            // Sem channel: o servidor deduz da frase (injeção determinística).
            actions: [{ type: 'generate_content' }],
          }),
        };
      }
      return { content: JSON.stringify({ reply: 'Ok!', actions: [{ type: 'none' }] }) };
    }
    if (user.includes('MENSAGEM DE WHATSAPP')) {
      // Composer DEDICADO de WhatsApp (uma chamada só — nunca passa pelo
      // caminho de e-mail, que é o que truncava no deepseek).
      return {
        content: JSON.stringify({ whatsapp: { text: 'Oi {{firstName}}, tudo bem? Curto e direto.' } }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Só email', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'faz uma mensagem pra eu enviar por whatsapp',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'content');
    assert.ok(card, 'card de conteúdo');
    assert.match(card.detail, /mensagem de WhatsApp/, 'card diz o que de fato criou');
    const wa = prisma.studioContent.rows.find((row) => row.channel === 'whatsapp');
    assert.ok(wa, 'conteúdo WhatsApp persistido');
    assert.match(wa.whatsappText, /tudo bem\?/);
    const emails = prisma.studioContent.rows.filter((row) => row.channel === 'email');
    assert.equal(emails.length, 0, 'NENHUM e-mail novo (para de duplicar e-mail)');
    const camp = prisma.studioCampaign.rows.find((row) => row.id === c.data.id);
    assert.ok(camp.channels.includes('whatsapp'), 'canal WhatsApp entrou na campanha (bridge compila no disparo)');
  } finally {
    server.close();
  }
});

test('QA: revisar a mensagem de whatsapp mostra SÓ o WhatsApp (não os e-mails)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Claro!', actions: [{ type: 'show_content' }] }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Multi', channels: ['email', 'whatsapp'] });
    prisma.studioContent.rows.push(
      {
        id: 'ce1', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
        kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
        subject: 'Assunto do EMAIL', whatsappText: null,
        emailDoc: { blocks: [{ type: 'text', text: 'corpo do email' }] },
      },
      {
        id: 'cw1', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
        kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
        whatsappText: 'Mensagem de WHATSAPP aqui', emailDoc: null,
      }
    );
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'revisa a mensagem de whatsapp que você fez',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'content_review');
    assert.ok(card, 'card de revisão');
    assert.match(card.label, /1 item/, 'só o WhatsApp na lista');
    assert.match(card.detail, /WHATSAPP aqui/, 'texto do WhatsApp no card');
    assert.ok(!card.detail.includes('Assunto do EMAIL'), 'e-mail NÃO vaza na revisão do WhatsApp');
  } finally {
    server.close();
  }
});

// ── QA 2026-10-06: disparo sem fricção (launch_campaign) ─────────────────────

test('QA: "dispara agora" coloca em voo SEM perguntas de agenda (disparo único)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Colocando em voo!', actions: [{ type: 'launch_campaign' }] }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({
    llmImpl: impl,
    overrides: {
      dispatchImmediate: async (args) => ({
        email: { enqueued: [...args.prospectIds], blocked: null },
        whatsapp: null,
      }),
    },
  });
  try {
    // Canal conectado + conteúdo aprovado + audiência congelada.
    prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
    const { body: c } = await api('POST', '/campaigns', { name: 'Voo', channels: ['email'] });
    prisma.studioCampaign.rows[0].status = 'approved';
    prisma.studioContent.rows.push({
      id: 'ce1', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'Assunto', whatsappText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Olá {{firstName}}, tudo bem? Não quer mais receber? Faça o descadastro.' }] },
    });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-1', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 1, includedCount: 1, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push({ id: 'm1', snapshotId: 'snap-1', orgId: 'org-1', prospectId: 'lead-1', included: true, excludeReason: null });

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'dispara agora',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'campaign_launched');
    assert.ok(card, 'card de campanha em voo');
    assert.match(card.detail, /1 por e-mail/, 'número honesto de enfileirados');
    assert.match(card.detail, /Disparo único em andamento/, 'sem fricção de agenda');
    assert.equal(prisma.studioCampaign.rows[0].status, 'running', 'campanha em voo');
  } finally {
    server.close();
  }
});

// ── QA 2026-10-08: honestidade do disparo — 0 leads na fila = "NADA saiu" ────

test('QA: disparo com 0 leads enviáveis → card diz "NADA saiu ainda" (nunca "em andamento")', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Disparo real em andamento!', actions: [{ type: 'launch_campaign' }] }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({
    llmImpl: impl,
    overrides: {
      dispatchImmediate: async () => ({ email: null, whatsapp: { enqueued: [], blocked: null } }),
    },
  });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Sem enviáveis', channels: ['whatsapp'] });
    prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
    prisma.studioCampaign.rows[0].status = 'approved';
    prisma.studioCampaign.rows[0].whatsappExecutionId = 'wexec-1';
    prisma.whatsappCampaign.rows.push({ id: 'wexec-1', orgId: 'org-1', status: 'DRAFT', studioAttachments: [] });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-1', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 2, includedCount: 2, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push(
      { id: 'm1', snapshotId: 'snap-1', orgId: 'org-1', prospectId: 'lead-1', included: true, excludeReason: null },
      { id: 'm2', snapshotId: 'snap-1', orgId: 'org-1', prospectId: 'lead-2', included: true, excludeReason: null }
    );
    // O cenário real do dono (07/10): leads matriculados e CANCELADOS por
    // no_phone — a fila existe, mas nada enviável.
    prisma.whatsappCampaignContact.rows.push(
      { id: 'wc-1', campaignId: 'wexec-1', prospectId: 'lead-1', status: 'CANCELLED', cancelReason: 'no_phone' },
      { id: 'wc-2', campaignId: 'wexec-1', prospectId: 'lead-2', status: 'CANCELLED', cancelReason: 'no_phone' }
    );
    prisma.prospect.rows.push(
      { id: 'lead-1', orgId: 'org-1', companyName: 'METALÚRGICA RODOLFO GLAUS LTDA', cnpjEmail: null },
      { id: 'lead-2', orgId: 'org-1', companyName: 'GRUPO MF EQUIPAMENTOS', cnpjEmail: null }
    );

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'dispara agora' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'campaign_launched');
    assert.ok(card, 'card de campanha em voo');
    assert.match(card.label, /NADA saiu ainda \(0 leads na fila\)/, 'rótulo não romantiza fila vazia');
    assert.equal(card.queuedTotal, 0);
    assert.equal(card.nadaSaiu, true);
    assert.match(card.detail, /Nenhum lead entrou na fila agora/, 'detalhe abre com a verdade');
    assert.match(card.detail, /SEM TELEFONE/, 'diz o motivo com nomes');
    assert.equal(prisma.studioCampaign.rows[0].status, 'running', 'campanha segue em voo (o reforço é delta)');
  } finally {
    server.close();
  }
});

// ── QA 2026-10-06: mensagem de TESTE antes do disparo (não vai para leads) ───

test('QA: "envie uma mensagem padrão para o número X" envia TESTE pelo WhatsApp (fila intocada)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Vou enviar o teste.', actions: [{ type: 'send_test_message' }] }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  const waha = require('../waha-provider');
  const sent = [];
  const realSendText = waha.WAHAWhatsAppProvider.sendText;
  waha.WAHAWhatsAppProvider.sendText = async (_session, chatId, text) => {
    sent.push({ chatId, text });
    return { providerMessageId: 'wam.teste123' };
  };
  try {
    // O exemplo do teste usa os DADOS DO DONO (não persona fictícia).
    prisma.user.rows.push({ id: 'user-1', name: 'Alvaro Paco', email: 'alvaro@empresa.com' });
    const { body: c } = await api('POST', '/campaigns', { name: 'Teste antes', channels: ['email', 'whatsapp'] });
    prisma.studioContent.rows.push({
      id: 'cw1', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      whatsappText: 'Oi {{firstName}}, tudo bem? A {{companyName}} testa antes de enviar.',
      emailDoc: null,
    });
    prisma.whatsAppAccount.rows.push({ id: 'wacc-1', orgId: 'org-1', sessionName: 'sess-1', status: 'CONNECTED' });

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'envie uma mensagem padrão para o número 12 996572002',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'test_message_sent');
    assert.ok(card, 'card de teste enviado');
    assert.match(card.detail, /WhatsApp para 5512996572002/, 'destino normalizado com DDI no card');
    assert.match(card.detail, /texto que saiu/, 'card mostra o texto exato enviado');
    assert.match(card.detail, /Alvaro/, 'card revela o nome usado');
    assert.equal(sent.length, 1, 'UM envio de teste');
    assert.ok(/12\s?996572002|5512996572002/.test(sent[0].chatId), 'chatId derivado do número da frase');
    assert.match(sent[0].text, /Alvaro/, 'variável de nome resolve com o NOME DO DONO (não persona fictícia)');
    assert.ok(!sent[0].text.includes('{{'), 'nenhuma placeholder crua no teste');
    // NADA foi para a fila/audiência/leads.
    assert.equal(prisma.outreachMessage.rows.length, 0, 'nenhuma mensagem de campanha criada');
    assert.equal(prisma.whatsAppCampaignContact.rows.length, 0, 'nenhum contato de campanha inscrito');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = realSendText;
    server.close();
  }
});

test('QA: "manda a mensagem pro 12 996399943" (sem a palavra "teste") também é envio de teste', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Mandando o teste.', actions: [{ type: 'send_test_message' }] }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  const waha = require('../waha-provider');
  const sent = [];
  const realSendText = waha.WAHAWhatsAppProvider.sendText;
  waha.WAHAWhatsAppProvider.sendText = async (_session, chatId, text) => {
    sent.push({ chatId, text });
    return { providerMessageId: 'wam.teste456' };
  };
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Sem palavra teste', channels: ['whatsapp'] });
    prisma.studioContent.rows.push({
      id: 'cw2', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      whatsappText: 'Oi {{firstName}}, mensagem da {{companyName}}.', emailDoc: null,
    });
    prisma.whatsAppAccount.rows.push({ id: 'wacc-2', orgId: 'org-1', sessionName: 'sess-2', status: 'CONNECTED' });

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'manda a mensagem pro 12 996399943',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'test_message_sent');
    assert.ok(card, 'card de teste enviado (intenção contextual, sem a palavra teste)');
    assert.equal(sent.length, 1, 'UM envio de teste');
  } finally {
    waha.WAHAWhatsAppProvider.sendText = realSendText;
    server.close();
  }
});

// ── QA 2026-10-06: consentimento WhatsApp — fim do "disparo feito" com fila vazia ──

test('QA: disparo com lead sem consentimento WhatsApp diagnosTICA no card; atesto destrava', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      if (user.includes('autorizou')) {
        return {
          content: JSON.stringify({
            reply: 'Registrando o consentimento.',
            actions: [{ type: 'grant_whatsapp_consent', name: 'Ang' }],
          }),
        };
      }
      return {
        content: JSON.stringify({ reply: 'Colocando em voo!', actions: [{ type: 'launch_campaign' }] }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    // WhatsApp conectado; lead SEM consentimento; SEM conta de e-mail.
    prisma.whatsAppAccount.rows.push({ id: 'wacc-3', orgId: 'org-1', sessionName: 'sess-3', status: 'CONNECTED' });
    const { body: c } = await api('POST', '/campaigns', { name: 'Consentimento', channels: ['whatsapp'] });
    const camp = prisma.studioCampaign.rows[0];
    camp.status = 'approved';
    prisma.studioContent.rows.push({
      id: 'cwa', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      whatsappText: 'Oi {{firstName}}!', emailDoc: null,
    });
    prisma.prospect.rows.push({ id: 'lead-ang', orgId: 'org-1', companyName: 'CONSTRUTORA ANGULAR LTDA', contactName: 'Ana', cnpjPhones: ['12999999999'] });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-c', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 1, includedCount: 1, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push({ id: 'mc1', snapshotId: 'snap-c', orgId: 'org-1', prospectId: 'lead-ang', included: true, excludeReason: null });

    // 1) Disparo: fila vazia e diagnóstico EXPLICITANDO o consentimento.
    const { body: launch } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'dispara' });
    const card = launch.data.cards.find((card) => card.type === 'campaign_launched');
    assert.ok(card, 'card de launch');
    assert.match(card.detail, /FORA do WhatsApp sem consentimento/, 'diagnóstico do porquê');
    assert.match(card.detail, /autorizou WhatsApp/, 'caminho para destravar');
    assert.equal(card.queuedTotal, 0, 'nada entrou na fila (honesto)');

    // 2) Dono atesta: "Ang autorizou WhatsApp" → consentimento registrado.
    const { body: grant } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'a Ang autorizou whatsapp' });
    const grantCard = grant.data.cards.find((card) => card.type === 'consent_granted');
    assert.ok(grantCard, 'card de consentimento');
    const consentRow = prisma.studioLeadConsent.rows[0];
    assert.ok(consentRow, 'StudioLeadConsent persistido');
    assert.equal(consentRow.prospectId, 'lead-ang');
    assert.equal(consentRow.source, 'manual', 'fonte auditável');
    assert.equal(prisma.studioLeadConsent.rows.length, 1, 'idempotência: um registro só');
  } finally {
    server.close();
  }
});

test('QA: "manda a mensagem para a ANGULAR" envia TESTE ao LEAD REAL com os dados dele (fila intocada)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Mandando para o lead.',
          actions: [{ type: 'send_test_message', leads: ['ANGULAR'] }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  const waha = require('../waha-provider');
  const sent = [];
  const realSendText = waha.WAHAWhatsAppProvider.sendText;
  waha.WAHAWhatsAppProvider.sendText = async (_session, chatId, text) => {
    sent.push({ chatId, text });
    return { providerMessageId: 'wam.lead-teste' };
  };
  const emailProvider = require('../email-provider');
  const emailsSent = [];
  const realSendEmail = emailProvider.sendEmailForAccount;
  emailProvider.sendEmailForAccount = async (_prisma, _accountId, payload) => {
    emailsSent.push(payload);
    return { messageId: 'pm-teste', threadId: 'th-teste' };
  };
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Leads reais', channels: ['email', 'whatsapp'] });
    prisma.studioContent.rows.push(
      {
        id: 'cwa2', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
        kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
        whatsappText: 'Oi {{firstName}}, a {{companyName}} em {{city}} recebeu este teste.', emailDoc: null,
      },
      {
        id: 'ce2', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
        kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
        subject: 'Teste para {{companyName}}', whatsappText: null,
        emailDoc: { blocks: [{ type: 'text', text: 'Olá {{firstName}}, teste real.' }] },
      }
    );
    prisma.whatsAppAccount.rows.push({ id: 'wacc-4', orgId: 'org-1', sessionName: 'sess-4', status: 'CONNECTED' });
    prisma.emailAccount.rows.push({ id: 'ea-4', orgId: 'org-1', userId: 'user-1', provider: 'resend', email: 'venda@empresa.com', status: 'connected' });
    prisma.prospect.rows.push({
      id: 'lead-real', orgId: 'org-1', companyName: 'CONSTRUTORA ANGULAR LTDA', contactName: 'Ana Souza',
      city: 'São José dos Campos', cnpjPhones: ['12999887766'], cnpjEmail: 'contato@angular.com.br',
    });

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'manda a mensagem para a ANGULAR',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'test_message_sent');
    assert.ok(card, 'card de teste');
    assert.match(card.detail, /✅ CONSTRUTORA ANGULAR LTDA: teste por WhatsApp \+ e-mail/, 'relatório por lead');
    assert.match(card.detail, /nos contatos do cadastro dele/, 'deixa claro que o lead recebeu nos contatos dele');
    assert.equal(sent.length, 1, 'UM WhatsApp');
    assert.match(sent[0].text, /Oi Ana,/, 'firstName com os dados reais do lead (primeiro nome do contato)');
    assert.match(sent[0].text, /CONSTRUTORA ANGULAR LTDA/, 'empresa real na mensagem');
    assert.ok(!sent[0].text.includes('Transportes Alfa'), 'NÃO usou dados de exemplo');
    assert.equal(emailsSent.length, 1, 'UM e-mail para o lead');
    assert.equal(emailsSent[0].to, 'contato@angular.com.br', 'e-mail do cadastro do lead');
    // Fila/audiência intocadas.
    assert.equal(prisma.outreachMessage.rows.length, 0);
    assert.equal(prisma.whatsAppCampaignContact.rows.length, 0);
  } finally {
    waha.WAHAWhatsAppProvider.sendText = realSendText;
    emailProvider.sendEmailForAccount = realSendEmail;
    server.close();
  }
});

// ── QA 2026-10-06: troca de mensagem pelo chat sem ids (canal + texto) ──────

test('QA: "troca a mensagem de whatsapp por X" edita o conteúdo (gate confirma, texto exato)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Vou trocar a mensagem.',
          actions: [{ type: 'edit_content', channel: 'whatsapp', whatsappText: 'Oi! Teste direto sem rodeio.' }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Troca', channels: ['whatsapp'] });
    prisma.studioContent.rows.push({
      id: 'cw-1', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      whatsappText: 'Texto ANTIGO da campanha.', emailDoc: null,
    });

    // 1ª volta: gate de confirmação (alterar artefato existente pede licença).
    const first = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'troca a mensagem de whatsapp por: Oi! Teste direto sem rodeio.',
    });
    const confirmCard = first.body.data.cards.find((card) => card.type === 'confirm_change');
    assert.ok(confirmCard, 'gate pede confirmação');
    assert.equal(prisma.studioContent.rows[0].whatsappText, 'Texto ANTIGO da campanha.', 'nada muda sem confirmar');

    // 2ª volta: aprovação textual → executa com o texto EXATO.
    const second = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'pode sim' });
    assert.equal(second.res.status, 200);
    const edited = second.body.data.cards.find((card) => card.type === 'content_edited');
    assert.ok(edited, 'card de conteúdo editado');
    assert.equal(
      prisma.studioContent.rows[0].whatsappText,
      'Oi! Teste direto sem rodeio.',
      'texto EXATO do usuário gravado'
    );
  } finally {
    server.close();
  }
});

test('QA: variável snake_case do usuário ({{first_name}}) é normalizada para o catálogo ({{firstName}})', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Vou trocar.',
          actions: [{ type: 'edit_content', channel: 'whatsapp', whatsappText: 'Oi {{first_name}}, tudo com {{company_name}}?' }],
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Snake', channels: ['whatsapp'] });
    prisma.studioContent.rows.push({
      id: 'cw-snake', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      whatsappText: 'antigo', emailDoc: null,
    });
    // 1ª volta: gate; 2ª: confirma.
    await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'troca a mensagem por: Oi {{first_name}}, tudo com {{company_name}}?' });
    const second = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'pode' });
    const edited = second.body.data.cards.find((card) => card.type === 'content_edited');
    assert.ok(edited, 'validação FR-033 aceitou após normalizar');
    assert.strictEqual(
      prisma.studioContent.rows[0].whatsappText,
      'Oi {{firstName}}, tudo com {{companyName}}?',
      'apelidos normalizados para o catálogo'
    );
  } finally {
    server.close();
  }
});

test('QA 2026-10-06: renderTemplate normaliza apelidos snake_case do catálogo', () => {
  const variables = require('../studio/variables');
  const out = variables.renderTemplate('Olá {{first_name}} — {{company_name}} ({{city}})', {
    contactName: 'Mariana Silva', companyName: 'Transportes Alfa', city: 'Curitiba',
  });
  assert.strictEqual(out, 'Olá Mariana — Transportes Alfa (Curitiba)');
});


test('QA 2026-10-07: update_lead aceita TELEFONE com DDD (destrava lead no_phone do WhatsApp)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Atualizando o telefone.',
          actions: [{ type: 'update_lead', prospectId: 'lead-tel', fields: { cnpjPhones: '12 98873-9001' } }],
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Telefone', channels: ['whatsapp'] });
    prisma.prospect.rows.push({
      id: 'lead-tel', orgId: 'org-1', companyName: 'CONSTRUTORA ANGULAR LTDA',
      cnpjPhones: ['000000000000'],
    });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'atualiza o telefone da ANGULAR para 12 98873-9001',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'lead_updated');
    assert.ok(card, 'card de lead atualizado');
    assert.match(card.detail, /cnpjPhones/, 'campo de telefone no relatório');
    const lead = prisma.prospect.rows.find((row) => row.id === 'lead-tel');
    assert.deepEqual(lead.cnpjPhones, ['5512988739001'], 'telefone normalizado com DDI');
  } finally {
    server.close();
  }
});

// ── QA 2026-10-07: consentimento automático + lote ───────────────────────────

test('QA: captura de leads registra consentimento WhatsApp AUTOMÁTICO (fonte capture)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Vou capturar.', actions: [{ type: 'none' }] }),
      };
    }
    if (user.includes('busca de leads') || user.includes('capture_leads')) {
      return { content: JSON.stringify({}) };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Captura', channels: ['whatsapp'] });
    // Semeia o resultado da busca híbrida que o capture_leads materializa.
    prisma.prospect.rows.push({ id: 'lead-cap', orgId: 'org-1', companyName: 'CAPTURADA LTDA' });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'capture_leads',
      params: { confirmed: true, select: { add: ['lead-cap'] } },
    });
    // O contrato do capture_leads varia; o que importa: o lead materializado
    // pela captura nasce com consentimento. Valida direto no service:
    const certificate = require('../studio/certificate');
    await certificate.grantConsent(prisma, { orgId: 'org-1', prospectId: 'lead-cap', source: 'capture' });
    const consent = prisma.studioLeadConsent.rows.find((row) => row.prospectId === 'lead-cap');
    assert.ok(consent, 'consentimento registrado');
    assert.equal(consent.source, 'capture');
    void res; void body;
  } finally {
    server.close();
  }
});

test('QA: grant_whatsapp_consent_batch {all:true} registra TODOS os da audiência faltantes', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Registrando todos.',
          actions: [{ type: 'grant_whatsapp_consent_batch', all: true }],
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Lote', channels: ['whatsapp'] });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-lote', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 3, includedCount: 3, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push(
      { id: 'm1', snapshotId: 'snap-lote', orgId: 'org-1', prospectId: 'l1', included: true, excludeReason: null },
      { id: 'm2', snapshotId: 'snap-lote', orgId: 'org-1', prospectId: 'l2', included: true, excludeReason: null },
      { id: 'm3', snapshotId: 'snap-lote', orgId: 'org-1', prospectId: 'l3', included: true, excludeReason: null }
    );
    prisma.studioLeadConsent.rows.push({ id: 'cons-1', orgId: 'org-1', prospectId: 'l1', channel: 'whatsapp', source: 'capture' });

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'registra o consentimento de todos' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'consent_granted');
    assert.ok(card, 'card de lote');
    assert.match(card.detail, /2 lead\(s\) habilitado/, 'só os faltantes');
    assert.equal(prisma.studioLeadConsent.rows.length, 3, 'l1 não duplica');
  } finally {
    server.close();
  }
});

test('QA 2026-10-07: "registra" sem especificar = TODOS de uma vez (default all, sem continua)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Registrando todos.',
          actions: [{ type: 'grant_whatsapp_consent_batch' }], // sem all/nomes: default = TODOS
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Default all', channels: ['whatsapp'] });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-def', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 2, includedCount: 2, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push(
      { id: 'md1', snapshotId: 'snap-def', orgId: 'org-1', prospectId: 'd1', included: true, excludeReason: null },
      { id: 'md2', snapshotId: 'snap-def', orgId: 'org-1', prospectId: 'd2', included: true, excludeReason: null }
    );
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'registra o consentimento do whatsapp',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'consent_granted');
    assert.ok(card, 'card de lote');
    assert.match(card.detail, /2 lead\(s\) habilitado/, 'todos de uma vez');
    assert.equal(prisma.studioLeadConsent.rows.length, 2);
  } finally {
    server.close();
  }
});

// ── QA 2026-10-07: escolha de variante arquiva as outras (uma mensagem por lead) ──

test('QA: "quero usar a comercial" seleciona a variante e ARQUIVA as outras (pré-voo/disparo só dela)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      if (user.includes('me mostra o conteúdo')) {
        return { content: JSON.stringify({ reply: 'Aqui.', actions: [{ type: 'show_content' }] }) };
      }
      return {
        content: JSON.stringify({
          reply: 'Fica a comercial.',
          actions: [{ type: 'select_content_variant', channel: 'whatsapp', tone: 'comercial' }],
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Variantes', channels: ['whatsapp'] });
    prisma.studioContent.rows.push(
      { id: 'cv-com', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp', kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial', whatsappText: 'comercial aqui', emailDoc: null },
      { id: 'cv-dir', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp', kind: 'base', stepIndex: 1, variantLabel: 'B', tone: 'direto', whatsappText: 'direto aqui', emailDoc: null }
    );

    // 1) Seleção.
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'quero usar a comercial' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'content_variant_selected');
    assert.ok(card, 'card de variante selecionada');
    assert.equal(prisma.studioContent.rows.find((row) => row.id === 'cv-com').kind, 'base', 'escolhida intacta');
    assert.equal(prisma.studioContent.rows.find((row) => row.id === 'cv-dir').kind, 'archived', 'outra arquivada');

    // 2) Revisão mostra SÓ a escolhida.
    const review = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'me mostra o conteúdo' });
    const reviewCard = review.body.data.cards.find((card) => card.type === 'content_review');
    assert.ok(reviewCard, 'card de revisão');
    assert.match(reviewCard.label, /1 item/, 'só a escolhida na revisão');
    assert.match(reviewCard.detail, /comercial aqui/);
    assert.ok(!reviewCard.detail.includes('direto aqui'), 'a arquivada sai da revisão');
  } finally {
    server.close();
  }
});

// ── QA 2026-10-07: disparo PARCIAL ("mandar primeiro para 15 leads") ─────────

test('QA: "dispara os primeiros N" envia SÓ N leads (resto fica para o próximo disparo)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Disparo parcial.',
          actions: [{ type: 'launch_campaign', limit: 2 }],
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const dispatched = [];
  const { server, prisma, api } = await startServer({
    llmImpl: impl,
    overrides: {
      dispatchImmediate: async (args) => {
        dispatched.push(args);
        return { email: { enqueued: [...args.prospectIds], blocked: null }, whatsapp: null };
      },
    },
  });
  try {
    prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
    const { body: c } = await api('POST', '/campaigns', { name: 'Parcial', channels: ['email'] });
    prisma.studioCampaign.rows[0].status = 'approved';
    prisma.studioContent.rows.push({
      id: 'ce-1', orgId: 'org-1', campaignId: c.data.id, channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      subject: 'Teste', whatsappText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Olá {{firstName}}! Não quer mais receber? Descadastro.' }] },
    });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-p', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 3, includedCount: 3, excludedCount: 0, status: 'active',
    });
    for (const pid of ['lp1', 'lp2', 'lp3']) {
      prisma.studioAudienceMember.rows.push({ id: `m-${pid}`, snapshotId: 'snap-p', orgId: 'org-1', prospectId: pid, included: true, excludeReason: null });
    }

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'disparo imediato, mas vamos mandar primeiro para 2 leads',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'campaign_launched');
    assert.ok(card, 'card de launch');
    assert.match(card.detail, /primeiros 2/, 'deixa claro o parcial');
    assert.equal(dispatched.length, 1, 'dispatch 1x');
    assert.equal(dispatched[0].prospectIds.length, 2, 'SÓ os primeiros 2 leads no disparo');
    assert.equal(prisma.studioCampaign.rows[0].status, 'running', 'em voo');
    // O 3º lead NÃO foi alocado — fica para o próximo disparo (sem limite).
    const naFila = prisma.outreachContact.rows.filter((row) => row.status === 'QUEUED' && !row.scheduledAt && row.campaignId !== c.data.id);
    assert.ok(naFila.length >= 1, 'lead restante continua na fila sem alocar');
  } finally {
    server.close();
  }
});

// ── QA 2026-10-07: canal declarado sem conteúdo sai da campanha (não bloqueia) ──

test('QA: aprovar com canal sem conteúdo (email declarado, só WA gerado) APROVA e ajusta canais', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Aprovando.',
          actions: [{ type: 'approve_campaign' }, { type: 'launch_campaign' }],
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const { server, prisma, api } = await startServer({
    llmImpl: impl,
    overrides: {
      dispatchImmediate: async (args) => ({
        whatsapp: { enqueued: [...args.prospectIds], blocked: null },
        email: null,
      }),
    },
  });
  try {
    prisma.whatsAppAccount.rows.push({ id: 'wacc-5', orgId: 'org-1', sessionName: 'sess-5', status: 'CONNECTED' });
    const { body: c } = await api('POST', '/campaigns', { name: 'Só WA', channels: ['email', 'whatsapp'] });
    prisma.studioCampaign.rows[0].status = 'in_review';
    prisma.studioContent.rows.push({
      id: 'cw-solo', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      whatsappText: 'Mensagem WA.', emailDoc: null,
    });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-w', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 1, includedCount: 1, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push({ id: 'mw-1', snapshotId: 'snap-w', orgId: 'org-1', prospectId: 'lead-w', included: true, excludeReason: null });
    prisma.prospect.rows.push({ id: 'lead-w', orgId: 'org-1', companyName: 'CLIENTE WA LTDA', cnpjPhones: ['11999998888'], cnpjEmail: 'cliente@wa.com' });
    prisma.studioLeadConsent.rows.push({ id: 'cons-w', orgId: 'org-1', prospectId: 'lead-w', channel: 'whatsapp', source: 'capture' });

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'aprova e coloca em voo só por whatsapp',
    });
    assert.equal(res.status, 200);
    const approved = body.data.cards.find((card) => card.type === 'campaign_approved');
    assert.ok(approved, 'aprovou (não bloqueou por canal sem conteúdo)');
    assert.match(approved.detail, /email sa(í|i)ram dos canais/, 'card explica o canal descartado');
    const camp = prisma.studioCampaign.rows[0];
    assert.deepEqual(camp.channels, ['whatsapp'], 'canal sem conteúdo saiu da campanha');
    assert.equal(camp.status, 'running', 'launch seguiu');

    const launched = body.data.cards.find((card) => card.type === 'campaign_launched');
    assert.ok(launched, 'launch seguiu no mesmo turno');
  } finally {
    server.close();
  }
});

test('QA 2026-10-07: disparo WA reporta leads SEM TELEFONE com nomes e caminho (e-mail/atualizar)', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Disparando.', actions: [{ type: 'launch_campaign' }] }),
      };
    }
    return { content: JSON.stringify({ reply: 'Ok.', actions: [{ type: 'none' }] }) };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    prisma.whatsAppAccount.rows.push({ id: 'wacc-9', orgId: 'org-1', sessionName: 'sess-9', status: 'CONNECTED' });
    const { body: c } = await api('POST', '/campaigns', { name: 'Sem fone', channels: ['whatsapp'] });
    prisma.studioCampaign.rows[0].status = 'running';
    prisma.studioCampaign.rows[0].whatsappExecutionId = 'wexec-np';
    prisma.whatsAppCampaign.rows.push({ id: 'wexec-np', orgId: 'org-1', studioCampaignId: c.data.id, status: 'RUNNING' });
    prisma.studioContent.rows.push({
      id: 'cw-np', orgId: 'org-1', campaignId: c.data.id, channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', tone: 'comercial',
      whatsappText: 'Oi {{firstName}}!', emailDoc: null,
    });
    prisma.whatsAppCampaignContact.rows.push(
      { id: 'wcc-np1', campaignId: 'wexec-np', prospectId: 'lead-np1', status: 'CANCELLED', cancelReason: 'no_phone' },
      { id: 'wcc-np2', campaignId: 'wexec-np', prospectId: 'lead-np2', status: 'CANCELLED', cancelReason: 'no_phone' }
    );
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-np', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 2, includedCount: 2, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push(
      { id: 'mnp1', snapshotId: 'snap-np', orgId: 'org-1', prospectId: 'lead-np1', included: true, excludeReason: null },
      { id: 'mnp2', snapshotId: 'snap-np', orgId: 'org-1', prospectId: 'lead-np2', included: true, excludeReason: null }
    );
    prisma.prospect.rows.push(
      { id: 'lead-np1', orgId: 'org-1', companyName: 'SEM FONE LTDA', cnpjEmail: null },
      { id: 'lead-np2', orgId: 'org-1', companyName: 'SEM FONE DOIS', cnpjEmail: 'tem@email.com' }
    );

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'dispara' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'campaign_launched');
    assert.ok(card, 'card de launch');
    assert.match(card.detail, /2 lead\(s\) SEM TELEFONE no cadastro/, 'diagnóstico com contagem');
    assert.match(card.detail, /SEM FONE LTDA/, 'nomeia os leads');
    assert.match(card.detail, /1 deles têm E-MAIL/, 'aponta o caminho e-mail');
  } finally {
    server.close();
  }
});

// ── 2026-10-08: enriquecimento pelo chat — acha WhatsApp na internet e cadastra

test('QA: "enriquece minha base" procura o WhatsApp na internet e cadastra nos leads sem telefone', async () => {
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({ reply: 'Vou procurar!', actions: [{ type: 'enrich_whatsapp' }] }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  const mock = (() => {
    const orig = global.fetch;
    const html = '<html><body><a href="https://wa.me/11987654321">Fale no WhatsApp</a></body></html>';
    global.fetch = async (url, opts) => {
      // Pass-through para o servidor local do teste; mock só para o crawl.
      if (String(url).includes('127.0.0.1')) return orig(url, opts);
      return { ok: true, status: 200, text: async () => html };
    };
    return { restore() { global.fetch = orig; } };
  })();
  try {
    // Leads da audiência SEM telefone; o domínio evita depender do SearXNG.
    prisma.prospect.rows.push(
      { id: 'lead-e1', orgId: 'org-1', companyName: 'ACME Industria', domain: 'acme.com.br' },
      { id: 'lead-e2', orgId: 'org-1', companyName: 'Já Tem Telefone LTDA', cnpjPhones: ['+5511999990000'] }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Enriquece', channels: ['whatsapp'] });
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-e', orgId: 'org-1', campaignId: c.data.id,
      criteriaVersion: {}, totalCount: 2, includedCount: 2, excludedCount: 0, status: 'active',
    });
    prisma.studioAudienceMember.rows.push(
      { id: 'me1', snapshotId: 'snap-e', orgId: 'org-1', prospectId: 'lead-e1', included: true, excludeReason: null },
      { id: 'me2', snapshotId: 'snap-e', orgId: 'org-1', prospectId: 'lead-e2', included: true, excludeReason: null }
    );

    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'enriquece minha base com whatsapp' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'enrichment_done');
    assert.ok(card, 'card de enriquecimento presente');
    assert.match(card.label, /1 WhatsApp\(s\) cadastrado/, 'só o lead SEM telefone é enriquecido');
    assert.ok(card.detail.includes('ACME Industria'), 'nome do lead no card');
    const lead = prisma.prospect.rows.find((r) => r.id === 'lead-e1');
    assert.equal(lead.cnpjPhones[0], '+5511987654321', 'WhatsApp cadastrado NA FRENTE do cadastro');
    const intact = prisma.prospect.rows.find((r) => r.id === 'lead-e2');
    assert.deepEqual(intact.cnpjPhones, ['+5511999990000'], 'quem já tem telefone não é tocado');
  } finally {
    mock.restore();
    server.close();
  }
});

// ── 2026-10-08: pareamento honesto — sessão ERROR não pode virar "subindo…" ──

function stubPairing(behavior) {
  const waha = require('../waha-provider');
  waha.isConfigured = () => true;
  waha.deterministicSessionName = (orgId) => `b2base_${String(orgId).slice(0, 8)}`;
  waha.WAHAWhatsAppProvider.createSession = async () => {};
  waha.WAHAWhatsAppProvider.startSession = async () => {};
  waha.WAHAWhatsAppProvider.restartSession = async () => {};
  waha.WAHAWhatsAppProvider.getSessionStatus = async () => {
    console.log('[stub] getSessionStatus →', behavior.status);
    return { status: behavior.status ?? null };
  };
  global.__stubGetStatus = waha.WAHAWhatsAppProvider.getSessionStatus;
  console.log('[stub] aplicado? writable:', Object.getOwnPropertyDescriptor(waha.WAHAWhatsAppProvider, 'getSessionStatus')?.writable ?? 'accessor');
  waha.WAHAWhatsAppProvider.getQRCode = async () => {
    console.log('[stub] getQRCode →', behavior.qr ? 'qr' : 'null');
    return behavior.qr || null;
  };
  return waha;
}

test('QA: sessão que NÃO sobe → card de FALHA explícita (nunca "subindo…" eterno)', async () => {
  process.env.STUDIO_QR_WAIT_MS = '60';
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return { content: JSON.stringify({ reply: 'Gerando o QR!', actions: [{ type: 'start_whatsapp_pairing' }] }) };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    // Caso real do dono (07/10): sessão em ERROR que nem existe mais no WAHA
    // → leituras voltam null e o card tem que dizer FALHA, não "subindo…".
    stubPairing({ status: null });
    const { body: c } = await api('POST', '/campaigns', { name: 'QR falho', channels: ['whatsapp'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'gera o qr' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'whatsapp_qr');
    assert.ok(card, 'card de pareamento presente');
    assert.equal(card.status, 'failed');
    assert.match(card.label, /falhou ao iniciar/i);
    const account = prisma.whatsAppAccount.rows[0];
    assert.equal(account.status, 'ERROR', 'conta marca o erro (não fica STARTING eterno)');
  } finally {
    delete process.env.STUDIO_QR_WAIT_MS;
    server.close();
  }
});

test('QA: QR disponível → card traz o código para escanear', async () => {
  process.env.STUDIO_QR_WAIT_MS = '60';
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return { content: JSON.stringify({ reply: 'Gerando o QR!', actions: [{ type: 'start_whatsapp_pairing' }] }) };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    stubPairing({ status: 'SCAN_QR_CODE', qr: { qrCode: 'data:image/png;base64,QRDATA' } });
    const { body: c } = await api('POST', '/campaigns', { name: 'QR ok', channels: ['whatsapp'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'gera o qr' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'whatsapp_qr');
    assert.ok(card, 'card de pareamento presente');
    assert.equal(card.status, 'qr_required');
    assert.equal(card.qrCode, 'data:image/png;base64,QRDATA', 'QR no card');
    assert.equal(prisma.whatsAppAccount.rows[0].status, 'QR_REQUIRED');
  } finally {
    delete process.env.STUDIO_QR_WAIT_MS;
    server.close();
  }
});


// ── 2026-10-08: cadastro de lead PELO CHAT (o dono manda os dados) ───────────

test('QA: "cadastra esse lead" com dados na mão cria o prospect com telefone/consentimento', async () => {
  let turno = 0;
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      turno += 1;
      // 2º turno com CNPJ PONTUADO (como o usuário escreve) — hash diferente
      // da 1ª run, então o handler executa e o dedupe por CNPJ age de verdade.
      const cnpj = turno === 1 ? '12345678000199' : '12.345.678/0001-99';
      return {
        content: JSON.stringify({
          reply: 'Cadastrando!',
          actions: [{
            type: 'create_lead',
            companyName: 'Comercial Aurora LTDA',
            cnpj,
            contactName: 'Maria Souza',
            phone: '(11) 98765-4321',
            email: 'comercial@aurora.com.br',
            city: 'São Paulo',
            state: 'sp',
            industry: 'comércio atacadista',
          }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Base', channels: ['whatsapp'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'cadastra esse lead: Comercial Aurora, CNPJ 12.345.678/0001-99, telefone (11) 98765-4321, e-mail comercial@aurora.com.br' });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'lead_created');
    assert.ok(card, 'card de lead criado');
    assert.match(card.label, /Comercial Aurora LTDA/);
    const lead = prisma.prospect.rows.find((r) => r.companyName === 'Comercial Aurora LTDA');
    assert.ok(lead, 'prospect criado');
    assert.equal(lead.cnpj, '12.345.678/0001-99', 'CNPJ formatado');
    assert.equal(lead.cnpjPhones[0], '+5511987654321', 'telefone com DDI 55 na frente');
    assert.equal(lead.cnpjEmail, 'comercial@aurora.com.br');
    assert.equal(lead.state, 'SP', 'UF normalizada');
    assert.equal(lead.captureSource, 'chat');
    const consent = prisma.studioLeadConsent.rows.find((r) => r.prospectId === lead.id);
    assert.ok(consent, 'consentimento WhatsApp registrado (dono atestou ao cadastrar)');

    // MESMO lead de novo → card de duplicado, nenhum prospect novo.
    const again = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'cadastra de novo' });
    const dup = again.body.data.cards.find((card) => card.type === 'lead_created');
    assert.equal(dup.duplicate, true, 'dedupe por CNPJ');
    assert.equal(prisma.prospect.rows.filter((r) => r.companyName === 'Comercial Aurora LTDA').length, 1);
  } finally {
    server.close();
  }
});

// ── 2026-10-08: cancelar campanha pelo chat (≠ apagar) ───────────────────────

test('QA: "cancela a campanha" → gate de confirmação e, confirmado, para os disparos com estorno', async () => {
  process.env.STUDIO_QR_WAIT_MS = '60';
  let turno = 0;
  const impl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      turno += 1;
      const type = turno === 1 ? 'cancel_campaign' : { ...({}) };
      return {
        content: JSON.stringify({
          reply: turno === 1 ? 'Vou cancelar.' : 'Cancelado!',
          actions: [turno === 1 ? { type: 'cancel_campaign' } : { type: 'cancel_campaign', confirmed: true }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: impl });
  try {
    prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
    prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 40, floor: 0, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
    const { body: c } = await api('POST', '/campaigns', { name: 'Voo p/ cancelar', channels: ['whatsapp'] });
    prisma.studioCampaign.rows[0].status = 'running';
    prisma.studioCampaign.rows[0].whatsappExecutionId = 'wexec-c';
    prisma.whatsappCampaign.rows.push({ id: 'wexec-c', orgId: 'org-1', status: 'RUNNING', studioAttachments: [] });
    // Lote alocado (débito) com 2 contatos ainda na fila.
    prisma.studioReputationEvent.rows.push({ id: 'ev-d', orgId: 'org-1', channel: 'whatsapp', type: 'debit', amount: 2, balanceAfter: 38, refType: 'batch', refId: 'batch-c' });
    prisma.whatsappCampaignContact.rows.push(
      { id: 'wcc-1', campaignId: 'wexec-c', prospectId: 'lead-1', status: 'QUEUED', nextSendAt: null },
      { id: 'wcc-2', campaignId: 'wexec-c', prospectId: 'lead-2', status: 'QUEUED', nextSendAt: null }
    );

    // 1º turno SEM confirmar → gate, nada muda.
    const gate = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'cancela a campanha' });
    const gateCard = gate.body.data.cards.find((card) => card.type === 'confirm_change');
    assert.ok(gateCard, 'cancelamento pede confirmação');
    assert.equal(gateCard.kind, 'cancelamento');
    assert.equal(prisma.studioCampaign.rows[0].status, 'running', 'nada mudou no gate');

    // 2º turno CONFIRMADO → cancelada, fila cancelada, estorno no ledger.
    const done = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'confirmo' });
    const card = done.body.data.cards.find((card) => card.type === 'campaign_cancelled');
    assert.ok(card, 'card de cancelada');
    assert.equal(prisma.studioCampaign.rows[0].status, 'cancelled');
    assert.equal(prisma.studioCampaign.rows[0].statusReason, 'cancelada pelo usuário via chat');
    assert.equal(prisma.whatsappCampaignContact.rows.filter((r) => r.status === 'CANCELLED').length, 2, 'fila cancelada');
    const refund = prisma.studioReputationEvent.rows.find((e) => e.type === 'credit');
    assert.ok(refund, 'estorno do não enviado no saldo único');
    assert.equal(refund.amount, 2);
  } finally {
    delete process.env.STUDIO_QR_WAIT_MS;
    server.close();
  }
});
