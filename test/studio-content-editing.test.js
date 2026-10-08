'use strict';

/**
 * test/studio-content-editing.test.js — edição de conteúdo em voo e
 * destravamento (Epic 3 da onda "criação de campanha sem bloqueios"):
 *
 *  - Story 3.3/B1 (FR8): conteúdo editável em `approved`/`scheduled`/
 *    `running` (o Pré-voo é pós-aprove) via serviço único do PATCH —
 *    emailDoc PERSISTE (bug de contrato morto); mensagens já enviadas
 *    imutáveis; nenhum débito novo (AD-13); `approval.contentEdits` com
 *    leitor no Monitor (B8), SEM edição falsa (E8), com `unsubscribeMailto`
 *    (E9) e SEM fallback whatsappText no corpo (V7).
 *  - D9: action aditiva `edit_content` reusa o MESMO serviço (AD-6).
 *  - V1/D5: destrava-agendado — tick compila quando o gate passa e as
 *    execuções estão nulas (conectar canal depois basta).
 *  - V4: card de saldo sem "piso"/"bloqueado" (tom mordomo, UX-DR4).
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const bridge = require('../studio/channel-bridge');
const { tickCampaign } = require('../studio/scheduler-worker');

function seed(prisma) {
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'resend', email: 'venda@empresa.com', status: 'connected' });
  prisma.studioCampaign.rows.push({
    id: 'camp-1', orgId: 'org-1', name: 'Em voo', status: 'approved',
    channels: ['email', 'whatsapp'], schedule: {}, approval: {},
    emailExecutionId: 'exec-email', whatsappExecutionId: 'exec-wa',
  });
  prisma.outreachCampaign.rows.push({
    id: 'exec-email', tenantId: 'org-1', status: 'draft',
    emailTemplateSubject: 'Assunto antigo', emailTemplateBody: 'Corpo antigo\n\n—\nNão quer mais receber? Responda "sair" ou use o link: mailto:unsubscribe@b2base.net?subject=unsubscribe',
    emailHeaders: { 'List-Unsubscribe': '<mailto:unsubscribe@b2base.net?subject=unsubscribe>' },
    studioAttachments: [],
  });
  prisma.whatsappCampaign.rows.push({ id: 'exec-wa', orgId: 'org-1', status: 'DRAFT', studioAttachments: [] });
  prisma.whatsappSequenceStep.rows.push(
    { id: 'step-1', campaignId: 'exec-wa', orderIndex: 1, messageTemplate: 'Texto antigo do 1º toque', aiPersonalized: false, delayMinutes: 0 },
    { id: 'step-2', campaignId: 'exec-wa', orderIndex: 2, messageTemplate: 'Follow-up antigo', aiPersonalized: false, delayMinutes: 4320 }
  );
  prisma.studioContent.rows.push(
    {
      id: 'content-email', orgId: 'org-1', campaignId: 'camp-1', channel: 'email',
      kind: 'base', stepIndex: 1, variantLabel: 'A',
      subject: 'Assunto antigo', preheader: null, ctaUrl: 'https://exemplo.com',
      emailDoc: { blocks: [{ type: 'text', text: 'Corpo antigo' }] },
      unsubscribeMailto: 'mailto:sair@empresa.com?subject=unsubscribe', editHistory: [],
    },
    {
      id: 'content-wa', orgId: 'org-1', campaignId: 'camp-1', channel: 'whatsapp',
      kind: 'base', stepIndex: 1, variantLabel: 'A', whatsappText: 'Texto antigo do 1º toque', editHistory: [],
    },
    {
      id: 'content-wa-fup', orgId: 'org-1', campaignId: 'camp-1', channel: 'whatsapp',
      kind: 'followup', stepIndex: 2, variantLabel: 'A', whatsappText: 'Follow-up novo', editHistory: [],
    }
  );
  return prisma;
}

async function startServer(prisma) {
  const app = express();
  app.use(express.json());
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
    return { res, body: await res.json().catch(() => ({})) };
  };
  return { server, api };
}

// ── B1: conteúdo editável em approved (o Pré-voo é pós-aprove) ──────────────

test('B1: PATCH contents-only em approved → 200; emailDoc PERSISTE (bug de contrato morto)', async () => {
  const prisma = seed(createFakePrisma());
  const { server, api } = await startServer(prisma);
  try {
    const { res, body } = await api('PATCH', '/campaigns/camp-1', {
      contents: [{ id: 'content-email', subject: 'Assunto novo', emailDoc: { blocks: [{ type: 'text', text: 'Corpo novo' }] } }],
    });
    assert.equal(res.status, 200, 'conteúdo-only em approved NÃO dá 409 (B1/E1)');
    const email = prisma.studioContent.rows.find((c) => c.id === 'content-email');
    assert.equal(email.subject, 'Assunto novo');
    assert.equal(email.emailDoc.blocks[0].text, 'Corpo novo', 'emailDoc persistido — preview ≡ envio');
    assert.equal(email.editHistory.length, 1, 'histórico de edição do registro (não do payload do cliente)');

    // Sync propagou ao template NÃO enviado: subject novo + rodapé com o
    // unsubscribeMailto do conteúdo (E9), sem fallback whatsappText (V7).
    const execution = prisma.outreachCampaign.rows.find((r) => r.id === 'exec-email');
    assert.equal(execution.emailTemplateSubject, 'Assunto novo');
    assert.ok(execution.emailTemplateBody.includes('Corpo novo'));
    assert.ok(execution.emailTemplateBody.includes('sair@empresa.com'), 'rodapé com o mailto do conteúdo (E9)');
    assert.ok(!execution.emailTemplateBody.includes('Texto antigo do 1º toque'), 'V7: sem fallback whatsappText no corpo');

    // Metadados em approved continuam preservados (FR-006 de sempre).
    const meta = await api('PATCH', '/campaigns/camp-1', { name: 'Novo nome' });
    assert.equal(meta.res.status, 409, 'metadados em approved seguem bloqueados (CAMPAIGN_LOCKED)');
  } finally {
    server.close();
  }
});

test('edição em voo (running): só steps sem envio sincronizam; enviados imutáveis; contentEdits registrado SEM edição falsa (E8/B8)', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows[0].status = 'running';
  // Step 1 (1º toque) JÁ TEM mensagem enviada; step 2 ainda não.
  prisma.whatsAppMessage.rows.push(
    { id: 'wm-1', orgId: 'org-1', campaignContactId: 'cc-1', stepIndex: 0, status: 'SENT', content: 'Texto antigo do 1º toque' }
  );
  prisma.whatsappCampaignContact.rows.push({ id: 'cc-1', campaignId: 'exec-wa', prospectId: 'lead-1', status: 'SENT' });
  // E-mail já saiu → template do 1º toque é imutável.
  prisma.outreachContact.rows.push({ id: 'oc-1', campaignId: 'exec-email', prospectId: 'lead-1', status: 'SENT', sentAt: new Date() });

  const { server, api } = await startServer(prisma);
  try {
    const { res, body } = await api('PATCH', '/campaigns/camp-1', {
      contents: [
        { id: 'content-wa', whatsappText: 'Texto novo do 1º toque' },
        { id: 'content-wa-fup', whatsappText: 'Follow-up novo' },
      ],
    });
    assert.equal(res.status, 200);
    const sync = body.contents.sync;
    assert.equal(sync.whatsapp.synced.map((s) => s.stepIndex).sort().join(','), '2', 'só o step sem envio sincroniza');
    assert.ok(sync.whatsapp.skipped.some((s) => s.stepIndex === 1), 'step já enviado é imutável (explicável)');
    assert.equal(sync.email.synced, false, 'e-mail com envio não muda');
    assert.ok(sync.email.reason.includes('imutáveis'));

    const step1 = prisma.whatsappSequenceStep.rows.find((s) => s.orderIndex === 1);
    const step2 = prisma.whatsappSequenceStep.rows.find((s) => s.orderIndex === 2);
    assert.equal(step1.messageTemplate, 'Texto antigo do 1º toque', 'o que já saiu não muda');
    assert.equal(step2.messageTemplate, 'Follow-up novo');

    // B8: Monitor registra edição "a partir de quando vale".
    const edits = prisma.studioCampaign.rows[0].approval.contentEdits;
    assert.equal(edits.length, 1);
    assert.ok(edits[0].appliesFrom, 'a partir de quando vale');

    // E8: mesma edição de novo (sem mudança real) NÃO registra segunda edição.
    await api('PATCH', '/campaigns/camp-1', {
      contents: [{ id: 'content-wa-fup', whatsappText: 'Follow-up novo' }],
    });
    assert.equal(prisma.studioCampaign.rows[0].approval.contentEdits.length, 1, 'sem registro falso de edição');

    // AD-13: nenhum movimento no ledger (sem débito novo).
    assert.equal(prisma.studioReputationEvent.rows.length, 0);
  } finally {
    server.close();
  }
});

test('D9: action aditiva edit_content pelo chat REUSA o serviço do PATCH (idempotente por params)', async () => {
  const prisma = seed(createFakePrisma());
  const { server, api } = await startServer(prisma);
  try {
    const first = await api('POST', '/campaigns/camp-1/actions', {
      type: 'edit_content',
      actionId: 'edit-1',
      params: { confirmed: true, contents: [{ id: 'content-wa', whatsappText: 'Texto via chat' }] },
    });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.data.card.type, 'content_edited');
    assert.equal(prisma.studioContent.rows.find((c) => c.id === 'content-wa').whatsappText, 'Texto via chat');

    // Mesma actionId → replay, sem re-executar.
    const second = await api('POST', '/campaigns/camp-1/actions', {
      type: 'edit_content',
      actionId: 'edit-1',
      params: { confirmed: true, contents: [{ id: 'content-wa', whatsappText: 'Texto via chat' }] },
    });
    assert.equal(second.body.data.card.replayed, true);

    // Validação de placeholders também vale no chat (FR-033).
    const bad = await api('POST', '/campaigns/camp-1/actions', {
      type: 'edit_content',
      actionId: 'edit-2',
      params: { confirmed: true, contents: [{ id: 'content-wa', whatsappText: 'Oi {{desconhecida}}' }] },
    });
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error, 'UNKNOWN_VARIABLE');

    // Conteúdo de OUTRA campanha → 404 (escopo de org/campanha, NFR2).
    prisma.studioContent.rows.push({ id: 'content-outro', orgId: 'org-1', campaignId: 'camp-2', channel: 'email', kind: 'base', stepIndex: 1 });
    const foreign = await api('POST', '/campaigns/camp-1/actions', {
      type: 'edit_content',
      actionId: 'edit-3',
      params: { confirmed: true, contents: [{ id: 'content-outro', subject: 'x' }] },
    });
    assert.equal(foreign.res.status, 404);
  } finally {
    server.close();
  }
});

// ── V1/D5: destrava-agendado — tick compila quando o gate passa ─────────────

const IN_WINDOW = new Date('2026-09-23T13:00:00Z'); // 10h SP, quarta

test('D5: segundo canal conectado depois do voo compila no tick (falta execução de QUALQUER declarado)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.whatsappAccount.rows.push({ id: 'wa-1', orgId: 'org-1', status: 'CONNECTED' });
  // Saldo ÚNICO: uma linha por org (o domínio verificado vale para o pool).
  prisma.studioReputationAccount.rows.push(
    { id: 'acc-email', orgId: 'org-1', channel: 'unified', balance: 50, floor: 0, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' }
  );
  // Campanha em voo com execução SÓ de WhatsApp: e-mail foi conectado DEPOIS.
  prisma.studioCampaign.rows.push({
    id: 'camp-1', orgId: 'org-1', name: 'Segundo canal', status: 'scheduled',
    channels: ['email', 'whatsapp'], approval: {},
    schedule: { mode: 'scheduled', startAt: null, windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }], hourlyLimit: 5, dailyLimit: 20, timezone: 'America/Sao_Paulo', useLeadTimezone: false },
    emailExecutionId: null, whatsappExecutionId: 'exec-wa',
  });
  prisma.whatsappCampaign.rows.push({ id: 'exec-wa', orgId: 'org-1', status: 'DRAFT', studioAttachments: [] });
  prisma.whatsappSequenceStep.rows.push({ id: 'step-1', campaignId: 'exec-wa', orderIndex: 1, messageTemplate: 'Oi', aiPersonalized: false, delayMinutes: 0 });
  prisma.studioAudienceSnapshot.rows.push({ id: 'snap-1', orgId: 'org-1', campaignId: 'camp-1', criteriaVersion: {}, totalCount: 1, includedCount: 1, excludedCount: 0, status: 'active' });
  prisma.studioAudienceMember.rows.push({ id: 'm-1', snapshotId: 'snap-1', orgId: 'org-1', prospectId: 'lead-1', included: true, excludeReason: null });
  prisma.studioContent.rows.push(
    { id: 'content-email', orgId: 'org-1', campaignId: 'camp-1', channel: 'email', kind: 'base', stepIndex: 1, variantLabel: 'A', subject: 'Olá', emailDoc: { blocks: [{ type: 'text', text: 'Corpo com descadastro (unsubscribe).' }] } },
    { id: 'content-wa', orgId: 'org-1', campaignId: 'camp-1', channel: 'whatsapp', kind: 'base', stepIndex: 1, variantLabel: 'A', whatsappText: 'Oi!' }
  );

  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async () => {},
  });
  assert.equal(prisma.outreachCampaign.rows.length, 1, 'e-mail compilado no MESMO tick (ensure* idempotente não duplicou o WhatsApp)');
  const campaign = prisma.studioCampaign.rows[0];
  assert.ok(campaign.emailExecutionId, 'execução de e-mail persistida');
  assert.equal(result.released >= 1, true, 'lote liberado (lead entrou na nova fila de e-mail)');
});

test('tick sem snapshot ativo NÃO transita — skipped no_snapshot (nunca running com execuções nulas)', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 50, floor: 0, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
  prisma.studioCampaign.rows.push({
    id: 'camp-9', orgId: 'org-1', name: 'Sem snapshot', status: 'scheduled',
    channels: ['email'], approval: {},
    schedule: { mode: 'scheduled', startAt: null, windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }], hourlyLimit: 5, dailyLimit: 20, timezone: 'America/Sao_Paulo', useLeadTimezone: false },
    emailExecutionId: null, whatsappExecutionId: null,
  });
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async () => {},
  });
  assert.equal(result.skipped, 'no_snapshot');
  assert.equal(prisma.studioCampaign.rows[0].status, 'scheduled', 'não entra em running');
  assert.equal(prisma.studioCampaign.rows[0].emailExecutionId, null);
});

// ── V1/D5 (cont.) — e os cenários de edição pelo chat abaixo ────────────────

test('V1/D5: agendado sem execuções destrava no tick — compila e libera; statusReason limpo com canal de fato', async () => {
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium', studioSendPaused: false });
  // Campanha aprovada/agendada SEM canal (execuções nulas) — o canal chega DEPOIS.
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  prisma.studioReputationAccount.rows.push({ id: 'acc-1', orgId: 'org-1', channel: 'unified', balance: 50, floor: 0, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
  prisma.studioCampaign.rows.push({
    id: 'camp-1', orgId: 'org-1', name: 'Pendente', status: 'scheduled',
    statusReason: 'NO_CHANNEL_CONNECTED',
    channels: ['email'], approval: {},
    schedule: { mode: 'scheduled', startAt: null, windows: [{ days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }], hourlyLimit: 5, dailyLimit: 20, timezone: 'America/Sao_Paulo', useLeadTimezone: false },
    emailExecutionId: null, whatsappExecutionId: null,
  });
  prisma.studioAudienceSnapshot.rows.push({ id: 'snap-1', orgId: 'org-1', campaignId: 'camp-1', criteriaVersion: {}, totalCount: 1, includedCount: 1, excludedCount: 0, status: 'active' });
  prisma.studioAudienceMember.rows.push({ id: 'm-1', snapshotId: 'snap-1', orgId: 'org-1', prospectId: 'lead-1', included: true, excludeReason: null });
  prisma.studioContent.rows.push({ id: 'content-1', orgId: 'org-1', campaignId: 'camp-1', channel: 'email', kind: 'base', stepIndex: 1, variantLabel: 'A', subject: 'Olá', emailDoc: { blocks: [{ type: 'text', text: 'Corpo com descadastro (unsubscribe).' }] } });

  const enqueued = [];
  const result = await tickCampaign(prisma, prisma.studioCampaign.rows[0], {
    now: IN_WINDOW,
    enqueue: async (channel, ids) => enqueued.push({ channel, ids }),
  });
  assert.equal(result.released, 1, 'lote liberado no MESMO tick da conexão do canal');
  assert.deepEqual(enqueued, [{ channel: 'email', ids: ['lead-1'] }]);
  const campaign = prisma.studioCampaign.rows[0];
  assert.equal(campaign.status, 'running', 'scheduled → running');
  assert.equal(campaign.statusReason, null, '"pendente de envio" encerra com canal de fato (D5)');
  assert.ok(campaign.emailExecutionId, 'execução compilada e PERSISTIDA — o próximo tick acha a fila');
  assert.equal(prisma.outreachCampaign.rows.length, 1, 'compile rodou na hora (nada de fila vazia)');
  assert.equal(prisma.outreachCampaign.rows[0].id, campaign.emailExecutionId);
});

test('V4: card de saldo em tom mordomo — nunca "piso" nem "bloqueado" (UX-DR4)', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioReputationAccount.rows.push({ id: 'acc-email-zero', orgId: 'org-1', channel: 'unified', balance: 0, floor: 10, ceiling: 100, rampStage: 0, domainAuthStatus: 'verified' });
  const { server, api } = await startServer(prisma);
  try {
    const { res, body } = await api('POST', '/campaigns/camp-1/actions', { type: 'show_balance' });
    assert.equal(res.status, 200);
    const detail = body.data.card.detail;
    assert.ok(!detail.toLowerCase().includes('piso'), 'sintoma "piso é X" morreu (V4)');
    assert.ok(!detail.toLowerCase().includes('bloqueado'), 'nunca soa interdição (UX-DR4)');
    assert.ok(detail.includes('reposição diária'), 'diz quando libera');
    assert.ok(/\d{2}:\d{2}/.test(detail), 'horário em pt-BR local (B15), nunca UTC cru');
    assert.ok(detail.includes('criar e aprovar'), 'a criação segue livre — o disparo é que aguarda');
  } finally {
    server.close();
  }
});

// ── Null nunca apaga; diff canônico; PATCH sem mutação parcial; retorno fresco

test('edição sem um campo NÃO apaga o campo existente (null é ausente, nunca valor)', async () => {
  const prisma = seed(createFakePrisma());
  const { server, api } = await startServer(prisma);
  try {
    // Pelo chat (edit_content): só whatsappText veio.
    const { res } = await api('POST', '/campaigns/camp-1/actions', {
      type: 'edit_content',
      actionId: 'edit-parcial',
      params: { confirmed: true, contents: [{ id: 'content-email', subject: 'Só o assunto novo' }] },
    });
    assert.equal(res.status, 200);
    const email = prisma.studioContent.rows.find((c) => c.id === 'content-email');
    assert.equal(email.subject, 'Só o assunto novo');
    assert.equal(email.emailDoc.blocks[0].text, 'Corpo antigo', 'emailDoc NÃO apagado');
    assert.equal(email.ctaUrl, 'https://exemplo.com', 'ctaUrl NÃO apagado');

    // Pelo PATCH: null explícito também é ausente.
    const { res: res2 } = await api('PATCH', '/campaigns/camp-1', {
      contents: [{ id: 'content-email', subject: null, whatsappText: 'Só texto novo' }],
    });
    assert.equal(res2.status, 200);
    const after = prisma.studioContent.rows.find((c) => c.id === 'content-email');
    assert.equal(after.subject, 'Só o assunto novo', 'null não apaga o subject');
  } finally {
    server.close();
  }
});

test('edit_content com contents reordenados e SEM actionId → replay (chave estável, irmão do B18)', async () => {
  const prisma = seed(createFakePrisma());
  const { server, api } = await startServer(prisma);
  try {
    const first = await api('POST', '/campaigns/camp-1/actions', {
      type: 'edit_content',
      params: { confirmed: true,
        contents: [
          { id: 'content-wa', whatsappText: 'Texto A' },
          { id: 'content-email', subject: 'Assunto A' },
        ],
      },
    });
    assert.equal(first.res.status, 200);
    assert.equal(first.body.data.card.replayed, undefined, '1ª execução executa');

    const second = await api('POST', '/campaigns/camp-1/actions', {
      type: 'edit_content',
      params: { confirmed: true,
        contents: [
          { id: 'content-email', subject: 'Assunto A' },
          { id: 'content-wa', whatsappText: 'Texto A' },
        ],
      },
    });
    assert.equal(second.body.data.card.replayed, true, 'mesma intenção, ordem diferente = replay');
  } finally {
    server.close();
  }
});

test('emailDoc com ordem de chaves diferente NÃO conta como mudança (diff canônico)', async () => {
  const prisma = seed(createFakePrisma());
  const { server, api } = await startServer(prisma);
  try {
    const before = prisma.studioContent.rows.find((c) => c.id === 'content-email');
    const sameDocReordered = { blocks: [{ text: 'Corpo antigo', type: 'text' }] };
    const { res, body } = await api('PATCH', '/campaigns/camp-1', {
      contents: [{ id: 'content-email', emailDoc: sameDocReordered }],
    });
    assert.equal(res.status, 200);
    const after = prisma.studioContent.rows.find((c) => c.id === 'content-email');
    assert.deepEqual(after.emailDoc, before.emailDoc, 'documento preservado (não reescrito)');
    assert.equal(after.editHistory.length, 0, 'sem edição falsa');
    void body;
  } finally {
    server.close();
  }
});

test('PATCH com contents+metadado em estado não-editável → 409 SEM mutação parcial', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows[0].status = 'completed';
  const { server, api } = await startServer(prisma);
  try {
    const { res, body } = await api('PATCH', '/campaigns/camp-1', {
      name: 'Nome novo',
      contents: [{ id: 'content-wa', whatsappText: 'Nunca deve entrar' }],
    });
    assert.equal(res.status, 409);
    assert.equal(body.error, 'CAMPAIGN_LOCKED');
    const wa = prisma.studioContent.rows.find((c) => c.id === 'content-wa');
    assert.equal(wa.whatsappText, 'Texto antigo do 1º toque', 'conteúdo intacto (nada aplicou antes do 409)');
    assert.equal(prisma.studioCampaign.rows[0].name, 'Em voo', 'metadado intacto');
  } finally {
    server.close();
  }
});

test('PATCH contents-only devolve a campanha FRESCA (approval.contentEdits visível na resposta)', async () => {
  const prisma = seed(createFakePrisma());
  prisma.studioCampaign.rows[0].status = 'scheduled';
  const { server, api } = await startServer(prisma);
  try {
    const { res, body } = await api('PATCH', '/campaigns/camp-1', {
      contents: [{ id: 'content-wa', whatsappText: 'Texto fresco' }],
    });
    assert.equal(res.status, 200);
    assert.equal(body.data.status, 'scheduled');
    assert.ok(Array.isArray(body.data.approval.contentEdits), 'contentEdits no corpo da resposta');
    assert.equal(body.data.approval.contentEdits.length, 1);
  } finally {
    server.close();
  }
});
