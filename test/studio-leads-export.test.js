'use strict';

/**
 * test/studio-leads-export.test.js — planilha em PDF dos leads pelo chat
 * (action export_leads, 2026-10-15): colunas do catálogo, escopo
 * audiência/base/nomes, gate Premium (mesmo do CSV do painel), anexo no
 * storage do Studio com download autenticado e replay idempotente.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');
const { buildLeadsPdf } = require('../studio/leads-pdf');
const { normalizeExportColumns, canonicalColumn } = require('../studio/lead-export-columns');

process.env.STUDIO_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-leads-export-'));

// LLM mockado: orquestrador e segmento-NL respondem JSON estável. Pedido de
// planilha (a frase exata do dono no QA) → emitir export_leads.
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
    if (/planilha/i.test(user)) {
      return {
        content: JSON.stringify({
          reply: 'Prontinho — a planilha ficou pronta aqui embaixo.',
          actions: [{ type: 'export_leads', columns: ['nome', 'whatsapp', 'email'] }],
        }),
      };
    }
    return { content: JSON.stringify({ reply: 'Entendi.', actions: [{ type: 'none' }] }) };
  };
}

async function startServer({ plan = 'premium' } = {}) {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  prisma.organization.rows.push({ id: 'org-1', plan });
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
    const type = res.headers.get('content-type') || '';
    const bodyParsed = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { res, body: bodyParsed };
  };
  return { server, prisma, api };
}

function seedLeads(prisma) {
  prisma.prospect.rows.push(
    {
      id: 'l1', orgId: 'org-1', companyName: 'ACME Indústria Ltda', tradeName: 'ACME',
      cnpj: '12.345.678/0001-90', cnpjEmail: 'contato@acme.com.br',
      cnpjPhones: ['+5512999991234', '12 3634-0000'],
      city: 'São José dos Campos', state: 'SP', industry: 'metalurgia', employees: 120,
      opportunityScore: 90, status: 'qualified', createdAt: new Date('2026-10-01'),
    },
    {
      id: 'l2', orgId: 'org-1', companyName: 'Beltrão & Cia', cnpjEmail: 'vendas@beltrao.com',
      cnpjPhones: JSON.stringify(['11987654321']), // Json pode virar string no banco
      city: 'Campinas', state: 'SP', industry: 'comércio', opportunityScore: 70,
      status: 'prospect', createdAt: new Date('2026-10-02'),
    },
    {
      id: 'l3', orgId: 'org-2', companyName: 'Lead de OUTRA org', cnpjEmail: 'nao@pode.com',
      status: 'prospect', createdAt: new Date('2026-10-03'),
    }
  );
}

// ── catálogo de colunas ──────────────────────────────────────────────────────

test('colunas: apelidos viram canônico; default = nome, whatsapp, email', () => {
  assert.deepEqual(normalizeExportColumns(undefined), ['nome', 'whatsapp', 'email']);
  assert.deepEqual(normalizeExportColumns([]), ['nome', 'whatsapp', 'email']);
  assert.deepEqual(normalizeExportColumns(['empresa', 'telefone', 'e-mail']), ['nome', 'whatsapp', 'email']);
  assert.deepEqual(normalizeExportColumns(['nome', 'cidade', 'nome', 'CIDADE']), ['nome', 'cidade'], 'dedupe, ordem do pedido');
  assert.equal(canonicalColumn('planilha'), null, 'desconhecida não vira coluna');
});

// ── leads-pdf: buffer válido ────────────────────────────────────────────────

test('buildLeadsPdf: %PDF válido, acentos e paginação', () => {
  const one = buildLeadsPdf({
    title: 'Leads — Indústrias',
    subtitle: 'Gerado em 15/10/2026 · 2 lead(s)',
    columns: [{ label: 'Nome' }, { label: 'WhatsApp' }],
    rows: [['ACME Indústria', '+55 (12) 99999-1234']],
  });
  assert.ok(one.slice(0, 5).toString('latin1') === '%PDF-', 'magic header');
  const oneText = one.toString('latin1');
  assert.ok(oneText.includes('ACME Ind\\u00fastria') || oneText.includes('Indústria'), 'texto com acento entra no stream');
  assert.ok(oneText.includes('%%EOF'));

  const many = buildLeadsPdf({
    title: 'Leads',
    columns: [{ label: 'Nome' }],
    rows: Array.from({ length: 100 }, (_, i) => [`Empresa ${i}`]),
  });
  const pages = (many.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
  assert.ok(pages > 1, `100 linhas paginam (veio ${pages} página(s))`);
});

// ── action export_leads ─────────────────────────────────────────────────────

test('export_leads: gera PDF com nome/WhatsApp/e-mail como anexo da campanha', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Indústrias SP', channels: ['email'] });
    const campaignId = c.data.id;
    seedLeads(prisma);

    const out = await api('POST', `/campaigns/${campaignId}/actions`, {
      type: 'export_leads',
      params: { columns: ['empresa', 'telefone', 'e-mail'] },
    });
    assert.equal(out.res.status, 200);
    const card = out.body.data.card;
    assert.equal(card.type, 'leads_export');
    assert.equal(card.total, 2, 'só a base da org — lead de outra org NUNCA entra');
    assert.ok(card.attachmentId, 'card traz o anexo para download');
    assert.equal(card.campaignId, campaignId);
    assert.match(card.fileName, /^leads-industrias-sp-\d{4}-\d{2}-\d{2}\.pdf$/);

    // Anexo registrado no banco (org+campanha) e arquivo no storage.
    assert.equal(prisma.studioAttachment.rows.length, 1);
    const att = prisma.studioAttachment.rows[0];
    assert.equal(att.mimeType, 'application/pdf');
    assert.equal(att.orgId, 'org-1');
    assert.equal(att.campaignId, campaignId);
    const stored = fs.readFileSync(path.join(process.env.STUDIO_STORAGE_DIR, att.fileName));
    const text = stored.toString('latin1').replace(/\\([()\\])/g, '$1'); // de-escape de string PDF
    assert.ok(text.startsWith('%PDF-'), 'arquivo salvo é PDF de verdade');
    assert.ok(text.includes('ACME Ind'), 'nome do lead no PDF');
    assert.ok(text.includes('+55 (12) 99999-1234'), 'WhatsApp formatado e legível');
    assert.ok(text.includes('contato@acme.com.br'), 'e-mail do lead no PDF');
    assert.ok(!text.includes('nao@pode.com'), 'dado de OUTRA org nunca vaza');
  } finally {
    server.close();
  }
});

test('export_leads: escopo audiência (snapshot) e por nomes citados', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Escopo', channels: ['email'] });
    const campaignId = c.data.id;
    seedLeads(prisma);
    // Audiência materializada com SÓ o l1 (snapshot direto — o teste é do
    // ESCOPO da exportação, não da tradução NL→critérios).
    prisma.studioAudienceSnapshot.rows.push({ id: 'snap-1', campaignId, status: 'active', includedCount: 1 });
    prisma.studioAudienceMember.rows.push({ id: 'm-1', snapshotId: 'snap-1', prospectId: 'l1', included: true });

    const baseExport = await api('POST', `/campaigns/${campaignId}/actions`, {
      type: 'export_leads', params: { scope: 'base' },
    });
    assert.equal(baseExport.body.data.card.total, 2, 'scope base = toda a base da org');

    const audExport = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'export_leads', params: {} });
    assert.equal(audExport.body.data.card.total, 1, 'sem scope = audiência da campanha');

    const namesExport = await api('POST', `/campaigns/${campaignId}/actions`, {
      type: 'export_leads', params: { names: ['Beltrão'] },
    });
    assert.equal(namesExport.body.data.card.total, 1, 'nomes citados recortam o escopo');
    const att = prisma.studioAttachment.rows[namesExport.body.data.card.attachmentId ? prisma.studioAttachment.rows.length - 1 : 0];
    const text = fs.readFileSync(path.join(process.env.STUDIO_STORAGE_DIR, att.fileName)).toString('latin1');
    assert.ok(text.includes('Beltr'), 'lead citado no PDF');
    assert.ok(!text.includes('ACME'), 'lead fora do recorte fica de fora');
  } finally {
    server.close();
  }
});

test('export_leads: replay do MESMO pedido devolve o MESMO anexo (sem PDF duplicado)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Replay', channels: ['email'] });
    const campaignId = c.data.id;
    seedLeads(prisma);
    const path = `/campaigns/${campaignId}/actions`;
    const payload = { type: 'export_leads', actionId: 'tap-export-1', params: {} };
    const first = await api('POST', path, payload);
    const second = await api('POST', path, payload);
    assert.equal(first.res.status, 200);
    assert.equal(second.body.data.card.replayed, true);
    assert.equal(second.body.data.card.attachmentId, first.body.data.card.attachmentId, 'mesmo link no replay');
    assert.equal(prisma.studioAttachment.rows.length, 1, 'nenhum PDF duplicado');
  } finally {
    server.close();
  }
});

test('export_leads: trial, PELA CONVERSA, recebe card honesto de Premium e NADA é gerado', async () => {
  const { server, prisma, api } = await startServer({ plan: 'trial' });
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Trial', channels: ['email'] });
    seedLeads(prisma);
    // Pelo CHAT (sem gate de rota — trial usa o cockpit): a frase do dono.
    const turn = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'faça uma planilha pdf com o nome, whatsapp e email dos leads',
    });
    assert.equal(turn.res.status, 200);
    const card = (turn.body.data.cards || []).find((k) => k.type === 'leads_export');
    assert.ok(card, 'card de exportação no turno');
    assert.equal(card.premiumRequired, true);
    assert.ok(!card.attachmentId, 'sem anexo no trial');
    assert.equal(prisma.studioAttachment.rows.length, 0, 'nenhum arquivo gerado');
    assert.match(card.detail, /Premium/);
  } finally {
    server.close();
  }
});

test('chat: "faça uma planilha pdf…" (a frase do dono) gera o card com download', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Frase do dono', channels: ['email'] });
    seedLeads(prisma);
    const turn = await api('POST', `/campaigns/${c.data.id}/chat`, {
      message: 'faça uma planilha pdf com o nome, whatsapp e email dos leads',
    });
    assert.equal(turn.res.status, 200);
    const card = (turn.body.data.cards || []).find((k) => k.type === 'leads_export');
    assert.ok(card, 'a action export_leads EXECUTA pelo chat');
    assert.equal(card.total, 2);
    assert.ok(card.attachmentId, 'card traz o anexo para o botão de download');
    assert.deepEqual(card.columns, ['Nome', 'WhatsApp', 'E-mail']);
    assert.equal(prisma.studioAttachment.rows.length, 1);
  } finally {
    server.close();
  }
});

test('export_leads: coluna desconhecida → 400 com o catálogo; base vazia é honesto', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Vazio', channels: ['email'] });
    const campaignId = c.data.id;

    const bad = await api('POST', `/campaigns/${campaignId}/actions`, {
      type: 'export_leads', params: { columns: ['nome', 'cpf'] },
    });
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error, 'INVALID_ACTION_PARAMS');
    assert.match(bad.body.message, /cpf/);

    const empty = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'export_leads', params: {} });
    assert.equal(empty.res.status, 200);
    assert.equal(empty.body.data.card.type, 'leads_export');
    assert.equal(empty.body.data.card.total, 0, 'sem leads → card explicável, não erro');
    assert.equal(prisma.studioAttachment.rows.length, 0);
  } finally {
    server.close();
  }
});

test('download do anexo: bytes do PDF com escopo de org+campanha (404 fora)', async () => {
  const { server, prisma, api } = await startServer();
  try {
    const { body: c } = await api('POST', '/campaigns', { name: 'Download', channels: ['email'] });
    const campaignId = c.data.id;
    seedLeads(prisma);
    const out = await api('POST', `/campaigns/${campaignId}/actions`, { type: 'export_leads', params: {} });
    const { attachmentId } = out.body.data.card;

    const file = await api('GET', `/campaigns/${campaignId}/attachments/${attachmentId}/file`);
    assert.equal(file.res.status, 200);
    assert.equal(file.res.headers.get('content-type'), 'application/pdf');
    assert.ok(file.body.slice(0, 5).toString('latin1') === '%PDF-', 'serve o PDF de verdade');
    const disposition = file.res.headers.get('content-disposition');
    assert.match(disposition, /filename="/, 'Content-Disposition attachment');

    // Outra campanha da MESMA org → 404 (anexo não é global).
    const { body: c2 } = await api('POST', '/campaigns', { name: 'Outra', channels: ['email'] });
    const wrongCampaign = await api('GET', `/campaigns/${c2.data.id}/attachments/${attachmentId}/file`);
    assert.equal(wrongCampaign.res.status, 404);
    // Anexo inexistente → 404.
    const missing = await api('GET', `/campaigns/${campaignId}/attachments/att-inexistente/file`);
    assert.equal(missing.res.status, 404);
  } finally {
    server.close();
  }
});
