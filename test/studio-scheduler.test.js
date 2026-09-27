'use strict';

/**
 * test/studio-scheduler.test.js — US3 do Campaign Studio (specs/010, T032).
 *
 * Agendamento com janelas de envio, ritmo por hora/dia, previsão de
 * conclusão, controle de fila e follow-ups configuráveis (FR-016–FR-022,
 * FR-079). O scheduler é testado com `tickCampaign` e enqueue capturado —
 * sem BullMQ/Redis na suíte.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const scheduleService = require('../studio/schedule-service');
const { tickCampaign } = require('../studio/scheduler-worker');

const WINDOW_WEEKDAYS_9_12 = {
  mode: 'scheduled',
  startAt: null,
  windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 12 }],
  hourlyLimit: 5,
  dailyLimit: 20,
  timezone: 'America/Sao_Paulo',
  useLeadTimezone: false,
};

// Quarta-feira 2026-09-23: 13:00Z = 10h em São Paulo (dentro da janela 9–12).
const IN_WINDOW = new Date('2026-09-23T13:00:00Z');
// 16:00Z = 13h em SP (fora da janela).
const OUT_WINDOW = new Date('2026-09-23T16:00:00Z');
// Sábado 2026-09-26 13:00Z = 10h SP (fim de semana → fora).
const WEEKEND = new Date('2026-09-26T13:00:00Z');

function queuedContact(id, prospectId) {
  return { id, campaignId: 'exec-1', prospectId, status: 'QUEUED', scheduledAt: null, sentAt: null };
}

function campaignFixture(overrides = {}) {
  return {
    id: 'camp-1',
    orgId: 'org-1',
    name: 'Campanha',
    status: 'scheduled',
    channels: ['email'],
    schedule: { ...WINDOW_WEEKDAYS_9_12 },
    emailExecutionId: 'exec-1',
    whatsappExecutionId: null,
    approval: {},
    ...overrides,
  };
}

// ── Funções puras de janela/previsão ────────────────────────────────────────

test('janela: envia só dentro de dias/hora configurados, no fuso da org', () => {
  assert.equal(scheduleService.inWindow(WINDOW_WEEKDAYS_9_12, IN_WINDOW), true);
  assert.equal(scheduleService.inWindow(WINDOW_WEEKDAYS_9_12, OUT_WINDOW), false, '13h fora de 9–12');
  assert.equal(scheduleService.inWindow(WINDOW_WEEKDAYS_9_12, WEEKEND), false, 'sábado fora');
});

test('janela: fuso do lead (quando habilitado) pode manter o envio dentro da janela (FR-022)', () => {
  // 15:30Z = 12h30 em SP (fora) mas 11h30 em Manaus (dentro de 9–12).
  const at = new Date('2026-09-23T15:30:00Z');
  const leadTz = 'America/Manaus';
  assert.equal(
    scheduleService.inWindow({ ...WINDOW_WEEKDAYS_9_12, useLeadTimezone: true }, at, leadTz),
    true,
    'com fuso do lead, 11h30 local está na janela'
  );
  assert.equal(
    scheduleService.inWindow({ ...WINDOW_WEEKDAYS_9_12, useLeadTimezone: false }, at, leadTz),
    false,
    'sem fuso do lead, rege o fuso da org'
  );
});

test('previsão de conclusão (FR-020): respeita janelas e ritmo', () => {
  // 7 leads a 5/h, janela 9–12 qua: 5 na 1ª hora, 2 na 2ª — termina na
  // MESMA janela de quarta (antes da janela de quinta começar).
  const forecast = scheduleService.forecast(WINDOW_WEEKDAYS_9_12, 7, IN_WINDOW);
  assert.ok(forecast.estimatedAt > IN_WINDOW);
  const nextWindowStart = new Date('2026-09-24T12:00:00Z'); // qui 9h SP
  assert.ok(
    forecast.estimatedAt < nextWindowStart,
    `esperado dentro da janela de qua, obtido ${forecast.estimatedAt.toISOString()}`
  );
  // 25 leads: estoura qua (cap 15) e precisa de qua da semana seguinte…
  const big = scheduleService.forecast(WINDOW_WEEKDAYS_9_12, 25, IN_WINDOW);
  assert.ok(big.estimatedAt > nextWindowStart, 'estourando a janela, conclui só na próxima');
});

test('conflito entre campanhas: política decide enviar, adiar ou bloquear (edge case)', () => {
  assert.equal(scheduleService.decideConflict({ campaignConflict: 'block' }, true), 'block');
  assert.equal(scheduleService.decideConflict({ campaignConflict: 'postpone' }, true), 'postpone');
  assert.equal(scheduleService.decideConflict({}, true), 'postpone', 'default conservador');
  assert.equal(scheduleService.decideConflict({ campaignConflict: 'postpone' }, false), 'send');
});

test('follow-ups configuráveis (FR-079): sequência do Studio tem precedência; vazia = legado', () => {
  const sequence = [
    { stepIndex: 2, delayDays: 2 },
    { stepIndex: 3, delayDays: 4 },
  ];
  assert.deepEqual(scheduleService.nextFollowup(sequence, 1), { stepIndex: 2, delayDays: 2 });
  assert.deepEqual(scheduleService.nextFollowup(sequence, 2), { stepIndex: 3, delayDays: 4 });
  assert.equal(scheduleService.nextFollowup(sequence, 3), null, 'sequência acabou');
  assert.deepEqual(scheduleService.nextFollowup([], 1), { stepIndex: 2, delayDays: 3 }, 'legado D+3');
});

// ── tickCampaign: liberação por janela e ritmo ──────────────────────────────

test('tick: fora da janela não libera nenhum lead (pausa fora da janela)', async () => {
  const prisma = createFakePrisma();
  prisma.studioCampaign.rows.push(campaignFixture({ status: 'running' }));
  prisma.outreachContact.rows.push(queuedContact('oc-1', 'lead-1'));
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: OUT_WINDOW,
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.released, 0);
  assert.equal(result.skipped, 'outside_window');
  assert.equal(enqueued.length, 0);
});

test('tick: dentro da janela libera até o limite por hora; demais ficam para o próximo tick', async () => {
  const prisma = createFakePrisma();
  // specs/011: o gate exige canal configurado e domínio verificado (FR-16).
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'email', balance: 100, floor: 10, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
  const schedule = { ...WINDOW_WEEKDAYS_9_12, hourlyLimit: 2 };
  prisma.studioCampaign.rows.push(campaignFixture({ status: 'running', schedule }));
  for (let i = 1; i <= 3; i++) prisma.outreachContact.rows.push(queuedContact(`oc-${i}`, `lead-${i}`));
  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.released, 2, 'libera só o limite horário');
  assert.equal(enqueued[0].ids.length, 2);
  // Lead restante continua na fila com scheduledAt null (próximo tick).
  const pending = prisma.outreachContact.rows.filter((c) => c.scheduledAt === null);
  assert.equal(pending.length, 1);
});

test('tick: agendamento futuro não começa antes do startAt', async () => {
  const prisma = createFakePrisma();
  const schedule = {
    ...WINDOW_WEEKDAYS_9_12,
    startAt: '2026-10-01T12:00:00.000Z',
  };
  prisma.studioCampaign.rows.push(campaignFixture({ schedule }));
  prisma.outreachContact.rows.push(queuedContact('oc-1', 'lead-1'));
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async () => {},
  });
  assert.equal(result.skipped, 'not_started');
});

// ── HTTP: agendar com previsão e controle de fila ────────────────────────────

async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use(
    '/api/studio',
    createStudioRouter(prisma, {
      overrides: { dispatchImmediate: async () => ({ email: { jobsQueued: 0 } }) },
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
  return { server, prisma, api };
}

test('schedule aceita janelas/ritmo e devolve previsão de conclusão (FR-016/017/020)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.studioCampaign.rows.push(campaignFixture({ status: 'approved' }));
    prisma.studioAudienceSnapshot.rows.push({
      id: 'snap-1', orgId: 'org-1', campaignId: 'camp-1', criteriaVersion: {},
      totalCount: 7, includedCount: 7, excludedCount: 0, status: 'active', createdAt: new Date(),
    });
    const { res, body } = await api('POST', '/campaigns/camp-1/schedule', {
      mode: 'scheduled',
      windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 12 }],
      hourlyLimit: 5,
      dailyLimit: 20,
      timezone: 'America/Sao_Paulo',
    });
    assert.equal(res.status, 200);
    assert.equal(body.data.status, 'scheduled');
    assert.ok(body.forecast, 'resposta inclui previsão de conclusão');
    assert.ok(body.forecast.estimatedAt);
  } finally {
    server.close();
  }
});

test('cancelamento preserva enviados e descarta a fila com confirmação (FR-021)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    prisma.studioCampaign.rows.push(campaignFixture({ status: 'running' }));
    prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-1', prospectId: 'lead-1', status: 'SENT', sentAt: new Date(), scheduledAt: new Date() });
    prisma.outreachContact.rows.push(queuedContact('oc-2', 'lead-2'));

    const noConfirm = await api('POST', '/campaigns/camp-1/control', { action: 'cancel' });
    assert.equal(noConfirm.res.status, 400, 'cancelar sem confirm: true → 400');

    const { res, body } = await api('POST', '/campaigns/camp-1/control', { action: 'cancel', confirm: true });
    assert.equal(res.status, 200);
    assert.equal(body.data.status, 'cancelled');
    assert.equal(prisma.outreachContact.rows.find((c) => c.id === 'oc-1').status, 'SENT', 'enviado mantém status real');
    assert.equal(prisma.outreachContact.rows.find((c) => c.id === 'oc-2').status, 'CANCELLED');
    assert.equal(prisma.outreachContact.rows.find((c) => c.id === 'oc-2').cancelReason, 'cancelled');
  } finally {
    server.close();
  }
});

test('fila reporta motivo de retenção quando fora da janela (US3)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    // 16:00Z = fora da janela 9–12 SP; congelar "agora" para o endpoint.
    prisma.studioCampaign.rows.push(campaignFixture({ status: 'running' }));
    prisma.outreachContact.rows.push(queuedContact('oc-1', 'lead-1'));
    const { body } = await api('GET', '/campaigns/camp-1/queue', undefined);
    assert.equal(body.data[0].retainedReason, 'outside_window');
  } finally {
    server.close();
  }
});
