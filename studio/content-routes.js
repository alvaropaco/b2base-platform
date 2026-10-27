'use strict';

/**
 * studio/content-routes.js — rotas de conteúdo do Email Studio (US5, T054–
 * T061): preview (mesma função do envio), checks (spam/links/a11y), rewrite/
 * suggest por IA, UTM da campanha, geração de imagens (config-gated) e
 * templates da biblioteca (mínimo da US5; CRUD completo na US13).
 */

const { renderEmail } = require('./email-renderer');
const { httpError } = require('./errors');
const { createWriter } = require('./ai/write');

async function loadContent(prisma, orgId, campaignId, contentId) {
  const content = await prisma.studioContent.findUnique({ where: { id: contentId } });
  if (!content || content.orgId !== orgId || content.campaignId !== campaignId) {
    throw httpError('NOT_FOUND', 404, 'Conteúdo não encontrado');
  }
  return content;
}

/** Lead de exemplo para preview sem lead específico (dados representativos). */
const SAMPLE_LEAD = {
  contactName: 'Ana Silva',
  companyName: 'Empresa Exemplo',
  city: 'São Paulo',
  state: 'SP',
  industry: 'sua indústria',
  employees: 100,
};

function registerContentRoutes(router, context) {
  const { prisma, overrides = {} } = context;
  const aiDeps = overrides.aiDeps || {};
  const writer = createWriter(aiDeps);

  async function loadCampaign(prismaClient, orgId, id) {
    const campaign = await prismaClient.studioCampaign.findUnique({ where: { id } });
    if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
    return campaign;
  }

  // POST /campaigns/:id/contents — cria conteúdo por canal (contrato US5).
  router.post('/campaigns/:id/contents', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const body = req.body || {};
      const channel = String(body.channel || 'email');
      if (!['email', 'whatsapp', 'linkedin_text'].includes(channel)) {
        throw httpError('INVALID_CHANNELS', 400, `Canal desconhecido: ${channel}`);
      }
      const { validatePlaceholders } = require('./variables');
      for (const text of [body.subject, body.preheader, body.whatsappText, body.linkedinText]) {
        const { ok, unknown } = validatePlaceholders(text || '');
        if (!ok) throw httpError('UNKNOWN_VARIABLE', 400, `Variáveis fora do catálogo: ${unknown.join(', ')}`);
      }
      const content = await prisma.studioContent.create({
        data: {
          orgId,
          campaignId: campaign.id,
          channel,
          variantLabel: String(body.variantLabel || 'A').slice(0, 20),
          kind: body.kind === 'followup' ? 'followup' : 'base',
          stepIndex: Number(body.stepIndex) || 1,
          title: body.title ? String(body.title).slice(0, 200) : null,
          subject: body.subject || null,
          preheader: body.preheader || null,
          whatsappText: body.whatsappText || null,
          linkedinText: body.linkedinText || null,
          emailDoc: body.emailDoc || null,
          ctaUrl: body.ctaUrl || null,
          tone: body.tone || null,
          origin: 'manual',
        },
      });
      res.status(201).json({ success: true, data: content });
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/contents/:contentId/preview — mesma função do envio.
  router.get('/campaigns/:id/contents/:contentId/preview', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const content = await loadContent(prisma, orgId, campaign.id, req.params.contentId);
      const utm = campaign.utmTemplate || {};
      // Banner SEM href herda o link do botão (2026-10-27) — MESMA regra do
      // envio (emailDocToHtml): prévia mostra o banner clicável que o lead
      // vai receber (SC-006).
      const { linkBannerToCta } = require('./channel-bridge');
      const rendered = renderEmail(linkBannerToCta(content.emailDoc) || { blocks: [] }, SAMPLE_LEAD, {
        utmTemplate: utm,
        fallbacks: {},
      });
      const view = req.query.view === 'mobile' ? 375 : 600;
      res.json({
        success: true,
        data: {
          view,
          subject: content.subject,
          preheader: content.preheader,
          ...rendered,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /campaigns/:id/checks — spam, links e acessibilidade (FR-036).
  router.post('/campaigns/:id/checks', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadCampaign(prisma, orgId, req.params.id);
      const fetchImpl = aiDeps.fetchImpl;
      const result = await require('./compliance-service').runQualityChecks(prisma, campaign, { fetchImpl });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // POST /campaigns/:id/apply-utm — salva padrão de UTM da campanha (FR-037).
  router.post('/campaigns/:id/apply-utm', async (req, res, next) => {
    try {
      const campaign = await loadCampaign(prisma, req.studio.orgId, req.params.id);
      const { assertEditable } = require('./campaign-service');
      assertEditable(campaign);
      const utm = {};
      for (const key of ['utmSource', 'utmMedium', 'utmCampaign']) {
        if (req.body?.[key]) utm[key] = String(req.body[key]).slice(0, 120);
      }
      const updated = await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { utmTemplate: utm },
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // POST /contents/:contentId/rewrite [premium] — reescrita por IA (FR-035).
  router.post('/contents/:contentId/rewrite', async (req, res, next) => {
    try {
      await context.requirePremiumOrg(req.studio.orgId);
      const { orgId } = req.studio;
      const content = await prisma.studioContent.findUnique({ where: { id: req.params.contentId } });
      if (!content || content.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Conteúdo não encontrado');
      const { action = 'improve', target = 'body', tone } = req.body || {};
      const current =
        target === 'subject' ? content.subject
        : target === 'preheader' ? content.preheader
        : content.emailDoc
          ? content.emailDoc.blocks.map((b) => b.text || b.label || '').join('\n')
          : content.whatsappText || content.linkedinText || '';
      const result = await writer.rewrite({ action, tone, text: current });
      res.json({ success: true, data: { target, text: result.text } });
    } catch (err) {
      next(err);
    }
  });

  // POST /contents/:contentId/suggest — sugestões de assunto/pré-header/CTA.
  router.post('/contents/:contentId/suggest', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const content = await prisma.studioContent.findUnique({ where: { id: req.params.contentId } });
      if (!content || content.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Conteúdo não encontrado');
      const { kind = 'subject', n = 5 } = req.body || {};
      const contextText =
        content.subject || content.whatsappText || (content.emailDoc ? JSON.stringify(content.emailDoc).slice(0, 2000) : '');
      const result = await writer.suggest({ kind, text: contextText, n: Math.min(Number(n) || 5, 10) });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // POST /contents/:contentId/translate [premium] — tradução para novo
  // conteúdo variante, preservando variáveis e links (US13).
  router.post('/contents/:contentId/translate', async (req, res, next) => {
    try {
      await context.requirePremiumOrg(req.studio.orgId);
      const { orgId } = req.studio;
      const content = await prisma.studioContent.findUnique({ where: { id: req.params.contentId } });
      if (!content || content.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Conteúdo não encontrado');
      const targetLanguage = String((req.body || {}).targetLanguage || 'en');
      const baseText = [content.subject, content.emailDoc?.blocks?.map((b) => b.text || b.label || '').join('\n')]
        .filter(Boolean)
        .join('\n');
      const writer = createWriter(aiDeps);
      const { text } = await writer.translateText({ text: baseText, targetLanguage });
      const translated = await prisma.studioContent.create({
        data: {
          orgId,
          campaignId: content.campaignId,
          channel: content.channel,
          variantLabel: `${content.variantLabel}-${targetLanguage}`.slice(0, 20),
          kind: content.kind,
          stepIndex: content.stepIndex,
          subject: content.subject ? `${content.subject} (${targetLanguage})` : null,
          whatsappText: content.whatsappText ? text : null,
          linkedinText: content.linkedinText ? text : null,
          emailDoc: content.emailDoc ? { blocks: [{ type: 'text', text }] } : null,
          tone: content.tone,
          origin: 'manual',
        },
      });
      res.status(201).json({ success: true, data: translated });
    } catch (err) {
      next(err);
    }
  });

  // POST /campaigns/:id/image-gen [premium] — degradação explícita sem modelo.
  router.post('/campaigns/:id/image-gen', async (req, res, next) => {
    try {
      await context.requirePremiumOrg(req.studio.orgId);
      if (!process.env.STUDIO_IMAGE_MODEL) {
        throw httpError(
          'IMAGE_MODEL_NOT_CONFIGURED',
          400,
          'Geração de imagens indisponível: nenhum modelo configurado (STUDIO_IMAGE_MODEL). Envie sua própria mídia.'
        );
      }
      // Com modelo configurado, a geração efetiva entra na onda de polish.
      throw httpError('NOT_IMPLEMENTED', 501, 'Geração de imagens chega na onda de polish (T061).');
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerContentRoutes };
