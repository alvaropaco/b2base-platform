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
        kind: kind || (buffer ? storage.extFromMime(mimeType, originalName) : url ? 'url' : 'prompt'),
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
    if (material.kind === 'image') {
      // Sem modelo de visão configurado nos deps → manual (degradação explícita).
      if (deps.imageExtract) return deps.imageExtract(material);
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

      if (material.kind === 'image' && text == null) {
        await prisma.studioMaterial.update({
          where: { id: material.id },
          data: {
            extractionStatus: 'needs_manual',
            extractionError: 'Modelo de visão não configurado: descreva o material manualmente e confirme.',
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

  return { createMaterial, runExtraction, confirmExtraction, pptxToText };
}

module.exports = { createMaterialService };
