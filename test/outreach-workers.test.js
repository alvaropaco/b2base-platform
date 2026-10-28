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
    // Modelos do Studio (2026-10-26: HTML do disparo vem do emailDoc) —
    // populados via db.studioContentRow / db.studioCampaignRow.
    studioContent: {
      async findFirst({ where }) {
        const row = db.studioContentRow;
        if (!row) return null;
        return Object.entries(where).every(([k, v]) => row[k] === v) ? row : null;
      },
    },
    studioCampaign: {
      async findUnique() { return db.studioCampaignRow || null; },
    },
    studioPersonalization: {
      async findMany() { return []; },
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

// ── 2026-10-26: BOTÃO com link no e-mail REAL (pedido do dono) ──────────────
// O template do motor guarda o emailDoc achatado em TEXTO — o bloco button
// (wa.me) saía como "label: url" plano e o banner nem saía. Com emailDoc, o
// HTML do disparo usa o MESMO renderer da prévia (SC-006: preview ≡ envio).

test('Studio: disparo com emailDoc sai com o botão/link REAL e o banner no HTML', async () => {
  const { prisma, job } = baseFixture({
    campaignOverrides: {
      emailTemplateSubject: 'Olá {{firstName}}, sobre a {{companyName}}',
      emailTemplateBody: 'Olá {{firstName}}, tudo bem?\n\nFalar com a Arthur Company: https://wa.me/5512996399943',
      studioCampaignId: 'sc_1',
    },
  });
  prisma.db.studioContentRow = {
    campaignId: 'sc_1', channel: 'email', kind: 'base', stepIndex: 1,
    emailDoc: {
      blocks: [
        { type: 'text', text: 'Olá {{firstName}}, tudo bem?' },
        { type: 'button', label: 'Falar com a Arthur Company', url: 'https://wa.me/5512996399943' },
        { type: 'image', src: 'https://cdn.exemplo.com/banner.png', alt: 'Banner' },
      ],
    },
  };
  prisma.db.studioCampaignRow = { id: 'sc_1', utmTemplate: {} };

  const result = await workers.processPrepare(job);

  assert.ok(result.messageId, 'mensagem criada');
  const message = prisma.db.messages[0];
  assert.strictEqual(message.compositionOrigin, 'tenant_template');
  const html = String(message.htmlBody);
  assert.ok(html.includes('<a href="https://wa.me/5512996399943"'), 'link do WhatsApp como <a> REAL');
  assert.ok(html.includes('display:inline-block'), 'estilo de BOTÃO (não texto plano)');
  assert.ok(html.includes('<img src="https://cdn.exemplo.com/banner.png"'), 'banner do emailDoc no HTML');
  // Banner CLICÁVEL (2026-10-27): o bloco image NÃO tem href, mas herda a
  // url do button — o clique na arte cai na mesma conversa do WhatsApp.
  const bannerAnchor = html.match(/<a href="([^"]+)"[^>]*><img[^>]*banner\.png/);
  assert.ok(bannerAnchor, 'banner embrulhado em <a>');
  assert.ok(bannerAnchor[1].includes('wa.me/5512996399943'), 'clique no banner cai na conversa do WhatsApp');
  assert.ok(html.includes('Olá Mariana'), 'variáveis do emailDoc resolvidas POR LEAD');
  assert.ok(html.includes('use o link de descadastro'), 'rodapé de descadastro no HTML (FR-37)');
  // Pixel de tracking DENTRO do documento (antes do </body>).
  const pixelAt = html.indexOf('t/o/');
  const bodyCloseAt = html.indexOf('</body>');
  assert.ok(pixelAt > -1 && bodyCloseAt > -1 && pixelAt < bodyCloseAt, 'pixel antes do </body>');
  assert.ok(!html.includes('{{'), 'nenhuma placeholder crua');
  // Parte TEXTO continua a forma achatada (fallback de cliente sem HTML).
  assert.ok(message.body.includes('Falar com a Arthur Company: https://wa.me/5512996399943'));
});

test('Studio: sem emailDoc o disparo mantém o HTML de texto plano (fallback)', async () => {
  const { prisma, job } = baseFixture({
    campaignOverrides: {
      emailTemplateSubject: 'S {{firstName}}',
      emailTemplateBody: 'Corpo em texto simples.',
      studioCampaignId: 'sc_2',
    },
  });
  prisma.db.studioCampaignRow = { id: 'sc_2', utmTemplate: {} };
  // Sem db.studioContentRow → findFirst null → fallback atual.

  await workers.processPrepare(job);

  const message = prisma.db.messages[0];
  assert.ok(String(message.htmlBody).startsWith('<p>'), 'HTML segue o parágrafo escapado de sempre');
  assert.ok(!String(message.htmlBody).includes('<a href='), 'nenhum link inventado sem emailDoc');
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

test('Studio: src de PÁGINA no emailDoc é resolvido NO PREPARE, promovido e PERSISTIDO', async () => {
  const IMG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f030005fe02fea72d8b300000000049454e44ae426082', 'hex');
  const base = baseFixture({
    campaignOverrides: {
      emailTemplateSubject: 'Oi {{firstName}}',
      emailTemplateBody: 'Corpo.',
      studioCampaignId: 'sc_page_src',
    },
  });
  const { prisma, job } = base;
  // Storage real apontando para tmp (o banner promovido precisa existir).
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'page-src-resolve-'));
  const prevStorage = process.env.STUDIO_STORAGE_DIR;
  process.env.STUDIO_STORAGE_DIR = tmp;
  prisma.db.studioContentRow = {
    campaignId: 'sc_page_src', channel: 'email', kind: 'base', stepIndex: 1,
    emailDoc: {
      blocks: [
        { type: 'image', src: 'https://galeria.exemplo.com/a/test123', href: 'https://wa.me/5512996399943' },
        { type: 'button', label: 'Falar com a gente no WhatsApp', url: 'https://wa.me/5512996399943' },
      ],
    },
  };
  prisma.db.studioCampaignRow = { id: 'sc_page_src', utmTemplate: {} };

  // Stub do fetch: página do álbum (og:image) + download da imagem direta.
  const realFetch = global.fetch;
  let updatedDoc = null;
  global.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://galeria.exemplo.com/a/test123') {
      return { ok: true, status: 200, text: async () => '<meta property="og:image" content="https://cdn.exemplo.com/direct99.jpg" />' };
    }
    if (u === 'https://cdn.exemplo.com/direct99.jpg') {
      return { ok: true, status: 200, arrayBuffer: async () => IMG.buffer.slice(IMG.byteOffset, IMG.byteOffset + IMG.byteLength) };
    }
    throw new Error('fetch inesperado: ' + u);
  };
  const origUpdateMany = prisma.studioContent.updateMany;
  prisma.studioContent.updateMany = async ({ where, data }) => {
    updatedDoc = data.emailDoc;
    if (prisma.db.studioContentRow && prisma.db.studioContentRow.campaignId === where.campaignId) {
      prisma.db.studioContentRow.emailDoc = data.emailDoc;
    }
    return { count: 1 };
  };

  try {
    const result = await workers.processPrepare(job);
    assert.ok(result.messageId, 'mensagem criada');
    const html = String(prisma.db.messages[0].htmlBody);
    assert.ok(!html.includes('galeria.exemplo.com/a/test123'), 'nenhum src de página no e-mail');
    assert.match(html, /\/media\/[a-f0-9]{32}\.jpg/, 'banner promovido com src local');
    assert.ok(updatedDoc, 'emailDoc persistido na origem');
    const persistedImg = updatedDoc.blocks.find((b) => b.type === 'image');
    assert.match(persistedImg.src, /^\/media\/[a-f0-9]{32}\.jpg$/, 'emailDoc na origem aponta para o arquivo promovido');
    assert.ok(require('fs').existsSync(path.join(tmp, 'generated', persistedImg.src.split('/media/')[1])), 'bytes reais no storage público');
    // CID no send: a extração do html resolvido embute os bytes.
    const { extractInlineImages } = require('../studio/email-inline');
    const { inlineImages } = extractInlineImages(html, { readGenerated: require('../studio/storage').readGenerated });
    assert.equal(inlineImages.length, 1);
    assert.deepEqual(Buffer.from(inlineImages[0].content, 'base64'), IMG);
  } finally {
    global.fetch = realFetch;
    prisma.studioContent.updateMany = origUpdateMany;
    process.env.STUDIO_STORAGE_DIR = prevStorage;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
