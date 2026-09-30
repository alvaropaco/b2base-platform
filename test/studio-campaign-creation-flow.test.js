'use strict';

/**
 * test/studio-campaign-creation-flow.test.js — onda "criação de campanha sem
 * bloqueios" (epics-studio-campaign-creation-flow 2026-09-29):
 *
 *  - Story 1.4 (FR2/FR3): canais efetivos = canais da campanha ∩ canais
 *    conectados — a interseção vive no compile do channel-bridge (AD-2/AD-14);
 *    peças de canal não conectado permanecem salvas como rascunho.
 *  - Story 1.3 (FR5): leads sem consentimento WhatsApp não bloqueiam — ficam
 *    fora do canal WhatsApp na matrícula (recebem só e-mail).
 *  - Story 1.5 (FR4): sem nenhum canal a campanha é criada do começo ao fim
 *    e fica "pendente de envio" (statusReason NO_CHANNEL_CONNECTED); conectar
 *    o canal destrava o disparo sem refazer a criação.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const bridge = require('../studio/channel-bridge');
const { tickCampaign } = require('../studio/scheduler-worker');

// ── Fixtures ─────────────────────────────────────────────────────────────────

function campaignFixture(overrides = {}) {
  return {
    id: 'camp-1',
    orgId: 'org-1',
    name: 'Campanha',
    status: 'approved',
    channels: ['email', 'whatsapp'],
    schedule: {},
    emailExecutionId: null,
    whatsappExecutionId: null,
    approval: {},
    ...overrides,
  };
}

function seedSnapshot(prisma, prospectIds) {
  prisma.studioAudienceSnapshot.rows.push({
    id: 'snap-1',
    orgId: 'org-1',
    campaignId: 'camp-1',
    criteriaVersion: {},
    totalCount: prospectIds.length,
    includedCount: prospectIds.length,
    excludedCount: 0,
    status: 'active',
  });
  for (const prospectId of prospectIds) {
    prisma.studioAudienceMember.rows.push({ id: `m-${prospectId}`, snapshotId: 'snap-1', orgId: 'org-1', prospectId, included: true, excludeReason: null });
  }
  return prisma.studioAudienceSnapshot.rows[0];
}

function seedContents(prisma, channels) {
  if (channels.includes('email')) {
    prisma.studioContent.rows.push({
      id: 'content-email', orgId: 'org-1', campaignId: 'camp-1', channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A',
      subject: 'Olá {{firstName}}', whatsappText: null,
      emailDoc: { blocks: [{ type: 'text', text: 'Conteúdo com descadastro (unsubscribe).' }] },
      origin: 'manual',
    });
  }
  if (channels.includes('whatsapp')) {
    prisma.studioContent.rows.push({
      id: 'content-wa', orgId: 'org-1', campaignId: 'camp-1', channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A',
      subject: null, whatsappText: 'Oi {{firstName}}! Posso te mandar uma novidade?',
      emailDoc: null, origin: 'manual',
    });
  }
}

// ── Story 1.4: canais efetivos no compile (AD-2) ─────────────────────────────

test('compile: só e-mail conectado → só e-mail compila; peças de WhatsApp permanecem rascunho (FR2)', async () => {
  const prisma = createFakePrisma();
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', status: 'connected' });
  const campaign = campaignFixture();
  prisma.studioCampaign.rows.push(campaign);
  const snapshot = seedSnapshot(prisma, ['l1']);
  seedContents(prisma, ['email', 'whatsapp']);

  const compiled = await bridge.compile(prisma, {
    campaign,
    contents: prisma.studioContent.rows.slice(),
    snapshot,
    channels: campaign.channels,
  });

  assert.ok(compiled.emailExecution, 'execução de e-mail criada');
  assert.equal(compiled.whatsappExecution, null, 'WhatsApp sem conta NÃO compila execução');
  assert.deepEqual(compiled.channels.effective, ['email']);
  assert.deepEqual(compiled.channels.skipped.map((s) => s.channel), ['whatsapp']);
  assert.equal(compiled.channels.skipped[0].code, 'CANAL_NAO_CONECTADO');
  // Nada se perde: as peças de WhatsApp continuam salvas no StudioContent.
  const waContent = prisma.studioContent.rows.find((c) => c.channel === 'whatsapp');
  assert.ok(waContent, 'peça de WhatsApp preservada como rascunho');
  assert.equal(prisma.whatsappCampaign.rows.length, 0, 'nenhuma execução de WhatsApp criada');
});

test('compile: ambos conectados → dispara pelos dois (FR3); sem nenhum → compila nada sem falhar (FR4)', async () => {
  const prisma = createFakePrisma();
  const campaign = campaignFixture();
  prisma.studioCampaign.rows.push(campaign);
  const snapshot = seedSnapshot(prisma, ['l1']);
  seedContents(prisma, ['email', 'whatsapp']);
  const contents = prisma.studioContent.rows.slice();

  // Nenhum canal conectado: compila sem execuções e SEM erro.
  const none = await bridge.compile(prisma, { campaign, contents, snapshot, channels: campaign.channels });
  assert.equal(none.emailExecution, null);
  assert.equal(none.whatsappExecution, null);
  assert.deepEqual(none.channels.effective, []);

  // Ambos conectados: duas execuções.
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', status: 'connected' });
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  const both = await bridge.compile(prisma, { campaign, contents, snapshot, channels: campaign.channels });
  assert.ok(both.emailExecution);
  assert.ok(both.whatsappExecution);
  assert.deepEqual(both.channels.effective, ['email', 'whatsapp']);
  assert.deepEqual(both.channels.skipped, []);
});

// ── Story 1.3: consentimento na matrícula (FR5) ──────────────────────────────

test('matrícula: lead sem consentimento fica fora do WhatsApp e recebe só e-mail; nada bloqueia', async () => {
  const prisma = createFakePrisma();
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', status: 'connected' });
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  const campaign = campaignFixture();
  prisma.studioCampaign.rows.push(campaign);
  const snapshot = seedSnapshot(prisma, ['l-consentido', 'l-sem-consentimento']);
  seedContents(prisma, ['email', 'whatsapp']);
  prisma.studioLeadConsent.rows.push({ id: 'consent-1', orgId: 'org-1', prospectId: 'l-consentido', channel: 'whatsapp', source: 'opt_in' });

  const compiled = await bridge.compile(prisma, {
    campaign,
    contents: prisma.studioContent.rows.slice(),
    snapshot,
    channels: campaign.channels,
  });

  const waContacts = bridge.waContactModel(prisma);
  const waEnrolled = waContacts.rows.map((r) => r.prospectId);
  const emailEnrolled = prisma.outreachContact.rows.map((r) => r.prospectId);
  assert.deepEqual(waEnrolled, ['l-consentido'], 'só quem tem consentimento entra no WhatsApp');
  assert.deepEqual([...emailEnrolled].sort(), ['l-consentido', 'l-sem-consentimento'], 'e-mail alcança todos');
  assert.equal(compiled.enrollment.whatsappSkippedNoConsent, 1, 'exclusão explicável');
  assert.equal(compiled.enrollment.members, 2);
});

test('matrícula: resposta prévia a e-mail (REPLIED) conta como consentimento (FR-35)', async () => {
  const prisma = createFakePrisma();
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  const campaign = campaignFixture({ channels: ['whatsapp'] });
  prisma.studioCampaign.rows.push(campaign);
  const snapshot = seedSnapshot(prisma, ['l-respondeu']);
  seedContents(prisma, ['whatsapp']);
  prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-velha', prospectId: 'l-respondeu', status: 'REPLIED' });

  await bridge.compile(prisma, {
    campaign,
    contents: prisma.studioContent.rows.slice(),
    snapshot,
    channels: campaign.channels,
  });
  const waContacts = bridge.waContactModel(prisma);
  assert.deepEqual(waContacts.rows.map((r) => r.prospectId), ['l-respondeu'], 'REPLIED é porta de entrada válida');
});

// ── Story 1.5: pendente de envio (FR4) ───────────────────────────────────────

async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  const dispatched = [];
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use(
    '/api/studio',
    createStudioRouter(prisma, {
      overrides: {
        dispatchImmediate: async (args) => {
          dispatched.push(args);
          return { email: { enqueued: args.prospectIds.length }, whatsapp: null };
        },
      },
    })
  );
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
  async function createApprovedCampaign(channels) {
    const { body } = await api('POST', '/campaigns', { name: 'Sem bloqueios', channels });
    const campaign = body.data;
    for (const id of ['lead-1', 'lead-2']) {
      prisma.prospect.rows.push({ id, orgId: 'org-1', companyName: `Empresa ${id}`, cnpjEmail: `${id}@e.com`, lastContact: null });
    }
    await api('POST', `/campaigns/${campaign.id}/audience`, { manual: { prospectIds: ['lead-1', 'lead-2'] } });
    seedContents(prisma, channels);
    for (const row of prisma.studioContent.rows) row.campaignId = campaign.id;
    await api('POST', `/campaigns/${campaign.id}/submit-review`);
    return campaign;
  }
  return { server, prisma, api, dispatched, createApprovedCampaign };
}

test('approve sem nenhum canal: campanha criada do começo ao fim e "pendente de envio" (FR4)', async () => {
  const { server, prisma, api, createApprovedCampaign } = await startServer();
  try {
    const campaign = await createApprovedCampaign(['email', 'whatsapp']);
    const { res, body } = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(res.status, 200, 'aprovação NUNCA depende de canal');
    assert.equal(body.data.status, 'approved');
    assert.equal(body.data.statusReason, 'NO_CHANNEL_CONNECTED', 'pendente de envio por nome');
    assert.equal(body.data.emailExecutionId, null);
    assert.equal(body.data.whatsappExecutionId, null);
    // Nenhuma campanha presa em draft/in_review (AC da story 1.5).
    assert.equal(prisma.studioCampaign.rows[0].status, 'approved');

    // O estado aparece na listagem (UX-DR5).
    const list = await api('GET', '/campaigns');
    const listed = list.body.data.find((c) => c.id === campaign.id);
    assert.equal(listed.statusReason, 'NO_CHANNEL_CONNECTED');
  } finally {
    server.close();
  }
});

test('pendente de envio: disparo sem canal → 409 explicável; conectar canal destrava sem refazer a criação', async () => {
  const { server, prisma, api, dispatched, createApprovedCampaign } = await startServer();
  try {
    const campaign = await createApprovedCampaign(['email']);
    await api('POST', `/campaigns/${campaign.id}/approve`);

    // Sem canal conectado: 409 com caminho (conectar canal), campanha intacta.
    const blocked = await api('POST', `/campaigns/${campaign.id}/schedule`, { mode: 'immediate' });
    assert.equal(blocked.res.status, 409);
    assert.equal(blocked.body.error, 'NO_CHANNEL_CONNECTED');
    assert.equal(prisma.studioCampaign.rows[0].status, 'approved', 'não entra em running sem canal');
    assert.equal(dispatched.length, 0);

    // Cliente conecta o canal — o disparo destrava na mesma tela, sem refazer
    // a criação (gate normal se aplica).
    prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', status: 'connected' });
    const released = await api('POST', `/campaigns/${campaign.id}/schedule`, { mode: 'immediate' });
    assert.equal(released.res.status, 200);
    assert.equal(released.body.data.status, 'running');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].channel, 'email');
    const fresh = await api('GET', `/campaigns/${campaign.id}`);
    assert.equal(fresh.body.data.statusReason, null, 'pendente de envio encerra ao sair para o voo');
  } finally {
    server.close();
  }
});

test('com canal conectado, re-aprovar limpa statusReason "pendente de envio" antigo', async () => {
  const { server, prisma, api, createApprovedCampaign } = await startServer();
  try {
    const campaign = await createApprovedCampaign(['email']);
    await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(prisma.studioCampaign.rows[0].statusReason, 'NO_CHANNEL_CONNECTED');

    // Conecta o canal e re-aprova (approved → in_review → approved).
    prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', status: 'connected' });
    await api('POST', `/campaigns/${campaign.id}/require-review`, { reason: 'reaprove após conectar canal' });
    const { res, body } = await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(res.status, 200);
    assert.equal(body.data.status, 'approved');
    assert.equal(body.data.statusReason, null, 'estado antigo não sobrevive à re-aprovação');
    assert.ok(body.data.emailExecutionId, 'execução de e-mail compilada com o canal conectado');
  } finally {
    server.close();
  }
});

// ── Scheduler: transição scheduled→running usa o canal EFETIVO ───────────────

const IN_WINDOW = new Date('2026-09-23T13:00:00Z'); // 10h SP, quarta — dentro de 9–18

test('tick: e-mail declarado mas só WhatsApp conectado → transita e dispara WhatsApp (canais efetivos)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'whatsapp', balance: 30, floor: 0, ceiling: 30, rampStage: 0, domainAuthStatus: 'unverified' });
  prisma.studioCampaign.rows.push({
    id: 'camp-1', orgId: 'org-1', name: 'Campanha', status: 'scheduled',
    channels: ['email', 'whatsapp'],
    schedule: { mode: 'scheduled', startAt: null, windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }], hourlyLimit: 5, dailyLimit: 20, timezone: 'America/Sao_Paulo', useLeadTimezone: false },
    emailExecutionId: null, whatsappExecutionId: 'exec-wa', approval: {},
  });
  bridge.waContactModel(prisma).rows.push(
    { id: 'wac-1', campaignId: 'exec-wa', prospectId: 'l1', status: 'QUEUED', nextSendAt: null },
    { id: 'wac-2', campaignId: 'exec-wa', prospectId: 'l2', status: 'QUEUED', nextSendAt: null }
  );
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => { enqueued.push({ channel, ids }); },
  });
  assert.equal(result.released, 2, 'lote de WhatsApp liberado');
  assert.equal(prisma.studioCampaign.rows[0].status, 'running', 'scheduled → running via gate');
  assert.deepEqual(enqueued, [{ channel: 'whatsapp', ids: ['l1', 'l2'] }], 'WhatsApp entra em voo');
});

test('tick: nenhum canal conectado → nada libera (no_channel), fail-closed', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  prisma.studioCampaign.rows.push({
    id: 'camp-2', orgId: 'org-1', name: 'Sem canal', status: 'scheduled',
    channels: ['email'],
    schedule: { mode: 'scheduled', startAt: null, windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }], hourlyLimit: 5, dailyLimit: 20, timezone: 'America/Sao_Paulo', useLeadTimezone: false },
    emailExecutionId: null, whatsappExecutionId: null, approval: {},
  });
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => { enqueued.push({ channel, ids }); },
  });
  assert.equal(result.released, 0);
  assert.equal(result.skipped, 'no_channel');
  assert.deepEqual(enqueued, []);
  assert.equal(prisma.studioCampaign.rows[0].status, 'scheduled', 'não transita sem canal efetivo');
});

// ── Revisão: sem canal DECLARÁVEL nunca entra em voo; agenda preserva/limpa
// o motivo "pendente de envio" pela INTERSEÇÃO (canal declarado conectado).

test('disparo imediato sem canal DECLARÁVEL (só linkedin_text) → 409, nunca running com fila vazia', async () => {
  const { server, prisma, api, dispatched, createApprovedCampaign } = await startServer();
  try {
    const campaign = await createApprovedCampaign(['linkedin_text']);
    // Peça do canal declarado (o compile não tem nada a compilar — sem motor).
    prisma.studioContent.rows.push({
      id: 'content-li', orgId: 'org-1', campaignId: campaign.id, channel: 'linkedin_text',
      kind: 'base', stepIndex: 1, variantLabel: 'A', linkedinText: 'Olá {{firstName}}',
    });
    await api('POST', `/campaigns/${campaign.id}/approve`);

    prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', status: 'connected' });
    const blocked = await api('POST', `/campaigns/${campaign.id}/schedule`, { mode: 'immediate' });
    assert.equal(blocked.res.status, 409, 'canal declarável nenhum → 409 NO_CHANNEL_CONNECTED');
    assert.equal(blocked.body.error, 'NO_CHANNEL_CONNECTED');
    assert.equal(prisma.studioCampaign.rows[0].status, 'approved', 'não entra em running');
    assert.equal(dispatched.length, 0);
  } finally {
    server.close();
  }
});

test('schedule preserva "pendente de envio" sem canal declarado conectado; limpa com a interseção (D5)', async () => {
  const { server, prisma, api, createApprovedCampaign } = await startServer();
  try {
    const campaign = await createApprovedCampaign(['email']);
    await api('POST', `/campaigns/${campaign.id}/approve`);
    assert.equal(prisma.studioCampaign.rows[0].statusReason, 'NO_CHANNEL_CONNECTED');

    // Sem canal: agendar PRESERVA o motivo — o rótulo segue "Pendente de envio".
    const kept = await api('POST', `/campaigns/${campaign.id}/schedule`, {
      mode: 'scheduled',
      startAt: '2026-10-05T10:00:00.000Z',
    });
    assert.equal(kept.res.status, 200);
    assert.equal(kept.body.data.status, 'scheduled');
    assert.equal(kept.body.data.statusReason, 'NO_CHANNEL_CONNECTED', 'motivo preservado (outro motivo nunca é tocado)');

    // Com o canal DECLARADO conectado: transição aprovada→agendada LIMPA o motivo.
    const campaign2 = await createApprovedCampaign(['email']);
    await api('POST', `/campaigns/${campaign2.id}/approve`);
    prisma.emailAccount.rows.push({ id: 'ea-2', tenantId: 'org-1', userId: 'user-1', status: 'connected' });
    const cleared = await api('POST', `/campaigns/${campaign2.id}/schedule`, { mode: 'scheduled' });
    assert.equal(cleared.res.status, 200);
    assert.equal(cleared.body.data.statusReason, null, 'limpo pela interseção declarado ∩ conectado');
  } finally {
    server.close();
  }
});
