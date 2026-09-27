'use strict';

/**
 * studio/dns-verify.js — Autenticação de domínio VERIFICADA, não declarada
 * (specs/011, AD-8; FR-16/FR-28).
 *
 * Verifica SPF/DKIM/DMARC por DNS real na configuração do canal de e-mail e
 * roda o job diário de revalidação (repeat job BullMQ em produção; chamado
 * direto nos testes). Falha na revalidação → domainAuthStatus='failed' →
 * floor efetivo do saldo vira zero (o gate bloqueia com instrução).
 */

const dns = require('dns');
const reputation = require('./reputation');

const RESOLVER = {
  resolveTxt: (name) => new Promise((resolve, reject) => {
    dns.resolveTxt(name, (err, records) => (err ? reject(err) : resolve(records)));
  }),
};

function domainFromEmail(email) {
  const at = String(email || '').lastIndexOf('@');
  return at >= 0 ? String(email).slice(at + 1).trim().toLowerCase() : null;
}

function hasSpf(records) {
  return records.some((chunks) => chunks.join('').toLowerCase().startsWith('v=spf1'));
}

/**
 * DKIM: procura um seletor comum sob `._domainkey.<domain>` — gmail usa
 * `google._domainkey`. Verifica qualquer um dos seletores padrão.
 */
const DKIM_SELECTORS = ['google', 'default', 'selector1', 's1', 'k1', 'dkim'];

async function checkDomain(domain, resolver = RESOLVER) {
  const detail = { domain, spf: false, dkim: false, dmarc: false };
  const safeResolveTxt = async (name) => {
    try {
      return await resolver.resolveTxt(name);
    } catch (_) {
      return [];
    }
  };

  const [txt, dkimTxts, dmarc] = await Promise.all([
    safeResolveTxt(domain),
    Promise.all(DKIM_SELECTORS.map((sel) => safeResolveTxt(`${sel}._domainkey.${domain}`))),
    safeResolveTxt(`_dmarc.${domain}`),
  ]);

  detail.spf = hasSpf(txt);
  // DKIM: registro DKIM legítimo carrega a chave pública ('p='); alguns
  // seletores não têm 'dkim' no valor — aceitamos qualquer uma das formas.
  detail.dkim = dkimTxts.some((records) =>
    records.some((chunks) => {
      const joined = chunks.join('').toLowerCase();
      return joined.includes('dkim') || joined.includes('p=');
    })
  );
  detail.dmarc = dmarc.some((chunks) => chunks.join('').toLowerCase().startsWith('v=dmarc1'));

  // Pré-condição do gate: SPF + DKIM (FR-16). DMARC é recomendado (quando
  // aplicável), mas o bloqueio nasce de SPF+DKIM.
  detail.verified = detail.spf && detail.dkim;
  return detail;
}

/**
 * Verifica e persiste o estado de autenticação de domínio de TODAS as contas
 * de e-mail conectadas da org. Retorna o status consolidado da org.
 */
async function verifyOrgDomain(prisma, orgId, { resolver = RESOLVER, history = null } = {}) {
  const accounts = await prisma.emailAccount.findMany({
    where: { tenantId: orgId, status: 'connected' },
  });
  if (accounts.length === 0) {
    return { orgId, status: 'unverified', detail: { reason: 'sem conta de e-mail conectada' } };
  }

  // v1 assume 1 domínio por org (PRD §9): verifica a primeira conta conectada.
  const account = accounts[0];
  const domain = account.sendingDomain || domainFromEmail(account.email);
  if (!domain) {
    return { orgId, status: 'unverified', detail: { reason: 'domínio de envio desconhecido' } };
  }

  const detail = await checkDomain(domain, resolver);
  const status = detail.verified ? 'verified' : 'failed';
  const checkedAt = new Date();

  await prisma.emailAccount.updateMany({
    where: { id: account.id },
    data: { sendingDomain: domain, domainAuthStatus: status, domainAuthDetail: detail, domainAuthVerifiedAt: detail.verified ? checkedAt : account.domainAuthVerifiedAt || null },
  });
  await reputation.recordDomainAuth(prisma, orgId, { status, detail, checkedAt, history });

  console.log(`[studio:dns] org ${orgId} domínio ${domain}: spf=${detail.spf} dkim=${detail.dkim} → ${status}`);
  return { orgId, domain, status, detail };
}

/**
 * Job diário de revalidação (AD-8): re-verifica todas as orgs com conta de
 * e-mail conectada. Falha → floor 0 (gate bloqueia com instrução); DNS verde
 * libera o saldo da regra.
 */
async function runDailyVerification(prisma, { resolver = RESOLVER } = {}) {
  const accounts = await prisma.emailAccount.findMany({
    where: { status: 'connected' },
  });
  const orgIds = [...new Set(accounts.map((a) => a.tenantId))];
  const results = [];
  const autonomy = require('./autonomy');
  for (const orgId of orgIds) {
    // Estado anterior: só domínio VERIFICADO que falha desperta (FR-31).
    let previous = null;
    try {
      const acc = await prisma.studioReputationAccount.findFirst({ where: { orgId, channel: 'email' } });
      previous = acc ? acc.domainAuthStatus : null;
    } catch (_) { /* segue com previous null */ }
    try {
      const result = await verifyOrgDomain(prisma, orgId, { resolver });
      if (previous === 'verified' && result.status === 'failed') {
        await autonomy.report(prisma, {
          orgId,
          type: 'studio.domain.auth_failed',
          details: { domain: result.domain },
        }).catch(() => {});
      }
      results.push(result);
    } catch (err) {
      // Fail-closed: erro de DNS não pode deixar status stale "verified".
      console.error(`[studio:dns] revalidação falhou para org ${orgId}:`, err.message);
      await reputation.recordDomainAuth(prisma, orgId, {
        status: 'failed',
        detail: { reason: `revalidação falhou: ${err.message}` },
      }).catch(() => {});
      if (previous === 'verified') {
        await autonomy.report(prisma, {
          orgId,
          type: 'studio.domain.auth_failed',
          details: { reason: err.message },
        }).catch(() => {});
      }
      results.push({ orgId, status: 'failed', error: err.message });
    }
  }
  return results;
}

/** Registro do repeat job diário (produção). Testes chamam runDailyVerification. */
function registerDailyJob(prisma) {
  try {
    const { createQueue } = require('../outreach-queues');
    const queue = createQueue('studio:domain-verify');
    queue
      .add('verify', {}, { repeat: { cron: '17 6 * * *' }, jobId: 'studio-domain-verify-daily' })
      .then(() => console.log('[studio:dns] ✓ repeat job diário registrado (06:17)'))
      .catch((err) => console.error('[studio:dns] falha ao registrar repeat job:', err.message));
    queue.process(async () => runDailyVerification(prisma));
    return queue;
  } catch (err) {
    console.error('[studio:dns] registro indisponível:', err.message);
    return null;
  }
}

module.exports = { verifyOrgDomain, runDailyVerification, checkDomain, registerDailyJob, domainFromEmail, _resolver: RESOLVER };
