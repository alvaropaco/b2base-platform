'use strict';

/**
 * test/studio-actions.test.js — actions semânticas v1 idempotentes (specs/011,
 * AD-6; FR-9). Mesmo actionId 2× em set_audience devolve o MESMO resultado
 * sem criar segmento novo; contrato versionado (manifest.v1).
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const manifest = require('../studio/actions/manifest.v1');

// LLM mockado: orquestrador (chat) e segmento-NL respondem JSON estável.
function llm() {
  return async ({ user }) => {
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
          title: 'ERP',
          email: { subject: 'ERP para {{companyName}}', preheader: 'p', blocks: [{ type: 'text', text: 'Olá {{firstName}} — descadastro aqui.' }] },
          whatsapp: { text: 'Oi {{firstName}}, ERP?' },
          linkedinText: 'texto',
          timing: 'terça 10h',
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Entendi.', actions: [{ type: 'none' }] }) };
  };
}

async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  prisma.commercialSettings.rows.push({ orgId: 'org-1', productDescription: 'software B2B' });
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma, {
    overrides: { aiDeps: { callLlm: llm(), fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>produto</html>' }) } },
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

// ── actionKey: chave estável (AD-6) ──────────────────────────────────────────

test('actionKey: escopada em org+campanha; actionId do cliente vence; hash determinístico', () => {
  const byClient = manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'set_audience', params: { description: 'indústrias' }, actionId: 'tap-1' });
  assert.equal(byClient, 'v1:set_audience:org-1:c1:tap-1', 'duplo toque = mesma chave (escopada)');

  // Mesmo actionId em OUTRA org/campanha NUNCA colide (leak entre tenants).
  assert.notEqual(
    byClient,
    manifest.actionKey({ orgId: 'org-2', campaignId: 'c1', action: 'set_audience', params: {}, actionId: 'tap-1' }),
    'org diferente → chave diferente'
  );
  assert.notEqual(
    byClient,
    manifest.actionKey({ orgId: 'org-1', campaignId: 'c2', action: 'set_audience', params: {}, actionId: 'tap-1' }),
    'campanha diferente → chave diferente'
  );

  const a = manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'generate_content', params: { tones: ['formal', 'comercial'] } });
  const b = manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'generate_content', params: { tones: ['comercial', 'formal'] } });
  assert.notEqual(a, null);
  assert.notEqual(a, b, 'ordem do array faz parte do pedido');

  const x = manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'set_schedule', params: { a: 1, b: { y: 2, x: 3 } } });
  const y = manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'set_schedule', params: { b: { x: 3, y: 2 }, a: 1 } });
  assert.equal(x, null, 'set_schedule é idempotency none — NÃO repete nem por params');
  assert.equal(manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'set_schedule', params: {}, actionId: 'tap-x' }), null, 'idempotência none ignora actionId');
  assert.equal(manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'set_objective', params: {} }), null, 'idempotência none não gera chave');
});

test('manifest v1: contrato fechado com as 35 actions do orquestrador', () => {
  // Evolução ADITIVA (AD-6): show_balance/start_whatsapp_pairing (2026-09-27);
  // attach_files/edit_content (2026-09-29); capture_leads (Epic 2, 2026-09-30);
  // show_content (QA 2026-10-02) e a onda "IA com a plataforma inteira"
  // (QA 2026-10-02, bugs 1/2/6 do dono): list/create/rename/duplicate/delete/
  // approve_campaign, update_lead, show_replies, show_dns_records,
  // show_capabilities; launch_campaign (QA 2026-10-06, disparo sem fricção);
  // send_test_message (QA 2026-10-06, teste antes do disparo); grant_whatsapp_consent (QA 2026-10-06, caminho FR-35); grant_whatsapp_consent_batch (QA 2026-10-07, lote); select_content_variant (QA 2026-10-07, escolha de variante);
  // create_lead (2026-10-08, o dono manda os dados e a IA cadastra — a IA
  // dizia "não consigo pelo chat"); enrich_whatsapp (2026-10-08, pedido do dono: acha WhatsApp na internet e
  // cadastra nos leads); show/add/remove_suppression + disconnect_email (2026-10-08, paridade com o
  // painel Outreach) — sem alterar forma, idempotência ou chaves das
  // anteriores; consumidores existentes não quebram.
  assert.deepEqual(Object.keys(manifest.ACTIONS_V1).sort(), [
    'add_suppression', 'approve_campaign', 'attach_files', 'attach_url', 'cancel_campaign', 'capture_leads', 'confirm_material',
    'connect_email', 'create_campaign', 'create_lead', 'delete_campaign', 'disconnect_email', 'duplicate_campaign', 'edit_content',
    'enrich_whatsapp', 'generate_content', 'grant_whatsapp_consent', 'grant_whatsapp_consent_batch', 'launch_campaign', 'list_campaigns', 'remove_suppression', 'rename_campaign', 'select_content_variant', 'select_leads', 'send_test_message', 'set_audience',
    'set_objective', 'set_schedule', 'show_balance', 'show_capabilities', 'show_content',
    'show_dns_records', 'show_replies', 'show_suppression', 'start_whatsapp_pairing', 'update_lead',
  ]);
  assert.equal(manifest.ACTIONS_V1.add_suppression.idempotency, 'params', 'opt-out é idempotente por params');
  for (const t of ['show_suppression', 'remove_suppression', 'disconnect_email']) {
    assert.equal(manifest.ACTIONS_V1[t].idempotency, 'none', `${t}: repetir é um pedido NOVO`);
  }
  for (const spec of Object.values(manifest.ACTIONS_V1)) {
    assert.equal(spec.version, 1);
    assert.ok(['none', 'params', 'client'].includes(spec.idempotency));
  }
});

// ── POST /campaigns/:id/actions — Chip-ação idempotente (FR-9) ──────────────

test('mesmo actionId 2× em set_audience: resposta idêntica e NENHUM segmento novo', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Chips', channels: ['email'] });
    const campaignId = c.data.id;
    prisma.prospect.rows.push(
      { id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'indústria', opportunityScore: 90, status: 'qualified', state: 'SP' },
      { id: 'l2', orgId: 'org-1', companyName: 'B', industry: 'indústria', opportunityScore: 80, status: 'qualified', state: 'RJ' }
    );

    const first = await api('POST', `/campaigns/${campaignId}/actions`, {
      type: 'set_audience',
      actionId: 'tap-audience-1',
      params: { description: 'indústrias com score alto' },
    });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.data.card.type, 'audience');
    assert.equal(first.body.data.card.replayed, undefined, '1ª execução não é replay');
    const segmentsAfterFirst = prisma.studioSegment.rows.length;

    const second = await api('POST', `/campaigns/${campaignId}/actions`, {
      type: 'set_audience',
      actionId: 'tap-audience-1',
      params: { description: 'qualquer coisa — o actionId manda' },
    });
    assert.equal(second.res.status, 200);
    assert.equal(second.body.data.card.replayed, true, '2ª execução é replay');
    assert.deepEqual(second.body.data.card, { ...first.body.data.card, replayed: true }, 'resposta idêntica à 1ª');
    assert.equal(prisma.studioSegment.rows.length, segmentsAfterFirst, 'nenhum segmento novo criado');
    assert.equal(prisma.studioActionRun.rows.length, 1, 'uma run registrada (unique actionKey)');
    // Replay não duplica o thread (FR-4): 1 turno = user + assistant.
    const history = (await api('GET', `/campaigns/${campaignId}/chat`)).body.data;
    assert.equal(history.length, 2, 'turno único no histórico');
  } finally {
    server.close();
  }
});

test('runIdempotent: replay não executa o handler; run gravada running → succeeded', async () => {
  const prisma = createFakePrisma();
  let executions = 0;
  const params = { tones: ['formal'] };
  const run = async () => {
    executions += 1;
    return { type: 'content', label: 'Conteúdo gerado', detail: `execução ${executions}` };
  };
  const first = await manifest.runIdempotent(prisma, { orgId: 'org-1', campaignId: 'c1', action: 'generate_content', params, run });
  const second = await manifest.runIdempotent(prisma, { orgId: 'org-1', campaignId: 'c1', action: 'generate_content', params, run });
  assert.equal(first.replayed, false);
  assert.equal(executions, 1, 'handler roda 1x só');
  assert.equal(second.replayed, true);
  assert.equal(second.result.detail, 'execução 1', 'resultado da 1ª execução');
  const runRow = prisma.studioActionRun.rows[0];
  assert.equal(runRow.status, 'succeeded', 'run aberta como running e fechada succeeded');
  assert.equal(runRow.actionKey.includes('org-1'), true, 'chave escopada na org');
});

test('runIdempotent: run failed → a mesma chave RE-EXECUTA (nunca replay com resultado vazio)', async () => {
  const prisma = createFakePrisma();
  let calls = 0;
  const run = async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom de IA');
    return { type: 'audience', label: 'Audiência montada' };
  };
  const input = { orgId: 'org-1', campaignId: 'c1', action: 'set_audience', params: { description: 'indústrias' }, run };
  await assert.rejects(manifest.runIdempotent(prisma, input), /boom/);
  assert.equal(prisma.studioActionRun.rows[0].status, 'failed', 'falha registrada');
  const second = await manifest.runIdempotent(prisma, input);
  assert.equal(second.replayed, false, 're-executa após falha');
  assert.equal(calls, 2);
  assert.equal(second.result.label, 'Audiência montada');
  assert.equal(prisma.studioActionRun.rows.length, 1, 'mesma run reaberta (unique actionKey)');
  assert.equal(prisma.studioActionRun.rows[0].status, 'succeeded');
});

test('runIdempotent: P2002 de corrida com resultado vazio/running NÃO é replay', async () => {
  const prisma = createFakePrisma();
  // Run 'running' órfã (crash no meio): a chamada seguinte re-executa.
  prisma.studioActionRun.rows.push({
    id: 'run-1', orgId: 'org-1', campaignId: 'c1', action: 'set_audience',
    actionKey: manifest.actionKey({ orgId: 'org-1', campaignId: 'c1', action: 'set_audience', params: { description: 'x' } }),
    status: 'running', result: {},
  });
  let executed = false;
  const { result, replayed } = await manifest.runIdempotent(prisma, {
    orgId: 'org-1', campaignId: 'c1', action: 'set_audience', params: { description: 'x' },
    run: async () => { executed = true; return { type: 'audience', label: 'ok' }; },
  });
  assert.equal(executed, true, 'running órfã re-executa');
  assert.equal(replayed, false);
  assert.equal(result.label, 'ok');
});

test('attach_url com a mesma URL: replay devolve o mesmo material (sem duplicar extração)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'URL', channels: ['email'] });
    const path = `/campaigns/${c.data.id}/actions`;
    const payload = { type: 'attach_url', actionId: 'tap-url-1', params: { url: 'https://exemplo.com/produto' } };
    const first = await api('POST', path, payload);
    const second = await api('POST', path, payload);
    assert.equal(first.res.status, 200);
    assert.equal(second.res.status, 200);
    assert.equal(prisma.studioMaterial.rows.length, 1, 'material único');
    assert.equal(second.body.data.card.materialId, first.body.data.card.materialId);
  } finally {
    server.close();
  }
});

test('mesmo actionId em campanhas DIFERENTES: ambas executam (chave escopada por campanha)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c1 } = await api('POST', '/campaigns', { name: 'C1', channels: ['email'] });
    const { body: c2 } = await api('POST', '/campaigns', { name: 'C2', channels: ['email'] });
    prisma.prospect.rows.push({ id: 'l1', orgId: 'org-1', companyName: 'A', industry: 'indústria', opportunityScore: 90, status: 'qualified', state: 'SP' });

    const first = await api('POST', `/campaigns/${c1.data.id}/actions`, { type: 'set_audience', actionId: 'tap-1', params: { description: 'indústrias' } });
    const second = await api('POST', `/campaigns/${c2.data.id}/actions`, { type: 'set_audience', actionId: 'tap-1', params: { description: 'indústrias' } });
    assert.equal(first.res.status, 200);
    assert.equal(second.res.status, 200);
    assert.equal(first.body.data.card.replayed, undefined, 'campanha 1 executa');
    assert.equal(second.body.data.card.replayed, undefined, 'campanha 2 EXECUTA — não replaya a da 1ª');
    // Segmento é BIBLIOTECA por org (@@unique orgId+nome): mesma descrição no
    // mesmo dia deduplica (fix 2026-09-28) — as campanhas compartilham a
    // entrada da biblioteca; runs continuam por campanha.
    assert.equal(prisma.studioSegment.rows.length, 1, 'segmento deduplicado na biblioteca da org');
    assert.equal(prisma.studioActionRun.rows.length, 2, 'uma run por campanha');
  } finally {
    server.close();
  }
});

test('action desconhecida → 400 UNKNOWN_ACTION (contrato v1 fecha o vocabulário)', async () => {
  const { server, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'X', channels: ['email'] });
    const bad = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'delete_everything', actionId: 't-1' });
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error, 'UNKNOWN_ACTION');
  } finally {
    server.close();
  }
});

// ── Paridade com o painel Outreach (2026-10-08): supressão + disconnect ─────

test('suppression: show lista, add cria e add idêntico é replay (params)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Supressão', channels: ['email'] });
    const campaignId = c.data.id;
    prisma.suppressionList.rows.push({
      id: 'sup-1', tenantId: 'org-1', email: 'antigo@empresa.com', reason: 'unsubscribed', addedAt: new Date('2026-10-01'),
    });

    const show = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'show_suppression', params: {} });
    assert.equal(show.res.status, 200);
    assert.equal(show.body.data.card.type, 'suppression_list');
    assert.equal(show.body.data.card.total, 1);
    assert.ok(show.body.data.card.detail.includes('antigo@empresa.com'));

    const add = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'add_suppression', params: { email: 'nao-quer@acme.com' } });
    assert.equal(add.res.status, 200);
    assert.equal(add.body.data.card.type, 'suppression_added');
    assert.equal(add.body.data.card.replayed, undefined, '1ª execução não é replay');
    assert.equal(prisma.suppressionList.rows.length, 2, 'entrada criada');

    const again = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'add_suppression', params: { email: 'nao-quer@acme.com' } });
    assert.equal(again.res.status, 200);
    assert.equal(again.body.data.card.replayed, true, 'mesmo email = replay (idempotency params)');
    assert.equal(prisma.suppressionList.rows.length, 2, 'nenhuma linha duplicada');
  } finally {
    server.close();
  }
});

test('suppression: remove SEM confirmação vira confirm_change; confirmado reabilita; inexistente é honesto', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Reabilita', channels: ['email'] });
    const campaignId = c.data.id;
    prisma.suppressionList.rows.push({
      id: 'sup-9', tenantId: 'org-1', email: 'voltar@acme.com', reason: 'manual', addedAt: new Date(),
    });

    const gate = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'remove_suppression', params: { email: 'voltar@acme.com' } });
    assert.equal(gate.res.status, 200);
    assert.equal(gate.body.data.card.type, 'confirm_change', 'reabilitar contato SEMPRE pede confirmação');
    assert.equal(gate.body.data.card.kind, 'supressao');
    assert.equal(prisma.suppressionList.rows.length, 1, 'nada executado no gate');

    const done = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'remove_suppression', params: { email: 'voltar@acme.com', confirmed: true } });
    assert.equal(done.res.status, 200);
    assert.equal(done.body.data.card.type, 'suppression_removed');
    assert.equal(done.body.data.card.label.includes('reabilitado'), true);
    assert.equal(prisma.suppressionList.rows.length, 0, 'entrada removida');

    const missing = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'remove_suppression', params: { email: 'nunca-existiu@acme.com' } });
    assert.equal(missing.res.status, 200, 'entrada inexistente não é falha');
    assert.equal(missing.body.data.card.type, 'suppression_removed');
    assert.ok(missing.body.data.card.label.includes('não está na supressão'));

    const badParams = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'add_suppression', params: {} });
    assert.equal(badParams.res.status, 400);
    assert.equal(badParams.body.error, 'INVALID_ACTION_PARAMS');
  } finally {
    server.close();
  }
});

test('disconnect_email: sem conta é informativo; 1 conta gateia; 2 contas sem email desambigua; confirmado revoga', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Desconecta', channels: ['email'] });
    const campaignId = c.data.id;

    const none = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'disconnect_email', params: {} });
    assert.equal(none.res.status, 200);
    assert.equal(none.body.data.card.type, 'email_disconnected');
    assert.ok(none.body.data.card.label.includes('Nenhuma conta'), 'sem conta ativa → informativo, sem gate');

    prisma.emailAccount.rows.push(
      { id: 'ea-1', tenantId: 'org-1', email: 'vendas@acme.com', provider: 'gmail', status: 'connected', encryptedRefreshToken: 'tok', encryptedSecret: 'sec' },
      { id: 'ea-2', tenantId: 'org-1', email: 'suporte@acme.com', provider: 'smtp', status: 'connected', encryptedSecret: 'sec2' }
    );

    const ambiguous = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'disconnect_email', params: {} });
    assert.equal(ambiguous.body.data.card.type, 'email_disconnected');
    assert.ok(ambiguous.body.data.card.label.includes('Qual conta'), '2 contas sem email → pergunta qual');
    assert.equal(prisma.emailAccount.rows.filter((r) => r.status === 'connected').length, 2, 'nada desconectado por engano');

    const gate = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'disconnect_email', params: { email: 'vendas@acme.com' } });
    assert.equal(gate.body.data.card.type, 'confirm_change');
    assert.equal(gate.body.data.card.kind, 'desconexao');
    assert.equal(prisma.emailAccount.rows.find((r) => r.id === 'ea-1').status, 'connected', 'gate não executou');

    const done = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'disconnect_email', params: { email: 'vendas@acme.com', confirmed: true } });
    assert.equal(done.res.status, 200);
    assert.equal(done.body.data.card.type, 'email_disconnected');
    const revoked = prisma.emailAccount.rows.find((r) => r.id === 'ea-1');
    assert.equal(revoked.status, 'revoked', 'mesma semântica do DELETE /api/gmail/accounts/:id');
    assert.equal(revoked.encryptedRefreshToken, null, 'token OAuth nulo');
    assert.equal(revoked.encryptedSecret, null, 'segredo nulo');
    assert.equal(prisma.emailAccount.rows.find((r) => r.id === 'ea-2').status, 'connected', 'a outra conta segue de pé');
  } finally {
    server.close();
  }
});

test('show_capabilities cita supressão e desconexão (a resposta canônica de "o que você faz?")', async () => {
  const { server, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Caps', channels: ['email'] });
    const out = await api('POST', `/campaigns/${c.data.id}/actions`, { type: 'show_capabilities', params: {} });
    const detail = out.body.data.card.detail;
    assert.ok(detail.includes('supressão'), 'supressão listada');
    assert.ok(detail.includes('disconnect_email'), 'desconexão listada');
  } finally {
    server.close();
  }
});
