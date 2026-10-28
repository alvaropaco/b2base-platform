'use strict';

/**
 * studio/material-service.js — materiais de origem da campanha (T044).
 *
 * Fontes (FR-023): upload (PDF/DOCX/PPTX/imagem/vídeo), URL, prompt e
 * company_data (perfil da org). Extração de texto por tipo com parsers
 * injetáveis (DI — pesquisa D8); PPTX usa um leitor ZIP mínimo local
 * (zlib) — pptx é um ZIP de XML. Vídeo sem transcrição → `needs_manual`
 * (limite v1 documentado na spec); falhas viram `extractionError`
 * explicável (FR-029).
 */

const zlib = require('zlib');
const storage = require('./storage');

function createMaterialService(prisma, deps = {}) {
  const pdfParse = deps.pdfParse || ((buf) => require('pdf-parse')(buf));
  const docxExtract = deps.docxExtract || (async (buf) => (await require('mammoth').extractRawText({ buffer: buf })).text);
  const fetchImpl = deps.fetchImpl || fetch;
  const htmlToText = deps.htmlToText || require('../ava-extract').htmlToText;
  const extractor = deps.extractor || require('./ai/extract').createExtractor(deps).extractFromText;

  async function createMaterial({ orgId, userId, kind, campaignId, buffer, mimeType, originalName, url, prompt, description, extraction }) {
    let sourceRef = null;
    let sizeBytes = null;
    let mime = mimeType || null;
    if (buffer) {
      const ext = storage.extFromMime(mimeType, originalName);
      const saved = storage.saveBuffer(buffer, ext);
      sourceRef = saved.relativePath;
      sizeBytes = buffer.length;
    } else if (url) {
      sourceRef = String(url);
    }
    return prisma.studioMaterial.create({
      data: {
        orgId,
        // D7: upload no contexto de uma campanha nasce vinculado a ela
        // (nullable — materiais da org continuam existindo).
        campaignId: campaignId || null,
        // Upload de IMAGEM é kind 'image' — NÃO a extensão ('png'/'jpg'):
        // com a extensão, o branch de visão/extração de imagem NUNCA casava
        // e o material ficava 'pending' para sempre (2026-10-16).
        kind: kind || (buffer ? (mime && mime.startsWith('image/') ? 'image' : storage.extFromMime(mimeType, originalName)) : url ? 'url' : 'prompt'),
        sourceRef,
        mimeType: mime,
        sizeBytes,
        extractionStatus: 'pending',
        extraction: extraction || undefined,
        uploadedById: userId,
      },
    });
  }

  // ── PPTX: leitor ZIP mínimo (entries deflate/stored) → texto dos slides ──
  function pptxToText(buffer) {
    // End of Central Directory (EOCD) assinatura 0x06054b50, busca do fim.
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66_000; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('PPTX inválido (EOCD não encontrado).');
    const entryCount = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);
    const texts = [];
    for (let n = 0; n < entryCount; n++) {
      if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
      const method = buffer.readUInt16LE(offset + 10);
      const compressedSize = buffer.readUInt32LE(offset + 20);
      const nameLen = buffer.readUInt16LE(offset + 28);
      const extraLen = buffer.readUInt16LE(offset + 30);
      const commentLen = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
      if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) {
        // Local file header: pular nome+extra do header local.
        const localNameLen = buffer.readUInt16LE(localOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const data = buffer.slice(dataStart, dataStart + compressedSize);
        const xml = method === 8 ? zlib.inflateRawSync(data) : data;
        // Texto de <a:t>…</a:t>
        const xmlText = xml.toString('utf8');
        for (const m of xmlText.matchAll(/<a:t>([^<]*)<\/a:t>/g)) {
          if (m[1].trim()) texts.push(m[1].trim());
        }
      }
      offset += 46 + nameLen + extraLen + commentLen;
    }
    return texts.join('\n');
  }

  /** Material de IMAGEM por kind OU por mime/extensão — rows legados gravados
 *  com kind 'png'/'jpg' (a derivação antiga usava a extensão) continuam
 *  reconhecíveis. */
function isImageMaterial(material) {
  return (
    material.kind === 'image' ||
    /^image\//i.test(String(material.mimeType || '')) ||
    ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(String(material.kind))
  );
}

async function extractText(material) {
    if (material.kind === 'pdf') {
      const buf = storage.readBuffer(material.sourceRef);
      const result = await pdfParse(buf);
      return result.text || '';
    }
    if (material.kind === 'docx') {
      const buf = storage.readBuffer(material.sourceRef);
      return docxExtract(buf);
    }
    if (material.kind === 'pptx') {
      const buf = storage.readBuffer(material.sourceRef);
      return pptxToText(buf);
    }
    if (material.kind === 'url') {
      const res = await fetchImpl(material.sourceRef || material.sourceUrlFallback);
      if (!res.ok) throw new Error(`URL respondeu HTTP ${res.status}`);
      const html = await res.text();
      return htmlToText(html);
    }
    if (isImageMaterial(material)) {
      // Visão via gateway LiteLLM (2026-10-16): lê o banner/foto e descreve
      // produto/oferta/público para o extractor estruturado. Deps injetadas
      // (testes) vencem; sem LiteLLM configurado → null (needs_manual,
      // degradação explícita de sempre). O arquivo pode estar na raiz
      // (upload) ou em generated/ (imagem gerada por IA).
      if (deps.imageExtract) return deps.imageExtract(material);
      const vision = require('./ai/vision');
      if (vision.isConfigured()) {
        let buf = null;
        try { buf = storage.readBuffer(material.sourceRef); } catch (_e) { /* não é upload */ }
        if (!buf && storage.generatedExists(material.sourceRef)) buf = storage.readGenerated(material.sourceRef);
        if (!buf) throw new Error('arquivo do material indisponível no storage');
        return vision.describeImage({
          buffer: buf,
          mimeType: material.mimeType || 'image/jpeg',
          hint: material.title || null,
        });
      }
      return null;
    }
    if (material.kind === 'video') {
      return null; // transcrição fora do escopo v1 → needs_manual
    }
    if (material.kind === 'prompt' || material.kind === 'company_data') {
      return material.extraction?.sourceText || null;
    }
    throw new Error(`Tipo de material não suportado: ${material.kind}`);
  }

  /**
   * Roda a extração (IA sobre texto). Falha explicável não silencia (FR-029).
   */
  async function runExtraction(material, { description } = {}) {
    try {
      if (material.kind === 'video') {
        // Sem STT na v1: pede descrição manual (spec — limite documentado).
        await prisma.studioMaterial.update({
          where: { id: material.id },
          data: {
            extractionStatus: 'needs_manual',
            extractionError: 'Transcrição de vídeo indisponível na v1: descreva produto, oferta e público manualmente e confirme.',
          },
        });
        return { status: 'needs_manual' };
      }

      let text = null;
      if (description) text = description;
      else text = await extractText(material);

      if (isImageMaterial(material) && text == null) {
        await prisma.studioMaterial.update({
          where: { id: material.id },
          data: {
            extractionStatus: 'needs_manual',
            extractionError: `Análise visual indisponível: o gateway de IA (LITELLM_URL=${process.env.LITELLM_URL || 'http://localhost:4000'}) não está acessível ou não tem modelo de visão (STUDIO_VISION_MODEL). Inicie o gateway ou descreva o material manualmente e confirme.`,
          },
        });
        return { status: 'needs_manual' };
      }
      if (!text || !text.trim()) {
        throw new Error('Material sem texto extraível (vazio ou ilegível).');
      }

      const extraction = await extractor(text, {
        sourceHint: material.kind === 'url' ? material.sourceRef : material.kind,
      });
      const updated = await prisma.studioMaterial.update({
        where: { id: material.id },
        data: {
          extractionStatus: 'extracted',
          extraction: { ...extraction, sourceText: String(text).slice(0, 20_000) },
          extractionError: null,
        },
      });
      return { status: updated.extractionStatus, extraction };
    } catch (err) {
      await prisma.studioMaterial.update({
        where: { id: material.id },
        data: { extractionStatus: 'failed', extractionError: err.message },
      });
      return { status: 'failed', error: err.message };
    }
  }

  async function confirmExtraction(material, edits) {
    const extraction = { ...(material.extraction || {}), ...(edits || {}) };
    return prisma.studioMaterial.update({
      where: { id: material.id },
      data: {
        extraction,
        extractionStatus: material.extractionStatus === 'extracted' ? 'extracted' : 'extracted',
        confirmedAt: new Date(),
      },
    });
  }

  /**
   * AUTO-CURA de materiais de imagem presos sem leitura (2026-10-16):
   * uploads feitos ANTES do deploy da visão nasceram com kind pela extensão
   * e sem ninguém chamando a extração — ficaram pendentes para sempre, e
   * nada os relia. Varre imagem (kind novo OU legado por extensão/mime) em
   * `pending` E em `needs_manual`/`failed` QUANDO o erro é de visão
   * indisponível no momento (o sweep pode ter corrido antes do
   * STUDIO_VISION_MODEL existir — precisa se curar quando a env chega).
   * Reextrai SERIALIZADO, com o mesmo gate do upload automático (premium;
   * trial segue pelo caminho manual/confirm_material). Teto por rodada.
   */
  const VISION_ERROR_RE = /VISION_|vis[ãa]o n[ãa]o configurad[oa]|an[áa]lise visual indispon[íi]vel|gateway.*inacess[íi]vel|vision timeout/i;
  async function extractPendingImageMaterials({ max = 20 } = {}) {
    const vision = require('./ai/vision');
    if (!vision.isConfigured()) {
      return { skipped: 'vision_not_configured', checked: 0, extracted: 0, failed: 0 };
    }
    const { isPremiumOrg } = require('../plan');
    const stuck = await prisma.studioMaterial.findMany({
      where: {
        extractionStatus: { in: ['pending', 'needs_manual', 'failed'] },
        OR: [
          { kind: 'image' },
          { mimeType: { startsWith: 'image/' } },
          { kind: { in: ['png', 'jpg', 'jpeg', 'webp', 'gif'] } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(50, Number(max) || 20)) * 2,
    });
    const retryable = stuck.filter((m) => (
      m.extractionStatus === 'pending' || VISION_ERROR_RE.test(String(m.extractionError || ''))
    )).slice(0, Math.max(1, Math.min(50, Number(max) || 20)));
    let extracted = 0;
    let failed = 0;
    for (const material of retryable) {
      let premium = false;
      try { premium = await isPremiumOrg(prisma, material.orgId); } catch (_e) { /* fail-closed: pula */ }
      if (!premium) continue;
      const run = await runExtraction(material, {});
      if (run.status === 'extracted') extracted += 1;
      else failed += 1;
    }
    return { checked: retryable.length, extracted, failed };
  }

  return { createMaterial, runExtraction, confirmExtraction, pptxToText, extractPendingImageMaterials };
}

module.exports = { createMaterialService };
