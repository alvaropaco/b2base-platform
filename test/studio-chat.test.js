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
