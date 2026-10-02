'use strict';

/**
 * test/studio-capture-leads.test.js — Epic 2 (FR7/FR8/FR9; D1/D2): captura de
 * leads. Suítes:
 *   - busca híbrida lexical+semântica com proveniência `base-propria` (fixture
 *     agrícola — acento/CNAE via searchText do Epic 1);
 *   - lexical-only sem embeddings (modo explicado no card);
 *   - fallback MCP com stub (`_setMcpForTests`) + dedupe CNPJ + zero invenção;
 *   - P2002 na corrida → findFirst (dedupe por replay);
 *   - limite diário (bloqueio explicável com quando-libera);
 *   - replay idempotente da action (StudioActionRun);
 *   - trial permitido (D2) — capture_leads fora do gate premium;
 *   - cliente de embeddings (batch ≤128, retry 1×, null sem LITELLM_URL) e
 *     backfill idempotente/resumável.
 *
 * Asserções COMPORTAMENTAIS (NFR5): contagens, proveniência gravada e modo —
 * nunca texto exato de card.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const manifest = require('../studio/actions/manifest.v1');
const mcpCnpj = require('../mcp-cnpj');
const { createCaptureService } = require('../studio/capture-service');
const { createEmbeddingsClient, toPgVector } = require('../studio/ai/embeddings');
const { runEmbeddingsBackfill } = require('../jobs/embeddings-backfill');

const EMBEDDINGS_VECTOR = [0.1, -0.2, 0.3];

// LLM mockado: o orquestrador emite a action capture_leads pedida pelo teste.
function llm(captureAction) {
  return async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Deixa comigo — vou capturar os leads e te digo de onde vieram.',
          actions: [captureAction],
        }),
      };
    }
    return { content: '{}' };
  };
}

async function startServer({ orgPlan = 'premium', llmImpl, overrides = {} } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: orgPlan });
  prisma.commercialSettings.rows.push({ orgId: 'org-1', productDescription: 'máquinas agrícolas' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma, { overrides: { aiDeps: { callLlm: llmImpl || llm() }, ...overrides } }));
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

function withEnv(patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

function captureLlm(query) {
  return llm({ type: 'capture_leads', query });
}

// ── FR7: busca híbrida lexical+semântica com proveniência base-propria ──────

test('captura: híbrida encontra por termo com acento/grafia E pelo significado, com proveniência da própria base', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '2' }, async () => {
    let vectorSearchArgs = null;
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: {
        embedTexts: async () => [EMBEDDINGS_VECTOR],
        vectorSearch: async (args) => {
          vectorSearchArgs = args;
          return ['l-sem']; // candidato SEMÂNTICO-only (não casa lexicalmente)
        },
      },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Captura', channels: ['email'] });
      // Fixture agrícola: 'agricolas' casa 'agricola' (searchText normalizado);
      // 'lavoura' SÓ casa pela semântica; 'descartado' NUNCA volta na captura.
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Agro Vale Máquinas', industry: 'Comércio de equipamentos agrícolas', searchText: 'comercio de equipamentos agricolas agro vale maquinas', state: 'SP' },
        { id: 'l2', orgId: 'org-1', companyName: 'Tratorpec Peças', industry: 'Máquinas agrícolas', searchText: 'maquinas agricolas tratorpec pecas', state: 'PR' },
        { id: 'l-sem', orgId: 'org-1', companyName: 'Implementos do Campo', industry: 'Máquinas para lavoura', searchText: 'maquinas para lavoura implementos do campo', state: 'MG' },
        { id: 'l-out', orgId: 'org-1', companyName: 'Agro Descartada', industry: 'Equipamentos agrícolas descartados', searchText: 'equipamentos agricolas agro descartada', state: 'SP', status: 'discarded' }
      );

      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
        message: 'capture leads de equipamentos agrícolas',
      });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.ok(card, 'card de captura');
      assert.equal(card.status, 'captured');
      assert.equal(card.mode, 'hybrid', 'lexical + semântica rodaram');
      assert.equal(card.baseOwnCount, 3, 'os 3 candidatos (2 lexicais + 1 semântico)');
      assert.equal(card.mcpCount, 0, 'base própria atendeu — MCP não entra');
      assert.ok(card.detail.includes('da sua base'), 'proveniência do lote no card (UX-DR3)');
      assert.ok(Array.isArray(card.suggestedFilter.prospectIds) && card.suggestedFilter.prospectIds.length === 3);

      // Proveniência é COLUNA (FR9): gravada por lead, não convenção.
      // Lead DESCARTADO nunca volta na captura (opt-out segue garantido).
      const byId = new Map(prisma.prospect.rows.map((p) => [p.id, p]));
      for (const id of ['l1', 'l2', 'l-sem']) {
        assert.equal(byId.get(id).captureSource, 'base-propria', `proveniência gravada em ${id}`);
      }
      assert.equal(byId.get('l-out').captureSource, undefined, 'lead descartado fica fora da captura');
      // A busca vetorial é SEMPRE org-scoped (multi-tenancy).
      assert.equal(vectorSearchArgs.orgId, 'org-1');
      assert.deepEqual(vectorSearchArgs.embedding, EMBEDDINGS_VECTOR);
      // MCP nunca foi consultado (base atendeu) — nenhum create novo.
      assert.equal(prisma.prospect.rows.length, 4);
    } finally {
      server.close();
    }
  }));

// ── FR7/D1: sem embeddings, lexical-only funciona e o card informa o modo ───

test('captura: embeddings indisponíveis → lexical-only funciona e informa o modo', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '1' }, async () => {
    let vectorSearchCalls = 0;
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: {
        embedTexts: async () => null, // gateway desabilitado (sem LITELLM_URL)
        vectorSearch: async () => {
          vectorSearchCalls += 1;
          return [];
        },
      },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Lexical', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Agro Vale Máquinas', industry: 'Comércio de equipamentos agrícolas', searchText: 'comercio de equipamentos agricolas agro vale maquinas', state: 'SP' }
      );
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
        message: 'capture leads de equipamentos agrícolas',
      });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.ok(card, 'card de captura');
      assert.equal(card.status, 'captured');
      assert.equal(card.mode, 'lexical-only', 'modo honesto no card');
      assert.ok(/indispon/i.test(card.detail), 'degradação explicada ao usuário');
      assert.equal(card.baseOwnCount, 1);
      assert.equal(vectorSearchCalls, 0, 'sem embeddings, pgvector nunca é consultado');
      assert.equal(prisma.prospect.rows.find((p) => p.id === 'l1').captureSource, 'base-propria');
    } finally {
      server.close();
    }
  }));

// ── FR8/FR9/NFR3: fallback MCP com dedupe por CNPJ e zero invenção ──────────

test('captura: base própria não atende → MCP CNPJ é consultado, dedupe não duplica e nada é inventado', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    const mcpCalls = [];
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => true,
      searchCompanies: async (args) => {
        mcpCalls.push(args);
        // Contrato de mcp-cnpj.searchCompanies: registros JÁ mapeados.
        return [
          // Já presente na base (mesmo CNPJ) — NÃO duplica.
          { cnpj: '12.345.678/0001-95', legalName: 'Agro Vale Máquinas LTDA', industry: 'x' },
          // Novo e completo → cria.
          { cnpj: '98.765.432/0001-10', legalName: 'CNPJ Máquinas LTDA', tradeName: 'CNPJ Máquinas', industry: 'Comércio de máquinas agrícolas', city: 'Ribeirão Preto', state: 'SP', email: 'contato@cnpjmaquinas.com.br', isActive: true },
          // Incompleto (sem CNPJ) → NÃO vira lead (zero invenção).
          { cnpj: '', legalName: 'Sem CNPJ Ltda' },
          // BAIXADA (isActive false) → NÃO vira lead (empresa morta não é audiência).
          { cnpj: '11.222.333/0001-44', legalName: 'Baixada LTDA', isActive: false },
        ];
      },
    });
    const { server, prisma, api } = await startServer({
      llmImpl: llm({ type: 'capture_leads', query: 'maquinas agricolas', state: 'SP' }),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'MCP', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Agro Vale Máquinas', cnpj: '12.345.678/0001-95', industry: 'Comércio de equipamentos agrícolas', searchText: 'comercio de equipamentos agricolas agro vale maquinas', state: 'SP' }
      );
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
        message: 'capture leads de máquinas agrícolas em SP',
      });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.ok(card);
      assert.equal(card.status, 'captured');
      assert.equal(card.baseOwnCount, 1, 'o match da própria base entra com proveniência');
      assert.equal(card.mcpCount, 1, 'só o lead novo e completo');
      assert.equal(card.duplicates, 1, 'CNPJ existente não duplica');
      assert.ok(/cnpj/i.test(card.detail), 'proveniência "via CNPJ" visível no card');

      // UMA chamada de MCP por captura (Design Notes) com os filtros pedidos.
      // A 1ª chamada é da CAPTURA DETERMINÍSTICA (QA 2026-10-02): query é a
      // grafia da frase do usuário (acentos normalizados dentro do serviço)
      // e a UF veio da frase ('em SP').
      assert.equal(mcpCalls.length, 1);
      assert.equal(mcpCalls[0].query, 'máquinas agrícolas');
      assert.equal(mcpCalls[0].state, 'SP');

      const created = prisma.prospect.rows.find((p) => p.id !== 'l1');
      assert.ok(created, 'lead novo criado');
      assert.equal(created.captureSource, 'mcp-cnpj');
      assert.equal(created.status, 'prospect');
      // Zero invenção: campos EXATAMENTE os retornados pelo MCP — nada além.
      assert.equal(created.companyName, 'CNPJ Máquinas LTDA');
      assert.equal(created.tradeName, 'CNPJ Máquinas');
      assert.equal(created.industry, 'Comércio de máquinas agrícolas');
      assert.equal(created.city, 'Ribeirão Preto');
      assert.equal(created.state, 'SP');
      assert.equal(created.cnpjEmail, 'contato@cnpjmaquinas.com.br');
      assert.equal(created.cnpj, '98.765.432/0001-10');
      assert.equal(created.searchText.includes('cnpj maquinas ltda'), true, 'searchText mantido nos hooks de escrita');
      // Nem o duplicado, nem o sem-CNPJ, nem a BAIXADA viraram lead.
      assert.equal(prisma.prospect.rows.length, 2, 'só o lead novo entra');
      assert.equal(prisma.prospect.rows.some((p) => p.cnpj === '11.222.333/0001-44'), false, 'empresa baixada não vira lead');
      assert.equal(prisma.prospect.rows.find((p) => p.id === 'l1').captureSource, 'base-propria');
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

test('captura: CNPJ retornado de novo pela corrida (P2002) resolve por findFirst — nunca duplica', async () => {
  const existing = { id: 'p-existing', orgId: 'org-1', cnpj: '11.111.111/0001-11', companyName: 'Já Estava Aqui', status: 'prospect' };
  let creates = 0;
  let lookups = 0;
  const prismaStub = {
    prospect: {
      count: async () => 0,
      findMany: async () => [], // base própria vazia → fallback MCP
      findFirst: async () => (lookups += 1) === 1 ? null : existing, // 1ª: não existe; corrida depois do create → vencedor
      updateMany: async () => ({ count: 0 }),
      create: async () => {
        creates += 1;
        const err = new Error('unique violation');
        err.code = 'P2002';
        throw err;
      },
    },
  };
  mcpCnpj._setMcpForTests({
    isMcpConfigured: () => true,
    searchCompanies: async () => [{ cnpj: '11.111.111/0001-11', legalName: 'Já Estava Aqui LTDA' }],
  });
  try {
    const service = createCaptureService(prismaStub, {
      embedTexts: async () => null,
      mcp: mcpCnpj,
    });
    const result = await service.captureLeads({ orgId: 'org-1', query: 'agro' });
    // Só duplicado → status HONESTO no_results (nada virou lead), com o dedupe
    // resolvido pelo findFirst (P2002 → vencedor existe).
    assert.equal(result.status, 'no_results');
    assert.equal(result.mcpCount, 0, 'P2002 vira dedupe, não lead');
    assert.equal(result.duplicates, 1);
    assert.equal(creates, 1, 'create tentado 1× e resolvido pelo findFirst');
  } finally {
    mcpCnpj._resetMcpForTests();
  }
});

// ── QA 2026-10-02 (diretiva do dono): MCP fora NUNCA esconde o que a base ───
// própria já encontrou — entrega o lote com proveniência; recusa ZERO só
// quando não achou NADA (FR9: nunca inventar leads segue valendo).

test('captura: sem token MCP + base achou pouco → ENTREGA o lote próprio (não recusa)', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    let searchCalls = 0;
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => false, // CNPJ_MCP_TOKEN ausente
      searchCompanies: async () => {
        searchCalls += 1;
        return [];
      },
    });
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Sem token', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Agro Vale', industry: 'Equipamentos agrícolas', searchText: 'equipamentos agricolas agro vale', state: 'SP' }
      );
      const before = prisma.prospect.rows.length;
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
        message: 'capture mais leads de equipamentos agrícolas',
      });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.ok(card);
      assert.equal(card.status, 'captured', 'lead encontrado na própria base é ENTREGUE');
      assert.equal(card.baseOwnCount, 1, 'o lote próprio vem no card');
      assert.equal(searchCalls, 0, 'MCP nem é chamado sem token');
      assert.equal(prisma.prospect.rows.length, before, 'nenhum lead INVENTADO (FR9)');
      assert.equal(prisma.prospect.rows.find((p) => p.id === 'l1').captureSource, 'base-propria', 'proveniência marcada');
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

test('captura: sem token MCP e base VAZIA de matches → recusa explicável e nada marcado', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    let searchCalls = 0;
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => false, // CNPJ_MCP_TOKEN ausente
      searchCompanies: async () => {
        searchCalls += 1;
        return [];
      },
    });
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Sem token', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Mercadinho Central', industry: 'Varejo', searchText: 'mercadinho central varejo', state: 'SP' }
      );
      const before = prisma.prospect.rows.length;
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
        message: 'capture mais leads de equipamentos agrícolas',
      });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.ok(card);
      assert.equal(card.status, 'refused', 'sem match nenhum, a recusa é card explicável, não erro');
      assert.equal(searchCalls, 0, 'MCP nem é chamado sem token');
      assert.equal(prisma.prospect.rows.length, before, 'NENHUM lead criado (FR9)');
      assert.equal(prisma.prospect.rows.find((p) => p.id === 'l1').captureSource, undefined, 'recusa não marca proveniência');
      assert.ok(/administrador|configurar/i.test(card.detail), 'card diz o que falta');
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

// ── FR9/D2: limite diário — bloqueio explicável com quando-libera ───────────

test('captura: org no limite diário é bloqueada com quando-libera e sem consultar MCP', () =>
  withEnv({ STUDIO_CAPTURE_DAILY_LIMIT: '1', STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    let searchCalls = 0;
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => true,
      searchCompanies: async () => {
        searchCalls += 1;
        return [];
      },
    });
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Limite', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Agro Vale', industry: 'Equipamentos agrícolas', searchText: 'equipamentos agricolas agro vale', state: 'SP' },
        // Volume do dia JÁ registrado (monitoria usa as linhas — Design Notes).
        { id: 'cap-1', orgId: 'org-1', companyName: 'Capturado Hoje', captureSource: 'mcp-cnpj', createdAt: new Date() }
      );
      const before = prisma.prospect.rows.length;
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
        message: 'capture mais leads',
      });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.ok(card);
      assert.equal(card.status, 'limit_reached');
      assert.equal(card.capturedToday, 1);
      assert.equal(card.dailyLimit, 1);
      assert.ok(/meia-noite/i.test(card.detail), 'quando-libera no card');
      assert.equal(searchCalls, 0, 'bloqueio vem ANTES do MCP');
      assert.equal(prisma.prospect.rows.length, before, 'nada criado no bloqueio');
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

// ── AD-6/FR8 + D2: replay idempotente e trial permitido ─────────────────────

test('captura: replay do mesmo actionId devolve o mesmo card SEM re-executar; org trial executa (D2)', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    let searchCalls = 0;
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => true,
      searchCompanies: async () => {
        searchCalls += 1;
        return [
          // Contrato de searchCompanies: registro JÁ mapeado.
          { cnpj: '27.858.417/0001-62', legalName: 'MCP Agro LTDA', industry: 'Lavoura' },
        ];
      },
    });
    const { server, prisma, api } = await startServer({
      orgPlan: 'trial', // D2: captura disponível para trial
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Trial', channels: ['email'] });
      const payload = { type: 'capture_leads', actionId: 'cap-1', params: { query: 'equipamentos agricolas' } };

      const first = await api('POST', `/campaigns/${c.data.id}/actions`, payload);
      assert.equal(first.res.status, 200, 'trial NÃO recebe PREMIUM_REQUIRED na captura (D2)');
      assert.equal(first.body.data.card.status, 'captured');
      assert.equal(first.body.data.card.replayed, undefined);

      const second = await api('POST', `/campaigns/${c.data.id}/actions`, payload);
      assert.equal(second.res.status, 200);
      assert.equal(second.body.data.card.replayed, true, 'replay marcado no card');
      assert.equal(searchCalls, 1, 'MCP consultado UMA vez — replay não re-executa (AD-6)');
      assert.equal(prisma.prospect.rows.filter((p) => p.captureSource === 'mcp-cnpj').length, 1, 'nenhuma duplicação');

      // O chip do card emite select_leads — no trial TAMBÉM não pode dar 403
      // (senão a org captura e morre no único clique do card — furo D2).
      const capturedId = prisma.prospect.rows.find((p) => p.captureSource === 'mcp-cnpj').id;
      const chip = await api('POST', `/campaigns/${c.data.id}/actions`, {
        type: 'select_leads',
        actionId: 'chip-1',
        params: { set: [capturedId] },
      });
      assert.equal(chip.res.status, 200, 'select_leads (chip do card) roda no trial');
      assert.equal(chip.body.data.card.type, 'audience');

      // O gate premium segue INTACTO para as outras actions (guard-rail).
      const premiumGate = await api('POST', `/campaigns/${c.data.id}/actions`, {
        type: 'generate_content',
        params: {},
      });
      assert.equal(premiumGate.res.status, 403, 'outra action no trial continua gated (requirePremiumOrg)');
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

test('captura: action sem query é recusada no schema (400 INVALID_ACTION_PARAMS)', () =>
  withEnv({}, async () => {
    const { server, api } = await startServer({ llmImpl: llm() });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Sem query', channels: ['email'] });
      const r = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'capture_leads', params: {} });
      assert.equal(r.res.status, 400);
      assert.equal(r.body.error, 'INVALID_ACTION_PARAMS');
    } finally {
      server.close();
    }
  }));

// ── Contabilidade do limite: lote base-propria CLAMPEADO ao room restante ───

test('captura: limite 1 com 1 vaga → marca no MÁXIMO 1 da própria base', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '2', STUDIO_CAPTURE_DAILY_LIMIT: '1' }, async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000); // lead ANTIGO da base
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Clamp', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Agro Vale', industry: 'Equipamentos agrícolas', searchText: 'equipamentos agricolas agro vale', state: 'SP', createdAt: yesterday },
        { id: 'l2', orgId: 'org-1', companyName: 'Tratorpec', industry: 'Máquinas agrícolas', searchText: 'maquinas agricolas tratorpec', state: 'PR', createdAt: yesterday },
        { id: 'l3', orgId: 'org-1', companyName: 'Implementos', industry: 'Máquinas para lavoura', searchText: 'maquinas para lavoura implementos', state: 'MG', createdAt: yesterday }
      );
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'capture leads' });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.equal(card.status, 'captured');
      // 3 candidatos, mas room = 1 (cap 1 − 0 consumidos): marca SÓ 1.
      const marked = prisma.prospect.rows.filter((p) => p.captureSource === 'base-propria');
      assert.equal(marked.length, 1, 'lote clampeado ao room (marca no máx. 1)');
      // O card reporta o número que a CONTAGEM DB reproduz — lead antigo
      // re-marcado NÃO soma (createdAt continua ontem).
      assert.equal(card.capturedToday, 0);
      const dbCount = await prisma.prospect.count({
        where: { orgId: 'org-1', captureSource: { in: ['base-propria', 'mcp-cnpj'] }, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      });
      assert.equal(dbCount, card.capturedToday, 'capturedToday do card é exatamente o que a contagem reproduz');
    } finally {
      server.close();
    }
  }));

// ── Proveniência NUNCA é sobrescrita (auditoria LGPD) ───────────────────────

test('captura: lead mcp-cnpj que casa na busca própria PERMANECE mcp-cnpj', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '1' }, async () => {
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('equipamentos agricolas'),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Não sobrescreve', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'p-mcp', orgId: 'org-1', companyName: 'Vinda do MCP', industry: 'Equipamentos agrícolas', searchText: 'equipamentos agricolas vinda do mcp', captureSource: 'mcp-cnpj', createdAt: new Date() },
        { id: 'p-plain', orgId: 'org-1', companyName: 'Sem Marca', industry: 'Máquinas agrícolas', searchText: 'maquinas agricolas sem marca', createdAt: new Date() }
      );
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'capture leads' });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.equal(card.status, 'captured');
      assert.equal(card.baseOwnCount, 2);
      const byId = new Map(prisma.prospect.rows.map((p) => [p.id, p]));
      assert.equal(byId.get('p-mcp').captureSource, 'mcp-cnpj', 'proveniência original preservada');
      assert.equal(byId.get('p-plain').captureSource, 'base-propria', 'sem marca ganha a nova');
    } finally {
      server.close();
    }
  }));

// ── Zero-framing: MCP consultado e NADA vira lead → card próprio no_results ─

test('captura: MCP só devolve duplicado → no_results com copy honesta, sem "Leads capturados"', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => true,
      searchCompanies: async () => [
        // Mesmo CNPJ já na base (que NÃO casa a busca lexical) — nada novo.
        { cnpj: '12.000.000/0001-00', legalName: 'Já Tenho LTDA' },
      ],
    });
    const { server, prisma, api } = await startServer({
      llmImpl: captureLlm('náutica'),
      overrides: { embedTexts: async () => null },
    });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Sem resultados', channels: ['email'] });
      prisma.prospect.rows.push(
        { id: 'l1', orgId: 'org-1', companyName: 'Já Tenho LTDA', cnpj: '12.000.000/0001-00', industry: 'Metalurgia', searchText: 'metalurgia ja tenho' }
      );
      const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'capture leads de náutica' });
      assert.equal(res.status, 200);
      const card = body.data.cards.find((card) => card.type === 'capture');
      assert.ok(card);
      assert.equal(card.status, 'no_results', 'status próprio, não "captured" vazio');
      assert.equal(card.label.includes('capturados'), false, 'zero framing de sucesso');
      assert.ok(card.detail.includes('náutica'), 'copia fala o termo buscado');
      assert.ok(/tente outro termo/i.test(card.detail), 'orienta o próximo passo');
      assert.equal(card.suggestedFilter, null, 'nada capturado → nenhum chip');
      assert.equal(prisma.prospect.rows.length, 1, 'nada criado');
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

// ── Recusa NUNCA vira replay permanente: re-executa de verdade ──────────────

test('captura: recusa não é gravada como run — mesmo params re-executam após configurar o token', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    let searchCalls = 0;
    mcpCnpj._setMcpForTests({ isMcpConfigured: () => false });
    const { server, prisma, api } = await startServer({ llmImpl: llm(), overrides: { embedTexts: async () => null } });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Reexecuta', channels: ['email'] });
      const payload = { type: 'capture_leads', params: { query: 'equipamentos agricolas' } };

      const before = await api('POST', `/campaigns/${c.data.id}/actions`, payload);
      assert.equal(before.body.data.card.status, 'refused');
      assert.equal(prisma.studioActionRun.rows.filter((r) => r.action === 'capture_leads').length, 0, 'recusa NÃO persiste run');

      // "Configura o token" e o vendedor tenta DE NOVO os mesmos params.
      mcpCnpj._setMcpForTests({
        isMcpConfigured: () => true,
        searchCompanies: async () => {
          searchCalls += 1;
          return [{ cnpj: '45.723.174/0001-10', legalName: 'Agro Nova LTDA', industry: 'Lavoura' }];
        },
      });
      const after = await api('POST', `/campaigns/${c.data.id}/actions`, payload);
      assert.equal(after.body.data.card.status, 'captured', 'mesmos params agora EXECUTAM (não replayam a recusa)');
      assert.equal(searchCalls, 1);
      assert.equal(prisma.prospect.rows.filter((p) => p.captureSource === 'mcp-cnpj').length, 1);

      // E agora a captura FEITA replaya (mesmo params, sem re-executar).
      const replay = await api('POST', `/campaigns/${c.data.id}/actions`, payload);
      assert.equal(replay.body.data.card.replayed, true);
      assert.equal(searchCalls, 1, 'captured persiste replay como sempre');
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

// ── Hash de idempotência (params): state diferente = pedido diferente ───────

test('captura: mesma query com state diferente → chaves distintas e AMBAS executam (sem actionId)', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => true,
      searchCompanies: async (args) => [{
        cnpj: args.state === 'SP' ? '10.000.000/0001-10' : '20.000.000/0001-20',
        legalName: `Agro ${args.state} LTDA`,
        industry: 'Lavoura',
      }],
    });
    const { server, prisma, api } = await startServer({ llmImpl: llm(), overrides: { embedTexts: async () => null } });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Hash', channels: ['email'] });
      const sp = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'capture_leads', params: { query: 'agro', state: 'SP' } });
      const rj = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'capture_leads', params: { query: 'agro', state: 'RJ' } });
      assert.equal(sp.body.data.card.status, 'captured');
      assert.equal(rj.body.data.card.status, 'captured', 'state diferente → pedido DIFERENTE, executa');
      assert.equal(sp.body.data.card.replayed, undefined);
      assert.equal(rj.body.data.card.replayed, undefined);
      assert.equal(prisma.prospect.rows.filter((p) => p.captureSource === 'mcp-cnpj').length, 2, 'dois lotes distintos');
      // As runs gravadas têm chaves DIFERENTES (o state entra no hash).
      const keys = prisma.studioActionRun.rows.filter((r) => r.action === 'capture_leads').map((r) => r.actionKey);
      assert.equal(keys.length, 2);
      assert.notEqual(keys[0], keys[1]);
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

test('captura: params idênticos sem actionId → replay (mesma chave de hash)', () =>
  withEnv({ STUDIO_CAPTURE_MIN_OWN: '5' }, async () => {
    let searchCalls = 0;
    mcpCnpj._setMcpForTests({
      isMcpConfigured: () => true,
      searchCompanies: async () => {
        searchCalls += 1;
        return [{ cnpj: '30.000.000/0001-30', legalName: 'Agro Replay LTDA', industry: 'Lavoura' }];
      },
    });
    const { server, prisma, api } = await startServer({ llmImpl: llm(), overrides: { embedTexts: async () => null } });
    try {
      const { body: c } = await api('POST', '/campaigns', { name: 'Replay hash', channels: ['email'] });
      const payload = { type: 'capture_leads', params: { query: 'agro' } };
      const first = await api('POST', `/campaigns/${c.data.id}/actions`, payload);
      const second = await api('POST', `/campaigns/${c.data.id}/actions`, payload);
      assert.equal(first.body.data.card.status, 'captured');
      assert.equal(second.body.data.card.replayed, true, 'mesmo params → replay, sem re-executar');
      assert.equal(searchCalls, 1);
      assert.equal(prisma.prospect.rows.filter((p) => p.captureSource === 'mcp-cnpj').length, 1);
    } finally {
      mcpCnpj._resetMcpForTests();
      server.close();
    }
  }));

// ── Contrato do manifest: query precisa ser string não vazia ────────────────

test('manifest: capture_leads valida typeof string e trim — objeto não vira busca', () => {
  for (const bad of [undefined, null, '', '   ', { setor: 'agro' }, 42]) {
    assert.throws(
      () => manifest.validate('capture_leads', { query: bad }),
      (err) => err.code === 'INVALID_ACTION_PARAMS',
      `query ${JSON.stringify(bad)} é recusada`
    );
  }
  assert.equal(manifest.validate('capture_leads', { query: 'equipamentos agrícolas' }), true);
});



// ── Unidade: cliente de embeddings (D1) ─────────────────────────────────────

test('embeddings: batch ≤128, retry 1× (só 5xx/timeout), shape validado, null sem LITELLM_URL', () =>
  withEnv({ LITELLM_URL: 'https://litellm.test', LITELLM_API_KEY: 'k', STUDIO_EMBEDDING_MODEL: undefined }, async () => {
    // 1) Sem LITELLM_URL → desabilitado (null): captura segue lexical-only.
    await withEnv({ LITELLM_URL: undefined }, async () => {
      const disabled = createEmbeddingsClient();
      assert.equal(disabled.isConfigured(), false);
      assert.equal(await disabled.embedTexts(['texto']), null);
    });

    const calls = [];
    let failFirst = true;
    const client = createEmbeddingsClient({
      batchSize: 128,
      retryDelayMs: 1,
      fetchImpl: async (url, opts) => {
        calls.push({ url, body: JSON.parse(opts.body) });
        if (failFirst) {
          failFirst = false;
          return { ok: false, status: 502, text: async () => 'bad gateway' };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: calls[calls.length - 1].body.input.map((text, index) => ({ index, embedding: [text.length, index] })),
          }),
        };
      },
    });

    // 130 textos → 2 lotes (128 + 2), ordem preservada, retry 1× no 1º lote.
    const texts = Array.from({ length: 130 }, (_, i) => `empresa ${i}`);
    const vectors = await client.embedTexts(texts);
    assert.equal(vectors.length, 130);
    assert.deepEqual(vectors[0], ['empresa 0'.length, 0]);
    assert.deepEqual(vectors[129], ['empresa 129'.length, 1]);
    assert.equal(calls.length, 3, '1º lote falhou (502) → retry 1× + 2º lote');
    assert.equal(calls[0].body.input.length, 128);
    assert.equal(calls[2].body.input.length, 2);
    assert.equal(calls[0].body.model, 'gemini-embedding', 'modelo default do publisher');
    assert.equal(calls[0].url, 'https://litellm.test/v1/embeddings', 'endpoint OpenAI-compatible no gateway');

    // toPgVector: forma texto do pgvector (padrão embedder.py).
    assert.equal(toPgVector([0.1, -0.25, 2]), '[0.1,-0.25,2]');
  }));

test('embeddings: 4xx e shape inválido NÃO re-tentam; strings em branco vão como vieram', () =>
  withEnv({ LITELLM_URL: 'https://litellm.test', LITELLM_API_KEY: 'k' }, async () => {
    // 1) 401 → propaga na 1ª tentativa (repetir seria repetir o mesmo erro).
    const fourOhOne = createEmbeddingsClient({
      retryDelayMs: 1,
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }),
    });
    await assert.rejects(
      fourOhOne.embedTexts(['x']),
      (err) => err.code === 'EMBEDDINGS_HTTP_ERROR' && err.status === 401
    );

    // 2) Vetor com elemento não-finito → EMBEDDINGS_SHAPE na 1ª tentativa.
    let calls = 0;
    const shape = createEmbeddingsClient({
      retryDelayMs: 1,
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ index: 0, embedding: [Number.NaN, 1] }] }),
        };
      },
    });
    await assert.rejects(
      shape.embedTexts(['x']),
      (err) => err.code === 'EMBEDDINGS_SHAPE'
    );
    assert.equal(calls, 1, 'shape inválido não re-tenta');

    // 3) Contrato: UM vetor por texto, MESMA ordem — '' vai como veio (sem
    //    filtro no cliente; quem decide mandar é o chamador).
    const passthrough = createEmbeddingsClient({
      retryDelayMs: 1,
      fetchImpl: async (_url, opts) => ({
        ok: true,
        status: 200,
        json: async () => {
          const input = JSON.parse(opts.body).input;
          return { data: input.map((text, index) => ({ index, embedding: [index] })) };
        },
      }),
    });
    const vectors = await passthrough.embedTexts(['', 'agro', '  ']);
    assert.deepEqual(vectors, [[0], [1], [2]], 'sem pular strings em branco');
    assert.deepEqual(await passthrough.embedTexts([]), [], 'lista vazia → []');
  }));

test('embeddings: STUDIO_EMBEDDING_TIMEOUT_MS ≤0 não mata o cliente (cai no default)', () =>
  withEnv({ LITELLM_URL: 'https://litellm.test', STUDIO_EMBEDDING_TIMEOUT_MS: '-5' }, async () => {
    let aborted = null;
    const client = createEmbeddingsClient({
      retryDelayMs: 1,
      fetchImpl: async (_url, opts) => {
        aborted = opts.signal;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ index: 0, embedding: [1] }] }),
        };
      },
    });
    const vectors = await client.embedTexts(['x']);
    assert.deepEqual(vectors, [[1]], 'funciona com env de timeout inválida');
    assert.ok(aborted, 'signal passado ao fetch (timeout vivo, no default)');
  }));

// ── Unidade: backfill idempotente/resumável (padrão embedder.py) ────────────

test('backfill: só linhas NULL, com teto por execução e resumável; skipped sem embeddings', async () => {
  const rows = [
    { id: 'p1', searchText: 'agro ltda' },
    { id: 'p2', searchText: 'comercio de maquinas' },
  ];
  const selects = [];
  const updates = [];
  let dataSelects = 0;
  const prismaStub = {
    $queryRaw: async (strings) => {
      const sql = strings.join('?');
      selects.push(sql);
      if (sql.includes('count(*)')) return [{ pending: Math.max(0, rows.length - updates.length) }];
      dataSelects += 1;
      return dataSelects === 1 ? rows : [];
    },
    $executeRaw: async (strings, vector, id) => {
      updates.push({ sql: strings.join('?'), vector, id });
      return 1;
    },
  };
  const embeddings = {
    isConfigured: () => true,
    embedTexts: async (texts) => texts.map((t, i) => [t.length, i]),
  };
  const result = await runEmbeddingsBackfill(prismaStub, { maxRows: 10, batchSize: 128, embeddings });
  assert.equal(result.embedded, 2);
  assert.equal(result.done, true);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map((u) => u.id), ['p1', 'p2']);
  assert.equal(updates[0].vector.startsWith('['), true, 'forma texto do pgvector');
  assert.ok(selects.every((sql) => sql.includes('IS NULL')), 'seleção só de NULL (idempotente/resumável)');

  // Sem LITELLM_URL o job não tenta nada (captura segue lexical-only).
  const disabled = await runEmbeddingsBackfill(prismaStub, {
    embeddings: { isConfigured: () => false },
  });
  assert.deepEqual(disabled, { skipped: true, reason: 'embeddings_not_configured' });
});

test('backfill: mesmo lote falhando 2× ENCERRA o passe com stuckIds (nunca throw/loop infinito)', async () => {
  const rows = [
    { id: 'p1', searchText: 'agro ltda' },
    { id: 'p2', searchText: 'comercio de maquinas' },
  ];
  let dataSelects = 0;
  const prismaStub = {
    $queryRaw: async (strings) => {
      if (strings.join('?').includes('count(*)')) return [{ pending: rows.length }];
      dataSelects += 1;
      // As linhas seguem NULL (updates nunca rodam): o MESMO lote volta.
      return dataSelects <= 2 ? rows : [];
    },
    $executeRaw: async () => 1,
  };
  const embeddings = {
    isConfigured: () => true,
    embedTexts: async () => {
      const err = new Error('gateway fora');
      err.code = 'EMBEDDINGS_HTTP_ERROR';
      err.status = 503;
      throw err;
    },
  };
  const result = await runEmbeddingsBackfill(prismaStub, { maxRows: 10, embeddings });
  assert.deepEqual(result, { embedded: 0, stuckIds: ['p1', 'p2'] }, '2ª falha do mesmo lote encerra com ids');
});
