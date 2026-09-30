'use strict';

/**
 * test/email-provider-connect.test.js — Conectar Resend registra a
 * autenticação de domínio que o provedor já exigiu na conexão (2026-09-29).
 * Sem isso, o piso efetivo do Orçamento de Reputação engolia o saldo inteiro
 * (domainAuthStatus 'unverified') e a campanha aparecia como "0 envios
 * disponíveis" mesmo com o canal conectado. Nada de rede: fetch do Resend
 * é stubado.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');

process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || 'a'.repeat(64);

const emailProvider = require('../email-provider');

function stubResend(domains) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/domains')) {
      return { ok: true, status: 200, json: async () => ({ data: domains }) };
    }
    throw new Error(`fetch inesperado no teste: ${url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function seedOrgUser(prisma) {
  prisma.user.rows.push({ id: 'user-1', orgId: 'org-1' });
  return prisma;
}

test('connect Resend com domínio verificado registra autenticação no EmailAccount e no saldo do Studio', async () => {
  const restore = stubResend([{ name: 'empresa.com', status: 'verified' }]);
  try {
    const prisma = seedOrgUser(createFakePrisma());
    const account = await emailProvider.connectEmailAccount(prisma, {
      provider: 'resend',
      email: 'vendas@empresa.com',
      secret: 're_chave_teste',
      userId: 'user-1',
    });

    assert.equal(account.status, 'connected');
    assert.equal(account.sendingDomain, 'empresa.com');
    assert.equal(account.domainAuthStatus, 'verified', 'Resend só conecta com domínio verificado — registra na conexão');
    assert.ok(account.domainAuthVerifiedAt);
    assert.equal(account.domainAuthDetail.source, 'resend-connect');

    const rep = prisma.studioReputationAccount.rows.find(
      (r) => r.orgId === 'org-1' && r.channel === 'email'
    );
    assert.ok(rep, 'conta de reputação do Studio criada');
    assert.equal(rep.domainAuthStatus, 'verified', 'piso efetivo liberado sem esperar o job diário de DNS');
  } finally {
    restore();
  }
});

test('connect Resend sem domínio verificado falha cedo e não registra nada', async () => {
  const restore = stubResend([{ name: 'outra.com', status: 'verified' }]);
  try {
    const prisma = seedOrgUser(createFakePrisma());
    await assert.rejects(
      () =>
        emailProvider.connectEmailAccount(prisma, {
          provider: 'resend',
          email: 'vendas@empresa.com',
          secret: 're_chave',
          userId: 'user-1',
        }),
      /não está verificado no Resend/
    );
    assert.equal(prisma.emailAccount.rows.length, 0);
    assert.equal(prisma.studioReputationAccount.rows.length, 0);
  } finally {
    restore();
  }
});

test('reconectar Resend atualiza o estado de autenticação da conta existente', async () => {
  const restore = stubResend([{ name: 'empresa.com', status: 'verified' }]);
  try {
    const prisma = seedOrgUser(createFakePrisma());
    prisma.emailAccount.rows.push({
      id: 'ea-1',
      userId: 'user-1',
      tenantId: 'org-1',
      provider: 'resend',
      email: 'vendas@empresa.com',
      status: 'error',
      domainAuthStatus: 'failed',
    });
    await emailProvider.connectEmailAccount(prisma, {
      provider: 'resend',
      email: 'vendas@empresa.com',
      secret: 're_chave',
      userId: 'user-1',
    });
    const row = prisma.emailAccount.rows[0];
    assert.equal(row.status, 'connected');
    assert.equal(row.domainAuthStatus, 'verified', 'reconexão conserta o estado antigo');
    const rep = prisma.studioReputationAccount.rows.find(
      (r) => r.orgId === 'org-1' && r.channel === 'email'
    );
    assert.equal(rep.domainAuthStatus, 'verified');
  } finally {
    restore();
  }
});
