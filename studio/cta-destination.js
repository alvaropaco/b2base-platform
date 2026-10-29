'use strict';

/**
 * studio/cta-destination.js — DESTINO CANÔNICO do botão de contato
 * (2026-10-29, pedido do dono: "fale com a empresa" SEMPRE abre o WhatsApp
 * 5512996399943).
 *
 * Cadeia de resolução do destino, da mais específica para a canônica:
 *   1. link REAL definido pelo dono (edit_content ctaUrl / botão do emailDoc);
 *   2. WhatsApp registrado nos materiais da org (cta-cure);
 *   3. ESTE destino padrão — WHATSAPP_CTA_URL ou o número da própria B2Base.
 *
 * Domínio de exemplo/placeholder (exemplo.com.br, example.com…) NUNCA é
 * destino: onde quer que apareça, vira o destino canônico (ver isPlaceholderLink).
 */

const DEFAULT_WHATSAPP_URL = 'https://wa.me/5512996399943';

function whatsappCtaUrl() {
  const fromEnv = String(process.env.WHATSAPP_CTA_URL || '').trim();
  return fromEnv || DEFAULT_WHATSAPP_URL;
}

module.exports = { whatsappCtaUrl, DEFAULT_WHATSAPP_URL };
