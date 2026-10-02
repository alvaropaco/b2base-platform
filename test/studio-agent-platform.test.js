'use strict';

/**
 * test/studio-agent-platform.test.js — onda "IA com a plataforma inteira"
 * (QA 2026-10-02, bugs 1/2/4/5/6 do dono): o agente enxerga a organização
 * (todas as campanhas + base), executa pelo chat o que existia só no painel
 * (criar/renomear/duplicar/apagar/aprovar campanha, respostas dos leads,
 * DNS, capacidades, editar lead) e pede confirmação antes de alterar
 * artefato que já existe. Streaming do reply coberto no último teste.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const manifest = require('../studio/actions/manifest.v1');
const { SYSTEM_PROMPT, campaignManagementHint } = require('../studio/ai/chat-agent');

/** segment-nl stub: traduz a descrição em critérios determinísticos. */
function segmentStub({ user }) {
  if (!user.includes('critérios de segmento')) return null;
  const spOnly = user.includes('só SP') || user.includes('só indústrias de SP');
  const criteria = spOnly
    ? { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'state', op: 'equals', value: 'SP' }] }] }
    : { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'indústria' }] }] };
  return {
    content: JSON.stringify({ criteria, rationale: spOnly ? 'só SP' : 'indústrias' }),
  };
}

async function startServer({ llmImpl } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma, {
    overrides: {
      aiDeps: {
        callLlm:
          llmImpl ||
          (async () => ({ content: JSON.stringify({ reply: 'Feito.', actions: [{ type: 'none' }] }) })),
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html></html>' }),
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

test('bug 6: toda action do manifest é declarada no SYSTEM_PROMPT (capacidades sem drift)', () => {
  for (const key of Object.keys(manifest.ACTIONS_V1)) {
    assert.ok(SYSTEM_PROMPT.includes(key), `SYSTEM_PROMPT cita a action "${key}"`);
  }
  // Anti-negação (QA 2026-10-02, 3ª bateria): o modelo negava que dava para
  // criar/renomear pelo chat — a regra absoluta precisa estar no prompt.
  assert.ok(SYSTEM_PROMPT.includes('REGRA ABSOLUTA CONTRA NEGAÇÃO FALSA'));
});

test('roteador de gerenciamento: pedido de campanha injeta a instrução; trabalho de conteúdo não', () => {
  assert.ok(campaignManagementHint('cria uma campanha chamada Rh Novo'), 'criação detectada');
  assert.ok(campaignManagementHint('renomeia a campanha para X'), 'renomear detectado');
  assert.ok(campaignManagementHint('quais campanhas eu tenho?'), 'listagem detectada');
  assert.ok(campaignManagementHint('apaga a campanha antiga'), 'exclusão detectada');
  assert.equal(campaignManagementHint('monta a audiência da campanha'), null, 'trabalho da jornada não é gerência');
  assert.equal(campaignManagementHint('criar conteúdo da campanha'), null, 'conteúdo não é gerência');
  assert.equal(campaignManagementHint('oi, tudo bem?'), null, 'conversa comum sem hint');
});

test('bug 2: criar campanha pelo CHAT (turno do modelo) materializa a campanha', async () => {
  const llmImpl = async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      assert.ok(user.includes('GERENCIAMENTO DE CAMPANHAS DETECTADO'), 'hint de gerência injetado no prompt do turno');
      return {
        content: JSON.stringify({
          reply: 'Campanha criada!',
          actions: [{ type: 'create_campaign', name: 'Rh Novo', channels: ['email'] }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Sessão', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'cria uma campanha chamada Rh Novo',
    });
    assert.equal(res.status, 200);
    const card = body.data.cards.find((card) => card.type === 'campaign_created');
    assert.ok(card, 'card de criação no thread');
    const created = (await api('GET', `/campaigns/${card.campaignId}`)).body.data;
    assert.equal(created.name, 'Rh Novo');
    assert.equal(created.origin, 'agent');
  } finally {
    server.close();
  }
});

test('bug 1/2: list_campaigns mostra as campanhas da organização inteira', async () => {
  const { server, api } = await startServer();
  try {
    await api('POST', '/campaigns', { name: 'Primeira', channels: ['email'] });
    const { body: c2 } = await api('POST', '/campaigns', { name: 'Segunda', channels: ['email'] });

    const { res, body } = await api('POST', `/campaigns/${c2.data.id}/actions`, { type: 'list_campaigns' });
    assert.equal(res.status, 200);
    const card = body.data.card;
    assert.equal(card.type, 'campaign_list');
    assert.equal(card.campaigns.length, 2, 'ambas as campanhas da org aparecem');
    const current = card.campaigns.find((c) => c.current);
    assert.equal(current.name, 'Segunda', 'a campanha aberta é marcada');
    assert.ok(card.detail.includes('Primeira'), 'a OUTRA campanha está na lista');
  } finally {
    server.close();
  }
});

test('bug 2: create_campaign pelo chat cria rascunho rastreável (origin agent)', async () => {
  const { server, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Atual', channels: ['email'] });
    const { res, body } = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'create_campaign',
      params: { name: 'Outbound indústrias', channels: ['email', 'whatsapp'] },
    });
    assert.equal(res.status, 200);
    const card = body.data.card;
    assert.equal(card.type, 'campaign_created');
    assert.ok(card.campaignId);
    const created = (await api('GET', `/campaigns/${card.campaignId}`)).body.data;
    assert.equal(created.status, 'draft');
    assert.equal(created.origin, 'agent');
    assert.deepEqual(created.channels, ['email', 'whatsapp']);
  } finally {
    server.close();
  }
});

test('bug 6: rename, duplicate e approve pelo chat (mesmos serviços do painel)', async () => {
  const llm = async ({ user }) => {
    const seg = segmentStub({ user });
    if (seg) return seg;
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      return {
        content: JSON.stringify({
          reply: 'Audiência montada.',
          actions: [{ type: 'set_audience', description: 'indústrias', confirmed: true }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl: llm });
  try {
    // A aprovação exige audiência > 0 (EMPTY_AUDIENCE caso contrário).
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'indústria', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Renomeável', channels: ['email'] });
    // Monta a audiência e leva à revisão (mesmo caminho do painel).
    const chat = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'monta a audiência' });
    assert.equal(chat.res.status, 200);
    // Aprovação exige conteúdo base para o canal declarado (compliance).
    await prisma.studioContent.create({
      data: {
        orgId: 'org-1', campaignId: c.data.id, channel: 'email', variantLabel: 'formal',
        kind: 'base', stepIndex: 1, subject: 'Assunto', tone: 'formal', origin: 'ai_from_material',
        emailDoc: { blocks: [{ type: 'text', text: 'Olá {{firstName}}' }] },
      },
    });
    await api('POST', `/campaigns/${c.data.id}/submit-review`);

    const ren = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'rename_campaign', params: { name: 'Novo nome' },
    });
    assert.equal(ren.body.data.card.type, 'campaign_renamed');
    assert.equal((await api('GET', `/campaigns/${c.data.id}`)).body.data.name, 'Novo nome');

    const dup = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'duplicate_campaign', params: { campaignId: c.data.id },
    });
    const copyId = dup.body.data.card.campaignId;
    const copy = (await api('GET', `/campaigns/${copyId}`)).body.data;
    assert.equal(copy.origin, 'duplicate');
    assert.equal(copy.sourceCampaignId, c.data.id);
    assert.equal(copy.status, 'draft');

    const app = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'approve_campaign' });
    assert.equal(app.body.data.card.type, 'campaign_approved');
    assert.equal((await api('GET', `/campaigns/${c.data.id}`)).body.data.status, 'approved');
  } finally {
    server.close();
  }
});

test('bug 5: alterar audiência decidida pede confirmação — texto "pode sim" aprova', async () => {
  let round = 0;
  const llmImpl = async ({ user }) => {
    const seg = segmentStub({ user });
    if (seg) return seg;
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      round += 1;
      const description = round >= 2 ? 'só indústrias de SP' : 'indústrias';
      return {
        content: JSON.stringify({
          reply: 'Montando a audiência.',
          actions: [{ type: 'set_audience', description }],
        }),
      };
    }
    return { content: '{}' };
  };
  const { server, prisma, api } = await startServer({ llmImpl });
  try {
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'indústria', opportunityScore: 90, status: 'qualified', state: 'SP', cnpjEmail: 'a@a.com' },
      { id: 'l2', orgId: 'org-1', companyName: 'B', industry: 'indústria', opportunityScore: 80, status: 'qualified', state: 'RJ', cnpjEmail: 'b@b.com' }
    );
    const { body: c } = await api('POST', '/campaigns', { name: 'Gate', channels: ['email'] });
    const first = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'monta a audiência' });
    assert.equal(first.body.data.cards.find((card) => card.type === 'audience').detail.includes('2 leads'), true);

    // 2ª mudança SEM confirmação: card confirm_change, NADA executa.
    const gated = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'muda para só SP' });
    const confirmCard = gated.body.data.cards.find((card) => card.type === 'confirm_change');
    assert.ok(confirmCard, 'gate devolve card de confirmação');
    assert.equal(confirmCard.kind, 'audiencia');
    assert.ok(confirmCard.action.params.confirmed, 'chip carrega o selo de aprovação');
    assert.equal((await api('GET', `/campaigns/${c.data.id}/state`)).body.data.extras.audienceCount, 2, 'audiência intacta');

    // Aprovação textual: "pode sim" reenvia a action com o selo.
    const approved = await api('POST', `/campaigns/${c.data.id}/chat`, { message: 'pode sim' });
    assert.equal(approved.res.status, 200);
    const after = (await api('GET', `/campaigns/${c.data.id}/state`)).body.data;
    assert.equal(after.extras.audienceCount, 1, 'audiência substituída só depois do ok (só l1 é de SP)');
  } finally {
    server.close();
  }
});

test('bug 5: delete_campaign SEMPRE confirma — apagada só com o selo', async () => {
  const { server, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Alvo', channels: ['email'] });
    const gated = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'delete_campaign', params: {},
    });
    assert.equal(gated.body.data.card.type, 'confirm_change');
    assert.ok((await api('GET', `/campaigns/${c.data.id}`)).body.data, 'ainda existe');

    const done = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'delete_campaign', params: { confirmed: true },
    });
    assert.equal(done.body.data.card.type, 'campaign_deleted');
    const check = await api('GET', `/campaigns/${c.data.id}`);
    assert.equal(check.res.status, 404, 'apagada de verdade');
  } finally {
    server.close();
  }
});

test('bug 2/6: show_replies, show_dns_records, show_capabilities e update_lead', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Extras', channels: ['email'] });

    // Respostas de leads (caixa de entrada do agente).
    prisma.studioReplyClassification.rows.push({
      id: 'r1', orgId: 'org-1', prospectId: 'l1', channel: 'email',
      label: 'interested', confidence: 0.92, needsHumanReview: false, createdAt: new Date(),
    });
    const replies = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'show_replies' });
    assert.equal(replies.body.data.card.type, 'replies');
    assert.ok(replies.body.data.card.detail.includes('interessado'));

    // Capacidades: a resposta canônica para "o que você faz?".
    const caps = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'show_capabilities' });
    assert.equal(caps.body.data.card.type, 'capabilities');
    assert.ok(caps.body.data.card.detail.includes('Campanhas'));
    assert.ok(caps.body.data.card.detail.includes('criar'));

    // update_lead: escopo de org + campos da lista branca.
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'Metalúrgica Taunus', industry: 'metalurgia', status: 'qualified', cnpjEmail: 'a@a.com' },
      { id: 'lf', orgId: 'org-2', companyName: 'De Outra Org', status: 'qualified' }
    );
    const upd = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'update_lead',
      params: { prospectId: 'l1', fields: { contactName: 'Maria', employees: 120 } },
    });
    assert.equal(upd.body.data.card.type, 'lead_updated');
    const lead = prisma.prospect.rows.find((row) => row.id === 'l1');
    assert.equal(lead.contactName, 'Maria');
    assert.equal(lead.employees, 120);

    const foreign = await api('POST', `/campaigns/${c.data.id}/actions`, {
      type: 'update_lead',
      params: { prospectId: 'lf', fields: { contactName: 'X' } },
    });
    assert.equal(foreign.res.status, 404, 'lead de outra org nunca é tocado');

    // DNS: sem conta de e-mail conectada → recusa honesta (não inventa registros).
    const dns = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'show_dns_records' });
    assert.equal(dns.body.data.card.type, 'dns_records');
    assert.ok(dns.body.data.card.detail.includes('Conecte'));
  } finally {
    server.close();
  }
});

test('bug 4: o reply chega EM STREAMING (eventos reply_delta no SSE)', async () => {
  let llmCalls = 0;
  const llmImpl = async () => {
    llmCalls += 1;
    return {
      content: JSON.stringify({ reply: 'Resposta em streaming!', actions: [{ type: 'none' }] }),
    };
  };
  const { server, api } = await startServer({ llmImpl });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Stream', channels: ['email'] });
    const port = server.address().port;
    const sse = await fetch(`http://127.0.0.1:${port}/api/studio/campaigns/${c.data.id}/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'oi' }),
    });
    assert.ok(sse.ok);
    const text = await sse.text();
    assert.ok(text.includes('event: reply_delta'), 'delta de streaming transmitido');
    assert.ok(text.includes('event: reply'), 'reply final autoritativo também sai');
    assert.ok(text.includes('Resposta em streaming'), 'conteúdo do reply presente');
    // 2 chamadas: pré-extração de intenção (campanha sem objetivo) + orchestrate.
    assert.equal(llmCalls, 2, 'pré-extração + orchestrate (stream sintetizado no teste)');
  } finally {
    server.close();
  }
});
