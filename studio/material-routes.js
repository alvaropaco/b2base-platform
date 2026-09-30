'use strict';

/**
 * studio/material-routes.js — materiais, extração e composição por IA
 * (US4, T048): upload (multer, limites por plano), URL/prompt, extração
 * `[premium]`, confirmação humana, compose `[premium]` (202 + polling) e
 * progresso do lote (`GET /ai-batch/:id`).
 */

const multer = require('multer');
const { createMaterialService } = require('./material-service');
// Limites 5MB/25MB em UMA fonte (attachment-service) — materiais e anexos
// compartilham os mesmos tetos por plano.
const { createAttachmentService, MAX_UPLOAD_TRIAL, MAX_UPLOAD_PREMIUM } = require('./attachment-service');
const { createBatchRunner } = require('./ai-batch');
const { createExtractor } = require('./ai/extract');
const { createComposer } = require('./ai/compose');
const { httpError } = require('./errors');

/** Middleware multer com erro EXPLICÁVEL: LIMIT_FILE_SIZE → 400 (E4), nunca 500. */
function uploadOr400(multerInstance) {
  return (req, res, next) => {
    multerInstance(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') {
        return next(httpError('MATERIAL_TOO_LARGE', 400, 'Arquivo acima do limite do plano — veja o limite antes de enviar.'));
      }
      if (err) return next(err);
      return next();
    });
  };
}

function registerMaterialRoutes(router, context) {
  const { prisma, overrides = {} } = context;
  const aiDeps = overrides.aiDeps || {};

  // Serviços do Studio (singletons por instância do router — testes injetam
  // deps de IA via overrides.aiDeps, produção usa llm-client real).
  const materialService = createMaterialService(prisma, aiDeps);
  const attachmentService = createAttachmentService(prisma);
  const composer = createComposer(aiDeps);
  context.batchHandlers = context.batchHandlers || {};
  const metrics = require('../metrics');
  context.batchHandlers.compose = async (item, ctx) => {
    try {
      return await composeOne(item, ctx);
    } catch (err) {
      metrics.incStudioAiBatchItem('compose', 'error');
      throw err;
    }
  };
  async function composeOne(item, ctx) {
      // Um item = um tom/variante do pacote (adaptação real por canal).
        const campaign = await prisma.studioCampaign.findUnique({ where: { id: ctx.campaignId } });
        // Brand Voice como diretriz extra quando configurada (US12, FR-070).
        let orgContext = ctx.orgContext;
        try {
          const brand = require('./brand-service').createBrandService(prisma, aiDeps);
          const directive = await brand.voiceDirective(ctx.orgId);
          if (directive) orgContext = orgContext ? `${orgContext}\n${directive}` : directive;
        } catch (_err) { /* sem marca configurada */ }
        const pack = await composer.composeForTone({
          tone: item.tone,
          sourceText: ctx.sourceText,
          orgContext,
          objective: campaign?.objective,
          offer: campaign?.offer,
        });
        const channels = campaign?.channels || [];
        const variantLabel = item.tone;
        if (channels.includes('email') && pack.email) {
          await prisma.studioContent.create({
            data: {
              orgId: campaign.orgId,
              campaignId: campaign.id,
              channel: 'email',
              variantLabel,
              kind: 'base',
              stepIndex: 1,
              title: pack.title || null,
              subject: pack.email.subject || null,
              preheader: pack.email.preheader || null,
              emailDoc: { blocks: pack.email.blocks || [] },
              ctaUrl: pack.email?.blocks?.find((b) => b.type === 'button')?.url || null,
              tone: item.tone,
              origin: 'ai_from_material',
            },
          });
        }
        if (channels.includes('whatsapp') && pack.whatsapp?.text) {
          await prisma.studioContent.create({
            data: {
              orgId: campaign.orgId,
              campaignId: campaign.id,
              channel: 'whatsapp',
              variantLabel,
              kind: 'base',
              stepIndex: 1,
              whatsappText: pack.whatsapp.text,
              tone: item.tone,
              origin: 'ai_from_material',
            },
          });
        }
        if (channels.includes('linkedin_text') && pack.linkedinText) {
          await prisma.studioContent.create({
            data: {
              orgId: campaign.orgId,
              campaignId: campaign.id,
              channel: 'linkedin_text',
              variantLabel,
              kind: 'base',
              stepIndex: 1,
              linkedinText: pack.linkedinText,
              tone: item.tone,
              origin: 'ai_from_material',
            },
          });
        }
        metrics.incStudioAiBatchItem('compose', 'ok');
        return { tone: item.tone };
  };
  context.batchRunner =
    context.batchRunner || createBatchRunner({ handlers: context.batchHandlers });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_PREMIUM },
  });

  async function loadMaterial(prismaClient, orgId, id) {
    const material = await prismaClient.studioMaterial.findUnique({ where: { id } });
    if (!material || material.orgId !== orgId) {
      throw httpError('NOT_FOUND', 404, 'Material não encontrado');
    }
    return material;
  }

  // POST /api/studio/materials — upload (multipart) ou {url|prompt|kind+description}.
  // D7: quando o upload acontece no contexto de uma campanha (campo
  // `campaignId`), o material nasce vinculado a ela (aba Materiais por
  // campanha); sem contexto, continua material da org.
  router.post('/materials', uploadOr400(upload.any()), async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      let material;
      const files = req.files || [];
      if (files.length > 1) {
        throw httpError('INVALID_MATERIAL', 400, 'Envie UM arquivo por vez.');
      }
      const file = files[0];
      if (file) {
        const { isPremiumOrg } = require('../plan');
        const premium = await isPremiumOrg(prisma, orgId);
        const limit = premium ? MAX_UPLOAD_PREMIUM : MAX_UPLOAD_TRIAL;
        if (file.size > limit) {
          throw httpError('MATERIAL_TOO_LARGE', 400, `Material excede o limite do plano (${Math.round(limit / 1024 / 1024)}MB).`);
        }
        let campaignId = null;
        if (req.body?.campaignId) {
          const campaign = await prisma.studioCampaign.findUnique({ where: { id: String(req.body.campaignId) } });
          if (!campaign || campaign.orgId !== orgId) {
            throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
          }
          campaignId = campaign.id;
        }
        material = await materialService.createMaterial({
          orgId,
          userId,
          campaignId,
          buffer: file.buffer,
          mimeType: file.mimetype,
          originalName: file.originalname,
        });
      } else if (req.body?.url) {
        material = await materialService.createMaterial({ orgId, userId, url: String(req.body.url) });
      } else if (req.body?.prompt) {
        material = await materialService.createMaterial({
          orgId,
          userId,
          kind: 'prompt',
          extraction: { sourceText: String(req.body.prompt) },
        });
      } else if (req.body?.companyData) {
        const settings = await prisma.commercialSettings.findUnique({ where: { orgId } });
        material = await materialService.createMaterial({
          orgId,
          userId,
          kind: 'company_data',
          extraction: {
            sourceText: JSON.stringify({
              produto: settings?.productDescription || null,
              proposta: settings?.valueProposition || null,
              diferenciais: settings?.differentiators || [],
              site: settings?.websiteUrl || null,
            }),
          },
        });
      } else if (req.body?.kind === 'video' || req.body?.kind === 'image') {
        material = await materialService.createMaterial({
          orgId,
          userId,
          kind: req.body.kind,
        });
      } else {
        throw httpError('INVALID_MATERIAL', 400, 'Envie um arquivo, url, prompt ou companyData.');
      }
      res.status(201).json({ success: true, data: material });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/studio/materials/:id/extract [premium] — extração estruturada.
  router.post('/materials/:id/extract', async (req, res, next) => {
    try {
      await context.requirePremiumOrg(req.studio.orgId);
      const material = await loadMaterial(prisma, req.studio.orgId, req.params.id);
      if (material.confirmedAt) {
        throw httpError('ALREADY_CONFIRMED', 409, 'Extração já confirmada — crie um novo material para re-extrair.');
      }
      await materialService.runExtraction(material, { description: req.body?.description });
      const updated = await loadMaterial(prisma, req.studio.orgId, req.params.id);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/studio/materials/:id/confirm — confirmação humana (FR-024).
  router.post('/materials/:id/confirm', async (req, res, next) => {
    try {
      const material = await loadMaterial(prisma, req.studio.orgId, req.params.id);
      const confirmed = await materialService.confirmExtraction(material, req.body?.extraction);
      res.json({ success: true, data: confirmed });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/studio/campaigns/:id/compose [premium] — 202 + polling.
  router.post('/campaigns/:id/compose', async (req, res, next) => {
    try {
      await context.requirePremiumOrg(req.studio.orgId);
      const { orgId } = req.studio;
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== orgId) {
        throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
      }
      const body = req.body || {};
      const tones = (Array.isArray(body.tones) && body.tones.length ? body.tones : ['formal', 'comercial']).slice(0, 4);

      let sourceText = null;
      if (body.materialId) {
        const material = await loadMaterial(prisma, orgId, String(body.materialId));
        if (!material.confirmedAt) {
          throw httpError('EXTRACTION_NOT_CONFIRMED', 409, 'Confirme a extração do material antes de compor.');
        }
        if (material.extractionStatus === 'failed') {
          throw httpError('EXTRACTION_FAILED', 409, material.extractionError || 'Extração falhou.');
        }
        sourceText = JSON.stringify(material.extraction || {});
      } else if (body.prompt) {
        sourceText = String(body.prompt);
      } else {
        throw httpError('INVALID_SOURCE', 400, 'Informe materialId (confirmado) ou prompt.');
      }

      // Pacote cai em revisão: draft → in_review (FR-002 — nunca dispara).
      if (campaign.status === 'draft') {
        await prisma.studioCampaign.update({
          where: { id: campaign.id },
          data: { status: 'in_review' },
        });
      }

      const settings = await prisma.commercialSettings.findUnique({ where: { orgId } });
      const orgContext = settings
        ? `${settings.companyName || ''} vende ${settings.productDescription || '?'}; proposta: ${settings.valueProposition || '?'}`
        : null;

      const batchId = await context.batchRunner.createBatch(
        'compose',
        tones.map((tone) => ({ tone })),
        { campaignId: campaign.id, sourceText, orgContext }
      );
      res.status(202).json({ success: true, data: { batchId } });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/studio/ai-batch/:id — progresso do lote (polling).
  router.get('/ai-batch/:id', async (req, res, next) => {
    try {
      const progress = context.batchRunner.getProgress(req.params.id);
      if (!progress) throw httpError('NOT_FOUND', 404, 'Lote não encontrado');
      res.json({ success: true, data: progress });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/studio/ai-batch/:id/pause — pausa mid-batch (FR-048).
  router.post('/ai-batch/:id/pause', async (req, res, next) => {
    try {
      const paused = context.batchRunner.pauseBatch(req.params.id);
      if (!paused) throw httpError('NOT_FOUND', 404, 'Lote não encontrado');
      res.json({ success: true, data: { paused: true } });
    } catch (err) {
      next(err);
    }
  });

  // ── Anexos de campanha (Story 2.1, FR6) e Materiais da campanha (2.4/D7) ──

  async function loadOrgCampaignLocal(orgId, id) {
    const campaign = await prisma.studioCampaign.findUnique({ where: { id } });
    if (!campaign || campaign.orgId !== orgId) {
      throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
    }
    return campaign;
  }

  // POST /campaigns/:id/attachments — upload do anexo (multipart) com canal
  // destino (`email|whatsapp|both`), limites do plano visíveis + recusa
  // explicável (E4: multer LIMIT_FILE_SIZE vira 400) — reutiliza o storage do
  // Studio (SHA-256 + whitelist, NFR5). Sem message/rota nova fora daqui.
  router.post('/campaigns/:id/attachments', uploadOr400(upload.any()), async (req, res, next) => {
    try {
      const { orgId, userId } = req.studio;
      const campaign = await loadOrgCampaignLocal(orgId, req.params.id);
      const file = (req.files || []).find(Boolean);
      if (!file) throw httpError('INVALID_ATTACHMENT', 400, 'Envie um arquivo para anexar.');
      const { isPremiumOrg } = require('../plan');
      const premium = await isPremiumOrg(prisma, orgId);
      const limit = premium ? MAX_UPLOAD_PREMIUM : MAX_UPLOAD_TRIAL;
      if (file.size > limit) {
        throw httpError('ATTACHMENT_TOO_LARGE', 400, `Anexo excede o limite do plano (${Math.round(limit / 1024 / 1024)}MB).`);
      }
      const attachment = await attachmentService.createAttachment({
        orgId,
        userId,
        campaignId: campaign.id,
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
        channels: String(req.body?.channels || 'both'),
      });
      res.status(201).json({ success: true, data: attachment });
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/attachments — anexos da campanha (escopo de org).
  router.get('/campaigns/:id/attachments', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaignLocal(req.studio.orgId, req.params.id);
      const rows = await prisma.studioAttachment.findMany({
        where: { orgId: campaign.orgId, campaignId: campaign.id },
      });
      rows.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      res.json({ success: true, data: rows, count: rows.length });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /campaigns/:id/attachments/:attachmentId — B9: o :id da campanha
  // É o escopo (anexo de outra campanha/ org → 404); registro sai antes do
  // arquivo (E10).
  router.delete('/campaigns/:id/attachments/:attachmentId', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await loadOrgCampaignLocal(orgId, req.params.id);
      const attachment = await attachmentService.loadAttachment(orgId, req.params.attachmentId);
      if (!attachment || attachment.campaignId !== campaign.id) {
        throw httpError('NOT_FOUND', 404, 'Anexo não encontrado nesta campanha');
      }
      const result = await attachmentService.removeAttachment(attachment);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/materials — aba Materiais (Story 2.4/FR7/PS1/D7):
  // materiais da campanha, anexos prontos e, à parte, os materiais da org
  // (sem campanha) rotulados. Falha de extração NUNCA some (motivo + caminho).
  router.get('/campaigns/:id/materials', async (req, res, next) => {
    try {
      const campaign = await loadOrgCampaignLocal(req.studio.orgId, req.params.id);
      const byCampaign = await prisma.studioMaterial.findMany({
        where: { orgId: campaign.orgId, campaignId: campaign.id },
      });
      const orgLevel = await prisma.studioMaterial.findMany({
        where: { orgId: campaign.orgId, campaignId: null },
      });
      const attachments = await prisma.studioAttachment.findMany({
        where: { orgId: campaign.orgId, campaignId: campaign.id },
      });
      const sortAsc = (arr) => arr.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const view = (m) => ({
        id: m.id,
        kind: m.kind,
        sourceRef: m.sourceRef || null,
        mimeType: m.mimeType || null,
        sizeBytes: m.sizeBytes || null,
        extractionStatus: m.extractionStatus,
        extractionError: m.extractionError || null,
        confirmedAt: m.confirmedAt || null,
        scope: 'campaign',
        createdAt: m.createdAt,
      });
      res.json({
        success: true,
        data: {
          campaignMaterials: sortAsc(byCampaign).map(view),
          attachments: sortAsc(attachments.slice()).map((a) => ({
            id: a.id,
            fileName: a.fileName,
            originalName: a.originalName,
            mimeType: a.mimeType || null,
            sizeBytes: a.sizeBytes || 0,
            channels: a.channels,
            createdAt: a.createdAt,
          })),
          orgMaterials: sortAsc(orgLevel).map((m) => ({ ...view(m), scope: 'org' })),
        },
      });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerMaterialRoutes };
