'use strict';
const test = require('node:test');
const assert = require('node:assert');

const workers = require('../outreach-workers');

// ── Fake Prisma in-memory (apenas o que processPrepare usa) ─────────────────
function makeFakePrisma({ campaign, prospect, settings }) {
  const db = {
    contacts: [], messages: [], events: [],
  };
  let seq = 0;
  const id = (p) => `${p}_${++seq}`;

  const prisma = {
    db,
    organization: { async findUnique() { return { id: 'org_1', name: 'Org Teste' }; } },
    commercialSettings: { async findUnique() { return db.settings || null; } },
    prospect: {
      async findUnique({ where }) {
        return db.prospectRow || null;
      },
    },
    outreachContact: {
      async findUnique({ where, include }) {
        if (where.id !== undefined) {
          const row = db.contacts.find((c) => c.id === where.id) || null;
          return row && include && include.campaign
            ? { ...row, campaign: db.campaignRow && row.campaignId === db.campaignRow.id ? db.campaignRow : null }
            : row;
        }
        // compound prospectId_campaignId
        const w = where.prospectId_campaignId || {};
        return db.contacts.find((c) => c.prospectId === w.prospectId && c.campaignId === w.campaignId) || null;
      },
      async upsert({ where, create, update }) {
        const w = where.prospectId_campaignId || {};
        let row = db.contacts.find((c) => c.prospectId === w.prospectId && c.campaignId === w.campaignId);
        if (row) {
          Object.assign(row, update);
        } else {
          row = { id: id('ct'), ...create };
          db.contacts.push(row);
        }
        return row;
      },
      async update({ where, data }) {
        const row = db.contacts.find((c) => c.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
    },
    outreachCampaign: {
      async findUnique({ where }) { return db.campaignRow || null; },
    },
    outreachMessage: {
      async findMany() { return []; },
      async create({ data }) {
        const row = { id: id('om'), createdAt: new Date(), ...data };
        db.messages.push(row);
        return row;
      },
    },
    outreachEvent: {
      async create({ data }) {
        db.events.push(data);
        return { id: id('ev'), ...data };
      },
    },
  };
  prisma.db.prospectRow = prospect;
  prisma.db.campaignRow = campaign;
  prisma.db.settings = settings;
  return prisma;
}

const makeFakeQueueFactory = () => {
  const queues = [];
  return {
    queues,
    factory: (name) => {
      const q = {
        name,
        adds: [],
        async getJob() { return null; },
        async add(job, opts) { this.adds.push({ job, opts }); return { id: 'job' }; },
      };
      queues.push(q);
      return q;
    },
  };
};

function baseFixture({ campaignOverrides = {}, settingsOverrides = {} } = {}) {
  const prospect = {
    id: 'pr_1', orgId: 'org_1', contactName: 'Mariana',
    companyName: 'Acme Industria', tradeName: null, industry: 'Metalurgia',
    city: 'Joinville', state: 'SC', employees: 50, revenueEstimate: 1000000,
  };
  const campaign = {
    id: 'camp_1', tenantId: 'org_1', name: 'Campanha Teste',
    status: 'active', trigger: 'manual', source: 'manual',
    objective: null, offer: null,
    emailAccountId: 'ea_1',
    ...campaignOverrides,
  };
  const settings = {
    orgId: 'org_1', companyName: 'MB Máquinas',
    valueProposition: 'corte e dobra de precisão',
    ...settingsOverrides,
  };
  const prisma = makeFakePrisma({ campaign, prospect, settings });
  const { queues, factory } = makeFakeQueueFactory();
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(factory);
  const job = { id: 'job_1', data: { prospectId: 'pr_1', campaignId: 'camp_1', emailAccountId: 'ea_1', tenantId: 'org_1' } };
  return { prisma, queues, job };
}

test('US3 email: template do tenant renderizado com origin "tenant_template"', async () => {
  const { prisma, queues, job } = baseFixture({
    campaignOverrides: {
      emailTemplateSubject: 'Olá {{firstName}}, sobre a {{companyName}}',
      emailTemplateBody: 'Olá {{firstName}}, tudo bem?\n\nMensagem configurada pelo TENANT.',
    },
  });

  const result = await workers.processPrepare(job);

  assert.ok(result.messageId, `mensagem criada (${JSON.stringify(result)})`);
  const message = prisma.db.messages[0];
  assert.ok(message.subject.includes('Mariana'), 'placeholder do tenant resolvido');
  assert.ok(message.body.includes('Mensagem configurada pelo TENANT'));
  assert.strictEqual(message.compositionOrigin, 'tenant_template');
  assert.strictEqual(queues[0].adds.length, 1, 'envio enfileirado');
});

test('US3 email: sem template + IA falha + perfil configurado → base por perfil', async () => {
  const { prisma, job } = baseFixture({
    campaignOverrides: { emailTemplateSubject: null, emailTemplateBody: null },
  });

  const result = await workers.processPrepare(job);

  assert.ok(result.messageId, 'mensagem criada com base por perfil');
  const message = prisma.db.messages[0];
  assert.strictEqual(message.compositionOrigin, 'profile_base');
  assert.ok(message.body.includes('MB Máquinas'), 'identidade do tenant');
  assert.ok(/corte e dobra de precisão/i.test(message.body), 'proposta de valor do tenant');
  // QA 2026-10-06 (159 leads receberam "{{firstName}}" literal): a base do
  // perfil é renderizada POR LEAD — nome resolvido, zero placeholder crua.
  assert.ok(message.body.includes('Olá Mariana'), 'saudação com o nome do lead');
  assert.ok(!message.body.includes('{{'), 'nenhum placeholder residual no body');
  assert.ok(!message.subject.includes('{{'), 'nenhum placeholder no subject');
  assert.ok(!message.htmlBody.includes('{{'), 'nenhum placeholder no htmlBody');
  // Nenhum texto genérico da plataforma (FR-005): sem "agendar uma conversa
  // rápida de 15 min" do antigo _templateFallback.
  assert.ok(!/agendar uma conversa rápida de 15 min/i.test(message.body));
  assert.ok(!/espero que esteja bem/i.test(message.body));
});

test('US3 email: sem template e sem perfil configurado → NADA genérico é enviado', async () => {
  const { prisma, job } = baseFixture({
    campaignOverrides: { emailTemplateSubject: null, emailTemplateBody: null },
    settingsOverrides: { valueProposition: null, productDescription: null },
  });

  const result = await workers.processPrepare(job);

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'no_base_message');
  assert.strictEqual(prisma.db.messages.length, 0, 'nenhuma mensagem criada');
  const contact = prisma.db.contacts[0];
  assert.strictEqual(contact.status, 'CANCELLED');
  assert.strictEqual(contact.cancelReason, 'no_base_message');
});

test('US3 email: IA disponível gera mensagem com origin "ai"', async () => {
  // Stub do gateway LiteLLM (o prepare usa fetch direto).
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        subject: 'Assunto gerado por IA',
        body: 'Corpo gerado por IA para o lead.',
        reasoning_facts: ['fato'],
      }) } }],
    }),
  });
  try {
    const { prisma, job } = baseFixture({
      campaignOverrides: { emailTemplateSubject: null, emailTemplateBody: null },
    });
    const result = await workers.processPrepare(job);
    assert.ok(result.messageId);
    const message = prisma.db.messages[0];
    assert.strictEqual(message.compositionOrigin, 'ai');
    assert.strictEqual(message.subject, 'Assunto gerado por IA');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── Convergence T036: follow-up de email em campanhas IA ────────────────────

test('T036: campanha IA no 1º toque usa a base semeada com origin "profile_base"', async () => {
  const { prisma, job } = baseFixture({
    campaignOverrides: {
      source: 'ai',
      emailTemplateSubject: 'Corte e dobra de precisão',
      emailTemplateBody: 'Olá {{firstName}}, tudo bem?\n\nAqui é o(a) MB Máquinas. Corte e dobra de precisão.',
    },
  });

  const result = await workers.processPrepare(job);

  assert.ok(result.messageId);
  const message = prisma.db.messages[0];
  // A base semeada é composta do perfil (aprovada pelo tenant no approve) —
  // origem auditória honesta é profile_base, não tenant_template.
  assert.strictEqual(message.compositionOrigin, 'profile_base');
  assert.ok(/MB Máquinas/i.test(message.body));
});

test('T036: follow-up de campanha IA é gerado por IA (origin "ai"), não reenvia a base', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({
        subject: 'Retomando — IA',
        body: 'Segunda mensagem gerada por IA sobre a Acme.',
        reasoning_facts: [],
      }) } }],
    }),
  });
  try {
    const { prisma, job } = baseFixture({
      campaignOverrides: {
        source: 'ai',
        emailTemplateSubject: 'Corte e dobra de precisão',
        emailTemplateBody: 'Olá {{firstName}}, tudo bem?',
      },
    });
    job.data._isFollowup = true;
    job.data.followupSequence = 2;
    // histórico: 1º toque já existe
    prisma.db.messages.unshift({ id: 'om_0', subject: 'Primeira', status: 'SENT', createdAt: new Date() });

    const result = await workers.processPrepare(job);

    assert.ok(result.messageId);
    const message = prisma.db.messages.find((m) => m.id === result.messageId);
    assert.strictEqual(message.compositionOrigin, 'ai');
    assert.strictEqual(message.body, 'Segunda mensagem gerada por IA sobre a Acme.');
    assert.strictEqual(message.subject, 'Retomando — IA');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('T036: _scheduleFollowup agenda para campanha IA mesmo com template semeado', async () => {
  const contact = {
    id: 'ct_1', campaignId: 'camp_1', prospectId: 'pr_1', emailAccount_id: 'ea_1',
    status: 'SENT', outreachSequence: 1,
  };
  const campaign = {
    id: 'camp_1', tenantId: 'org_1', name: 'IA', source: 'ai',
    emailTemplateSubject: 'S', emailTemplateBody: 'B',
  };
  const prisma = makeFakePrisma({ campaign, prospect: { id: 'pr_1' }, settings: { orgId: 'org_1' } });
  prisma.db.contacts.push(contact);
  const { queues, factory } = makeFakeQueueFactory();
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(factory);

  await workers._scheduleFollowup(prisma, 'ct_1');

  const prepareQueue = queues.find((q) => q.name === 'outreach:prepare');
  assert.ok(prepareQueue, 'fila de prepare criada');
  assert.strictEqual(prepareQueue.adds.length, 1, 'follow-up agendado para campanha IA');
  assert.strictEqual(prepareQueue.adds[0].job._isFollowup, true);
  assert.strictEqual(prepareQueue.adds[0].job.followupSequence, 2);
  const event = prisma.db.events.find((e) => e.type === 'followup_scheduled');
  assert.ok(event, 'evento followup_scheduled registrado');
});

test('T036: suíte manual com template continua single-shot (sem follow-up)', async () => {
  const contact = {
    id: 'ct_1', campaignId: 'camp_1', prospectId: 'pr_1', emailAccount_id: 'ea_1',
    status: 'SENT', outreachSequence: 1,
  };
  const campaign = {
    id: 'camp_1', tenantId: 'org_1', name: 'Suíte', source: 'manual',
    emailTemplateSubject: 'S', emailTemplateBody: 'B',
  };
  const prisma = makeFakePrisma({ campaign, prospect: { id: 'pr_1' }, settings: { orgId: 'org_1' } });
  prisma.db.contacts.push(contact);
  const { queues, factory } = makeFakeQueueFactory();
  workers._setPrismaForTests(prisma);
  workers._setQueueFactoryForTests(factory);

  await workers._scheduleFollowup(prisma, 'ct_1');

  const prepareQueue = queues.find((q) => q.name === 'outreach:prepare');
  assert.ok(!prepareQueue || prepareQueue.adds.length === 0, 'single-shot preservado');
  assert.strictEqual(prisma.db.events.length, 0);
});
