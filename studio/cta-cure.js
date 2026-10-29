'use strict';

/**
 * studio/cta-cure.js — CURA do CTA do e-mail (2026-10-29).
 *
 * Caso real: o modelo gerou o botão com domínio de exemplo; o guarda do
 * renderer bloqueia o link fictício (o botão sai SEM link) e o destino real
 * — o WhatsApp do próprio dono — está registrado nos MATERIAIS da org. Se o
 * botão está sem destino válido e os materiais registram EXATAMENTE UM
 * WhatsApp, o botão aponta para ele: link fictício ou morto nunca é opção,
 * e o destino é o da fonte do próprio dono (não é invenção do modelo).
 *
 * Persistência na origem é melhor-esforço; o envio segue com o doc curado
 * em memória de qualquer forma. Vários WhatsApps diferentes nos materiais →
 * NÃO cura (não adivinha entre vários) e devolve o motivo.
 */

function extractWaNumbers(text, found) {
  const re = /https?:\/\/(?:wa\.me|api\.whatsapp\.com\/send\?phone=)\/?(\d{10,15})/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) found.add(m[1]);
}

function isUsableCtaUrl(url) {
  const { sanitizeLink } = require('./email-renderer');
  return Boolean(sanitizeLink(url)); // placeholder/relativa/insegura → ''
}

/**
 * Cura o botão do emailDoc com o WhatsApp dos materiais (quando determinístico).
 * @returns {Promise<{cured:boolean, url?:string, reason?:string}>}
 */
async function cureCta(prisma, { campaign, emailDoc, persist, logger = console }) {
  const blocks = emailDoc && Array.isArray(emailDoc.blocks) ? emailDoc.blocks : [];
  const button = blocks.find((b) => b && b.type === 'button');
  if (button && isUsableCtaUrl(button.url)) return { cured: false, reason: 'cta_ok' };

  // org no Studio é orgId; no disparo (OutreachCampaign) é tenantId.
  const orgId = campaign.orgId || campaign.tenantId;
  const materials = await prisma.studioMaterial.findMany({ where: { orgId } });
  const numbers = new Set();
  for (const m of materials) {
    extractWaNumbers(m.sourceRef, numbers);
    extractWaNumbers(JSON.stringify(m.extraction || {}), numbers);
  }
  if (numbers.size === 0) return { cured: false, reason: 'sem_whatsapp_nos_materiais' };
  if (numbers.size > 1) return { cured: false, reason: 'varios_whatsapps_nos_materiais' };

  const url = `https://wa.me/${[...numbers][0]}`;
  let target = button;
  if (!target) {
    target = { type: 'button', label: 'Falar com a gente no WhatsApp', color: '#25D366' };
    blocks.push(target);
  }
  target.url = url;
  if (typeof persist === 'function') {
    try { await persist(emailDoc); } catch (_e) { /* melhor-esforço: o envio segue com o doc curado em memória */ }
  }
  if (logger && typeof logger.warn === 'function') {
    logger.warn(`[cta-cure] botão do e-mail curado com o WhatsApp dos materiais: ${url}`);
  }
  return { cured: true, url };
}

module.exports = { cureCta, isUsableCtaUrl };
