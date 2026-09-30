'use strict';

/**
 * test/cnpj-enrichment-searchtext.test.js — Epic 1 (FR4): o enriquecimento
 * CNPJ grava identidade/setor e o `Prospect.searchText` é recalculado da
 * LINHA FINAL (patch ∪ linha) — hook de escrita do matching de segmento.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const { enrichProspectWithCnpj } = require('../cnpj-enrichment');
const { buildSearchText } = require('../search-text');

const BRASILAPI_PAYLOAD = {
  razao_social: 'Metalúrgica Taunus LTDA',
  nome_fantasia: 'Taunus',
  cnae_fiscal_descricao: 'Fabricação de estruturas metálicas',
  email: 'contato@taunus.com.br',
  ddd_telefone_1: '1140028922',
};

test('enrichProspectWithCnpj: searchText recalculado da LINHA FINAL (patch ∪ linha)', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => BRASILAPI_PAYLOAD });
  try {
    const prisma = createFakePrisma();
    prisma.organization.rows.push({ id: 'org-1', plan: 'trial' });
    // Já tinha companyName de import CSV; o CNPJ traz razão social/setor novos.
    const prospect = {
      id: 'p1', orgId: 'org-1', cnpj: '12.345.678/0001-95', status: 'prospect',
      companyName: 'Taunus Importadora', industry: null,
      searchText: 'taunus importadora',
      enrichmentSource: 'nats.enrichment',
    };
    prisma.prospect.rows.push(prospect);

    const updated = await enrichProspectWithCnpj(prisma, prospect);

    assert.notEqual(updated.enrichmentStatus, 'error', 'enriquecimento conclui sem erro');
    assert.equal(updated.industry, 'Fabricação de estruturas metálicas');
    assert.equal(updated.tradeName, 'Taunus');
    // Linha final = patch do CNPJ ∪ linha anterior — NUNCA só o patch.
    const expected = buildSearchText({
      industry: 'Fabricação de estruturas metálicas',
      companyName: 'Metalúrgica Taunus LTDA',
      tradeName: 'Taunus',
    });
    assert.equal(updated.searchText, expected, 'searchText cobre TODOS os campos da linha final');
    assert.ok(updated.searchText.includes('fabricacao de estruturas metalicas'), 'setor acentuado normalizado');
    assert.ok(updated.searchText.includes('taunus'), 'identidade do CNPJ presente');
  } finally {
    global.fetch = originalFetch;
  }
});
