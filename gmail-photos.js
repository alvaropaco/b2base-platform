'use strict';

/**
 * gmail-photos.js — envio de FOTOS por e-mail na conta Gmail conectada
 * (2026-10-27). Usado pela rota POST /api/gmail/photos do painel.
 *
 * Regras (todas validadas NO SERVIDOR — nunca confiar no navegador):
 *   - destinatário e-mail válido (RFC simples);
 *   - extensão E tipo de conteúdo na lista branca: jpg/jpeg/png/webp;
 *   - até MAX_PHOTOS fotos por envio, cada uma até MAX_FILE_BYTES;
 *   - total até MAX_TOTAL_BYTES (margem sob o teto de 25 MB do Gmail —
 *     base64 adiciona ~37% de overhead; se estourar, recusa ANTES de enviar);
 *   - conta Gmail (provider 'gmail') conectada e pertencente ao usuário.
 *
 * Segurança: tokens ficam cifrados no banco (AES-256-GCM) e NUNCA vão para
 * o frontend; nada é logado além do resultado (ids/contagens).
 */

const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_PHOTOS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB por foto
const MAX_TOTAL_BYTES = 18 * 1024 * 1024; // margem p/ overhead MIME sob os 25 MB do Gmail

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extFromName(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

/**
 * Valida o lote de fotos + destino. Devolve { ok: true, attachments, totalBytes }
 * ou { ok: false, status, error } — mensagens em PT-BR acionáveis.
 */
function validatePhotoPayload({ to, photos }) {
  const recipient = String(to || '').trim();
  if (!EMAIL_RE.test(recipient)) {
    return { ok: false, status: 400, error: 'Destinatário inválido — informe um e-mail válido (ex.: pessoa@empresa.com).' };
  }

  const list = Array.isArray(photos) ? photos : [];
  if (list.length === 0) {
    return { ok: false, status: 400, error: 'Selecione pelo menos UMA foto para enviar.' };
  }
  if (list.length > MAX_PHOTOS) {
    return { ok: false, status: 400, error: `Máximo de ${MAX_PHOTOS} fotos por envio (recebi ${list.length}).` };
  }

  const attachments = [];
  let totalBytes = 0;
  for (const photo of list) {
    const ext = extFromName(photo.originalname);
    if (!ALLOWED_EXTENSIONS.includes(ext) || !ALLOWED_MIME_TYPES.includes(photo.mimetype)) {
      return {
        ok: false,
        status: 400,
        error: `"${photo.originalname}" não é aceita — use JPG, JPEG, PNG ou WEBP.`,
      };
    }
    const size = Number(photo.size) || Buffer.byteLength(photo.buffer);
    if (size > MAX_FILE_BYTES) {
      return { ok: false, status: 413, error: `"${photo.originalname}" passa de 10 MB — reduza a foto antes de enviar.` };
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        status: 413,
        error: `O conjunto passa de ${Math.round(MAX_TOTAL_BYTES / (1024 * 1024))} MB (limite do Gmail com a codificação do e-mail). Envie em duas remessas.`,
      };
    }
    attachments.push({
      fileName: String(photo.originalname || 'foto').slice(0, 120),
      content: Buffer.from(photo.buffer).toString('base64'),
      contentType: photo.mimetype,
    });
  }

  return { ok: true, recipient, attachments, totalBytes };
}

/**
 * Escolhe a conta Gmail conectada do usuário (a mais recente).
 * Escopo por userId — o dono só envia de contas DELE.
 */
async function pickGmailAccount(prisma, userId) {
  const account = await prisma.emailAccount.findFirst({
    where: { userId, provider: 'gmail', status: 'connected' },
    orderBy: { createdAt: 'desc' },
  });
  return account;
}

/**
 * Envia as fotos. Só considera ENVIADO após confirmação da API (messageId).
 * @param {object} deps - { prisma, emailProvider: {sendEmailForAccount} }
 */
async function sendPhotos(deps, { userId, to, subject, message, photos }) {
  const { prisma, emailProvider } = deps;
  const check = validatePhotoPayload({ to, photos });
  if (!check.ok) {
    const err = new Error(check.error);
    err.status = check.status;
    err.expose = true;
    throw err;
  }

  const account = await pickGmailAccount(prisma, userId);
  if (!account) {
    const err = new Error('Nenhuma conta Gmail conectada — clique em "Conectar com Google" primeiro.');
    err.status = 409;
    err.expose = true;
    throw err;
  }

  const text = String(message || '').trim() || 'Seguem as fotos em anexo.';
  const html = `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>')}</p><p>${check.attachments.length} foto(s) em anexo.</p>`;

  // Só chega aqui APÓS a resposta da Gmail API — o messageId veio de lá.
  const result = await emailProvider.sendEmailForAccount(prisma, account.id, {
    to: check.recipient,
    subject: String(subject || '').trim() || 'Fotos',
    body: text,
    htmlBody: html,
    messageId: `fotos-${require('crypto').randomUUID()}`,
    attachments: check.attachments,
  });

  return {
    to: check.recipient,
    from: account.email,
    count: check.attachments.length,
    totalBytes: check.totalBytes,
    messageId: result.messageId,
    attachmentsSkipped: result.attachmentsSkipped || [],
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  MAX_PHOTOS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  validatePhotoPayload,
  pickGmailAccount,
  sendPhotos,
};
