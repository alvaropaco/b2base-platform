'use strict';

/**
 * test/studio-epic1-reliability.test.js — Epic 1 "Conversa que não trava"
 * (plan-epic1-conversa-que-nao-trava).
 *
 * Stories cobertas (stub de LLM, asserções comportamentais — NFR5):
 *   1.1 turno resiliente: JSON inválido/timeout → degradação honesta +
 *       trace com errorCode+errorStack; retry por estágio recupera.
 *   1.2 memória de decisão: critérios fechados voltam ao prompt como FATO;
 *       replay idempotente não duplica registros.
 *   1.3 segmentação que casa: acento/grafia/companyName + ≥50 leads (D5)
 *       na base fixa QA-like; segment-nl ancorado na base real (FR5).
 *   1.4 recuperação de 0-match: diagnóstico + proposta de 1 clique;
 *       o mesmo `where` nunca volta 2× (sem loop).
 *   1.5 F2: confirm_material resolve por id OU nome; ambíguo pede
 *       desambiguação; inexistente → 404 explicável.
 *   Extremos (barra do dono): cadastro todo null, tudo acentuado.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const { normalizeText, buildSearchText, withSearchText } = require('../search-text');
const segmentService = require('../studio/segment-service');
const manifest = require('../studio/actions/manifest.v1');

/** Linha de prospect com searchText já retroalimentado (estado pós-migração). */
function lead(orgId, fields) {
  const row = { orgId, status: 'qualified', state: 'SP', ...fields };
  row.searchText = buildSearchText(row);
  return row;
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
    overrides: { aiDeps: { callLlm: llmImpl } },
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

/** Stub que responde o orquestrador com a decisão dada e o segmento com critérios fixos. */
function orchestratorStub(actionsByMessage, segmentCriteria) {
  return async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      return {
        content: JSON.stringify({
          criteria: segmentCriteria,
          rationale: 'critério do pedido',
        }),
      };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      for (const [marker, decision] of Object.entries(actionsByMessage)) {
        if (user.includes(`NOVA MENSAGEM DO USUÁRIO: ${marker}`)) {
          return { content: JSON.stringify(decision) };
        }
      }
      return { content: JSON.stringify({ reply: 'Me conta mais?', actions: [{ type: 'none' }] }) };
    }
    return { content: '{}' };
  };
}

// ── Story 1.1 — erro interno visível e recuperável ──────────────────────────

test('1.1: JSON inválido em todas as tentativas → degradação honesta + trace com errorCode+errorStack', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) return { content: 'isto definitivamente não é json' };
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Degrada', channels: ['email'] });
    prisma.prospect.rows.push(lead('org-1', { id: 'l1', companyName: 'Metalúrgica Alfa', industry: 'Metalurgia' }));
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'monta a audiência' });
    assert.equal(res.status, 200, 'turno degradado NÃO derruba a requisição');

    // Degradação honesta (FR1/UX-DR4): assume a falha, diz o que NÃO mudou
    // (chips leigos) e dá o próximo passo — nunca beco sem saída.
    assert.ok(body.data.reply.includes('problema técnico'), 'assume a falha');
    assert.ok(body.data.reply.includes('leads não foram tocados'), 'chip: leads intactos');
    assert.ok(body.data.reply.includes('1 minuto'), 'próximo passo com quando tentar de novo');
    assert.equal(body.data.cards.length, 0, 'nenhuma ação executada no turno degradado');

    // FR3: trace persistido com a causa real, consultável via GET .../traces.
    assert.equal(prisma.studioChatTrace.rows.length, 1);
    const trace = prisma.studioChatTrace.rows[0];
    assert.equal(trace.status, 'degraded');
    assert.ok(trace.errorCode, 'errorCode não-nulo');
    assert.ok(trace.errorStack && trace.errorStack.length > 20, 'stack do erro real persistida');

    const traces = await api('GET', `/campaigns/${c.data.id}/traces`);
    assert.equal(traces.res.status, 200);
    assert.equal(traces.body.data[0].status, 'degraded');
    assert.equal(traces.body.data[0].errorCode, trace.errorCode);
    assert.equal(traces.body.data[0].errorStack, trace.errorStack);

    // Estado da campanha intacto (nada foi tocado de verdade).
    const state = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.equal(state.extras.audienceCount, null);
  } finally {
    server.close();
  }
});

test('1.1: timeout do gateway em toda tentativa → degradação com a causa LLM_TIMEOUT no trace', async () => {
  const llmImpl = async () => {
    const err = new Error('llm_timeout_30000ms');
    err.code = 'LLM_TIMEOUT';
    err.name = 'AbortError';
    throw err;
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Timeout', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'oi' });
    assert.equal(res.status, 200);
    assert.ok(body.data.reply.includes('leads não foram tocados'), 'degradação explicável');
    const trace = prisma.studioChatTrace.rows[0];
    assert.equal(trace.status, 'degraded');
    assert.ok(trace.errorCode, 'errorCode não-nulo (antes do fix, abort não tinha code)');
    assert.ok(trace.errorStack.includes('LLM_TIMEOUT'), 'a causa real (timeout) fica visível na stack');
  } finally {
    server.close();
  }
});

test('1.1: retry por estágio — validação reprova a 1ª tentativa e a 2ª recupera sem degradar', async () => {
  let orchestratorCalls = 0;
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      orchestratorCalls += 1;
      if (orchestratorCalls === 1) {
        // JSON válido, mas o validate reprova (reply vazio) — estágio de
        // validação tem orçamento próprio e não consome o de parse.
        return { content: JSON.stringify({ reply: '   ', actions: [] }) };
      }
      return {
        content: JSON.stringify({
          reply: 'anotado!',
          actions: [{ type: 'set_objective', objective: 'vender ERP', offer: 'demonstração' }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: camp } = await api('POST', '/campaigns', { name: 'Estágios', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${camp.data.id}/chat`, { message: 'vender ERP com demo' });
    assert.equal(res.status, 200);
    assert.equal(orchestratorCalls, 2, 'retry do estágio de validação aconteceu');
    assert.equal(body.data.reply, 'anotado!', 'resposta do modelo, não degradação');
    const trace = prisma.studioChatTrace.rows[0];
    assert.equal(trace.status, 'succeeded', 'turno se recuperou — não degrada');
    assert.equal(prisma.studioCampaign.rows.find((r) => r.id === camp.data.id).offer, 'demonstração');
  } finally {
    server.close();
  }
});

// ── Story 1.2 — memória de decisão do vendedor ──────────────────────────────

test('1.2: decisão fechada volta ao prompt como FATO e replay não duplica registros', async () => {
  const orchestratorPrompts = [];
  const criteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'indústria' }] }] };
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      return { content: JSON.stringify({ criteria, rationale: 'só industrial' }) };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      orchestratorPrompts.push(user);
      if (user.includes('NOVA MENSAGEM DO USUÁRIO: PODE DETALHAR O PÚBLICO')) {
        // Só "lembra" se o estado trouxer a decisão como FATO — é o
        // determinismo que impede o re-pergunta (o resto é prompt).
        if (!user.includes('audienciaDecidida') || !user.includes('"pedido":"só indústrias"')) {
          return { content: JSON.stringify({ reply: 'Para quem vamos vender?', actions: [{ type: 'set_audience', description: 'sem critério' }] }) };
        }
        return {
          content: JSON.stringify({
            reply: 'Mantendo sua decisão de só indústrias — quer que eu gere o conteúdo?',
            actions: [{ type: 'none' }],
          }),
        };
      }
      return {
        content: JSON.stringify({
          reply: 'Audiência fechada: só indústrias.',
          actions: [{ type: 'set_audience', description: 'só indústrias' }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    prisma.prospect.rows.push(
      lead('org-1', { id: 'l1', companyName: 'Metalúrgica Alfa', industry: 'Indústria Metalúrgica' }),
      lead('org-1', { id: 'l2', companyName: 'Indústria Beta', industry: 'Indústria Química' }),
      lead('org-1', { id: 'l3', companyName: 'Varejão Gamma', industry: 'Varejo' })
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Decisão', channels: ['email'] });

    // Turno 1: vendedor fecha a decisão ("só industrial").
    const t1 = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'só indústrias' });
    assert.equal(t1.res.status, 200);
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 2, 'critério industrial casou 2 dos 3 leads');

    // Estado persistido carrega a decisão (pedido + critérios + contagem).
    const extras = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras;
    assert.ok(extras.audienceCriteria, 'decisão persistida vai ao estado');
    assert.equal(extras.audienceCriteria.pedido, 'só indústrias');
    assert.deepEqual(extras.audienceCriteria.criterios, criteria);
    assert.equal(extras.audienceCriteria.leadsIncluidos, 2);

    // Turno 2: o prompt do orquestrador carrega o FATO — o agente não
    // re-pergunta o que já está decidido.
    const t2 = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'PODE DETALHAR O PÚBLICO' });
    assert.equal(t2.res.status, 200);
    assert.ok(t2.body.data.reply.includes('só indústrias'), 'referencia a decisão em vez de re-perguntar');
    const lastPrompt = orchestratorPrompts[orchestratorPrompts.length - 1];
    assert.ok(lastPrompt.includes('audienciaDecidida'), 'bloco de decisão no prompt');
    assert.ok(lastPrompt.includes('"pedido":"só indústrias"'), 'pedido persistido no prompt');
    assert.ok(lastPrompt.includes('leadsIncluidos":2'), 'contagem do snapshot ativo no prompt');

    // Replay idempotente: mesma decisão de novo NÃO duplica segmento/snapshot.
    const chip = { type: 'set_audience', params: { description: 'só indústrias' } };
    const r1 = await api('POST', `/campaigns/${c.data.id}/actions`, chip);
    assert.equal(r1.res.status, 200);
    assert.equal(r1.body.data.card.replayed, true, 'mesma decisão é replay (hash de params)');
    const r2 = await api('POST', `/campaigns/${c.data.id}/actions`, chip);
    assert.equal(r2.body.data.card.replayed, true);
    assert.equal(prisma.studioSegment.rows.length, 1, 'decisão persiste sem duplicar registros');
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 2, 'snapshot não muda no replay');
  } finally {
    server.close();
  }
});

// ── Story 1.3 — segmentação que casa com a base real ────────────────────────

test('1.3: matching sem acento e por companyName — "metalurgica"/"taunus" casam "Metalúrgica"', async () => {
  const seenSegmentPrompts = [];
  const criteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'metalurgica' }] }] };
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      seenSegmentPrompts.push(user);
      return { content: JSON.stringify({ criteria, rationale: 'setor metalúrgico' }) };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return { content: JSON.stringify({ reply: 'Audiência montada.', actions: [{ type: 'set_audience', description: 'metalurgica' }] }) };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    prisma.prospect.rows.push(
      lead('org-1', { id: 'l1', companyName: 'Metalúrgica Taunus', industry: 'Fabricação de estruturas metálicas' }),
      lead('org-1', { id: 'l2', companyName: 'Metalúrgica Horizonte', industry: 'Fabricação de estruturas metálicas' }),
      lead('org-1', { id: 'l3', companyName: 'Mercearia Central', industry: 'Comércio varejista de alimentos' })
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Acento', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'indústrias metalmecânicas' });
    assert.equal(r.res.status, 200);
    const card = r.body.data.cards.find((card) => card.type === 'audience');
    assert.ok(card, 'card de audiência');
    assert.equal(card.emptyMatch, false, 'acento/grafia NÃO impedem o casamento');
    assert.ok(card.detail.includes('2 leads'), 'as 2 metalúrgicas entram (termo sem acento casa via searchText)');

    // companyName no catálogo: nome fantasia/razão social casam.
    const byName = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'set_audience',
      params: {
        description: 'taunus',
        criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'companyName', op: 'contains', value: 'taunus' }] }] },
      },
    });
    assert.equal(byName.res.status, 200);
    assert.ok(byName.body.data.card.detail.includes('1 leads'), 'companyName é aceito no catálogo e casa');
    assert.ok(
      segmentService.validateCriteria({ version: 1, groups: [{ op: 'AND', conditions: [{ field: 'tradeName', op: 'contains', value: 'x' }] }] }) === true,
      'tradeName aceito no catálogo'
    );
  } finally {
    server.close();
  }
});

test('1.3 (D5): pedido industrial na base fixa de 505 leads materializa ≥50; segment-nl ancorado na base', async () => {
  let segmentPrompt = null;
  const industrialCriteria = {
    version: 1,
    groups: [{
      op: 'OR',
      conditions: [
        { field: 'industry', op: 'contains', value: 'metalúrgica' },
        { field: 'companyName', op: 'contains', value: 'metalúrgica' },
      ],
    }],
  };
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      segmentPrompt = user;
      return { content: JSON.stringify({ criteria: industrialCriteria, rationale: 'termos atômicos do setor' }) };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return { content: JSON.stringify({ reply: 'Montei a audiência industrial.', actions: [{ type: 'set_audience', description: 'indústrias metalmecânicas' }] }) };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    // Base fixa QA-like: 505 leads, 57 industriais com industry CNAE acentuado.
    for (let i = 0; i < 57; i++) {
      prisma.prospect.rows.push(lead('org-1', {
        id: `ind-${i}`,
        companyName: `Metalúrgica Taunus ${i}`,
        industry: 'Fabricação de estruturas metálicas',
      }));
    }
    for (let i = 0; i < 448; i++) {
      prisma.prospect.rows.push(lead('org-1', {
        id: `food-${i}`,
        companyName: `Distribuidora de Alimentos ${i}`,
        industry: 'Comércio atacadista de alimentos',
      }));
    }
    const { body: c } = await api('POST', '/campaigns', { name: 'Industrial 505', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'quero indústrias metalmecânicas' });
    assert.equal(r.res.status, 200);
    const card = r.body.data.cards.find((card) => card.type === 'audience');
    assert.ok(card, 'card de audiência');
    assert.equal(card.emptyMatch, false, 'sem falso "nenhum casou"');
    const count = Number((card.detail.match(/(\d+) leads incluídos/) || [])[1]);
    assert.ok(count >= 50, `pedido industrial materializa ≥50 leads (D5) — veio ${count}`);

    // FR5: o prompt do segment-nl recebe amostra REAL da base como few-shot.
    assert.ok(segmentPrompt, 'segment-nl foi chamado');
    assert.ok(segmentPrompt.includes('SETORES REAIS desta base'), 'amostra de industry no prompt');
    assert.ok(segmentPrompt.includes('Fabricação de estruturas metálicas'), 'valor real da org no few-shot');
    assert.ok(segmentPrompt.includes('TERMOS ATÔMICOS'), 'instrução de termos atômicos no prompt');
  } finally {
    server.close();
  }
});

// ── Story 1.4 — recuperação determinística de audiência 0-match ─────────────

function industrialBase(prisma) {
  for (let i = 0; i < 57; i++) {
    prisma.prospect.rows.push(lead('org-1', {
      id: `met-${i}`,
      companyName: 'Metalúrgica Alfa Ltda',
      industry: 'Metalurgia',
    }));
  }
  for (let i = 0; i < 20; i++) {
    prisma.prospect.rows.push(lead('org-1', {
      id: `tec-${i}`,
      companyName: 'Tech Integradora',
      industry: 'Tecnologia',
    }));
  }
}

test('1.4: 0-match recebe diagnóstico + proposta de 1 clique que materializa ao tocar', async () => {
  const naauticaCriteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'náutica' }] }] };
  const llmImpl = orchestratorStub(
    { 'MONTE A AUDIÊNCIA': { reply: 'Montei!', actions: [{ type: 'set_audience', description: 'empresas de náutica' }] } },
    naauticaCriteria
  );
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    industrialBase(prisma);
    const { body: c } = await api('POST', '/campaigns', { name: 'Zero', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    assert.equal(r.res.status, 200);
    const card = r.body.data.cards.find((card) => card.type === 'audience');
    assert.equal(card.emptyMatch, true);
    assert.ok(card.diagnosis, 'diagnóstico do porquê presente');
    assert.ok(card.diagnosis.includes('nautica'), 'diagnóstico diz os termos consultados');
    assert.ok(card.diagnosis.includes('77'), 'diagnóstico contrasta com o total da base');
    assert.ok(card.diagnosis.includes('Metalurgia'), 'diagnóstico cita os setores reais da base');

    // Proposta materialmente diferente (hash distinto do where falho) e que
    // CASA — decisão de 1 clique para o vendedor.
    assert.ok(card.suggestedFilter, 'proposta de critério no card');
    assert.ok(card.suggestedFilter.matchedCount >= 50, `proposta casa leads de verdade (${card.suggestedFilter.matchedCount})`);
    assert.notDeepEqual(
      card.suggestedFilter.criteria,
      naauticaCriteria,
      'proposta é materialmente diferente do critério que falhou'
    );

    // 1 clique: o chip aplica o critério pronto (sem passar pelo LLM).
    const apply = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'set_audience',
      params: { description: card.suggestedFilter.description, criteria: card.suggestedFilter.criteria },
    });
    assert.equal(apply.res.status, 200);
    assert.equal(apply.body.data.card.type, 'audience');
    assert.equal(apply.body.data.card.emptyMatch, false, 'proposta aplicada materializa');
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, card.suggestedFilter.matchedCount);
  } finally {
    server.close();
  }
});

test('1.4: proposta NUNCA repete where já tentado — 2ª proposta difere e, esgotadas, vira diagnóstico sem loop', async () => {
  const failedCriteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'metalmecanica' }] }] };
  let rounds = 0;
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      return { content: JSON.stringify({ criteria: failedCriteria, rationale: 'x' }) };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      rounds += 1;
      // Descrição distinta por rodada: pedir EXATAMENTE a mesma audiência é
      // replay de idempotência (AD-6 — intocável), não nova tentativa.
      return {
        content: JSON.stringify({
          reply: 'Montei!',
          actions: [{ type: 'set_audience', description: `empresas metalmecânicas (tentativa ${rounds})` }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    industrialBase(prisma);
    const { body: c } = await api('POST', '/campaigns', { name: 'Sem loop', channels: ['email'] });

    // "Tentativas anteriores": propostas já aplicadas ficam como segmentos —
    // as propostas seguintes precisam ter where de hash diferente de TODAS.
    const seed = (name, value) => prisma.studioSegment.rows.push({
      id: `seed-${name}`, orgId: 'org-1', name,
      criteria: {
        version: 1,
        groups: [{ op: 'OR', conditions: [
          { field: 'industry', op: 'contains', value },
          { field: 'companyName', op: 'contains', value },
        ] }],
      },
      naturalLanguageInput: name, createdAt: new Date(),
    });

    const attempted = [JSON.stringify(failedCriteria)];

    // 1ª rodada: proposta difere do critério falho.
    const r1 = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    let card = r1.body.data.cards.find((card) => card.type === 'audience');
    assert.ok(card.suggestedFilter, '1ª proposta existe');
    const firstProposal = JSON.stringify(card.suggestedFilter.criteria);
    assert.ok(!attempted.includes(firstProposal), 'proposta difere do critério falho');
    attempted.push(firstProposal);

    // Proposta aplicada (virou tentativa) — a próxima NÃO pode repeti-la.
    seed('Tentativa aplicada', card.suggestedFilter.criteria.groups[0].conditions[0].value);

    // 2ª rodada: proposta nova, diferente de tudo que já foi tentado.
    const r2 = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    card = r2.body.data.cards.find((card) => card.type === 'audience');
    assert.ok(card.suggestedFilter, '2ª proposta existe (sem loop)');
    assert.notEqual(JSON.stringify(card.suggestedFilter.criteria), firstProposal, '2ª proposta é materialmente diferente da 1ª');
    assert.ok(!attempted.includes(JSON.stringify(card.suggestedFilter.criteria)), 'nunca repete where já tentado');
    attempted.push(JSON.stringify(card.suggestedFilter.criteria));

    // Esgotadas as propostas (todas já tentadas): diagnóstico honesto,
    // sugestão nula — nunca o mesmo where de novo.
    for (const value of ['metalurgia', 'metalurgica', 'Metalurgia']) seed(`Seed ${value}`, value);
    const r3 = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    card = r3.body.data.cards.find((card) => card.type === 'audience');
    assert.equal(card.emptyMatch, true);
    assert.equal(card.suggestedFilter, null, 'sem proposta repetida — melhor não propor');
    assert.ok(card.diagnosis, 'diagnóstico permanece como saída honesta');
  } finally {
    server.close();
  }
});

// ── Story 1.5 — F2: confirm_material resolve por nome ───────────────────────

function seedMaterials(prisma) {
  prisma.studioMaterial.rows.push(
    {
      id: 'mat-erp', orgId: 'org-1', kind: 'url', sourceRef: 'https://exemplo.com/erp',
      extractionStatus: 'extracted', extraction: { product: 'ERP industrial', offer: 'implantação' },
      confirmedAt: null, createdAt: new Date(),
    },
    {
      id: 'mat-id', orgId: 'org-1', kind: 'url', sourceRef: 'https://exemplo.com/datasheet',
      extractionStatus: 'extracted', extraction: { product: 'Datasheet Único' },
      confirmedAt: null, createdAt: new Date(),
    },
    {
      id: 'mat-amb-1', orgId: 'org-1', kind: 'url', sourceRef: 'https://exemplo.com/p1',
      extractionStatus: 'extracted', extraction: { product: 'Proposta Comercial' },
      confirmedAt: null, createdAt: new Date(),
    },
    {
      id: 'mat-amb-2', orgId: 'org-1', kind: 'url', sourceRef: 'https://exemplo.com/p2',
      extractionStatus: 'extracted', extraction: { product: 'Proposta comercial' },
      confirmedAt: null, createdAt: new Date(),
    }
  );
}

test('1.5: confirm_material resolve por nome; ambíguo pede desambiguação; inexistente vira 404 explicável', async () => {
  const decisions = {
    'CONFIRMA PELO NOME': { reply: 'Confirmado.', actions: [{ type: 'confirm_material', materialId: 'ERP Industrial' }] },
    'CONFIRA O DATASHEET': { reply: 'Confirmado.', actions: [{ type: 'confirm_material', materialId: 'mat-id' }] },
    'CONFIRMA A PROPOSTA': { reply: 'Vou confirmar.', actions: [{ type: 'confirm_material', materialId: 'proposta comercial' }] },
    'CONFIRMA O CATÁLOGO': { reply: 'Vou confirmar.', actions: [{ type: 'confirm_material', materialId: 'Catálogo Inexistente' }] },
  };
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      for (const [marker, decision] of Object.entries(decisions)) {
        if (user.includes(`NOVA MENSAGEM DO USUÁRIO: ${marker}`)) return { content: JSON.stringify(decision) };
      }
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    seedMaterials(prisma);
    const { body: c } = await api('POST', '/campaigns', { name: 'F2', channels: ['email'] });

    // a) Nome em vez de id: resolve na org e confirma o material certo.
    const byName = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'CONFIRMA PELO NOME' });
    assert.equal(byName.res.status, 200);
    assert.ok(
      byName.body.data.cards.some((card) => card.type === 'material_confirmed'),
      'confirmação por nome funciona'
    );
    assert.equal(byName.body.data.cards.some((card) => card.type === 'error'), false, 'sem card de erro');
    assert.ok(prisma.studioMaterial.rows.find((m) => m.id === 'mat-erp').confirmedAt, 'material certo confirmado');

    // b) Id exato continua funcionando (contrato v1 intacto — AD-6).
    const byId = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'CONFIRA O DATASHEET' });
    assert.ok(byId.body.data.cards.some((card) => card.type === 'material_confirmed'), 'id exato segue funcionando');
    assert.ok(prisma.studioMaterial.rows.find((m) => m.id === 'mat-id').confirmedAt);

    // c) Nome ambíguo: NUNCA resolve sozinho — card de desambiguação.
    const ambiguous = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'CONFIRMA A PROPOSTA' });
    const ambCard = ambiguous.body.data.cards.find((card) => card.type === 'material_ambiguous');
    assert.ok(ambCard, 'ambiguidade vira card de desambiguação');
    assert.equal(ambCard.candidates.length, 2, 'lista os candidatos');
    assert.equal(ambiguous.body.data.cards.some((card) => card.type === 'error'), false, 'desambiguação não é falha');
    assert.ok(!prisma.studioMaterial.rows.find((m) => m.id === 'mat-amb-1').confirmedAt, 'nada confirmado sozinho');
    assert.ok(!prisma.studioMaterial.rows.find((m) => m.id === 'mat-amb-2').confirmedAt);

    // d) Nome que não casa com nada: 404 explicável (nunca inventa).
    const missing = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'CONFIRMA O CATÁLOGO' });
    const errCard = missing.body.data.cards.find((card) => card.type === 'error');
    assert.ok(errCard, 'falha vira card de erro');
    assert.ok(errCard.detail.includes('Material não encontrado'), '404 explicável');
    assert.equal(missing.body.data.cards.some((card) => card.type === 'material_confirmed'), false);
  } finally {
    server.close();
  }
});

// ── Cenários extremos (barra do dono — NFR5/FR14 base) ──────────────────────

test('extremo: cadastro todo null — turno segue de pé com diagnóstico honesto', async () => {
  const criteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'náutica' }] }] };
  const llmImpl = orchestratorStub(
    { 'MONTE A AUDIÊNCIA': { reply: 'Montei!', actions: [{ type: 'set_audience', description: 'náutica' }] } },
    criteria
  );
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    // Cadastro "vazio": nem companyName, nem industry, nem searchText.
    prisma.prospect.rows.push(
      { id: 'n1', orgId: 'org-1', status: 'qualified', state: 'SP' },
      { id: 'n2', orgId: 'org-1', status: 'qualified', state: 'MG' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Nulls', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    assert.equal(r.res.status, 200, 'cadastro vazio não derruba o turno');
    const card = r.body.data.cards.find((card) => card.type === 'audience');
    assert.equal(card.emptyMatch, true);
    assert.ok(card.diagnosis.includes('2 lead(s)'), 'diagnóstico informa o total mesmo sem setores');
    assert.equal(card.suggestedFilter, null, 'sem dados reais, não inventa proposta');
    const state = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.ok(Array.isArray(state.extras.audienceAvailableSample), 'estado segue consistente');
  } finally {
    server.close();
  }
});

test('extremo: base toda acentuada casa com pedido sem acento (searchText)', async () => {
  const criteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'construcao' }] }] };
  const llmImpl = orchestratorStub(
    { 'MONTE A AUDIÊNCIA': { reply: 'Montei!', actions: [{ type: 'set_audience', description: 'construcao' }] } },
    criteria
  );
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    for (let i = 0; i < 5; i++) {
      prisma.prospect.rows.push(lead('org-1', { id: `c${i}`, companyName: `Construtora Ânima ${i}`, industry: 'Construção Civil' }));
    }
    prisma.prospect.rows.push(lead('org-1', { id: 'a0', companyName: 'Padaria Estrela', industry: 'Alimentação e Bebidas' }));
    const { body: c } = await api('POST', '/campaigns', { name: 'Acentuada', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    assert.equal(r.res.status, 200);
    const card = r.body.data.cards.find((card) => card.type === 'audience');
    assert.equal(card.emptyMatch, false, '"construcao" sem acento casa "Construção Civil"');
    assert.ok(card.detail.includes('5 leads'), 'só as 5 da construção entram');
  } finally {
    server.close();
  }
});

// ── Unidade: search-text.js + catálogo/tradução do segment-service (FR4) ────

test('FR4 unidade: normalizeText/buildSearchText/withSearchText e catálogo com termos atômicos', () => {
  assert.equal(normalizeText('Metalúrgicas ÁÉÍÕÇ'), 'metalurgicas aeioc');
  assert.equal(buildSearchText({ industry: 'Fabricação', companyName: null, tradeName: 'Taunus' }), 'fabricacao taunus');
  assert.equal(buildSearchText({}), null, 'sem valores → null (contains nunca casa com null)');
  assert.equal(
    withSearchText({ industry: 'Metalurgia' }, { companyName: 'Alfa Ltda', industry: 'Varejo' }).searchText,
    'metalurgia alfa ltda',
    'update parcial recalcula do patch ∪ linha'
  );
  assert.equal(
    withSearchText({ industry: null }, { industry: 'X', companyName: 'A' }).searchText,
    'a',
    'null no patch limpa o campo antes de compor'
  );

  assert.ok(segmentService.FIELD_CATALOG.companyName.includes('contains'), 'companyName no catálogo');
  assert.ok(segmentService.FIELD_CATALOG.tradeName.includes('equals'), 'tradeName no catálogo');
  assert.equal(
    segmentService.validateCriteria({ version: 1, groups: [{ op: 'AND', conditions: [{ field: 'companyName', op: 'contains', value: 'x' }] }] }),
    true
  );

  // Revisão Epic 1: AND com 2+ condições de texto — o assign plano mesclava a
  // chave OR e a PRIMEIRA condição desaparecia do where (audiência inflada).
  const mixed = segmentService.translateCriteria({
    version: 1,
    groups: [{
      op: 'AND',
      conditions: [
        { field: 'industry', op: 'contains', value: 'metalurgica' },
        { field: 'companyName', op: 'contains', value: 'taunus' },
      ],
    }],
  });
  const merged = mixed.AND[0].AND;
  assert.ok(Array.isArray(merged) && merged.length === 2, 'as DUAS condições sobrevivem no where');
  assert.ok(merged[0].OR.some((b) => b.industry), 'primeira condição (industry) presente');
  assert.ok(merged[1].OR.some((b) => b.companyName), 'segunda condição (companyName) presente');

  // Revisão Epic 1: equals em campo de texto também é tolerante a acento.
  const byEquals = segmentService.translateCriteria({
    version: 1,
    groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'equals', value: 'metalurgica' }] }],
  });
  assert.ok(byEquals.AND[0].OR.some((b) => b.searchText && b.searchText.equals === 'metalurgica'), 'equals consulta searchText normalizado');
  assert.ok(byEquals.AND[0].OR.some((b) => b.industry && b.industry.equals === 'metalurgica'), 'equals preserva o literal');

  // Revisão Epic 1: siglas curtas ("TI", "RH") não podem ser descartadas.
  assert.ok(segmentService.termVariants('TI e RH').includes('ti'));
  assert.ok(segmentService.termVariants('TI e RH').includes('rh'));
  assert.ok(segmentService.termVariants('indústrias metalmecânicas').includes('industria'), 'frase composta vira termos atômicos');

  const variants = segmentService.termVariants('indústrias metalmecânicas');
  assert.ok(variants.includes('industria'), 'frase composta vira termos atômicos');
  assert.ok(variants.includes('metalmecanica'), 'variante sem plural gerada');

  const translated = segmentService.translateCriteria({
    version: 1,
    groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'Metalúrgica' }] }],
  });
  const branch = translated.AND[0];
  assert.ok(branch.OR, 'contains em campo de texto vira OR com searchText');
  assert.ok(
    branch.OR.some((b) => b.searchText && b.searchText.contains === 'metalurgica'),
    'termo normalizado consulta searchText'
  );
  assert.ok(
    branch.OR.some((b) => b.industry),
    'OR preserva o campo estrutural (linhas sem backfill)'
  );
});

// ── Revisão Epic 1 — ajustes finos ──────────────────────────────────────────

test('1.2: decisão de OUTRA campanha (ou sem snapshot) é histórico, não FATO inegociável', async () => {
  const prompts = [];
  const criteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'indústria' }] }] };
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) {
      return { content: JSON.stringify({ criteria, rationale: 'x' }) };
    }
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      prompts.push(user);
      if (user.includes('NOVA MENSAGEM DO USUÁRIO: TURNO CAMPANHA A')) return { content: JSON.stringify({ reply: 'ok A', actions: [{ type: 'none' }] }) };
      if (user.includes('NOVA MENSAGEM DO USUÁRIO: TURNO CAMPANHA B')) return { content: JSON.stringify({ reply: 'ok B', actions: [{ type: 'none' }] }) };
      return { content: JSON.stringify({ reply: 'Audiência fechada: só indústrias.', actions: [{ type: 'set_audience', description: 'só indústrias' }] }) };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    prisma.prospect.rows.push(
      lead('org-1', { id: 'l1', companyName: 'Metalúrgica Alfa', industry: 'Indústria Metalúrgica' }),
      lead('org-1', { id: 'l2', companyName: 'Indústria Beta', industry: 'Indústria Química' })
    );
    const { body: a } = await api('POST', '/campaigns', { name: 'A', channels: ['email'] });
    await api('POST', `/campaigns/${a.data.id}/chat`, { message: 'só indústrias' });

    const { body: b } = await api('POST', '/campaigns', { name: 'B', channels: ['email'] });

    await api('POST', `/campaigns/${a.data.id}/chat`, { message: 'TURNO CAMPANHA A' });
    await api('POST', `/campaigns/${b.data.id}/chat`, { message: 'TURNO CAMPANHA B' });

    const promptA = prompts.find((p) => p.includes('TURNO CAMPANHA A'));
    const promptB = prompts.find((p) => p.includes('TURNO CAMPANHA B'));
    assert.ok(promptA.includes('"audienciaDecidida":{"pedido":"só indústrias"'), 'campanha COM snapshot ativo recebe a decisão como FATO');
    assert.ok(!promptB.includes('"audienciaDecidida":{"pedido"'), 'campanha SEM snapshot NÃO recebe o FATO');
    assert.ok(promptB.includes('"audienciaHistorico":{"pedido":"só indústrias"'), 'decisão vai como histórico recente (sem a regra de nunca re-perguntar)');
  } finally {
    server.close();
  }
});

test('1.1: falha de LLM DENTRO da action → card mordomo (zero jargão) + trace degraded', async () => {
  const criteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'náutica' }] }] };
  const llmImpl = async ({ user }) => {
    if (user.includes('critérios de segmento')) return { content: 'isto não é json' };
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return { content: JSON.stringify({ reply: 'Montei!', actions: [{ type: 'set_audience', description: 'náutica' }] }) };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    industrialBase(prisma);
    const { body: c } = await api('POST', '/campaigns', { name: 'Action LLM falha', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    assert.equal(res.status, 200);

    const degraded = body.data.cards.find((card) => card.type === 'degraded');
    assert.ok(degraded, 'card de aviso existe');
    assert.ok(!/estágio|tentativa|parse|json/i.test(degraded.detail), 'zero jargão no card');
    assert.ok(degraded.detail.includes('não foi alterada'), 'diz o que NÃO mudou');
    assert.ok(degraded.detail.includes('1 minuto'), 'próximo passo');

    const trace = prisma.studioChatTrace.rows[0];
    assert.equal(trace.status, 'degraded', 'trace não mente como succeeded');
    assert.equal(trace.errorCode, 'LLM_JSON_FAILED');
    assert.ok(trace.errorStack);
  } finally {
    server.close();
  }
});

test('1.4: proposta que casaria 0 é pulada — só vai ao card proposta que CASA', async () => {
  const criteria = {
    version: 1,
    groups: [{
      op: 'AND',
      conditions: [
        { field: 'industry', op: 'contains', value: 'náutica' },
        { field: 'opportunityScore', op: 'gte', value: 90 },
      ],
    }],
  };
  const llmImpl = orchestratorStub(
    { 'MONTE A AUDIÊNCIA': { reply: 'Montei!', actions: [{ type: 'set_audience', description: 'náutica score 90' }] } },
    criteria
  );
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    industrialBase(prisma); // nenhum lead com opportunityScore >= 90
    const { body: c } = await api('POST', '/campaigns', { name: 'Skip zero', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    const card = r.body.data.cards.find((card) => card.type === 'audience');
    assert.equal(card.emptyMatch, true);
    assert.ok(card.suggestedFilter, 'existe proposta — e ela CASA');
    assert.ok(card.suggestedFilter.matchedCount > 0, 'proposta entregue materializa (nunca 0)');
    const fields = card.suggestedFilter.criteria.groups.flatMap((g) => g.conditions).map((c) => c.field);
    assert.ok(!fields.includes('opportunityScore'), 'a combinação que casaria 0 (filtros sem o setor) foi pulada');
  } finally {
    server.close();
  }
});

test('AD-6: set_audience sem criteria reusa o hash LEGADO — replay de run pré-deploy não re-executa', async () => {
  const llmImpl = async () => ({ content: '{}' });
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Chave legada', channels: ['email'] });
    // Row gravada pelo código PRÉ-deploy: chave com params {description} apenas.
    prisma.studioActionRun.rows.push({
      id: 'run-legacy',
      orgId: 'org-1',
      campaignId: c.data.id,
      action: 'set_audience',
      actionKey: manifest.actionKey({ orgId: 'org-1', campaignId: c.data.id, action: 'set_audience', params: { description: 'só industrial' } }),
      status: 'succeeded',
      result: { type: 'audience', label: 'Audiência legada', detail: 'x' },
    });
    const r = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'set_audience', params: { description: 'só industrial' } });
    assert.equal(r.res.status, 200);
    assert.equal(r.body.data.card.replayed, true, 'mesma chave do pré-deploy → replay');
    assert.equal(r.body.data.card.label, 'Audiência legada', 'resultado original, sem re-execução');
  } finally {
    server.close();
  }
});

test('1.4: diagnóstico usa o total REAL da base (não o teto da amostra de 1000)', async () => {
  const criteria = { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'náutica' }] }] };
  const llmImpl = orchestratorStub(
    { 'MONTE A AUDIÊNCIA': { reply: 'Montei!', actions: [{ type: 'set_audience', description: 'náutica' }] } },
    criteria
  );
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    for (let i = 0; i < 1001; i++) {
      prisma.prospect.rows.push(lead('org-1', { id: `c${i}`, companyName: `Construtora ${i}`, industry: 'Construção Civil' }));
    }
    const { body: c } = await api('POST', '/campaigns', { name: 'Total real', channels: ['email'] });
    const r = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'MONTE A AUDIÊNCIA' });
    const card = r.body.data.cards.find((card) => card.type === 'audience');
    assert.equal(card.emptyMatch, true);
    assert.ok(card.diagnosis.includes('1001 lead(s)'), `total real no diagnóstico (veio: ${card.diagnosis})`);
    assert.ok(card.diagnosis.includes('na amostra'), 'amostra identificada como amostra');
    assert.ok(card.suggestedFilter && card.suggestedFilter.matchedCount === 1001, 'proposta que casa');
  } finally {
    server.close();
  }
});
