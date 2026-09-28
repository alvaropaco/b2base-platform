'use strict';

/**
 * test/studio-audience-leads.test.js — GET /campaigns/:id/audience/leads:
 * modo snapshot (revisão: só incluídos) e modo base (seleção: todos os leads
 * da organização com selectedIds = audiência atual), com agrupamento
 * indústria › cidade/UF › porte.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { createStudioRouter } = require('../studio/router');

async function startServer() {
  const app = express();
  app.use(express.json());
  const prisma = createFakePrisma();
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', orgId: 'org-1' };
    next();
  });
  app.use('/api/studio', createStudioRouter(prisma));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, prisma };
}

function seedOrg(prisma) {
  const rows = [
    { id: 'p1', orgId: 'org-1', companyName: 'Metalúrgica Sul', contactName: 'João', industry: 'Metalurgia', city: 'Caxias do Sul', state: 'RS', employees: 120, opportunityScore: 80 },
    { id: 'p2', orgId: 'org-1', companyName: 'Plásticos Gaúcha', contactName: 'Maria', industry: 'Metalurgia', city: 'Porto Alegre', state: 'RS', employees: 30, opportunityScore: 70 },
    { id: 'p3', orgId: 'org-1', companyName: 'TechLeaf', contactName: 'Ana', industry: 'Software', city: 'Florianópolis', state: 'SC', employees: 18, opportunityScore: 60 },
    { id: 'p4', orgId: 'org-1', companyName: 'Sem Tudo', orgOnly: true, industry: null, city: null, state: null, employees: null, opportunityScore: 0 },
  ];
  for (const r of rows) prisma.prospect.rows.push(r);
  prisma.studioCampaign.rows.push({ id: 'camp-1', orgId: 'org-1', name: 'C', status: 'draft', channels: ['email'] });
  prisma.studioAudienceSnapshot.rows.push({
    id: 'snap-1', orgId: 'org-1', campaignId: 'camp-1', criteriaVersion: {},
    totalCount: 2, includedCount: 2, excludedCount: 0, status: 'active',
  });
  prisma.studioAudienceMember.rows.push(
    { snapshotId: 'snap-1', prospectId: 'p1', included: true },
    { snapshotId: 'snap-1', prospectId: 'p3', included: true }
  );
}

test('GET leads (snapshot): só incluídos + agrupamento hierárquico', async () => {
  const { server, base, prisma } = await startServer();
  try {
    seedOrg(prisma);
    const res = await fetch(`${base}/api/studio/campaigns/camp-1/audience/leads`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.total, 2, 'apenas os incluídos no snapshot');
    assert.deepEqual(body.data.selectedIds, ['p1', 'p3']);
    const metal = body.data.groups.find((g) => g.key === 'Metalurgia');
    assert.ok(metal, 'grupo por indústria');
    assert.equal(metal.count, 1);
    assert.ok(metal.subs[0].key.includes('Caxias do Sul'), 'subgrupo por cidade/UF');
    assert.ok(metal.subs[0].subs.some((leaf) => leaf.key.startsWith('Média (51–200)')), 'folha por porte');
  } finally {
    server.close();
  }
});

test('GET leads?source=base: todos os leads da org + selectedIds da audiência atual', async () => {
  const { server, base, prisma } = await startServer();
  try {
    seedOrg(prisma);
    const res = await fetch(`${base}/api/studio/campaigns/camp-1/audience/leads?source=base`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.data.total, 4, 'toda a base da organização');
    assert.deepEqual([...body.data.selectedIds].sort(), ['p1', 'p3'], 'audiência atual pré-marcada');
    assert.ok(body.data.leads.find((l) => l.id === 'p4' && l.industry === null), 'lead sem atributos entra com fallback');
    const semCategoria = body.data.groups.find((g) => g.key === 'Sem categoria');
    assert.ok(semCategoria, 'lead sem indústria agrupa em "Sem categoria"');
    assert.ok(semCategoria.subs[0].key.includes('Cidade não informada'), 'localidade com fallback');
  } finally {
    server.close();
  }
});

test('GET leads sem snapshot: modo base segue funcionando, snapshot retorna vazio', async () => {
  const { server, base, prisma } = await startServer();
  try {
    prisma.prospect.rows.push({ id: 'p1', orgId: 'org-1', companyName: 'Única', industry: 'Tech' });
    prisma.studioCampaign.rows.push({ id: 'camp-2', orgId: 'org-1', name: 'C2', status: 'draft', channels: ['email'] });

    const baseRes = await fetch(`${base}/api/studio/campaigns/camp-2/audience/leads?source=base`);
    const baseBody = await baseRes.json();
    assert.equal(baseBody.data.total, 1, 'base lista mesmo sem snapshot');
    assert.deepEqual(baseBody.data.selectedIds, [], 'nada pré-marcado sem audiência');

    const snapRes = await fetch(`${base}/api/studio/campaigns/camp-2/audience/leads`);
    const snapBody = await snapRes.json();
    assert.equal(snapBody.data.total, 0, 'snapshot vazio sem audiência');
  } finally {
    server.close();
  }
});
