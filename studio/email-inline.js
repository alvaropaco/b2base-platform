'use strict';

/**
 * studio/email-inline.js — banner do e-mail EMBUTIDO na mensagem (CID).
 *
 * POR QUÊ (2026-10-27, "a imagem não está indo no e-mail"): o src do banner
 * aponta para a origem da plataforma (APP_URL — em dev, localhost). O cliente
 * de e-mail do lead (e o proxy do Gmail) NUNCA alcança localhost — a imagem
 * chega quebrada ou é removida. Embutir a imagem como anexo INLINE
 * (Content-ID, referenciada por `cid:`) leva os DENTRO do próprio e-mail: os
 * bytes viajam junto e o banner abre em qualquer cliente, com ou sem
 * APP_URL público.
 *
 * Falha segura: arquivo ausente/ilegível → a imagem NÃO vai para a lista e o
 * src remoto PERMANECE no HTML (mesma degradação de sempre — nunca quebra o
 * envio por causa da embutida).
 */

const INLINE_SRC_RE = /https?:\/\/[^"'\s>]*\/media\/([a-f0-9]{32}\.(?:png|jpe?g))/gi;

function contentTypeFor(fileName) {
  return String(fileName || '').toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png';
}

/**
 * Encontra no HTML as imagens servidas por /media/:hash e devolve a lista
 * `inlineImages` (bytes em base64 + cid + src original). O HTML volta
 * INTACTO — a troca por `cid:` é feita pelo PROVIDER que de fato embute
 * (`applyCid`), para que um provider sem suporte (Gmail API) mantenha o
 * src remoto de sempre.
 *
 * @param {string} htmlBody
 * @param {object} io - { readGenerated(name): Buffer }
 * @returns {{ html: string, inlineImages: Array<{cid, fileName, embedFileName, content, contentType, originalSrc}> }}
 */
function extractInlineImages(htmlBody, io = {}) {
  const html = String(htmlBody || '');
  const readGenerated = io && typeof io.readGenerated === 'function' ? io.readGenerated : null;
  const inlineImages = [];
  if (!html || !readGenerated) return { html, inlineImages };
  const seen = new Set();
  let match;
  const re = new RegExp(INLINE_SRC_RE.source, 'gi');
  while ((match = re.exec(html)) !== null) {
    const fileName = match[1];
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    try {
      const buffer = readGenerated(fileName);
      inlineImages.push({
        cid: `banner-${fileName.replace(/[^a-z0-9]/gi, '').toLowerCase()}`,
        fileName,
        embedFileName: fileName,
        content: buffer.toString('base64'),
        contentType: contentTypeFor(fileName),
        originalSrc: match[0],
      });
    } catch (_err) {
      // Arquivo ausente/ilegível: mantém o src remoto (degradação de sempre).
    }
  }
  return { html, inlineImages };
}

/** Troca os src originais por `cid:` — SÓ o provider que embute chama. */
function applyCid(htmlBody, inlineImages) {
  let html = String(htmlBody || '');
  for (const img of inlineImages || []) {
    if (img && img.originalSrc && img.cid) {
      html = html.split(img.originalSrc).join(`cid:${img.cid}`);
    }
  }
  return html;
}

module.exports = { extractInlineImages, applyCid };
