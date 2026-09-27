'use strict';

/**
 * studio/brand-routes.js — endpoints de marca e conformidade (US12, T119):
 * GET/PUT brand, learn [premium], brand-check [premium] e compliance
 * (parecer completo persistido em StudioComplianceReview, FR-073).
 *
 * Assets da marca (2026-09-27): logo, materiais de marketing (imagem/PDF) e
 * arquivos de contexto para os agentes — upload via multipart, binários no
 * storage local (studio/storage.js), metadados em kit.assets[].
 */

const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { httpError } = require('./errors');
const compliance = require('./compliance-service');
const { createBrandService } = require('./brand-service');
const storage = require('./storage');

const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10MB por arquivo
const ASSET_KINDS = {
  logo: /^image\/(png|jpe?g|webp|svg\+xml)$/,
  material: /^(image\/(png|jpe?g|webp)|application\/pdf)$/,
  context: /^(text\/(plain|markdown)|application\/pdf)$/,
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ASSET_BYTES },
});

function contentTypeFor(fileName) {
  const ext = path.extname(String(fileName)).toLowerCase();
  return (
    {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
    }[ext] || 'application/octet-stream'
  );
}

async function readProfile(prisma, orgId) {
  const rows = await prisma.studioBrandProfile.findMany({ where: { orgId } });
  return rows[0] || null;
}

async function saveKit(prisma, orgId, kit) {
  const profile = await readProfile(prisma, orgId);
  return profile
    ? prisma.studioBrandProfile.update({ where: { id: profile.id }, data: { kit } })
    : prisma.studioBrandProfile.create({ data: { orgId, kit } });
}

function registerBrandRoutes(router, context) {
  const { prisma, overrides = {} } = context;
  const aiDeps = overrides.aiDeps || {};
  const brand = createBrandService(prisma, aiDeps);

  // GET /api/studio/brand
  router.get('/brand', async (req, res, next) => {
    try {
      const rows = await prisma.studioBrandProfile.findMany({ where: { orgId: req.studio.orgId } });
      res.json({ success: true, data: rows[0] || { voice: {}, kit: {} } });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/studio/brand — salva voz/kit manualmente. Merge: assets enviados
  // por outros clientes (que não conhecem kit.assets) não são apagados.
  router.put('/brand', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const body = req.body || {};
      const current = await readProfile(prisma, orgId);
      const data = {
        ...(body.voice ? { voice: body.voice } : {}),
        ...(body.kit || current?.kit
          ? {
              kit: {
                ...(current?.kit || {}),
                ...(body.kit || {}),
                assets: Array.isArray(body.kit?.assets)
                  ? body.kit.assets
                  : (current?.kit?.assets || []),
              },
            }
          : {}),
      };
      const saved = current
        ? await prisma.studioBrandProfile.update({ where: { id: current.id }, data })
        : await prisma.studioBrandProfile.create({ data: { orgId, ...data } });
      res.json({ success: true, data: saved });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/studio/brand/assets — upload de logo/material/contexto.
  // kind=logo substitui o logo anterior (um só); materiais/contexto acumulam.
  router.post('/brand/assets', upload.single('file'), async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const kind = String(req.body?.kind || 'material');
      if (!ASSET_KINDS[kind]) throw httpError('INVALID_KIND', 400, "kind deve ser 'logo', 'material' ou 'context'.");
      const file = req.file;
      if (!file) throw httpError('FILE_REQUIRED', 400, 'Envie o arquivo no campo "file".');
      const mime = String(file.mimetype || '').toLowerCase();
      if (!ASSET_KINDS[kind].test(mime)) {
        throw httpError('INVALID_FILE_TYPE', 400, `Tipo ${mime || 'desconhecido'} não aceito para ${kind}.`);
      }
      const ext = (file.originalname.match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
      const { fileName } = storage.saveBuffer(file.buffer, ext);
      const asset = {
        id: crypto.randomBytes(10).toString('hex'),
        kind,
        fileName,
        originalName: path.basename(String(file.originalname || fileName)).slice(0, 120),
        mime,
        size: file.size,
        url: `/api/studio/brand/assets/${fileName}`,
        createdAt: new Date().toISOString(),
      };
      const profile = await readProfile(prisma, orgId);
      const kit = { ...(profile?.kit || {}) };
      const assets = (kit.assets || []).filter((a) => a && (kind !== 'logo' || a.kind !== 'logo'));
      kit.assets = [...assets, asset];
      if (kind === 'logo') kit.logoUrl = asset.url;
      const saved = await saveKit(prisma, orgId, kit);
      res.json({ success: true, data: saved, asset });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/studio/brand/assets/:fileName — serve o binário (hash próprio).
  router.get('/brand/assets/:fileName', async (req, res, next) => {
    try {
      const safe = path.basename(req.params.fileName);
      // Escopo: o arquivo só é servido se estiver listado no kit da org.
      const profile = await readProfile(prisma, req.studio.orgId);
      const listed = (profile?.kit?.assets || []).some((a) => a && a.fileName === safe);
      if (!listed) throw httpError('NOT_FOUND', 404, 'Asset não encontrado');
      let buffer;
      try {
        buffer = storage.readBuffer(safe);
      } catch (_e) {
        throw httpError('NOT_FOUND', 404, 'Asset não encontrado');
      }
      res.setHeader('Content-Type', contentTypeFor(safe));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/studio/brand/assets/:id — remove metadado + binário.
  router.delete('/brand/assets/:id', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const profile = await readProfile(prisma, orgId);
      const assets = (profile?.kit?.assets || []).filter(Boolean);
      const asset = assets.find((a) => a.id === req.params.id);
      if (!asset) throw httpError('NOT_FOUND', 404, 'Asset não encontrado');
      const kit = { ...(profile?.kit || {}) };
      kit.assets = assets.filter((a) => a.id !== asset.id);
      if (asset.kind === 'logo' && kit.logoUrl === asset.url) {
        const nextLogo = kit.assets.find((a) => a.kind === 'logo');
        kit.logoUrl = nextLogo ? nextLogo.url : '';
      }
      const saved = await saveKit(prisma, orgId, kit);
      try {
        storage.removeFile(asset.fileName);
      } catch (_e) { /* binário já sumido: metadata é a verdade */ }
      res.json({ success: true, data: saved });
    } catch (err) {
      next(err);
    }
  });

  // POST /brand/learn [premium] — aprende voz de samples (FR-070).
  router.post('/brand/learn', async (req, res, next) => {
    try {
      await context.requirePremiumOrg(req.studio.orgId);
      const samples = Array.isArray((req.body || {}).samples) ? req.body.samples.map(String) : [];
      if (samples.length === 0) throw httpError('INVALID_SAMPLES', 400, 'Envie samples de texto da marca.');
      const learned = await brand.learn(req.studio.orgId, { samples });
      res.json({ success: true, data: learned });
    } catch (err) {
      next(err);
    }
  });

  // POST /campaigns/:id/brand-check [premium] — consistência (FR-072).
  router.post('/campaigns/:id/brand-check', async (req, res, next) => {
    try {
      await context.requirePremiumOrg(req.studio.orgId);
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== req.studio.orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
      const contents = await prisma.studioContent.findMany({ where: { campaignId: campaign.id } });
      const text = contents.map((c) => [c.subject, c.whatsappText, c.linkedinText].filter(Boolean).join('\n')).join('\n');
      const result = await brand.checkConsistency(req.studio.orgId, { text });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // GET /campaigns/:id/compliance — último parecer.
  router.get('/campaigns/:id/compliance', async (req, res, next) => {
    try {
      const { orgId } = req.studio;
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
      const reviews = await prisma.studioComplianceReview.findMany({ where: { campaignId: campaign.id } });
      res.json({ success: true, data: reviews[reviews.length - 1] || null });
    } catch (err) {
      next(err);
    }
  });

  // POST /campaigns/:id/compliance — roda parecer completo (FR-073).
  router.post('/campaigns/:id/compliance', async (req, res, next) => {
    try {
      const campaign = await prisma.studioCampaign.findUnique({ where: { id: req.params.id } });
      if (!campaign || campaign.orgId !== req.studio.orgId) throw httpError('NOT_FOUND', 404, 'Campanha não encontrada');
      const result = await compliance.runFullCompliance(prisma, campaign);
      await prisma.studioCampaign.update({
        where: { id: campaign.id },
        data: { approval: { ...((campaign.approval) || {}), complianceLevel: result.level } },
      });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { registerBrandRoutes };
