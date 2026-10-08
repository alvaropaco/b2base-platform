'use strict';

/**
 * test/studio-dns-verify.test.js — Autenticação de domínio VERIFICADA, não
 * declarada (specs/011, AD-8; FR-16/FR-28). Resolver DNS injetado: nada de
 * rede na suíte. SPF/DKIM (inclusive registro com 'p=' sem 'dkim' no valor),
 * persistência do estado e revalidação diária fail-closed com Despertar.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createFakePrisma } = require('./helpers/fake-prisma');
const dnsVerify = require('../studio/dns-verify');

const RESOLVER_OK = {
  resolveTxt: async (name) => {
    if (name.startsWith('_dmarc.')) return [['v=DMARC1; p=none']];
    if (name.includes('_domainkey')) return [['v=DKIM1; k=rsa; p=MIIBIjANBg']];
    if (name === 'empresa.com') return [['v=spf1 include:_spf.google.com ~all']];
    return [];
  },
};

// DKIM sem a substring "dkim" no valor: só a chave pública 'p='.
const RESOLVER_DKIM_P_ONLY = {
  resolveTxt: async (name) => {
    if (name === 'k1._domainkey.minha.com') return [['k=rsa; p=MIIBIjANBgkq']];
    if (name === 'minha.com') return [['v=spf1 -all']];
    return [];
  },
};

const RESOLVER_VAZIO = {
  resolveTxt: async () => [],
};

function seedOrg(prisma, { status = null } = {}) {
  prisma.organization.rows.push({ id: 'org-1', plan: 'premium' });
  prisma.emailAccount.rows.push({ id: 'ea-1', tenantId: 'org-1', userId: 'user-1', provider: 'gmail', email: 'venda@empresa.com', status: 'connected' });
  if (status) {
    prisma.studioReputationAccount.rows.push({
      id: 'acc-1', orgId: 'org-1', channel: 'unified',
      balance: 100, floor: 10, ceiling: 100, rampStage: 0,
      domainAuthStatus: status, domainAuthDetail: {},
    });
  }
  return prisma;
}

test('checkDomain: SPF + DKIM detectados; DMARC reportado; sem registros → falha', async () => {
  const ok = await dnsVerify.checkDomain('empresa.com', RESOLVER_OK);
  assert.equal(ok.spf, true);
  assert.equal(ok.dkim, true);
  assert.equal(ok.dmarc, true);
  assert.equal(ok.verified, true);

  const vazio = await dnsVerify.checkDomain('sem-dns.com', RESOLVER_VAZIO);
  assert.equal(vazio.spf, false);
  assert.equal(vazio.dkim, false);
  assert.equal(vazio.verified, false);
});

test('checkDomain: DKIM legítimo sem "dkim" no valor (só "p=") NÃO é falso-negativo', async () => {
  const result = await dnsVerify.checkDomain('minha.com', RESOLVER_DKIM_P_ONLY);
  assert.equal(result.spf, true);
  assert.equal(result.dkim, true, 'registro com p= é DKIM válido');
  assert.equal(result.verified, true);
});

test('checkDomain: DKIM do Resend (seletor resend._domainkey) é reconhecido', async () => {
  const RESOLVER_RESEND = {
    resolveTxt: async (name) => {
      if (name === 'resend._domainkey.empresa.com') return [['v=DKIM1; k=rsa; p=MIIBIjANBg']];
      if (name === 'empresa.com') return [['v=spf1 include:amazonses.com ~all']];
      return [];
    },
  };
  const result = await dnsVerify.checkDomain('empresa.com', RESOLVER_RESEND);
  assert.equal(result.dkim, true, 'domínio configurado no Resend publica resend._domainkey');
  assert.equal(result.verified, true, 'revalidação diária não derruba o que a conexão registrou');
});

test('verifyOrgDomain: verifica, persiste no EmailAccount e na account de saldo', async () => {
  const prisma = seedOrg(createFakePrisma());
  const result = await dnsVerify.verifyOrgDomain(prisma, 'org-1', { resolver: RESOLVER_OK });
  assert.equal(result.status, 'verified');
  assert.equal(result.domain, 'empresa.com');

  const account = prisma.emailAccount.rows[0];
  assert.equal(account.domainAuthStatus, 'verified');
  assert.equal(account.sendingDomain, 'empresa.com');
  assert.ok(account.domainAuthVerifiedAt);
  assert.equal(account.domainAuthDetail.spf, true);

  const reputation = prisma.studioReputationAccount.rows[0];
  assert.equal(reputation.domainAuthStatus, 'verified', 'floor efetivo liberado (FR-16)');
  assert.ok(reputation.domainAuthCheckedAt);
});

test('verifyOrgDomain com history (FR-28): pré-aquecido eleva o piso', async () => {
  const prisma = seedOrg(createFakePrisma());
  await dnsVerify.verifyOrgDomain(prisma, 'org-1', { resolver: RESOLVER_OK, history: 'pre-aquecido' });
  assert.equal(prisma.studioReputationAccount.rows[0].floor > 0, true, 'piso elevado pelo histórico');
});

test('runDailyVerification fail-closed: domínio VERIFICADO que perde DNS → failed + Despertar', async () => {
  const prisma = seedOrg(createFakePrisma(), { status: 'verified' });
  const results = await dnsVerify.runDailyVerification(prisma, { resolver: RESOLVER_VAZIO });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'failed');
  assert.equal(prisma.studioReputationAccount.rows[0].domainAuthStatus, 'failed', 'floor efetivo zero');
  const wakes = prisma.opsNotification.rows.filter((n) => n.kind === 'wake');
  assert.equal(wakes.length, 1, 'despertar studio.domain.auth_failed');
  assert.equal(wakes[0].payload.type, 'studio.domain.auth_failed');
});

test('runDailyVerification: domínio já unverified que falha de novo NÃO desperta de novo', async () => {
  const prisma = seedOrg(createFakePrisma(), { status: 'unverified' });
  await dnsVerify.runDailyVerification(prisma, { resolver: RESOLVER_VAZIO });
  assert.equal(prisma.opsNotification.rows.filter((n) => n.kind === 'wake').length, 0);
});

test('runDailyVerification: DNS verde em domínio verificado segue verde, sem despertar', async () => {
  const prisma = seedOrg(createFakePrisma(), { status: 'verified' });
  const results = await dnsVerify.runDailyVerification(prisma, { resolver: RESOLVER_OK });
  assert.equal(results[0].status, 'verified');
  assert.equal(prisma.opsNotification.rows.filter((n) => n.kind === 'wake').length, 0);
});
