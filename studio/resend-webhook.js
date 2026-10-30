'use strict';

/**
 * studio/resend-webhook.js — WEBHOOK DO RESEND (2026-10-30).
 *
 * Eventos REAIS do provedor (entrega, bounce, abertura, clique) passam a
 * ser registrados em vez de inferidos. Correlação pelo id do provider,
 * persistido em OutreachMessage.gmailMessageId no envio (campo histórico
 * que guarda o id retornado pelo provider — Gmail OU Resend — e é indexado;
 * sem migração e sem depender de assunto/endereço).
 *
 * Segurança: assinatura Svix (padrão oficial do Resend) sobre o payload
 * cru — `v1,base64(HMAC-SHA256(chave, "{id}.{timestamp}.{body}"))` — com
 * tolerância de 5 min contra replay. Sem segredo configurado, o endpoint
 * rejeita (503): nunca processa sem verificação.
 *
 * Idempotência: transições de status são MONOTÔNICAS (nunca regridem —
 * SENT < DELIVERED < OPENED < REPLIED; BOUNCED/COMPLAINED/UNSUBSCRIBED
 * terminais) e o evento só é gravado quando há mudança real. Entrega
 * CONFIRMADA nunca é confundida com "aceito pelo provider".
 */

const crypto = require('crypto');

const RESEND_EVENT_TYPES = [
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.opened',
  'email.clicked',
];

// Escada de progressão do contato por e-mail (índice maior = mais avançado).
const STATUS_ORDER = {
  SCHEDULED: 0, QUEUED: 0, GENERATING: 0,
  SENT: 1, DELIVERED_INFERRED: 1,
  DELIVERED: 2,
  OPENED_INFERRED: 3, OPENED: 4,
  REPLIED: 5,
  BOUNCED: 5, COMPLAINED: 5, UNSUBSCRIBED: 5, CANCELLED: 5,
};
const TERMINAL = new Set(['BOUNCED', 'COMPLAINED', 'UNSUBSCRIBED', 'REPLIED', 'CANCELLED']);

// evento Resend → status do contato + tipo do evento interno.
const EVENT_MAP = {
  'email.delivered': { status: 'DELIVERED', type: 'email_delivered_confirmed' },
  'email.bounced': { status: 'BOUNCED', type: 'email_bounced' },
  'email.complained': { status: 'COMPLAINED', type: 'email_complained' },
  'email.opened': { status: 'OPENED', type: 'email_opened' },
  'email.clicked': { status: null, type: 'email_clicked' },
  'email.delivery_delayed': { status: null, type: 'email_delivery_delayed' },
};

/** Verificação Svix (padrão do Resend). Retorna { ok, reason } — nunca lança. */
function verifySvixSignature(rawBody, headers, secret, { toleranceSeconds = 300, nowMs = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'webhook_secret_ausente' };
  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signatureHeader = headers['svix-signature'];
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: 'headers_svix_ausentes' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp_invalido' };
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return { ok: false, reason: 'timestamp_fora_da_janela' };

  let key;
  try {
    key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  } catch (_err) {
    return { ok: false, reason: 'secret_invalido' };
  }
  const signedContent = `${id}.${timestamp}.${String(rawBody || '')}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');

  // Formato oficial: "v1,<base64> v1,<base64> ..." — qualquer match vale.
  const provided = String(signatureHeader)
    .split(' ')
    .map((pair) => pair.replace(/^v1,/, '').trim())
    .filter(Boolean);

  const expectedBuf = Buffer.from(expected);
  const anyMatch = provided.some((sig) => {
    const providedBuf = Buffer.from(sig);
    return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  });
  return anyMatch ? { ok: true } : { ok: false, reason: 'assinatura_invalida' };
}

/** Evento já registrado para este contato/providerEvent? (idempotência) */
async function eventAlreadyRecorded(prisma, { contactId, type, eventId }) {
  if (!eventId) return false;
  const existing = await prisma.outreachEvent.findFirst({
    where: { contactId, type, details: { path: ['providerEventId'], equals: eventId } },
    select: { id: true },
  });
  return Boolean(existing);
}

/**
 * Aplica um evento do Resend ao contato da mensagem correlacionada.
 * @returns {Promise<{handled:boolean, reason?:string, status?:string, changed?:boolean}>}
 */
async function applyResendEvent(prisma, payload, { logger = console } = {}) {
  const type = String(payload?.type || '');
  if (!RESEND_EVENT_TYPES.includes(type)) return { handled: false, reason: 'tipo_nao_suportado' };
  const providerMessageId = String(payload?.data?.email_id || '');
  const providerEventId = String(payload?.data?.id || '') || undefined; // id do EVENTO (svix/payload)
  if (!providerMessageId) return { handled: false, reason: 'email_id_ausente' };

  const message = await prisma.outreachMessage.findUnique({
    where: { gmailMessageId: providerMessageId },
    include: { contact: { include: { campaign: { select: { tenantId: true } } } } },
  });
  if (!message || !message.contact) return { handled: false, reason: 'mensagem_nao_encontrada' };

  // email.sent já é registrado no envio — evento repetido é no-op.
  if (type === 'email.sent') return { handled: true, reason: 'ja_registrado_no_envio' };

  const contact = message.contact;
  const mapping = EVENT_MAP[type];
  let changed = false;
  let newStatus;

  if (mapping.status) {
    const current = STATUS_ORDER[contact.status] ?? 0;
    const target = STATUS_ORDER[mapping.status] ?? 0;
    if (TERMINAL.has(contact.status) || target <= current) {
      // Nunca regride; terminal nunca é sobrescrito. Evento só se inédito.
      const duplicated = await eventAlreadyRecorded(prisma, { contactId: contact.id, type: mapping.type, eventId: providerEventId });
      if (!duplicated) {
        await prisma.outreachEvent.create({ data: {
          contactId: contact.id, messageId: message.id, type: mapping.type, status: 'ignored',
          details: { provider: 'resend', providerEventId, providerMessageId, contactStatus: contact.status },
        } });
      }
      return { handled: true, reason: 'status_ja_avancado', status: contact.status };
    }
    newStatus = mapping.status;
  }

  if (newStatus && newStatus !== contact.status) {
    await prisma.outreachContact.update({ where: { id: contact.id }, data: { status: newStatus } });
    contact.status = newStatus;
    changed = true;
  }

  const duplicated = await eventAlreadyRecorded(prisma, { contactId: contact.id, type: mapping.type, eventId: providerEventId });
  if (!duplicated) {
    await prisma.outreachEvent.create({ data: {
      contactId: contact.id, messageId: message.id, type: mapping.type,
      status: newStatus ? 'confirmed' : 'info',
      details: { provider: 'resend', providerEventId, providerMessageId },
    } });
    changed = true;
  }

  // Bounce/complaint são falha definitiva do contato → estorno do débito.
  if (type === 'email.bounced' || type === 'email.complained') {
    try {
      const orgId = contact.campaign?.tenantId;
      if (orgId) {
        const reputation = require('./reputation');
        await reputation.refundSend(prisma, { orgId, channel: 'email', messageId: message.id, reason: type });
      }
    } catch (err) {
      logger.warn?.(`[resend-webhook] estorno de ${type} falhou (ignorado): ${err.message}`);
    }
  }

  if (changed) logger.log?.(`[resend-webhook] ${type} → contato ${contact.id} (${newStatus || mapping.type})`);
  return { handled: true, status: newStatus || contact.status, changed };
}

module.exports = { verifySvixSignature, applyResendEvent, RESEND_EVENT_TYPES, STATUS_ORDER };
