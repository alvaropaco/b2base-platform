'use strict';

/**
 * Epic 3 (Story 3.1) — estado explícito da jornada de criação (suíte L0 da
 * eval-matrix). Comportamento, não texto: fase derivada do estado
 * materializado, decisão fechada (FR2) marca audiência como concluída e o
 * guard recusa atalho de fase À FRENTE com explicação — ação de fase
 * corrente/anterior nunca bloqueia (onda "criação sem bloqueios").
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const journey = require('../studio/journey');
const { createFakePrisma } = require('./helpers/fake-prisma');

// ── Unidade: derivação da fase (espelho server-side do Rail do cliente) ──

test('derivePhase: campanha nova começa no objetivo', () => {
  assert.equal(journey.derivePhase({ objective: null, audienceDecided: false, hasContent: false, hasSchedule: false }), 'objetivo');
});

test('derivePhase: jornada canônica objetivo→audiência→conteúdo→agenda→certificado', () => {
  const base = { objective: 'vender ERP', audienceDecided: false, hasContent: false, hasSchedule: false };
  assert.equal(journey.derivePhase(base), 'audiencia');
  assert.equal(journey.derivePhase({ ...base, audienceDecided: true }), 'conteudo');
  assert.equal(journey.derivePhase({ ...base, audienceDecided: true, hasContent: true }), 'agenda');
  assert.equal(journey.derivePhase({ ...base, audienceDecided: true, hasContent: true, hasSchedule: true }), 'certificado');
});

test('derivePhase: schedule `{}` default não é agenda configurada', () => {
  assert.equal(journey.hasScheduleSet({}), false);
  assert.equal(journey.hasScheduleSet({ hourlyLimit: 20 }), true);
  assert.equal(journey.hasScheduleSet(null), false);
});

// ── Unidade: guard de atalho (Story 3.1) ──

test('guardAction: agendar sem conteúdo é bloqueado com o que falta', () => {
  const guard = journey.guardAction('set_schedule', { hasContent: false });
  assert.equal(guard.ok, false);
  assert.equal(guard.card.type, 'journey_block');
  assert.deepEqual(guard.card.missing, ['conteudo']);
  assert.ok(guard.card.detail.includes('mensagem'), 'explica o que falta em linguagem de vendedor');
});

test('guardAction: com conteúdo, agendar passa; ações de revisão nunca bloqueiam', () => {
  assert.equal(journey.guardAction('set_schedule', { hasContent: true }).ok, true);
  for (const type of ['set_objective', 'set_audience', 'attach_url', 'generate_content', 'edit_content', 'show_balance', 'capture_leads']) {
    assert.equal(journey.guardAction(type, { hasContent: false }).ok, true, `${type} é revisão/guia, não atalho`);
  }
});

// ── Persistência: syncJourney (fase explícita + decisão fechada FR2) ──

function campaignRow(over = {}) {
  return { id: 'camp-1', orgId: 'org-1', objective: null, schedule: {}, journey: null, ...over };
}

test('syncJourney: decisão fechada (audiência > 0) marca a fase como concluída', async () => {
  const prisma = createFakePrisma();
  const campaign = campaignRow({ objective: 'vender ERP' });
  prisma.studioCampaign.rows.push(campaign);
  const result = await journey.syncJourney(prisma, campaign, { mark: 'audiencia', audienceDecided: true });
  assert.equal(result.phase, 'conteudo');
  assert.ok(result.completed.audiencia, 'audiência concluída pela decisão fechada');
  const stored = prisma.studioCampaign.rows.find((r) => r.id === 'camp-1');
  assert.equal(stored.journey.phase, 'conteudo');
  assert.ok(stored.journey.completed.audiencia);
});

test('syncJourney: 0-match NÃO conclui a fase de audiência', async () => {
  const prisma = createFakePrisma();
  const campaign = campaignRow({ objective: 'vender ERP' });
  prisma.studioCampaign.rows.push(campaign);
  const result = await journey.syncJourney(prisma, campaign, { mark: null, audienceDecided: false });
  assert.equal(result.phase, 'audiencia');
  assert.ok(!result.completed.audiencia);
});

test('syncJourney: conteúdo existente (criado fora do chat) também conclui a fase', async () => {
  const prisma = createFakePrisma();
  prisma.studioContent.rows.push({ id: 'c1', campaignId: 'camp-1', channel: 'email' });
  const campaign = campaignRow({ objective: 'vender ERP' });
  prisma.studioCampaign.rows.push(campaign);
  await journey.syncJourney(prisma, campaign, { mark: 'audiencia', audienceDecided: true });
  assert.ok(campaign.journey.completed.conteudo, 'conteúdo na base marca a fase mesmo sem mark');
});

test('syncJourney: status scheduled marca agenda + certificado (marks múltiplos)', async () => {
  const prisma = createFakePrisma();
  const campaign = campaignRow({ objective: 'vender ERP' });
  prisma.studioCampaign.rows.push(campaign);
  await journey.syncJourney(prisma, campaign, { mark: 'audiencia', audienceDecided: true });
  await journey.syncJourney(prisma, campaign, { mark: ['agenda', 'certificado'] });
  assert.ok(campaign.journey.completed.agenda);
  assert.ok(campaign.journey.completed.certificado);
});

test('syncJourney: é idempotente — reexecutar não duplica nem volta fase', async () => {
  const prisma = createFakePrisma();
  const campaign = campaignRow({ objective: 'vender ERP' });
  prisma.studioCampaign.rows.push(campaign);
  await journey.syncJourney(prisma, campaign, { mark: 'audiencia', audienceDecided: true });
  const before = campaign.journey.completed.audiencia;
  await journey.syncJourney(prisma, campaign, { mark: 'audiencia', audienceDecided: true });
  assert.equal(campaign.journey.completed.audiencia, before);
});

test('syncJourney: falha de persistência NÃO derruba a action (efeito já aconteceu)', async () => {
  const prisma = createFakePrisma();
  prisma.studioContent.count = async () => {
    throw new Error('db em chamas');
  };
  const campaign = campaignRow({ objective: 'vender ERP' });
  const result = await journey.syncJourney(prisma, campaign, { mark: 'audiencia', audienceDecided: true });
  assert.ok(result.completed.audiencia, 'conclusão computada mesmo sem persistir');
  assert.equal(result.stale, true);
});

test('previewFromExtras: audiência só conta como decidida pela DECISÃO FECHADA (mesma regra do sync)', async () => {
  const campaign = campaignRow({ objective: 'vender ERP' });
  const preview = journey.previewFromExtras(campaign, { audienceCount: 42, contentSummary: [] });
  assert.equal(preview.fase, 'audiencia', 'contagem bruta não é decisão fechada');
  const closed = campaignRow({ objective: 'vender ERP', journey: { completed: { audiencia: '2026-10-01T10:00:00Z' } } });
  assert.equal(journey.previewFromExtras(closed, {}).fase, 'conteudo');
});

// ── Integração: guard na rota do chat e nos chips (runAction) ──

function llm() {
  return async ({ user }) => {
    if (user.includes('NOVA MENSAGEM DO USUÁRIO')) {
      // A mensagem ATUAL vem por último no prompt: os marcadores de turnos
      // anteriores ficam no histórico — teste o turno atual PRIMEIRO.
      if (user.includes('agenda sem conteúdo')) {
        return {
          content: JSON.stringify({
            reply: 'Vou agendar então.',
            actions: [{
              type: 'set_schedule', mode: 'scheduled',
              windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }],
              hourlyLimit: 20, dailyLimit: 100,
            }],
          }),
        };
      }
      if (user.includes('meu objetivo é vender consultoria')) {
        return {
          content: JSON.stringify({
            reply: 'Objetivo anotado.',
            actions: [{ type: 'set_objective', objective: 'vender consultoria industrial' }],
          }),
        };
      }
      if (user.includes('agora pode agendar')) {
        return {
          content: JSON.stringify({
            reply: 'Agenda configurada.',
            actions: [{
              type: 'set_schedule', mode: 'scheduled',
              windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }],
              hourlyLimit: 20, dailyLimit: 100,
            }],
          }),
        };
      }
      if (user.includes('gera o conteúdo')) {
        return {
          content: JSON.stringify({
            reply: 'Conteúdo gerado — em revisão.',
            actions: [{ type: 'generate_content', tones: ['formal'] }],
          }),
        };
      }
    }
    if (user.includes('critérios de segmento')) {
      return {
        content: JSON.stringify({
          criteria: { version: 1, groups: [{ op: 'AND', conditions: [{ field: 'industry', op: 'contains', value: 'indústria' }] }] },
          rationale: 'indústrias',
        }),
      };
    }
    if (user.includes('pacote de campanha')) {
      return {
        content: JSON.stringify({
          title: 'Consultoria',
          email: { subject: 'Oi {{firstName}}', preheader: 'p', blocks: [{ type: 'text', text: 'Olá {{firstName}}.' }] },
          whatsapp: { text: 'Oi {{firstName}}' },
          linkedinText: 'texto',
          timing: 'terça 10h',
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Me conta mais?', actions: [{ type: 'none' }] }) };
  };
}

async function startServer({ llmImpl } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  prisma.commercialSettings.rows.push({ orgId: 'org-1', productDescription: 'consultoria industrial' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', require('../studio/router').createStudioRouter(prisma, {
    overrides: { aiDeps: { callLlm: llmImpl || llm(), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html><body>consultoria</body></html>' }) } },
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

test('integração: atalho "agendar sem conteúdo" é recusado com explicação, sem gravar run', async () => {
  const { server, prisma, api } = await startServer();
  const { body } = await api('POST', '/campaigns', { name: 'Atalho', channels: ['email'] });
  const id = body.data.id;
  const { body: turn } = await api('POST', `/campaigns/${id}/chat`, { message: 'agenda sem conteúdo' });
  assert.ok(turn.success);
  const card = turn.data.cards.find((c) => c.type === 'journey_block');
  assert.ok(card, 'recusa explicável no lugar da action');
  assert.ok(card.detail.includes('mensagem'));
  // Bloqueio NÃO grava StudioActionRun (replay de bloqueio esconderia o avanço).
  assert.equal(prisma.studioActionRun.rows.filter((r) => r.action === 'set_schedule').length, 0);
  // E o agendamento não foi configurado.
  assert.equal((prisma.studioCampaign.rows.find((r) => r.id === id).schedule || {}).hourlyLimit, undefined);
  server.close();
});

test('integração: jornada em ordem persiste a fase e o mesmo agendamento passa', async () => {
  const { server, prisma, api } = await startServer();
  const { body } = await api('POST', '/campaigns', { name: 'Jornada', channels: ['email'] });
  const id = body.data.id;

  // Conteúdo primeiro (fase de conteúdo).
  await api('POST', `/campaigns/${id}/chat`, { message: 'gera o conteúdo' });
  assert.ok(prisma.studioContent.rows.some((c) => c.campaignId === id), 'conteúdo criado');

  // Agendar DEPOIS do conteúdo passa.
  const { body: turn } = await api('POST', `/campaigns/${id}/chat`, { message: 'agora pode agendar' });
  assert.ok(!turn.data.cards.some((c) => c.type === 'journey_block'), 'sem bloqueio com conteúdo existente');
  assert.equal((prisma.studioCampaign.rows.find((r) => r.id === id).schedule || {}).hourlyLimit, 20);

  // Jornada persistida: sem objetivo/audiência neste fluxo, a fase derivada
  // é 'objetivo' — mas as conclusões explícitas (conteúdo, agenda) ficam
  // marcadas: o Json registra o que já foi feito, a fase mostra onde está.
  const stored = prisma.studioCampaign.rows.find((r) => r.id === id);
  assert.equal(stored.journey.phase, 'objetivo');
  assert.ok(stored.journey.completed.conteudo);
  assert.ok(stored.journey.completed.agenda);
  assert.ok(!stored.journey.completed.audiencia);
  server.close();
});

test('integração: objetivo definido conclui a primeira fase da jornada (persistida)', async () => {
  const { server, prisma, api } = await startServer();
  const { body } = await api('POST', '/campaigns', { name: 'Com Objetivo', channels: ['email'] });
  const id = body.data.id;
  await api('POST', `/campaigns/${id}/chat`, { message: 'meu objetivo é vender consultoria para indústrias' });
  const stored = prisma.studioCampaign.rows.find((r) => r.id === id);
  assert.equal(stored.journey.phase, 'audiencia');
  assert.ok(stored.journey.completed.objetivo, 'fase objetivo concluída e persistida desde o 1º passo');
  server.close();
});

test('integração: chip de voo sem conteúdo recebe a mesma recusa explicável', async () => {
  const { server, api } = await startServer();
  const { body } = await api('POST', '/campaigns', { name: 'Chip', channels: ['email'] });
  const id = body.data.id;
  const { res, body: chip } = await api('POST', `/campaigns/${id}/actions`, {
    type: 'set_schedule',
    params: { mode: 'immediate', hourlyLimit: 20, dailyLimit: 100 },
  });
  assert.equal(res.status, 200);
  assert.equal(chip.data.card.type, 'journey_block');
  server.close();
});

test('integração: bloqueio não persiste jornada — nada mudou no estado', async () => {
  const { server, prisma, api } = await startServer();
  const { body } = await api('POST', '/campaigns', { name: 'Estado', channels: ['email'] });
  const id = body.data.id;
  await api('POST', `/campaigns/${id}/chat`, { message: 'agenda sem conteúdo' });
  const stored = prisma.studioCampaign.rows.find((r) => r.id === id);
  assert.equal(stored.journey ?? null, null, 'guard recusou sem mutar a campanha');
  server.close();
});
