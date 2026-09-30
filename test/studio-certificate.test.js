'use strict';

/**
 * test/studio-certificate.test.js — Certificado de Segurança bloqueante
 * (specs/011, AD-7; FR-26…FR-30, FR-35/36/37). Disparo com item reprovado é
 * IMPOSSÍVEL: o gate re-avalia o selo no release; cada item tem estado e
 * explicação; consentimento WhatsApp vem de registro persistido (AD-11).
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const certificate = require('../studio/certificate');
const reputationGate = require('../studio/reputation-gate');

function seedCampaign(prisma, { channels = ['email'], content = {}, approval = {}, members = [], schedule } = {}) {
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.studioReputationAccount.rows.push({
    id: 'acc-1', orgId: 'org-1', channel: 'email',
    balance: 100, floor: 10, ceiling: 100, rampStage: 0,
    domainAuthStatus: 'verified', domainAuthDetail: {},
  });
  prisma.studioCampaign.rows.push({
    id: 'camp-1', orgId: 'org-1', name: 'Campanha', status: 'approved',
    channels, schedule: schedule || { mode: 'scheduled', windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }], hourlyLimit: 5, dailyLimit: 50, timezone: 'America/Sao_Paulo', useLeadTimezone: false },
    approval, ...content,
  });
  prisma.studioAudienceSnapshot.rows.push({
    id: 'snap-1', orgId: 'org-1', campaignId: 'camp-1', criteriaVersion: {},
    totalCount: members.length, includedCount: members.filter((m) => m.included !== false).length,
    excludedCount: members.filter((m) => m.included === false).length, status: 'active',
  });
  for (const member of members) {
    prisma.studioAudienceMember.rows.push({ snapshotId: 'snap-1', orgId: 'org-1', ...member });
  }
  prisma.studioContent.rows.push({
    id: 'content-1', orgId: 'org-1', campaignId: 'camp-1', channel: channels[0],
    kind: 'base', stepIndex: 1, variantLabel: 'A',
    subject: 'Olá {{firstName}} — descadastro no rodapé',
    emailDoc: { blocks: [{ type: 'text', text: 'Conteúdo curto com link de descadastro (unsubscribe).' }] },
    whatsappText: channels.includes('whatsapp') ? 'Oi! Posso te mandar uma novidade rápida?' : null,
  });
  return prisma.studioCampaign.rows[0];
}

test('tudo verde: certificado aprova e persiste o selo na campanha (AD-7)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    members: [
      { prospectId: 'l1', included: true },
      { prospectId: 'l2', included: true },
    ],
  });
  const verdict = await certificate.evaluate(prisma, campaign);
  assert.equal(verdict.level, 'green');
  assert.ok(verdict.items.length >= 1, 'itens de estado relevantes (ruído ok foi removido)');
  assert.ok(verdict.items.every((i) => i.detail), 'cada item com explicação (FR-27)');
  assert.ok(verdict.items.every((i) => !['window', 'unsubscribe'].includes(i.key)), 'itens de ruído não existem mais');
  const persisted = prisma.studioCampaign.rows[0].approval.certificate;
  assert.ok(persisted, 'selo persistido na campanha');
  assert.equal(persisted.level, 'green');
});

test('saldo abaixo do necessário é PENDÊNCIA na criação — tom mordomo, nunca "bloqueado" (FR1 onda 2026-09-29)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    members: Array.from({ length: 50 }, (_, i) => ({ prospectId: `l${i}`, included: true })), // 50 necessárias
  });
  prisma.studioReputationAccount.rows[0].balance = 20;
  const verdict = await certificate.evaluate(prisma, campaign);
  assert.equal(verdict.level, 'amber', 'pendência NUNCA bloqueia a criação');
  const saldo = verdict.items.find((i) => i.key === 'saldo');
  assert.equal(saldo.level, 'pending');
  assert.ok(saldo.detail.includes('Faltam'), 'diz o que falta (tom mordomo)');
  assert.ok(saldo.detail.includes('reposição diária libera'), 'diz quando libera');
  assert.ok(!saldo.detail.toLowerCase().includes('bloqueado'), 'nunca soa interdição (UX-DR4)');
  assert.ok(saldo.whenUnblocks && /\d{2}:\d{2}/.test(saldo.whenUnblocks), 'quando libera, em horário pt-BR local (B15)');
  assert.ok(saldo.howToFix, 'o que destrava (howToFix)');
  assert.ok(!verdict.items.some((i) => i.level === 'block'), 'nenhum item bloqueia o avanço da criação');

  // DISPARO (`forDispatch`, só o gate): o anti-spam físico permanece (AD-4) —
  // o mesmo estado, avaliado no disparo, volta a ser 'block'.
  const release = await certificate.evaluate(prisma, campaign, { skipPersist: true, forDispatch: true });
  assert.equal(release.level, 'blocked');
  assert.equal(release.items.find((i) => i.key === 'saldo').level, 'block');
});

test('domínio sem SPF/DKIM é AVISO não-bloqueante, com passo a passo leigo (FR-16/AD-8; pivô 2026-09-27)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    members: [{ prospectId: 'l1', included: true }],
  });
  prisma.studioReputationAccount.rows[0].domainAuthStatus = 'unverified';
  const verdict = await certificate.evaluate(prisma, campaign);
  const domain = verdict.items.find((i) => i.key === 'domain_auth');
  assert.equal(domain.level, 'warning', 'SPF/DKIM não bloqueia mais (orientação, não portão)');
  assert.ok(domain.detail.toLowerCase().includes('spf'), 'explica o que falta');
  assert.ok(domain.detail.includes('Registros DNS'), 'passo a passo leigo (painel do provedor → DNS)');
  assert.ok(domain.detail.includes('peça'), 'oferece ajuda do agente (listar registros)');
  const saldo = verdict.items.find((i) => i.key === 'saldo');
  assert.equal(saldo.level, 'pending', 'saldo efetivo 0 segue visível — como pendência de disparo (o gate decide no envio)');
  assert.equal(verdict.level, 'amber', 'criação segue liberada com pendências');
});

test('consentimento WhatsApp é INFORMATIVO na criação e bloqueia só no disparo (FR5/FR-35/AD-11; task 1.3)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    channels: ['whatsapp'],
    members: [
      { prospectId: 'l1', included: true },
      { prospectId: 'l2', included: true },
    ],
  });
  // Canal WhatsApp conectado (isola o item `canal`) + saldo do canal
  // WhatsApp (v1: 1 conta por canal — PRD §9).
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'whatsapp', balance: 30, floor: 5, ceiling: 30, rampStage: 0, domainAuthStatus: 'unverified' });
  const verdict = await certificate.evaluate(prisma, campaign);
  assert.equal(verdict.level, 'amber', 'consentimento não bloqueia a criação');
  const consent = verdict.items.find((i) => i.key === 'consent_whatsapp');
  assert.equal(consent.level, 'pending');
  assert.ok(consent.detail.includes('2'), 'conta os leads sem consentimento');
  assert.ok(consent.detail.includes('fora do WhatsApp'), 'caminho: ficam fora do canal (canal único)');
  assert.ok(!consent.detail.includes('recebem só e-mail'), 'E12: sem canal e-mail declarado, a copy não promete e-mail');

  // No DISPARO (`forDispatch`) o consentimento segue bloqueando campanha com
  // canal WhatsApp (gate AD-4 — task 1.3 do plano); a matrícula preserva a
  // regra de excluir não consentidos (bridge).
  const dispatch = await certificate.evaluate(prisma, campaign, { skipPersist: true, forDispatch: true });
  assert.equal(dispatch.items.find((i) => i.key === 'consent_whatsapp').level, 'block', 'consentimento bloqueia no disparo');

  // Caminho para consentir: registro persistido resolve o aviso.
  await certificate.grantConsent(prisma, { orgId: 'org-1', prospectId: 'l1', source: 'email_reply', evidence: { messageId: 'm-1' } });
  const one = await certificate.evaluate(prisma, campaign, { skipPersist: true });
  assert.equal(one.items.find((i) => i.key === 'consent_whatsapp').detail.includes('1'), true, 'contagem cai ao consentir');
  await certificate.grantConsent(prisma, { orgId: 'org-1', prospectId: 'l2', source: 'opt_in' });
  const allGreen = await certificate.evaluate(prisma, campaign, { skipPersist: true });
  assert.equal(allGreen.level, 'green');
});

test('consentimento com canal e-mail na campanha: copy diz "recebem só e-mail" (E12)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    channels: ['email', 'whatsapp'],
    members: [{ prospectId: 'l1', included: true }],
  });
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'whatsapp', balance: 30, floor: 5, ceiling: 30, rampStage: 0, domainAuthStatus: 'unverified' });
  const verdict = await certificate.evaluate(prisma, campaign, { skipPersist: true });
  const consent = verdict.items.find((i) => i.key === 'consent_whatsapp');
  assert.ok(consent.detail.includes('recebem só e-mail'), 'E12: com canal e-mail, copy explica que recebem e-mail');
});

test('sem canal de envio conectado: item `canal` pendente com caminho (Story 1.5/UX-DR5)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    channels: ['email', 'whatsapp'],
    members: [{ prospectId: 'l1', included: true }],
  });
  // Nenhuma conta conectada: remove o e-mail da seed.
  prisma.emailAccount.rows.length = 0;
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'whatsapp', balance: 30, floor: 5, ceiling: 30, rampStage: 0, domainAuthStatus: 'unverified' });
  const verdict = await certificate.evaluate(prisma, campaign, { skipPersist: true });
  const canal = verdict.items.find((i) => i.key === 'canal');
  assert.ok(canal, 'item de canal presente');
  assert.equal(canal.level, 'pending', 'criação nunca bloqueia por canal');
  assert.equal(canal.howToFix, 'conectar um canal de envio (e-mail ou WhatsApp)');
  assert.ok(canal.whenUnblocks.includes('conectar'), 'caminho de destravamento por nome');
  const dispatch = await certificate.evaluate(prisma, campaign, { skipPersist: true, forDispatch: true });
  assert.equal(dispatch.items.find((i) => i.key === 'canal').level, 'block', 'no disparo o gate bloqueia (AD-4)');
});

test('consentimento: resposta prévia a e-mail (REPLIED) conta como porta de entrada (FR-35)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    channels: ['whatsapp'],
    members: [{ prospectId: 'l1', included: true }],
  });
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'whatsapp', balance: 30, floor: 5, ceiling: 30, rampStage: 0, domainAuthStatus: 'unverified' });
  prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-1', prospectId: 'l1', status: 'REPLIED' });
  const verdict = await certificate.evaluate(prisma, campaign, { skipPersist: true });
  assert.equal(verdict.level, 'green', 'lead que respondeu e-mail tem consentimento inferível do registro');
});

test('gate re-avalia o selo no release: certificado reprovado bloqueia mesmo aprovado antes (AD-7)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    members: [{ prospectId: 'l1', included: true }],
    approval: { certificate: { level: 'green', items: [], evaluatedAt: '2026-09-01T00:00:00Z' } }, // selo VELHO
  });
  // O domínio PERDEU a verificação depois da aprovação (job diário revalidou).
  prisma.studioReputationAccount.rows[0].domainAuthStatus = 'failed';
  const release = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'email', units: 1, campaign });
  assert.equal(release.allow, false, 'selo vencido/reprovado bloqueia');
  assert.equal(release.code, 'CERTIFICADO_REPROVADO');
});

test('gate NÃO exige selo para campanhas sem certificado (legado 010), mas saldo/pausa vigem', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, { members: [{ prospectId: 'l1', included: true }], approval: {} });
  const release = await reputationGate.evaluate(prisma, { orgId: 'org-1', channel: 'email', units: 1, campaign });
  assert.equal(release.allow, true);
});

test('Teste da Maria é AVISO, não bloqueio: conteúdo longo marca warning (FR-30)', async () => {
  const prisma = createFakePrisma();
  const campaign = seedCampaign(prisma, {
    channels: ['whatsapp'],
    members: [{ prospectId: 'l1', included: true }],
  });
  prisma.studioReputationAccount.rows.push({ id: 'acc-wa', orgId: 'org-1', channel: 'whatsapp', balance: 30, floor: 5, ceiling: 30, rampStage: 0, domainAuthStatus: 'unverified' });
  prisma.studioLeadConsent.rows.push({ id: 'consent-1', orgId: 'org-1', prospectId: 'l1', channel: 'whatsapp', source: 'opt_in' });
  prisma.studioContent.rows[0].whatsappText = 'palavra '.repeat(200);
  const verdict = await certificate.evaluate(prisma, campaign, { skipPersist: true });
  const maria = verdict.items.find((i) => i.key === 'maria_test');
  assert.ok(maria, 'heurística presente');
  assert.equal(maria.level, 'warning');
  assert.equal(verdict.level, 'amber', 'aviso marca pendência, não bloqueio');
});

// ── HTTP: rotas do Certificado e do consentimento ────────────────────────────

async function startServer({ orgPlan = 'premium' } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: orgPlan, studioSendPaused: false });
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

test('POST /leads/:id/consent: registra consentimento auditável; sem confirm → 400', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.prospect.rows.push({ id: 'l1', orgId: 'org-1', companyName: 'Lead 1' });
    const noConfirm = await api('POST', '/leads/l1/consent', { source: 'manual' });
    assert.equal(noConfirm.res.status, 400, 'consentimento manual exige confirmação');

    const { res, body } = await api('POST', '/leads/l1/consent', { source: 'manual', confirm: true, note: 'lead pediu no WhatsApp' });
    assert.equal(res.status, 200);
    assert.equal(body.data.replayed, false);
    const consent = prisma.studioLeadConsent.rows[0];
    assert.equal(consent.channel, 'whatsapp');
    assert.equal(consent.grantedById, 'user-1', 'auditável: quem concedeu');
    assert.equal(consent.evidence.note, 'lead pediu no WhatsApp');

    const replay = await api('POST', '/leads/l1/consent', { source: 'manual', confirm: true });
    assert.equal(replay.body.data.replayed, true, 'idempotente por (org, lead, canal)');
    assert.equal(prisma.studioLeadConsent.rows.length, 1);
  } finally {
    server.close();
  }
});

test('POST /cockpit/wakes/:id/ack: escopo por org (cross-org 404) e listagem filtra ack', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.opsNotification.rows.push(
      { dedupKey: 'w-1', kind: 'wake', orgId: 'org-1', severity: 'critical', title: 'Meu despertar', payload: { type: 'studio.anomaly.detected' }, createdAt: new Date() },
      { dedupKey: 'w-2', kind: 'wake', orgId: 'org-2', severity: 'warning', title: 'De outra org', payload: { type: 'studio.anomaly.detected' }, createdAt: new Date() }
    );
    // Despertar de OUTRA org: 404, jamais tocado (isolamento constituição IV).
    const cross = await api('POST', '/cockpit/wakes/w-2/ack', {});
    assert.equal(cross.res.status, 404);
    assert.equal(prisma.opsNotification.rows.find((r) => r.dedupKey === 'w-2').payload.acknowledgedAt, undefined);

    const own = await api('POST', '/cockpit/wakes/w-1/ack', {});
    assert.equal(own.res.status, 200);
    assert.ok(prisma.opsNotification.rows.find((r) => r.dedupKey === 'w-1').payload.acknowledgedAt);

    // Listagem só traz pendentes — o reconhecido sai.
    const wakes = await api('GET', '/cockpit/wakes');
    assert.equal(wakes.res.status, 200);
    assert.deepEqual(wakes.body.data, []);
  } finally {
    server.close();
  }
});

test('GETs do Cockpit exigem plano premium (constituição IV)', async () => {
  const { server, api } = await startServer({ orgPlan: 'trial' });
  try {
    const home = await api('GET', '/cockpit/home');
    assert.equal(home.res.status, 403);
    assert.equal(home.body.error, 'PREMIUM_REQUIRED');
    const rep = await api('GET', '/reputation');
    assert.equal(rep.res.status, 403);
  } finally {
    server.close();
  }
});

test('POST /reputation/pause: pausa 1-clique persistida e retomada explícita (FR-19)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const pause = await api('POST', '/reputation/pause', { paused: true, reason: 'fim de semana' });
    assert.equal(pause.res.status, 200);
    assert.equal(prisma.organization.rows[0].studioSendPaused, true);
    assert.equal(prisma.organization.rows[0].studioPausedById, 'user-1');

    const state = await api('GET', '/reputation');
    assert.equal(state.body.data.paused, true);

    const resume = await api('POST', '/reputation/pause', { paused: false });
    assert.equal(resume.res.status, 200);
    assert.equal(prisma.organization.rows[0].studioSendPaused, false);
  } finally {
    server.close();
  }
});

test('GET /reputation: painel com saldo por canal e eventos explicados (FR-20)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'email', balance: 90, floor: 10, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
    prisma.studioReputationEvent.rows.push({ id: 'ev-1', orgId: 'org-1', channel: 'email', type: 'debit', amount: 10, balanceAfter: 90, refType: 'batch', refId: 'batch-1', reason: 'lote da campanha X' });
    const { res, body } = await api('GET', '/reputation');
    assert.equal(res.status, 200);
    assert.equal(body.data.balances[0].available, 80, 'disponível = saldo − floor');
    assert.equal(body.data.events.length, 1);
    assert.ok(body.data.events[0].reason, 'variação atribuível a evento explicado');
  } finally {
    server.close();
  }
});
