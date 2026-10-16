/**
 * B2Base — Área administrativa (admin)
 * =====================================================================
 * Admin isolado e independente do Firebase. Autenticação BÁSICA com
 * login/senha vindos do Infisical (env do deploy), não do banco de
 * usuários da plataforma.
 *
 * Variáveis de ambiente (populadas via Infisical no cluster, path /b2base):
 *   ADMIN_USERNAME        Usuário admin (fail-closed: se vazio, admin desligado)
 *   ADMIN_PASSWORD        Senha admin (comparação em tempo constante)
 *   ADMIN_COOKIE_NAME     (opcional) nome do cookie de sessão admin
 *   ADMIN_SESSION_TTL_HOURS (opcional) vida da sessão em horas (default 12)
 *
 * Sessão admin: JWT assinado com o mesmo SESSION_SECRET da aplicação
 * (garante sobrevivência a restarts) num cookie httpOnly dedicado.
 * A assinatura <ADMIN_USERNAME>:<senha> NUNCA vai para o cliente — apenas
 * o cookie de sessão httpOnly.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const { parse: parseCookie, serialize: serializeCookie } = require('cookie');

const DEFAULT_ADMIN_COOKIE = 'b2base_admin_session';
const ADMIN_COOKIE_NAME =
  process.env.ADMIN_COOKIE_NAME || DEFAULT_ADMIN_COOKIE;
const ADMIN_SESSION_TTL_HOURS = Math.max(
  1,
  Number(process.env.ADMIN_SESSION_TTL_HOURS) || 12
);
const ADMIN_SESSION_TTL_SECONDS = ADMIN_SESSION_TTL_HOURS * 60 * 60;

let _adminSecret = null;
function adminSecret() {
  if (_adminSecret) return _adminSecret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim().length >= 32) {
    _adminSecret = fromEnv.trim();
    return _adminSecret;
  }
  // Fallback estável derivado apenas para desenvolvimento local; em produção
  // SESSION_SECRET vem do Infisical. Se não houver, derivamos de uma seed via
  // hash — ainda quebraria após restart aleatório, por isso exigimos a env em prod.
  _adminSecret = crypto
    .createHash('sha256')
    .update(process.env.ADMIN_PASSWORD ? 'b2base-admin-' + process.env.ADMIN_PASSWORD : 'b2base-admin-dev-seed')
    .digest('hex');
  return _adminSecret;
}

/** true apenas quando o admin está configurado (login+senha presentes). */
function isAdminEnabled() {
  const user = String(process.env.ADMIN_USERNAME || '').trim();
  const pass = process.env.ADMIN_PASSWORD;
  return Boolean(user) && Boolean(pass && pass.length > 0);
}

/** Comparação de strings em tempo constante para evitar timing attacks. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Ainda percorre para não vazar diferença só pela regra de tamanho em
    // alguns engines; o digest abaixo domina o custo.
    return crypto.timingSafeEqual(bufA, bufA) && false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isCookieSecure() {
  if (typeof process.env.SESSION_COOKIE_SECURE === 'string') {
    return process.env.SESSION_COOKIE_SECURE.toLowerCase() === 'true';
  }
  return process.env.NODE_ENV === 'production';
}

function setAdminCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ADMIN_COOKIE_NAME, token, {
      httpOnly: true,
      secure: isCookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: ADMIN_SESSION_TTL_SECONDS,
    })
  );
}

function clearAdminCookie(res) {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(ADMIN_COOKIE_NAME, '', {
      httpOnly: true,
      secure: isCookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
      expires: new Date(0),
    })
  );
}

function signAdminToken(username) {
  return jwt.sign(
    { sub: 'admin', username, scope: 'admin' },
    adminSecret(),
    {
      expiresIn: ADMIN_SESSION_TTL_SECONDS,
      issuer: 'b2base',
      audience: 'b2base-admin',
    }
  );
}

function verifyAdminToken(token) {
  return jwt.verify(token, adminSecret(), {
    issuer: 'b2base',
    audience: 'b2base-admin',
  });
}

/** Middleware: protege /api/admin/*. 401 sem sessão válida. */
function requireAdmin(req, res, next) {
  if (!isAdminEnabled()) {
    return res
      .status(503)
      .json({ success: false, error: 'Admin não configurado no servidor.', code: 'ADMIN_DISABLED' });
  }
  const token = (req.cookies && req.cookies[ADMIN_COOKIE_NAME]) || '';
  if (!token) {
    return res
      .status(401)
      .json({ success: false, error: 'Não autenticado no admin.', code: 'ADMIN_UNAUTHENTICATED' });
  }
  try {
    const payload = verifyAdminToken(token);
    req.admin = payload;
    return next();
  } catch (_err) {
    clearAdminCookie(res);
    return res
      .status(401)
      .json({ success: false, error: 'Sessão admin expirada ou inválida.', code: 'ADMIN_SESSION_INVALID' });
  }
}

/**
 * Busca no STRIPE API o status de pagamento AO VIVO de um org com assinatura.
 * Usado pelo admin para verificar pagamento em tempo real — não depende só do
 * cache `stripePlanStatus` (que pode estar defasado). Tolerante a falhas:
 * se o Stripe não estiver configurado ou a chamada falhar, devolve snapshot
 * null com motivo em `error` (o admin segue útil sem derrubar a listagem).
 */
async function fetchStripeBillingSnapshot(prisma, org) {
  const noBilling = { configured: false, hasSubscription: false, snapshot: null };
  try {
    const billing = require('./stripe-billing');
    if (!billing.isBillingConfigured()) return noBilling;
    if (!org.stripeSubscriptionId) {
      return { configured: true, hasSubscription: false, snapshot: null };
    }
    const stripe = billing.getStripe();
    // Timeout total (5s): a listagem de orgs chama isto por org — não pode
    // ficar presa se a API do Stripe estiver lenta/indisponível.
    const withTimeout = (p, ms = 5000, label = 'stripe') =>
      Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
      ]);
    const [sub, latestInvoice, customer] = await withTimeout(
      Promise.all([
        stripe.subscriptions.retrieve(org.stripeSubscriptionId, {
          expand: ['default_payment_method'],
        }),
        stripe.invoices.list({ subscription: org.stripeSubscriptionId, limit: 1 }),
        org.stripeCustomerId ? stripe.customers.retrieve(org.stripeCustomerId) : Promise.resolve(null),
      ]),
      8000,
      'stripe-billing'
    );

    const pm = sub.default_payment_method;
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
    const periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000) : null;
    const lastInvoice = latestInvoice && latestInvoice.data && latestInvoice.data[0];

    // Tarifa mensal do plano (amount/interval) a partir do item da assinatura.
    const priceItem = sub.items && sub.items.data && sub.items.data[0];
    const amount = (priceItem && priceItem.price && priceItem.price.unit_amount) || null;
    const currency = (priceItem && priceItem.price && priceItem.price.currency) || 'brl';
    const interval = (priceItem && priceItem.price && priceItem.price.recurring && priceItem.price.recurring.interval) || null;

    return {
      configured: true,
      hasSubscription: true,
      snapshot: {
        subscriptionId: sub.id,
        status: sub.status, // active | trialing | past_due | canceled | unpaid | incomplete…
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        currentPeriod: {
          start: periodStart ? periodStart.toISOString() : null,
          end: periodEnd ? periodEnd.toISOString() : null,
        },
        plan: {
          amount: amount != null ? amount / 100 : null,
          currency,
          interval,
          nickname: (priceItem && priceItem.price && priceItem.price.nickname) || null,
        },
        paymentMethod: pm
          ? {
              brand: pm.card ? pm.card.brand : null,
              last4: pm.card ? pm.card.last4 : null,
              expMonth: pm.card ? pm.card.exp_month : null,
              expYear: pm.card ? pm.card.exp_year : null,
            }
          : null,
        lastInvoice: lastInvoice
          ? {
              id: lastInvoice.id,
              number: lastInvoice.number || null,
              status: lastInvoice.status, // paid | open | uncollectible | void | draft
              amountDue: lastInvoice.amount_due != null ? lastInvoice.amount_due / 100 : null,
              amountPaid: lastInvoice.amount_paid != null ? lastInvoice.amount_paid / 100 : null,
              currency: lastInvoice.currency || 'brl',
              created: lastInvoice.created ? new Date(lastInvoice.created * 1000).toISOString() : null,
              hostedInvoiceUrl: lastInvoice.hosted_invoice_url || null,
            }
          : null,
        // Retrato do customer (delinquent = pagamento atrasado pendente).
        customer: customer && customer.deleted !== true ? { delinquent: Boolean(customer.delinquent) } : null,
      },
    };
  } catch (err) {
    return {
      configured: true,
      hasSubscription: Boolean(org.stripeSubscriptionId),
      snapshot: null,
      error: err.message,
    };
  }
}

/**
 * Enriquece uma lista de orgs com o snapshot Stripe ao vivo, de forma
 * resiliente e paralela (não derruba a listagem se um org falhar/expirar).
 */
async function attachStripeSnapshots(prisma, items) {
  const results = await Promise.allSettled(
    items.map((org) => fetchStripeBillingSnapshot(prisma, org))
  );
  return items.map((org, i) => {
    const r = results[i];
    return {
      ...org,
      billingLive: r.status === 'fulfilled' ? r.value : { configured: false, snapshot: null, error: 'timeout' },
    };
  });
}

/**
 * Registra as rotas do admin no app Express fornecido.
 * Fica FORA do guard global de /api do Firebase por design: usa a própria
 * sessão admin (env), não o cookie /api/user da plataforma.
 */
function createAdminRouter(prisma) {
  const router = express.Router();

  // ── Auth básica ────────────────────────────────────────────────────────
  router.post('/login', (req, res) => {
    if (!isAdminEnabled()) {
      return res
        .status(503)
        .json({ success: false, error: 'Admin não configurado no servidor.', code: 'ADMIN_DISABLED' });
    }
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const okUser = safeEqual(username, String(process.env.ADMIN_USERNAME || '').trim());
    const okPass = safeEqual(password, String(process.env.ADMIN_PASSWORD || ''));

    if (!okUser || !okPass) {
      // Resposta idêntica para usuário/senha errados — não informa qual falhou.
      return res
        .status(401)
        .json({ success: false, error: 'Credenciais inválidas.', code: 'ADMIN_BAD_CREDENTIALS' });
    }

    const token = signAdminToken(username);
    setAdminCookie(res, token);
    return res.json({ success: true, data: { username } });
  });

  router.post('/logout', (req, res) => {
    clearAdminCookie(res);
    return res.json({ success: true });
  });

  router.get('/me', requireAdmin, (req, res) => {
    return res.json({ success: true, data: { username: req.admin.username } });
  });

  // ── Resumo (KPI) ───────────────────────────────────────────────────────
  router.get('/summary', requireAdmin, async (req, res) => {
    try {
      const [users, orgs, trials, premiums, prospects] = await Promise.all([
        prisma.user.count(),
        prisma.organization.count(),
        prisma.organization.count({ where: { plan: 'trial' } }),
        prisma.organization.count({ where: { plan: 'premium' } }),
        prisma.prospect.count(),
      ]);
      let billingConfigured = false;
      try {
        billingConfigured = require('./stripe-billing').isBillingConfigured();
      } catch (_e) {
        billingConfigured = false;
      }
      return res.json({
        success: true,
        data: { users, orgs, trials, premiums, prospects, billingConfigured },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── Usuários ───────────────────────────────────────────────────────────
  // Lista todos os usuários cadastrados, com a organização e plano de origem.
  router.get('/users', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

      const where = q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {};

      const [total, items] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip,
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            role: true,
            sessionVersion: true,
            createdAt: true,
            updatedAt: true,
            lastActiveAt: true,
            blockedAt: true,
            orgId: true,
            organization: {
              select: { id: true, name: true, plan: true, cnpj: true },
            },
          },
        }),
      ]);

      return res.json({
        success: true,
        data: items,
        meta: { total, limit, skip },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── Bloquear / desbloquear usuário ───────────────────────────────────────
  // Bloquear: preenche blockedAt → requireAuth e login rejeitam toda request
  // autenticada do usuário imediatamente (invalida sessões existentes).
  // Desbloquear: volta a null → acesso restaurado.
  const setUserBlocked = async (req, res, blocked) => {
    try {
      const userId = String(req.params.id || '').trim();
      if (!userId) {
        return res.status(400).json({ success: false, error: 'ID de usuário inválido.' });
      }
      const existing = await prisma.user.findUnique({ where: { id: userId } });
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Usuário não encontrado.' });
      }
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { blockedAt: blocked ? new Date() : null },
        select: {
          id: true,
          email: true,
          name: true,
          blockedAt: true,
          lastActiveAt: true,
          createdAt: true,
          updatedAt: true,
          orgId: true,
        },
      });
      return res.json({ success: true, data: updated });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  };

  router.post('/users/:id/block', requireAdmin, (req, res) => setUserBlocked(req, res, true));
  router.post('/users/:id/unblock', requireAdmin, (req, res) => setUserBlocked(req, res, false));

  // ── Organizações / contas ──────────────────────────────────────────────
  router.get('/orgs', requireAdmin, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase();
      const planFilter = String(req.query.plan || '').trim();
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);

      const where = {
        ...(planFilter === 'trial' || planFilter === 'premium'
          ? { plan: planFilter }
          : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { cnpj: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      };

      const [total, items] = await Promise.all([
        prisma.organization.count({ where }),
        prisma.organization.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip,
          select: {
            id: true,
            name: true,
            cnpj: true,
            plan: true,
            stripeCustomerId: true,
            stripeSubscriptionId: true,
            stripePlanStatus: true,
            createdAt: true,
            updatedAt: true,
            _count: { select: { users: true, prospects: true } },
            users: {
              select: { id: true, email: true, name: true },
              take: 10,
            },
          },
        }),
      ]);

      const data = await attachStripeSnapshots(prisma, items);

      // Saldo de disparo (carteira única de reputação) por org — o painel
      // mostra e o admin usa para creditar manualmente. Mostra o SALDO
      // DISPONÍVEL (balance − piso de reputação), o MESMO número do Studio
      // (2026-10-16: o admin exibia o bruto 134 enquanto o Studio mostrava
      // 124 — o piso fica reservado e não é disparável).
      try {
        const reputation = require('./studio/reputation');
        const accounts = await prisma.studioReputationAccount.findMany({
          where: { orgId: { in: items.map((o) => o.id) }, channel: reputation.UNIFIED_CHANNEL },
          select: { orgId: true, balance: true, floor: true },
        });
        const balanceByOrg = new Map(
          accounts.map((a) => [a.orgId, Math.max(0, (a.balance || 0) - (a.floor || 0))])
        );
        for (const org of data) org.balance = balanceByOrg.get(org.id) || 0;
      } catch (_e) {
        // saldo é cosmético na listagem — falha não derruba a rota
      }

      return res.json({
        success: true,
        data,
        meta: { total, limit, skip },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── Status de pagamento AO VIVO (Stripe API) de um org ──────────────────
  // Consulta a API do Stripe (não o cache) para verificar pagamento atual:
  // status da assinatura, período, valor, cartão, fatura mais recente.
  router.get('/orgs/:id/billing', requireAdmin, async (req, res) => {
    try {
      const orgId = String(req.params.id || '');
      const org = await prisma.organization.findUnique({
        where: { id: orgId },
        select: {
          id: true,
          name: true,
          plan: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          stripePlanStatus: true,
        },
      });
      if (!org) {
        return res.status(404).json({ success: false, error: 'Organização não encontrada.' });
      }
      const billing = await fetchStripeBillingSnapshot(prisma, org);
      return res.json({ success: true, data: { org, billing } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── Trocar plano trial ↔ premium (e vice-versa) ────────────────────────
  // A fonte de verdade do plano é a `Organization.plan`. Quando o admin força
  // "premium" manualmente, limpamos os vínculos Stripe órfãos para não
  // conflitar; quando volta para "trial", mantemos o Stripe linkado (caso uma
  // assinatura real exista, o webhook retoma o plano automaticamente).
  router.post('/orgs/:id/plan', requireAdmin, async (req, res) => {
    try {
      const orgId = String(req.params.id || '');
      const plan = String((req.body && req.body.plan) || '').trim();
      if (plan !== 'trial' && plan !== 'premium') {
        return res
          .status(400)
          .json({ success: false, error: 'Plano inválido. Use "trial" ou "premium".' });
      }

      const existing = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { id: true, plan: true },
      });
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Organização não encontrada.' });
      }

      const data =
        plan === 'premium'
          ? { plan, stripePlanStatus: 'active' }
          : { plan };

      const updated = await prisma.organization.update({
        where: { id: orgId },
        data,
        select: {
          id: true,
          name: true,
          plan: true,
          stripePlanStatus: true,
          updatedAt: true,
        },
      });

      console.log(`[admin] Org ${orgId} (${updated.name}): plano ${existing.plan} → ${plan} por ${req.admin.username}`);
      return res.json({ success: true, data: updated });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ── Saldo de disparo da org (carteira única de reputação) ──────────────
  router.get('/orgs/:id/balance', requireAdmin, async (req, res) => {
    try {
      const orgId = String(req.params.id || '');
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
      if (!org) {
        return res.status(404).json({ success: false, error: 'Organização não encontrada.' });
      }
      const reputation = require('./studio/reputation');
      const account = await reputation.getAccount(prisma, orgId);
      const events = await reputation.listEvents(prisma, orgId, { limit: 10 });
      return res.json({
        success: true,
        data: {
          org,
          balance: account ? account.balance : 0,
          effectiveBalance: account ? reputation.effectiveBalance(account) : 0,
          rampStage: account ? account.rampStage : null,
          recentEvents: events,
        },
      });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /orgs/:id/balance { amount, reason? } — credita saldo manualmente.
  // Passa pelo reputation.credit (ledger append-only + idempotência): cada
  // clique é UM crédito novo (refId único por chamada), auditado com o admin
  // que fez. Falha de org inexistente → 404; valor inválido → 400.
  router.post('/orgs/:id/balance', requireAdmin, async (req, res) => {
    try {
      const orgId = String(req.params.id || '');
      const amount = Math.floor(Number(req.body && req.body.amount));
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Informe um valor inteiro maior que 0.' });
      }
      if (amount > 100000) {
        return res.status(400).json({ success: false, error: 'Valor máximo por crédito: 100.000.' });
      }
      const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
      if (!org) {
        return res.status(404).json({ success: false, error: 'Organização não encontrada.' });
      }
      const reputation = require('./studio/reputation');
      const result = await reputation.credit(prisma, {
        orgId,
        channel: reputation.UNIFIED_CHANNEL,
        amount,
        refType: 'admin',
        refId: `admin:${req.admin.username}:${crypto.randomUUID()}`,
        reason: reason || `crédito manual do admin ${req.admin.username}`,
        metadata: { by: req.admin.username },
      });
      if (!result.ok) {
        return res.status(409).json({ success: false, error: `Não foi possível creditar (${result.code || 'erro'}).` });
      }
      // O número que o admin vê (e o Studio mostra) é o DISPONÍVEL — o bruto
      // do ledger fica como rawBalance para auditoria.
      const account = await reputation.getAccount(prisma, orgId);
      const available = account ? reputation.effectiveBalance(account) : result.balance;
      console.log(`[admin] Org ${orgId} (${org.name}): +${result.credited} de saldo (novo saldo ${result.balance}, disponível ${available}) por ${req.admin.username}`);
      return res.json({ success: true, data: { credited: result.credited, balance: available, rawBalance: result.balance } });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}

module.exports = {
  createAdminRouter,
  requireAdmin,
  isAdminEnabled,
  ADMIN_COOKIE_NAME,
};
