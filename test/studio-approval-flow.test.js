'use strict';

/**
 * test/studio-approval-flow.test.js — US1 do Campaign Studio (specs/010, T014).
 *
 * A regra de ouro da spec: nenhuma campanha nasce disparável (FR-002) e nada
 * envia sem revisão + aprovação explícita (FR-001/FR-003). Compliance em
 * nível `block` impede a aprovação (FR-073 mínimo); a audiência congela no
 * snapshot (FR-013); edição pós-run exige pausar → re-aprovar (FR-006).
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const campaignService = require('../studio/campaign-service');

// ── Helpers ─────────────────────────────────────────────────────────────────

function leadFixture(id, orgId, overrides = {}) {
  return {
    id,
    orgId,
    companyName: `Empresa ${id}`,
    contactName: 'Ana Silva',
    city: 'São Paulo',
    state: 'SP',
    industry: 'indústria',
    status: 'qualified',
    cnpjEmail: `${id}@empresa.com.br`,
    lastContact: null,
    ...overrides,
  };
}

// Conteúdo de e-mail que passa no compliance mínimo (tem descadastro).
const EMAIL_CONTENT_OK = {
  channel: 'email',
  subject: 'Proposta para {{companyName}}',
  whatsappText: null,
  emailDoc: {
    blocks: [
      { type: 'text', text: 'Olá {{firstName}}, tudo bem?' },
      { type: 'button', label: 'Agendar', url: 'https://exemplo.com' },
      { type: 'text', text: 'Não quer mais receber? Faça o descadastro.' },
    ],
  },
  origin: 'manual',
};

async function startServer({ dispatch } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  const dispatched = [];

  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use(
    '/api/studio',
    createStudioRouter(prisma, {
      overrides: {
        // Dispatch injetável: em teste não tocamos em BullMQ/motores reais.
        dispatchImmediate: async (args) => {
          dispatched.push(args);
          return { email: { jobsQueued: args.prospectIds.length }, whatsapp: null };
        },
        ...(dispatch ? { dispatchImmediate: dispatch } : {}),
      },
    })
  );

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
    const { body } = await api('POST', '/campaigns', { name: 'Campanha Teste', channels });
    return body.data;
  }

  return { server, base, prisma, api, createCampaign, dispatched };
}

// ── Máquina de estados (funções puras) ──────────────────────────────────────

test('máquina de estados: transições válidas do fluxo de aprovação', () => {
  assert.equal(campaignService.canTransition('draft', 'in_review'), true);
  assert.equal(campaignService.canTransition('in_review', 'approved'), true);
  assert.equal(campaignService.canTransition('approved', 'scheduled'), true);
  assert.equal(campaignService.canTransition('scheduled', 'running'), true);
  assert.equal(campaignService.canTransition('running', 'paused'), true);
  assert.equal(campaignService.canTransition('paused', 'in_review'), true, 'FR-006: pausar → re-aprovar');
  assert.equal(campaignService.canTransition('retained', 'in_review'), true, 're-derive 007');
});

test('máquina de estados: nenhuma origem pula a revisão (FR-002/FR-003)', () => {
  assert.equal(campaignService.canTransition('draft', 'approved'), false);
  assert.equal(campaignService.canTransition('draft', 'running'), false);
  assert.equal(campaignService.canTransition('in_review', 'running'), false);
  assert.equal(campaignService.canTransition('completed', 'running'), false);
  assert.throws(() => campaignService.assertTransition('draft', 'approved'), (err) => {
    assert.equal(err.code, 'INVALID_TRANSITION');
    assert.equal(err.status, 409);
    return true;
  });
});

// ── Fluxo HTTP: submit-review → approve ─────────────────────────────────────

test('submit-review: draft → in_review; approve sem audiência → 409 EMPTY_AUDIENCE', async () => {
  const { server, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign();
    const { res: resReview } = await api('POST', `/campaigns/${campaign.id}/submit-review`);
    assert.equal(resReview.status, 200);
    assert.equal((await api('GET', `/campaigns/${campaign.id}`)).body.data.status, 'in_review');

    const { res: resApprove, body } = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(resApprove.status, 409);
    assert.equal(body.error, 'EMPTY_AUDIENCE');
  } finally {
    server.close();
  }
});

test('audiência manual: lead em supressão é excluído com motivo e não pode ser re-incluído (FR-011/FR-012)', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign();
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    prisma.prospect.rows.push(leadFixture('lead-2', 'org-1'));
    prisma.suppressionList.rows.push({ id: 'sup-1', tenantId: 'org-1', email: 'lead-1@empresa.com.br', reason: 'unsubscribed' });

    const { res, body } = await api('POST', `/campaigns/${campaign.id}/audience`, {
      manual: { prospectIds: ['lead-1', 'lead-2'] },
    });
    assert.equal(res.status, 200);
    assert.equal(body.data.totalCount, 2);
    assert.equal(body.data.includedCount, 1);
    const excluded = body.data.members.find((m) => m.prospectId === 'lead-1');
    assert.equal(excluded.included, false);
    assert.equal(excluded.excludeReason, 'suppressed');
  } finally {
    server.close();
  }
});

test('approve com conteúdo sem descadastro no corpo → aprovado (garantia vive no compile — FR-37/AD-2)', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign(['email']);
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    await api('POST', `/campaigns/${campaign.id}/audience`, { manual: { prospectIds: ['lead-1'] } });

    // Conteúdo SEM mecanismo de descadastro.
    prisma.studioContent.rows.push({
      id: 'content-1', orgId: 'org-1', campaignId: campaign.id, channel: 'email',
      subject: 'Oferta', preheader: null, whatsappText: null, linkedinText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Compre agora {{companyName}}' }] },
      origin: 'manual', variantLabel: 'A', kind: 'base', stepIndex: 1,
      editHistory: [], ctaUrl: null, tone: null,
    });

    await api('POST', `/campaigns/${campaign.id}/submit-review`);
    const { res } = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(res.status, 200);
    assert.equal((await api('GET', `/campaigns/${campaign.id}`)).body.data.status, 'approved');
  } finally {
    server.close();
  }
});

test('approve com variável desconhecida no corpo → bloqueia (nunca envia {{...}} — SC-011)', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign(['email']);
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    await api('POST', `/campaigns/${campaign.id}/audience`, { manual: { prospectIds: ['lead-1'] } });
    prisma.studioContent.rows.push({
      id: 'content-2', orgId: 'org-1', campaignId: campaign.id, channel: 'email',
      subject: 'Oi {{apelidoSecreto}}', preheader: null, whatsappText: null, linkedinText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Texto com descadastro no fim.' }] },
      origin: 'manual', variantLabel: 'A', kind: 'base', stepIndex: 1,
      editHistory: [], ctaUrl: null, tone: null,
    });
    await api('POST', `/campaigns/${campaign.id}/submit-review`);
    const { res, body } = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(res.status, 409);
    assert.equal(body.error, 'COMPLIANCE_BLOCKED');
    assert.ok(body.message.includes('apelidoSecreto'));
  } finally {
    server.close();
  }
});

test('approve feliz: status approved, snapshot único e dispatch imediato com os leads certos', async () => {
  const { server, prisma, api, createCampaign, dispatched } = await startServer();
  try {
    const campaign = await createCampaign(['email']);
    prisma.prospect.rows.push(leadFixture('lead-1', 'org-1'));
    prisma.prospect.rows.push(leadFixture('lead-2', 'org-1'));
    await api('POST', `/campaigns/${campaign.id}/audience`, { manual: { prospectIds: ['lead-1', 'lead-2'] } });
    prisma.studioContent.rows.push({
      id: 'content-3', orgId: 'org-1', campaignId: campaign.id, channel: 'email',
      subject: 'Proposta {{companyName}}', preheader: null, whatsappText: null, linkedinText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Olá! Cancele quando quiser: descadastro.' }] },
      origin: 'manual', variantLabel: 'A', kind: 'base', stepIndex: 1,
      editHistory: [], ctaUrl: null, tone: null,
    });

    await api('POST', `/campaigns/${campaign.id}/submit-review`);
    const { res, body } = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(res.status, 200);
    assert.equal(body.data.status, 'approved');
    assert.ok(body.data.approvedAt);

    // Snapshot único com audiência congelada (FR-013).
    const snapshots = prisma.studioAudienceSnapshot.rows.filter((s) => s.campaignId === campaign.id && s.status === 'active');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].includedCount, 2);

    // Disparo imediato (approved → running via dispatch injetável).
    const { res: resRun } = await api('POST', `/campaigns/${campaign.id}/schedule`, {
      mode: 'immediate',
    });
    assert.equal(resRun.status, 200);
    assert.equal(dispatched.length, 1);
    assert.deepEqual([...dispatched[0].prospectIds].sort(), ['lead-1', 'lead-2']);
    assert.equal(dispatched[0].channel, 'email');

    // Aprovar 2× não duplica snapshot (409 INVALID_TRANSITION — não está mais em revisão).
    const second = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(second.res.status, 409);
    const activeSnapshots = prisma.studioAudienceSnapshot.rows.filter(
      (s) => s.campaignId === campaign.id && s.status === 'active'
    );
    assert.equal(activeSnapshots.length, 1);
  } finally {
    server.close();
  }
});

test('edição pós-run é bloqueada com CAMPAIGN_LOCKED (FR-006); paused permite re-aprovar', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign(['email']);
    prisma.studioCampaign.rows[0].status = 'running';
    const { res, body } = await api('PATCH', `/campaigns/${campaign.id}`, { objective: 'mudou' });
    assert.equal(res.status, 409);
    assert.equal(body.error, 'CAMPAIGN_LOCKED');

    prisma.studioCampaign.rows[0].status = 'paused';
    const ok = await api('PATCH', `/campaigns/${campaign.id}`, { objective: 'mudou na pausa' });
    assert.equal(ok.res.status, 200);
    // Editar na pausa devolve para revisão (re-aprovação obrigatória — FR-006).
    assert.equal(ok.body.data.status, 'in_review');
  } finally {
    server.close();
  }
});

test('campanha retida pelo saneamento aparece com motivo e volta a revisão no re-derive', async () => {
  const { server, prisma, api, createCampaign } = await startServer();
  try {
    const campaign = await createCampaign();
    prisma.studioCampaign.rows[0].status = 'retained';
    prisma.studioCampaign.rows[0].statusReason = 'synthetic_template_leak';
    const detail = await api('GET', `/campaigns/${campaign.id}`);
    assert.equal(detail.body.data.status, 'retained');
    assert.equal(detail.body.data.statusReason, 'synthetic_template_leak');

    const { res } = await api('POST', `/campaigns/${campaign.id}/rederive`);
    assert.equal(res.status, 200);
    assert.equal((await api('GET', `/campaigns/${campaign.id}`)).body.data.status, 'in_review');
  } finally {
    server.close();
  }
});
