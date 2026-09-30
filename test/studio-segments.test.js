'use strict';

/**
 * test/studio-segments.test.js — US2 do Campaign Studio (specs/010, T024).
 *
 * Segmentos salvos com critérios estruturados sobre catálogo fechado
 * (FR-008/FR-009), delta de reuso, importação de lista (FR-010) e uso de
 * segmento como audiência de campanha com exclusões obrigatórias (FR-011).
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const segmentService = require('../studio/segment-service');

function leadFixture(id, orgId, overrides = {}) {
  return {
    id,
    orgId,
    companyName: `Empresa ${id}`,
    contactName: 'Ana Silva',
    cnpj: null,
    cnpjEmail: `${id}@empresa.com.br`,
    city: 'São Paulo',
    state: 'SP',
    industry: 'indústria metalúrgica',
    status: 'qualified',
    opportunityScore: 80,
    employees: 120,
    revenueEstimate: 5_000_000,
    verdict: 'contact',
    lastContact: null,
    ...overrides,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  // Canal de envio conectado (onda 2026-09-29): só canal conectado compila
  // execução na aprovação — o teste de congelamento precisa da fila montada.
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function api(method, path, body) {
    const res = await fetch(`${base}/api/studio${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { res, body: await res.json() };
  }
  async function createCampaign(channels = ['email']) {
    const { body } = await api('POST', '/campaigns', { name: 'Campanha', channels });
    return body.data;
  }
  return { server, base, prisma, api, createCampaign };
}

// ── Tradução de critérios (funções puras) ───────────────────────────────────

test('critérios: catálogo fechado rejeita campo e operador desconhecidos (D3)', () => {
  assert.throws(
    () => segmentService.validateCriteria({ version: 1, groups: [{ op: 'AND', conditions: [{ field: 'senha', op: 'equals', value: 'x' }] }] }),
    (err) => err.code === 'INVALID_CRITERIA_FIELD'
  );
  assert.throws(
    () => segmentService.validateCriteria({ version: 1, groups: [{ op: 'AND', conditions: [{ field: 'opportunityScore', op: 'DROP TABLE', value: 1 }] }] }),
    (err) => err.code === 'INVALID_CRITERIA_FIELD'
  );
  assert.doesNotThrow(() =>
    segmentService.validateCriteria({
      version: 1,
      groups: [{ op: 'AND', conditions: [{ field: 'opportunityScore', op: 'gte', value: 70 }] }],
    })
  );
});

test('critérios: tradução para where do Prisma com grupos AND/OR', () => {
  const where = segmentService.translateCriteria({
    version: 1,
    groups: [
      { op: 'AND', conditions: [{ field: 'state', op: 'equals', value: 'SP' }] },
      {
        op: 'OR',
        conditions: [
          { field: 'industry', op: 'contains', value: 'metalúrgica' },
          { field: 'industry', op: 'contains', value: 'textil' },
        ],
      },
    ],
  });
  // grupo AND vira condição direta; grupo OR vira { OR: [...] }, tudo em AND.
  assert.deepEqual(where.AND[0], { state: { equals: 'SP' } });
  assert.equal(where.AND[1].OR.length, 2);
});

test('critérios: região expande para os estados da região (FR-008)', () => {
  const where = segmentService.translateCriteria({
    version: 1,
    groups: [{ op: 'AND', conditions: [{ field: 'region', op: 'in', value: ['Sul'] }] }],
  });
  assert.deepEqual(where.AND[0].state.in.sort(), ['PR', 'RS', 'SC']);
});

// ── Fluxo HTTP: segmento salvo → contagem → audiência → delta ───────────────

test('segmento: cria, conta e prévia mostra amostra; campo inválido → 400', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    prisma.prospect.rows.push(leadFixture('lead-2', 'org-1', { state: 'RS', industry: 'agronegócio' }));
    // Lead de OUTRA org não conta (constituição IV).
    prisma.prospect.rows.push(leadFixture('lead-3', 'org-2'));

    const { res, body } = await api('POST', '/segments', {
      name: 'Indústria SP score alto',
      criteria: {
        version: 1,
        groups: [
          { op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'metalúrgica' }, { field: 'state', op: 'equals', value: 'SP' }] },
        ],
      },
    });
    assert.equal(res.status, 201);
    const segmentId = body.data.id;

    const preview = await api('POST', `/segments/${segmentId}/preview`);
    assert.equal(preview.res.status, 200);
    assert.equal(preview.body.data.count, 1, 'apenas lead-1 casa com setor+estado da org-1');
    assert.equal(preview.body.data.sample[0].companyName, 'Empresa lead-1');

    const bad = await api('POST', '/segments', {
      name: 'Injeção',
      criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'id; --', op: 'equals', value: 1 }] }] },
    });
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error, 'INVALID_CRITERIA_FIELD');
  } finally {
    server.close();
  }
});

test('reuso de segmento indica delta de tamanho desde o último uso (FR-009)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    const created = await api('POST', '/segments', {
      name: 'SP qualificados',
      criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'state', op: 'equals', value: 'SP' }] }] },
    });
    const segmentId = created.body.data.id;

    const first = await api('POST', `/segments/${segmentId}/preview`);
    assert.equal(first.body.data.count, 1);
    assert.equal(first.body.data.delta, null, 'primeira contagem não tem delta');

    // Novo lead entra no segmento → delta +1 na contagem seguinte.
    prisma.prospect.rows.push(leadFixture('lead-9', 'org-1'));
    const second = await api('POST', `/segments/${segmentId}/preview`);
    assert.equal(second.body.data.count, 2);
    assert.equal(second.body.data.delta, 1);
  } finally {
    server.close();
  }
});

test('campanha com segmento como audiência: contagem + excluídos com motivo (FR-011)', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign(['email']);
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    prisma.prospect.rows.push(leadFixture('lead-2', 'org-1', { cnpjEmail: null }));
    // lead-2 sem e-mail não pode ser checado em supressão, mas lead-3 está
    // suprimido e lead-4 tem opt-out de WhatsApp (canal não usado → inclui).
    prisma.prospect.rows.push(leadFixture('lead-3', 'org-1', { cnpjEmail: 'suprimido@empresa.com.br' }));
    prisma.suppressionList.rows.push({ id: 'sup-1', tenantId: 'org-1', email: 'suprimido@empresa.com.br', reason: 'unsubscribed' });
    prisma.prospect.rows.push(leadFixture('lead-4', 'org-1'));
    prisma.leadChannelState.rows.push({ id: 'lc-1', orgId: 'org-1', prospectId: 'lead-4', channel: 'whatsapp', status: 'opted_out' });

    const segment = await api('POST', '/segments', {
      name: 'Todos SP',
      criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'state', op: 'equals', value: 'SP' }] }] },
    });

    const { res, body } = await api('POST', `/campaigns/${campaign.id}/audience`, {
      segmentId: segment.body.data.id,
    });
    assert.equal(res.status, 200);
    assert.equal(body.data.includedCount, 3, 'lead-1, lead-2 e lead-4 (opt-out é de WhatsApp)');
    const suppressed = body.data.members.find((m) => m.prospectId === 'lead-3');
    assert.equal(suppressed.excludeReason, 'suppressed');
  } finally {
    server.close();
  }
});

test('importação de lista (FR-010): CNPJs/e-mails resolvidos contra a org, unmatched reportado', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign(['email']);
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1', { cnpj: '11222333000181' }));
    prisma.prospect.rows.push(leadFixture('lead-2', 'org-1', { cnpjEmail: 'contato@outra.com.br' }));
    prisma.prospect.rows.push(leadFixture('lead-x', 'org-2', { cnpj: '99999999000199' })); // outra org

    const { res, body } = await api('POST', `/campaigns/${campaign.id}/audience`, {
      list: ['11.222.333/0001-81', 'contato@outra.com.br', 'naoachou@fantasma.com', '99999999000199'],
    });
    assert.equal(res.status, 200);
    assert.equal(body.data.matched.length, 2, 'CNPJ formatado e e-mail casam; CNPJ de outra org não');
    assert.deepEqual(body.data.matched.sort(), ['lead-1', 'lead-2']);
    assert.deepEqual(body.data.unmatched, ['naoachou@fantasma.com', '99999999000199']);
    // Nenhum prospect novo criado (importação de audiência ≠ importação de leads).
    assert.ok(!prisma.prospect.rows.some((p) => p.cnpj === 'naoachou@fantasma.com'));
  } finally {
    server.close();
  }
});

test('congelamento na aprovação: novos leads no segmento NÃO entram (FR-013/US2-AC3)', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign(['email']);
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    const segment = await api('POST', '/segments', {
      name: 'SP',
      criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'state', op: 'equals', value: 'SP' }] }] },
    });
    await api('POST', `/campaigns/${campaign.id}/audience`, { segmentId: segment.body.data.id });

    // Conteúdo válido + aprovação.
    prisma.studioContent.rows.push({
      id: 'content-ok', orgId: 'org-1', campaignId: campaign.id, channel: 'email',
      subject: 'Olá', preheader: null, whatsappText: null, linkedinText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Texto com descadastro.' }] },
      origin: 'manual', variantLabel: 'A', kind: 'base', stepIndex: 1,
      editHistory: [], ctaUrl: null, tone: null,
    });
    await api('POST', `/campaigns/${campaign.id}/submit-review`);
    const approved = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(approved.res.status, 200);

    // Novo lead entra no segmento DEPOIS da aprovação → não recebe.
    prisma.prospect.rows.push(leadFixture('lead-novo', 'org-1'));
    const queue = await api('GET', `/campaigns/${campaign.id}/queue`);
    assert.ok(!queue.body.data.some((r) => r.prospectId === 'lead-novo'), 'lead novo fora da fila');
    assert.equal(queue.body.data.length, 1, 'apenas o lead congelado está inscrito');
  } finally {
    server.close();
  }
});
