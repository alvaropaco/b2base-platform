'use strict';

/**
 * studio/attachment-service.js — anexos que saem JUNTO na mensagem (Story
 * 2.1, FR6 da onda "criação de campanha sem bloqueios").
 *
 * Diferente de StudioMaterial (insumo de IA): o anexo vive no storage do
 * Studio (`studio/storage.js`: SHA-256, whitelist de extensão) e é resolvido
 * NA LIBERAÇÃO do lote pelo channel-bridge (D6), por REFERÊNCIA (D8 — nada
 * de base64 em JSONB). Limites por plano visíveis antes de enviar (5MB
 * trial / 25MB premium — NFR5); multi-tenancy em toda query (NFR2).
 */

const storage = require('./storage');

const MAX_UPLOAD_TRIAL = 5 * 1024 * 1024; // 5MB
const MAX_UPLOAD_PREMIUM = 25 * 1024 * 1024; // 25MB

const CHANNELS = ['email', 'whatsapp', 'both'];

function createAttachmentService(prisma) {
  /**
   * Cria o anexo a partir do buffer já recebido (multipart). Valida canal
   * destino, extensão (whitelist do storage) e tamanho por plano.
   */
  async function createAttachment({ orgId, userId, campaignId, buffer, mimeType, originalName, channels }) {
    // Canal destino: ausente → 'both'; PRESENTE e inválido → 400 explicável
    // (nunca coerção silenciosa).
    let channel = 'both';
    if (channels != null && channels !== '') {
      if (!CHANNELS.includes(channels)) {
        const err = new Error(`Canal destino inválido: "${channels}" — use email, whatsapp ou both.`);
        err.code = 'INVALID_ATTACHMENT_CHANNEL';
        err.status = 400;
        throw err;
      }
      channel = channels;
    }

    // Whitelist de extensão (mesma do storage) — recusa explicável ANTES de
    // salvar; `bin` = extensão fora da whitelist/mime desconhecido.
    const ext = storage.extFromMime(mimeType, originalName);
    if (ext === 'bin') {
      const err = new Error(
        'Tipo de arquivo fora da lista permitida (imagens, PDF, DOCX, PPTX, TXT, CSV, MP4/MOV/WEBM).'
      );
      err.code = 'INVALID_FILE_TYPE';
      err.status = 400;
      throw err;
    }

    const saved = storage.saveBuffer(buffer, ext);
    return prisma.studioAttachment.create({
      data: {
        orgId,
        campaignId: campaignId || null,
        fileName: saved.fileName,
        originalName: String(originalName || 'arquivo').slice(0, 200),
        mimeType: mimeType || null,
        sizeBytes: buffer.length,
        channels: channel,
        uploadedById: userId || null,
      },
    });
  }

  /** Anexo da org (escopo de org em toda leitura — NFR2). */
  async function loadAttachment(orgId, id) {
    const attachment = await prisma.studioAttachment.findUnique({ where: { id } });
    if (!attachment || attachment.orgId !== orgId) return null;
    return attachment;
  }

  /**
   * Remoção: o REGISTRO sai primeiro e o arquivo depois (E10) — MAS só se
   * nenhum outro anexo da org compartilha o mesmo fileName (o storage dedup
   * por SHA-256: apagar sem refcount mataria o anexo irmão de conteúdo
   * idêntico).
   */
  async function removeAttachment(attachment) {
    await prisma.studioAttachment.deleteMany({ where: { id: attachment.id, orgId: attachment.orgId } });
    const siblings = await prisma.studioAttachment.count({
      where: { orgId: attachment.orgId, fileName: attachment.fileName },
    });
    if (siblings === 0) {
      try {
        storage.removeFile(attachment.fileName);
      } catch (err) {
        console.error('[studio:attachment] arquivo órfão no storage (registro já removido):', err.message);
      }
    }
    return { id: attachment.id, deleted: true, fileKept: siblings > 0 };
  }

  return { createAttachment, loadAttachment, removeAttachment, limits: { MAX_UPLOAD_TRIAL, MAX_UPLOAD_PREMIUM } };
}

module.exports = { createAttachmentService, CHANNELS, MAX_UPLOAD_TRIAL, MAX_UPLOAD_PREMIUM };
