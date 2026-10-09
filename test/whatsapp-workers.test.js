'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Rate limiter: janela ativa 24h para o teste ser determinístico (lê env na
// hora da chamada). Sem Redis/Prisma/WAHA reais — fakes in-memory injetados.
process.env.WHATSAPP_ALLOWED_HOURS_START = '0';
process.env.WHATSAPP_ALLOWED_HOURS_END = '24';

const workers = require('../whatsapp-workers');
const { renderTemplate } = require('../whatsapp-utils');

// ── Fake Prisma in-memory (apenas o que processSequence usa) ────────────────
function makeFakePrisma() {
  const db = {
    contacts: [], campaigns: [], steps: [], prospects: [],
    accounts: [], messages: [], conversations: [], channelStates: [],
  };
  let seq = 0;
  const id = (p) => `${p}_${++seq}`;

  // Suporta chaves compostas (campaignContactId_stepIndex, orgId_phoneNumber,
  // prospectId_channel) e filtros planos.
  function matches(rec, where = {}) {
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && v.constructor === Object) {
        if ('in' in v) return v.in.includes(rec[k]);
        if ('notIn' in v) return !v.notIn.includes(rec[k]);
        if ('not' in v) return (rec[k] ?? null) !== v.not;
        if ('gte' in v) return new Date(rec[k]) >= new Date(v.gte);
        return Object.entries(v).every(([sk, sv]) => rec[sk] === sv);
      }
      return rec[k] === v;
    });
  }
  const find = (arr, where) => arr.find((r) => matches(r, where)) || null;

  const prisma = {
    db,
    whatsAppCampaignContact: {
      async findUnique({ where, include }) {
        const row = find(db.contacts, where);
        if (row && include && include.campaign) {
          return { ...row, campaign: db.campaigns.find((c) => c.id === row.campaignId) };
        }
        return row;
      },
      async update({ where, data }) {
        const row = find(db.contacts, where);
        if (row) Object.assign(row, data);
        return row;
      },
      async upsert({ where, create, update }) {
        const row = find(db.contacts, where);
        if (row) {
          Object.assign(row, update);
          return row;
        }
        const created = { id: id('cc'), ...create };
        db.contacts.push(created);
        return created;
      },
      async count({ where } = {}) {
        return db.contacts.filter((r) => matches(r, where)).length;
      },
    },
    whatsAppCampaign: {
      async findUnique({ where }) { return find(db.campaigns, where); },
      async findFirst({ where }) { return find(db.campaigns, where); },
      async update({ where, data }) {
        const row = find(db.campaigns, where);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    whatsAppSequenceStep: {
      async findMany({ where } = {}) {
        return db.steps
          .filter((s) => matches(s, where))
          .sort((a, b) => (a.orderIndex || 0) - (b.orderIndex || 0));
      },
      async findFirst({ where }) { return find(db.steps, where); },
      async update({ where, data }) {
        const row = find(db.steps, where);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    whatsAppAccount: {
      async findUnique({ where }) { return find(db.accounts, where); },
    },
    whatsAppConversation: {
      async findUnique({ where }) { return find(db.conversations, where); },
      async findFirst({ where }) { return find(db.conversations, where); },
      async create({ data }) { const row = { id: id('conv'), ...data }; db.conversations.push(row); return row; },
      async update({ where, data }) { const row = find(db.conversations, where); if (row) Object.assign(row, data); return row; },
    },
    whatsAppMessage: {
      async findUnique({ where }) { return find(db.messages, where); },
      async findFirst({ where } = {}) { return db.messages.find((r) => matches(r, where)) || null; },
      async create({ data }) { const row = { id: id('msg'), ...data }; db.messages.push(row); return row; },
      async count({ where } = {}) { return db.messages.filter((r) => matches(r, where)).length; },
    },
    leadChannelState: {
      async findUnique({ where }) { return find(db.channelStates, where); },
    },
    prospect: {
      async findUnique({ where }) { return find(db.prospects, where); },
      async findMany({ where } = {}) { return db.prospects.filter((r) => matches(r, where)); },
    },
  };
  return prisma;
}

function makeFakeQueues() {
  const queues = {
    sequence: { adds: [], async add(job, opts) { this.adds.push({ job, opts }); return { id: 'job' }; } },
    send: { adds: [], async add(job, opts) { this.adds.push({ job, opts }); return { id: 'job' }; } },
  };
  return queues;
}

// ── Cenário base: campanha manual RUNNING com template do tenant ───────────
function seedManualCampaign({ messageTemplate = 'Olá {{firstName}}, da {{companyName}} ({{industry}}).', prospect } = {}) {
  const prisma = makeFakePrisma();
  prisma.db.campaigns.push({
    id: 'camp_1', orgId: 'org_1', status: 'RUNNING', source: 'manual',
    objective: null, offer: null, whatsappAccountId: 'acc_1',
  });
  prisma.db.accounts.push({ id: 'acc_1', orgId: 'org_1', sessionName: 'sess', status: 'CONNECTED' });
  prisma.db.prospects.push(prospect || {
    id: 'pr_1', orgId: 'org_1', companyName: 'Acme Industria', tradeName: null,
    contactName: null, cnpjPartners: null, industry: 'Metalurgia', city: 'Joinville', state: 'SC',
  });
  prisma.db.contacts.push({
    id: 'cc_1', campaignId: 'camp_1', prospectId: 'pr_1', phoneNumber: '11987654321',
    status: 'QUEUED', currentStepIndex: 0,
  });
  prisma.db.steps.push({
    id: 'step_1', campaignId: 'camp_1', orderIndex: 0,
    messageTemplate, aiPersonalized: false, delayMinutes: 0,
  });
  return prisma;
}

test('T012: campanha manual renderiza o TEMPLATE DO TENANT — nenhum texto de plataforma', async () => {
  const prisma = seedManualCampaign();
  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });

  assert.ok(result.messageId, `mensagem criada (${JSON.stringify(result)})`);
  const message = prisma.db.messages[0];
  const prospect = prisma.db.prospects[0];
  // O conteúdo é EXATAMENTE o template do tenant renderizado — nenhum texto
  // sintético/genérico da plataforma é adicionado (FR-001).
  assert.strictEqual(
    message.content,
    renderTemplate('Olá {{firstName}}, da {{companyName}} ({{industry}}).', prospect)
  );
  assert.ok(message.content.includes('Acme Industria'));
  assert.ok(!/pré-qualificados|leads prontos|enriquecimento/i.test(message.content));
  assert.strictEqual(message.source, 'CAMPAIGN');
  assert.strictEqual(message.direction, 'OUTBOUND');
  assert.strictEqual(queues.send.adds.length, 1, 'envio enfileirado 1x');
  assert.strictEqual(queues.send.adds[0].job.messageId, message.id);
});

test('T012: isolamento multi-tenant — campanha PAUSED não envia', async () => {
  const prisma = seedManualCampaign();
  prisma.db.campaigns[0].status = 'PAUSED';
  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  assert.strictEqual(result.paused, true);
  assert.strictEqual(prisma.db.messages.length, 0, 'nenhuma mensagem criada');
  assert.strictEqual(queues.send.adds.length, 0);
});

test('T012: template vazio do step → contato cancelado, nada enviado (FR-012 backstop)', async () => {
  const prisma = seedManualCampaign({ messageTemplate: '   ' });
  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  assert.strictEqual(result.skipped, 'empty_template');
  assert.strictEqual(prisma.db.messages.length, 0);
  const contact = prisma.db.contacts[0];
  assert.strictEqual(contact.status, 'CANCELLED');
  assert.strictEqual(contact.cancelReason, 'empty_template');
});

// ── Prompt da IA conhece a pessoa de contato (US2 — T015) ───────────────────
test('T015: prompt da IA inclui contactName e instrui saudação sem nome na falta', () => {
  const orgCtx = {
    nome: 'MB Máquinas',
    configured: true,
    renderForPrompt: () => 'EMPRESA: MB Máquinas',
  };
  const campaign = { name: 'Outbound', objective: null, offer: null, ctaUrl: null };

  const comContato = workers.buildStepMessagePrompt({
    prospect: { companyName: 'Acme', tradeName: null, contactName: 'Mariana Souza', industry: 'Metalurgia', city: 'Joinville', state: 'SC' },
    orgCtx,
    campaign,
  });
  assert.ok(comContato.includes('Pessoa de contato: Mariana Souza'));

  const semContato = workers.buildStepMessagePrompt({
    prospect: { companyName: 'Acme', tradeName: null, contactName: null, industry: 'Metalurgia', city: 'Joinville', state: 'SC' },
    orgCtx,
    campaign,
  });
  assert.ok(semContato.includes('não informada'));
  assert.ok(semContato.includes('saude sem nome'), 'IA não deve inventar pessoa');
});

// ── Fallback seguro + origem de composição (US3 — T017/T018) ────────────────
function makeFakeLlm({ message = null, rawContent = null, fail = false } = {}) {
  const calls = [];
  const callLlm = async (opts) => {
    calls.push(opts);
    if (fail) throw new Error('LiteLLM HTTP 502');
    return { content: rawContent != null ? rawContent : JSON.stringify({ message }), model: 'fake' };
  };
  callLlm.calls = calls;
  const parseJsonLoose = (content) => {
    const cleaned = String(content || '').replace(/```json|```/g, '').trim();
    try { return JSON.parse(cleaned); } catch (_) { return null; }
  };
  return {
    callLlm,
    parseJsonLoose,
    premiumModel: () => 'fake-model',
  };
}

function seedAiCampaign({ stepTemplate = 'Olá {{firstName}}, tudo bem? Aqui é o(a) MB Máquinas.' } = {}) {
  const prisma = seedManualCampaign({ messageTemplate: stepTemplate });
  prisma.db.campaigns[0].source = 'ai';
  prisma.db.steps[0].aiPersonalized = true;
  // organização premium (isPremiumOrg lê organization.findUnique)
  prisma.organization = {
    async findUnique() { return { id: 'org_1', plan: 'premium' }; },
  };
  prisma.commercialSettings = {
    async findUnique() { return { orgId: 'org_1', companyName: 'MB Máquinas', valueProposition: 'corte e dobra' }; },
  };
  return prisma;
}

test('US3: IA disponível → mensagem personalizada com compositionOrigin "ai"', async () => {
  const prisma = seedAiCampaign();
  prisma.db.prospects[0].contactName = 'Mariana';
  const llmStub = makeFakeLlm({ message: 'Oi Mariana! Tudo certo por aí?' });
  workers._setLlmForTests(llmStub);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(makeFakeQueues());

  const result = await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  assert.ok(result.messageId);
  const message = prisma.db.messages[0];
  assert.strictEqual(message.content, 'Oi Mariana! Tudo certo por aí?');
  assert.strictEqual(message.compositionOrigin, 'ai');
});

test('US3: LLM falha → fallback é o TEMPLATE do step (tenant), origin "ai_fallback_template"', async () => {
  const prisma = seedAiCampaign();
  const llmStub = makeFakeLlm({ fail: true });
  workers._setLlmForTests(llmStub);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(makeFakeQueues());

  const result = await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  assert.ok(result.messageId, 'a mensagem NUNCA deixa de sair por culpa do LLM');
  const message = prisma.db.messages[0];
  assert.ok(message.content.includes('MB Máquinas'), 'fallback = base do tenant composta');
  assert.ok(!/pré-qualificados|leads prontos|enriquecimento/i.test(message.content));
  assert.strictEqual(message.compositionOrigin, 'ai_fallback_template');
});

test('US3: resposta da IA fora da política (BLOCKLIST) → fallback do tenant', async () => {
  const prisma = seedAiCampaign();
  const llmStub = makeFakeLlm({ message: 'Temos desconto imperdível para você hoje!' });
  workers._setLlmForTests(llmStub);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(makeFakeQueues());

  await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  const message = prisma.db.messages[0];
  assert.ok(!/desconto/i.test(message.content), 'claim proibido não é enviado');
  assert.ok(message.content.includes('MB Máquinas'));
  assert.strictEqual(message.compositionOrigin, 'ai_fallback_template');
});

test('US3: personalização maior que 600 chars é truncada preservando frases (FR-007)', async () => {
  const prisma = seedAiCampaign();
  const long = 'Frase completa aqui. ' + 'm'.repeat(700);
  const llmStub = makeFakeLlm({ message: long });
  workers._setLlmForTests(llmStub);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(makeFakeQueues());

  await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  const message = prisma.db.messages[0];
  assert.ok(message.content.length <= 600, `comprimento ${message.content.length} ≤ 600`);
  assert.ok(message.content.startsWith('Frase completa aqui.'), 'corte preserva frase inteira');
  assert.strictEqual(message.compositionOrigin, 'ai');
});

test('US3: org degradada para trial usa o template direto (sem gasto de LLM)', async () => {
  const prisma = seedAiCampaign();
  prisma.organization = { async findUnique() { return { id: 'org_1', plan: 'trial' }; } };
  const llmStub = makeFakeLlm({ message: 'nunca deveria ser chamada' });
  workers._setLlmForTests(llmStub);
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(makeFakeQueues());

  await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  const message = prisma.db.messages[0];
  assert.strictEqual(llmStub.callLlm.calls.length, 0, 'trial não consome LLM');
  assert.ok(message.content.includes('MB Máquinas'));
  assert.strictEqual(message.compositionOrigin, 'ai_fallback_template');
});

// ── QA 2026-10-06: pré-matriculado ALOCADO pelo gate recebe seu job ──────────

test('startCampaign: contato pré-matriculado com nextSendAt (alocado pelo gate) enfileira o job da etapa', async () => {
  const prisma = makeFakePrisma();
  prisma.db.campaigns.push({
    id: 'camp_1', orgId: 'org_1', status: 'DRAFT', source: 'manual',
    objective: null, offer: null, whatsappAccountId: 'acc_1',
  });
  prisma.db.accounts.push({ id: 'acc_1', orgId: 'org_1', sessionName: 'sess', status: 'CONNECTED' });
  prisma.db.steps.push({
    id: 'step_1', campaignId: 'camp_1', orderIndex: 0,
    messageTemplate: 'Olá {{firstName}}.', aiPersonalized: false, delayMinutes: 0,
  });
  prisma.db.prospects.push(
    { id: 'pr_1', orgId: 'org_1', companyName: 'Ang', contactName: 'Ana', cnpjPhones: ['12999887766'] },
    { id: 'pr_2', orgId: 'org_1', companyName: 'Nova', contactName: 'Bruno', cnpjPhones: ['11999998888'] }
  );
  // pr_1: pré-matriculado pelo compile do Studio E ALOCADO pelo gate
  // (nextSendAt marcado) — o skip antigo o deixava 'Na fila' para sempre.
  prisma.db.contacts.push({
    id: 'cc_1', campaignId: 'camp_1', prospectId: 'pr_1', phoneNumber: '12999887766',
    status: 'QUEUED', currentStepIndex: 0, nextSendAt: new Date('2026-10-06T19:08:00Z'),
  });

  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.startCampaign(prisma, {
    campaignId: 'camp_1',
    prospectIds: ['pr_1', 'pr_2'],
    orgId: 'org_1',
  });

  assert.strictEqual(result.jobsQueued, 2, 'alocado + novo entram na sequência');
  assert.strictEqual(result.skippedAlreadyEnrolled, 0, 'nada pulado');
  assert.strictEqual(prisma.db.campaigns[0].status, 'RUNNING', 'campanha desperta');
  assert.strictEqual(queues.sequence.adds.length, 2);
  const jobAlocado = queues.sequence.adds.find((a) => a.job.contactId === 'cc_1');
  assert.ok(jobAlocado, 'job do pré-matriculado alocado');
  assert.strictEqual(jobAlocado.opts.delay, 0, 'sai na hora (gate já liberou)');
});

test('startCampaign: pré-matriculado SEM alocação (nextSendAt null) continua aguardando o gate', async () => {
  const prisma = makeFakePrisma();
  prisma.db.campaigns.push({
    id: 'camp_1', orgId: 'org_1', status: 'DRAFT', source: 'manual',
    objective: null, offer: null, whatsappAccountId: 'acc_1',
  });
  prisma.db.accounts.push({ id: 'acc_1', orgId: 'org_1', sessionName: 'sess', status: 'CONNECTED' });
  prisma.db.steps.push({
    id: 'step_1', campaignId: 'camp_1', orderIndex: 0,
    messageTemplate: 'Olá {{firstName}}.', aiPersonalized: false, delayMinutes: 0,
  });
  prisma.db.prospects.push({ id: 'pr_1', orgId: 'org_1', companyName: 'Ang', cnpjPhones: ['12999887766'] });
  prisma.db.contacts.push({
    id: 'cc_1', campaignId: 'camp_1', prospectId: 'pr_1', phoneNumber: '12999887766',
    status: 'QUEUED', currentStepIndex: 0, nextSendAt: null,
  });

  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.startCampaign(prisma, {
    campaignId: 'camp_1',
    prospectIds: ['pr_1'],
    orgId: 'org_1',
  });
  assert.strictEqual(result.skippedAlreadyEnrolled, 1, 'sem alocação do gate → aguarda');
  assert.strictEqual(result.jobsQueued, 0);
  assert.strictEqual(queues.sequence.adds.length, 0);
});

// ── 2026-10-09 (caso MB): número no CADASTRO do lead tem que chegar ao ENVIO ─
// A matrícula do Studio cria o contato SEM phoneNumber e o disparo cancelava
// por no_phone mesmo com cnpjPhones preenchido — a IA dizia "WhatsApp
// cadastrado" e o disparo dizia "sem número". O worker re-lê o cadastro.

test('processSequence: contato SEM snapshot de telefone é curado com o cnpjPhones do lead (mensagem sai)', async () => {
  const prisma = makeFakePrisma();
  prisma.db.campaigns.push({
    id: 'camp_1', orgId: 'org_1', status: 'RUNNING', source: 'studio',
    objective: null, offer: null, whatsappAccountId: 'acc_1',
  });
  prisma.db.accounts.push({ id: 'acc_1', orgId: 'org_1', sessionName: 'sess', status: 'CONNECTED' });
  prisma.db.prospects.push({
    id: 'pr_1', orgId: 'org_1', companyName: 'MB Máquinas', contactName: 'Ana',
    cnpjPhones: ['+5512987654321'], // cadastrado DEPOIS do lançamento (enriquecimento)
  });
  // Contato criado pela matrícula do Studio: SEM phoneNumber.
  prisma.db.contacts.push({
    id: 'cc_1', campaignId: 'camp_1', prospectId: 'pr_1', phoneNumber: null,
    status: 'QUEUED', currentStepIndex: 0,
  });
  prisma.db.steps.push({
    id: 'step_1', campaignId: 'camp_1', orderIndex: 0,
    messageTemplate: 'Olá {{firstName}}.', aiPersonalized: false, delayMinutes: 0,
  });

  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });

  assert.ok(result.messageId, `mensagem criada com o número do cadastro (${JSON.stringify(result)})`);
  assert.strictEqual(prisma.db.contacts[0].phoneNumber, '5512987654321', 'snapshot persistido no contato');
  assert.strictEqual(prisma.db.contacts[0].status, 'SENDING', 'seguiu para envio — não cancela por no_phone');
  assert.strictEqual(prisma.db.messages.length, 1);
});

test('processSequence: contato sem telefone E lead sem telefone → CANCELLED no_phone (comportamento mantido)', async () => {
  const prisma = makeFakePrisma();
  prisma.db.campaigns.push({
    id: 'camp_1', orgId: 'org_1', status: 'RUNNING', source: 'studio',
    objective: null, offer: null, whatsappAccountId: 'acc_1',
  });
  prisma.db.accounts.push({ id: 'acc_1', orgId: 'org_1', sessionName: 'sess', status: 'CONNECTED' });
  prisma.db.prospects.push({ id: 'pr_1', orgId: 'org_1', companyName: 'Sem Fone', cnpjPhones: [] });
  prisma.db.contacts.push({
    id: 'cc_1', campaignId: 'camp_1', prospectId: 'pr_1', phoneNumber: null,
    status: 'QUEUED', currentStepIndex: 0,
  });
  prisma.db.steps.push({
    id: 'step_1', campaignId: 'camp_1', orderIndex: 0,
    messageTemplate: 'Olá {{firstName}}.', aiPersonalized: false, delayMinutes: 0,
  });

  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.processSequence({ data: { contactId: 'cc_1', stepIndex: 0 } });
  assert.strictEqual(result.skipped, 'no_phone');
  assert.strictEqual(prisma.db.contacts[0].status, 'CANCELLED');
  assert.strictEqual(prisma.db.contacts[0].cancelReason, 'no_phone');
  assert.strictEqual(prisma.db.messages.length, 0);
});

test('startCampaign: pré-matriculado ALOCADO sem phoneNumber recebe backfill do cadastro antes do job', async () => {
  const prisma = makeFakePrisma();
  prisma.db.campaigns.push({
    id: 'camp_1', orgId: 'org_1', status: 'DRAFT', source: 'studio',
    objective: null, offer: null, whatsappAccountId: 'acc_1',
  });
  prisma.db.accounts.push({ id: 'acc_1', orgId: 'org_1', sessionName: 'sess', status: 'CONNECTED' });
  prisma.db.steps.push({
    id: 'step_1', campaignId: 'camp_1', orderIndex: 0,
    messageTemplate: 'Olá {{firstName}}.', aiPersonalized: false, delayMinutes: 0,
  });
  prisma.db.prospects.push({ id: 'pr_1', orgId: 'org_1', companyName: 'Ang', cnpjPhones: ['(12) 99820-0795'] });
  // Matrícula do Studio: QUEUED + alocado pelo gate, PORÉM sem snapshot.
  prisma.db.contacts.push({
    id: 'cc_1', campaignId: 'camp_1', prospectId: 'pr_1', phoneNumber: null,
    status: 'QUEUED', currentStepIndex: 0, nextSendAt: new Date('2026-10-09T12:00:00Z'),
  });

  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.startCampaign(prisma, {
    campaignId: 'camp_1',
    prospectIds: ['pr_1'],
    orgId: 'org_1',
  });

  assert.strictEqual(result.jobsQueued, 1, 'job enfileirado');
  assert.strictEqual(prisma.db.contacts[0].phoneNumber, '5512998200795', 'backfill do snapshot a partir do cadastro');
});

test('startCampaign: número curto/lixo no cadastro NÃO vira chatId inválido — fica no_phone', async () => {
  const prisma = makeFakePrisma();
  prisma.db.campaigns.push({
    id: 'camp_1', orgId: 'org_1', status: 'DRAFT', source: 'studio',
    objective: null, offer: null, whatsappAccountId: 'acc_1',
  });
  prisma.db.accounts.push({ id: 'acc_1', orgId: 'org_1', sessionName: 'sess', status: 'CONNECTED' });
  prisma.db.steps.push({
    id: 'step_1', campaignId: 'camp_1', orderIndex: 0,
    messageTemplate: 'Olá {{firstName}}.', aiPersonalized: false, delayMinutes: 0,
  });
  prisma.db.prospects.push({ id: 'pr_1', orgId: 'org_1', companyName: 'Lixo', cnpjPhones: ['3232-1212'] });
  prisma.db.contacts.push({
    id: 'cc_1', campaignId: 'camp_1', prospectId: 'pr_1', phoneNumber: null,
    status: 'QUEUED', currentStepIndex: 0, nextSendAt: new Date('2026-10-09T12:00:00Z'),
  });

  const queues = makeFakeQueues();
  workers._setPrismaForTests(prisma);
  workers._setQueuesForTests(queues);

  const result = await workers.startCampaign(prisma, {
    campaignId: 'camp_1',
    prospectIds: ['pr_1'],
    orgId: 'org_1',
  });

  // 8 dígitos sem DDD é inutilizável para WhatsApp: o contato segue o fluxo
  // (job enfileirado), mas o worker do envio cura/re-cancela — aqui o
  // backfill NÃO grava o lixo no snapshot.
  assert.strictEqual(result.jobsQueued, 1);
  assert.strictEqual(prisma.db.contacts[0].phoneNumber, null, 'lixo não é promovido a snapshot');
});
