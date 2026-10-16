'use strict';

/**
 * studio/email-renderer.js — documento de blocos → HTML responsivo (T053).
 *
 * ÚNICA função de render do Studio: preview (T054) e envio (channel-bridge)
 * chamam a mesma função, garantindo preview ≡ envio (SC-006). Compila MJML
 * server-side (pesquisa D7) com CSS inline para compatibilidade entre
 * clientes de e-mail. Blocos condicionais são resolvidos POR LEAD no
 * momento do render (FR-034); variáveis usam fallback (FR-033/SC-011) e
 * links recebem a UTM da campanha (FR-037).
 */

const { renderTemplate } = require('./variables');

let mjml2html = null;
try {
  mjml2html = require('mjml');
} catch (_) {
  mjml2html = null; // ambiente sem mjml → fallback HTML simples (testes leves)
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Condição de bloco sobre atributos do lead (catálogo simples). */
function matchesCondition(condition, lead) {
  if (!condition) return true;
  const value = lead ? lead[condition.field] : undefined;
  const target = condition.value;
  switch (condition.op) {
    case 'contains':
      return String(value ?? '').toLowerCase().includes(String(target).toLowerCase());
    case 'equals':
      return String(value ?? '') === String(target);
    case 'exists':
      return value != null && value !== '';
    case 'gte':
      return Number(value) >= Number(target);
    case 'lte':
      return Number(value) <= Number(target);
    default:
      return true; // operador desconhecido não bloqueia o envio
  }
}

/** Filtra blocos cuja condição não casa com o lead (FR-034). */
function resolveConditions(blocks, lead) {
  return (blocks || []).filter((block) => matchesCondition(block.condition, lead));
}

/** Anexa UTM da campanha aos links (FR-037), preservando query existente. */
const UTM_KEY_MAP = { utmSource: 'utm_source', utmMedium: 'utm_medium', utmCampaign: 'utm_campaign' };

function applyUtm(url, utmTemplate) {
  if (!url || !utmTemplate || Object.keys(utmTemplate).length === 0) return url;
  const [base, existingQuery] = String(url).split('?');
  if (existingQuery && existingQuery.includes('utm_')) return url; // já tem UTM
  const params = new URLSearchParams(existingQuery || '');
  for (const [key, value] of Object.entries(utmTemplate)) {
    const param = UTM_KEY_MAP[key] || key;
    if (value) params.set(param, String(value));
  }
  return `${base}?${params.toString()}`;
}

function blockToHtml(block, lead, utmTemplate, fallbacks) {
  const mergedFallbacks = { ...(fallbacks || {}), ...(block.fallbacks || {}) };
  const text = renderTemplate(block.text || '', lead, { fallbacks: mergedFallbacks, escapeHtml: true });
  switch (block.type) {
    case 'button': {
      const url = applyUtm(renderTemplate(block.url || '#', lead), utmTemplate);
      return `<a href="${escapeHtml(url)}" style="display:inline-block;background:#4f46e5;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">${escapeHtml(
        renderTemplate(block.label || 'Saiba mais', lead)
      )}</a>`;
    }
    case 'image': {
      // Banner por link: src obrigatório, href opcional (banner clicável,
      // UTM aplicada como em qualquer link — FR-037).
      const src = escapeHtml(block.src || '');
      const alt = escapeHtml(block.alt || '');
      const img = `<img src="${src}" alt="${alt}" style="width:100%;max-width:100%;height:auto;display:block;border-radius:6px;" />`;
      if (block.href) {
        const url = applyUtm(renderTemplate(block.href, lead), utmTemplate);
        return `<a href="${escapeHtml(url)}" target="_blank" style="text-decoration:none;">${img}</a>`;
      }
      return img;
    }
    case 'divider':
      return '<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;" />';
    case 'columns':
      return `<div style="display:flex;gap:16px;">${(block.children || [])
        .map((child) => `<div style="flex:1;">${blockToHtml(child, lead, utmTemplate)}</div>`)
        .join('')}</div>`;
    default:
      return `<p style="margin:0 0 12px 0;font-size:15px;line-height:1.6;">${text.replace(/\n/g, '<br/>')}</p>`;
  }
}

function blocksToText(blocks, lead, utmTemplate, fallbacks) {
  return (blocks || [])
    .map((block) => {
      if (block.type === 'button') {
        const url = applyUtm(block.url || '', utmTemplate);
        return `${renderTemplate(block.label || '', lead)}: ${url}`;
      }
      if (block.type === 'divider') return '---';
      if (block.type === 'columns') {
        return (block.children || []).map((child) => renderTemplate(child.text || '', lead)).join(' | ');
      }
      if (block.type === 'image') return '';
      return renderTemplate(block.text || '', lead, { fallbacks: { ...(fallbacks || {}), ...(block.fallbacks || {}) } });
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Renderiza o documento de blocos para um lead.
 * @returns {{ html: string, text: string }} mesma saída para preview e envio.
 */
function renderEmail(emailDoc, lead, { utmTemplate, fallbacks } = {}) {
  const blocks = resolveConditions(emailDoc?.blocks || [], lead);
  const inner = blocks.map((block) => blockToHtml(block, lead, utmTemplate, fallbacks)).join('\n');
  const bodyHtml = blocksToText(blocks, lead, utmTemplate, fallbacks);

  let html;
  if (mjml2html) {
    const mjml = `<mjml><mj-body width="600px" background-color="#f4f4f7">
      <mj-section background-color="#ffffff" padding="24px"><mj-column>${inner}</mj-column></mj-section>
    </mj-body></mjml>`;
    try {
      const compiled = mjml2html(mjml, { validationLevel: 'soft' });
      html = compiled?.html || fallbackHtml(inner);
    } catch (_) {
      html = fallbackHtml(inner);
    }
  } else {
    html = fallbackHtml(inner);
  }
  return { html, text: bodyHtml };
}

/** Fallback HTML (mesma estrutura mínima) quando mjml indisponível. */
function fallbackHtml(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width"/></head><body style="margin:0;background:#f4f4f7;"><div style="max-width:600px;margin:0 auto;padding:24px;font-family:Arial,sans-serif;">${inner}</div></body></html>`;
}

module.exports = { renderEmail, resolveConditions, matchesCondition, applyUtm };
