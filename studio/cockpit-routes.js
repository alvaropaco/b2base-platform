'use strict';

/**
 * studio/cockpit-routes.js — rotas do Cockpit (specs/011).
 *
 * Home do mordomo (sugestões), saldo/orçamento de reputação, pausa global,
 * Certificado de Segurança, consentimento WhatsApp e Despertares. Toda rota
 * tem escopo de organização (req.studio) e gating premium onde muta recurso
 * (constituição IV).
 *
 * Convenções do contrato: erros `{error: CODE, message}` com códigos
 * estáveis (SALDO_INSUFICIENTE, CANAL_NAO_CONFIGURADO, SEM_CONSENTIMENTO);
 * zero jargão nas mensagens ao usuário (voz de mordomo).
 */

const reputation = require('./reputation');
const reputationGate = require('./reputation-gate');
const certificate = require('./certificate');
const suggestions = require('./suggestions');
const autonomy = require('./autonomy');
const dnsVerify = require('./dns-verify');

function registerCockpitRoutes(router, context) {
  const { prisma, httpError, requirePremiumOrg } = context;
  const appBaseUrl = (req) => process.env.APP_URL || req.headers.origin || `${req.protocol}://${req.get('host')}`;

  // ── Compra de envios (Stripe Checkout — QA 2026-10-07) ───────────────────
  // GET  /reputation/topup-packs   — packs + preço (para o botão do /studio)
  // POST /reputation/topup-checkout {units} → { url } do Checkout (saldo é
  // ÚNICO desde 2026-10-08 — `channel` no body é ignorado por compat).
  // Fulfillment: webhook checkout.session.completed credita o pool.
  router.get('/reputation/topup-packs', async (req, res) => {
    const stripeBilling = require('../stripe-billing');
    res.json({ success: true, data: stripeBilling.balancePacks() });
  });

  router.post('/reputation/topup-checkout', async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      const stripeBilling = require('../stripe-billing');
      if (!stripeBilling.isBillingConfigured()) {
        const err = new Error('Compra de envios indisponível: Stripe não configurado nesta instalação.');
        err.status = 503;
        throw err;
      }
      const { units } = req.body || {};
      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      if (!org) throw httpError('NOT_FOUND', 404, 'Organização não encontrada');
      const session = await stripeBilling.createBalanceCheckoutSession(
        prisma,
        org,
        appBaseUrl(req),
        { units: units != null ? Number(units) : 100 }
      );
      await prisma.activity.create({ data: {
        orgId,
        userId: userId || null,
        type: 'billing.topup_checkout',
        message: `Checkout de ${units || 100} envios (saldo único) iniciado`,
      } }).catch(() => {});
      res.json({ success: true, data: { url: session.url, sessionId: session.id } });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /cockpit/home — Briefing do Mordomo (FR-21…FR-25) ────────────────
  // Estado único de abertura: sugestões (≤3 com motivo), saldo por canal,
  // pausa global, campanha ativa (Rail) e Despertares recentes.
  router.get('/cockpit/home', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      await requirePremiumOrg(orgId);
      const [home, paused, wakes] = await Promise.all([
        suggestions.suggestions(prisma, { orgId }),
        reputationGate.isOrgPaused(prisma, orgId),
        autonomy.pendingWakes(prisma, orgId, { limit: 5 }),
      ]);
      // Campanha ativa (Rail só existe com campanha — FR-3).
      const campaigns = await prisma.studioCampaign.findMany({ where: { orgId } });
      const active =
        campaigns
          .filter((c) => ['draft', 'in_review', 'approved', 'scheduled', 'running', 'paused'].includes(c.status))
          .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))[0] || null;
      res.json({
        success: true,
        data: {
          diaZero: home.diaZero,
          chips: home.chips,
          balances: home.balances,
          paused,
          activeCampaignId: active ? active.id : null,
          activeCampaignName: active ? active.name : null,
          wakes,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /cockpit/suggestions — só os chips (revalidável sem reload total).
  router.get('/cockpit/suggestions', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      await requirePremiumOrg(orgId);
      const home = await suggestions.suggestions(prisma, { orgId });
      res.json({ success: true, data: home });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /cockpit/wakes — Despertares do Contrato de Autonomia (FR-31).
  router.get('/cockpit/wakes', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      await requirePremiumOrg(orgId);
      const wakes = await autonomy.pendingWakes(prisma, orgId, { limit: 20 });
      res.json({ success: true, data: wakes });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /cockpit/wakes/:id/ack — Despertar resolvido pelo usuário.
  router.post('/cockpit/wakes/:id/ack', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const found = await prisma.opsNotification.findFirst({
        where: { dedupKey: String(req.params.id), orgId },
      });
      if (!found) throw httpError('NOT_FOUND', 404, 'Despertar não encontrado');
      // Escopo duplo (dedupKey + orgId): despertar de outra org nunca é tocado.
      await prisma.opsNotification.updateMany({
        where: { dedupKey: found.dedupKey, orgId },
        data: { payload: { ...(found.payload || {}), acknowledgedAt: new Date().toISOString() } },
      });
      res.json({ success: true, data: { id: found.dedupKey, acknowledged: true } });
    } catch (err) {
      next(err);
    }
  });

  // ── Painel de Saldo (FR-20): POOL ÚNICO (2026-10-08) + eventos. ──────────
  router.get('/reputation', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      await requirePremiumOrg(orgId);
      const [wallet, events, paused] = await Promise.all([
        reputation.getWallet(prisma, orgId),
        reputation.listEvents(prisma, orgId, { limit: 30 }),
        reputationGate.isOrgPaused(prisma, orgId),
      ]);
      // `balances` segue na resposta (array com a wallet) para compat com
      // consumidores que iteram — o painel novo usa `wallet`.
      res.json({ success: true, data: { wallet, balances: wallet ? [wallet] : [], events, paused } });
    } catch (err) {
      next(err);
    }
  });

  // ── Pausa global de emergência 1-clique (FR-19, AD-4). ───────────────────
  router.post('/reputation/pause', async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      await requirePremiumOrg(orgId);
      const body = req.body || {};
      const paused = body.paused !== false; // default: pausar (1-clique)
      const result = await reputationGate.setOrgPaused(prisma, orgId, {
        paused,
        userId,
        reason: body.reason ? String(body.reason).slice(0, 300) : paused ? 'pausa global acionada pelo usuário' : null,
      });
      res.json({ success: true, data: { ...result, resumed: !paused } });
    } catch (err) {
      next(err);
    }
  });

  // ── Verificação DNS sob demanda (configuração do canal — AD-8). ──────────
  router.post('/reputation/verify-domain', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      await requirePremiumOrg(orgId);
      const body = req.body || {};
      const history = ['novo', 'pre-aquecido', 'penalizado'].includes(body.domainHistory)
        ? body.domainHistory
        : null;
      const result = await dnsVerify.verifyOrgDomain(prisma, orgId, { history });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ── Certificado de Segurança da campanha (FR-27, AD-7). ──────────────────
  router.get('/campaigns/:id/certificate', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
      // GET: avaliação pura (skipPersist) — não muta a campanha nem o pick da home.
      const result = await certificate.evaluate(prisma, campaign, { skipPersist: true });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ── Consentimento WhatsApp por lead (FR-35, AD-11) — caminho para ────────
  // consentir quando o Certificado acusa SEM_CONSENTIMENTO.
  router.post('/leads/:prospectId/consent', async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      await requirePremiumOrg(orgId);
      const body = req.body || {};
      const source = ['email_reply', 'opt_in', 'manual'].includes(body.source) ? body.source : 'manual';
      if (source === 'manual' && !body.confirm) {
        throw httpError('CONFIRM_REQUIRED', 400, 'Confirme o consentimento do lead (confirm: true).');
      }
      // prospectId tem que ser da org (sem órfãos/cross-tenant).
      const prospect = await prisma.prospect.findFirst({ where: { id: String(req.params.prospectId), orgId } });
      if (!prospect) throw httpError('NOT_FOUND', 404, 'Lead não encontrado nesta organização');
      const { consent, replayed } = await certificate.grantConsent(prisma, {
        orgId,
        prospectId: String(req.params.prospectId),
        source,
        grantedById: userId,
        evidence: { note: body.note ? String(body.note).slice(0, 300) : null },
      });
      res.json({ success: true, data: { consent, replayed } });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerCockpitRoutes };
