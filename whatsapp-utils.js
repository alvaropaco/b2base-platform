/**
 * whatsapp-utils.js — helpers puros e sem efeitos colaterais para o canal WhatsApp:
 *   - normalização de telefone / chatId
 *   - interpolação de template (sanitizada)
 *   - detecção de opt-out
 *   - chaves de idempotência
 */

const crypto = require('crypto');

// ─── Telefones ────────────────────────────────────────────────────────────────
// O WhatsApp usa chatId no formato <digits>@c.us. Normalizamos para E.164
// (Brasil default 55) e derivamos o chatId de forma determinística.

function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (!digits) return null;
  // Remove código do país (55) se presente e o número tem comprimento de BR.
  if (digits.startsWith('55') && digits.length >= 12) {
    digits = digits.slice(2);
  }
  // Número brasileiro: DDD (2) + número (8 ou 9 dígitos) = 10 ou 11 dígitos.
  if (digits.length >= 10 && digits.length <= 11) {
    digits = '55' + digits;
  }
  return digits;
}

function toChatId(phone) {
  // JIDs completos (ex.: "850...@lid", "1203...@g.us") passam inalterados —
  // reconstruir "<digits>@c.us" quebra chats LID/grupo.
  if (String(phone || '').includes('@')) return String(phone);
  const normalized = normalizePhone(phone);
  return normalized ? `${normalized}@c.us` : null;
}

function phoneFromChatId(chatId) {
  return String(chatId || '').split('@')[0].replace(/\D/g, '');
}

// ─── Interpolação de template (sanitizada) ──────────────────────────────────
// Nunca interpolamos dados diretamente: só as chaves conhecidas são substituídas
// e todo valor é sanitizado (control chars removidos, tamanho limitado). O texto
// é plain-text (WhatsApp não interpreta HTML), então a sanitização foca em
// impedir quebras de linha indevidas/injeção de conteúdo de controle.

function _safe(value) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 500);
}

function _firstWord(value) {
  const words = String(value || '').trim().split(/\s+/);
  return words[0] || '';
}

function _partnerName(lead) {
  const partners = Array.isArray(lead.cnpjPartners) ? lead.cnpjPartners : null;
  if (partners && partners.length) {
    const first = partners[0];
    return (first && (first.name || first.nome)) || '';
  }
  return '';
}

function buildTemplateVars(lead) {
  const partner = _partnerName(lead);
  return {
    // Pessoa de contato é a fonte primária do primeiro nome (007/US2): lead
    // B2B sem contato identificado degrada para saudação SEM nome — o nome
    // da empresa (tradeName/companyName) nunca é tratado como pessoa.
    firstName: _safe(_firstWord(lead.contactName || partner || '')),
    companyName: _safe(lead.companyName || ''),
    jobTitle: _safe((lead.cnpjPartners && lead.cnpjPartners[0] && lead.cnpjPartners[0].qual) || ''),
    city: _safe(lead.city || ''),
    industry: _safe(lead.industry || ''),
  };
}

// Apelidos snake_case escritos pelo usuário → chaves canônicas do motor
// (QA 2026-10-06: {{first_name}} era limpo em silêncio no render).
const TEMPLATE_ALIAS_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

function normalizeTemplateAliases(template) {
  return String(template || '').replace(TEMPLATE_ALIAS_RE, (raw, name) => {
    if (name in buildTemplateVars({})) return raw;
    const camel = name.replace(/_([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
    return camel in buildTemplateVars({}) ? `{{${camel}}}` : raw;
  });
}

function renderTemplate(template, lead) {
  let out = normalizeTemplateAliases(template);
  const vars = buildTemplateVars(lead);
  for (const [key, value] of Object.entries(vars)) {
    out = out.replace(new RegExp('\\{\\{\\s*' + key + '\\s*\\}\\}', 'g'), value);
  }
  out = stripUnresolvedPlaceholders(out);
  // Variável vazia deixava resíduo de pontuação na mensagem ENVIADA
  // ("Olá,!" — 09/10): colapsa vírgula órfã antes de pontuação final.
  return out
    .replace(/,\s*([!?…])/g, '$1')
    .replace(/\s+([!?…])/g, ' $1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Garantia SC-011 como função pura: nenhuma placeholder `{{...}}` residual
 * chega ao lead. Usada no fim do renderTemplate e, como cinto-e-suspensório,
 * no próprio envio (outreach-workers.processSend) — incidente 2026-10-06:
 * base por perfil composta com "{{firstName}}" e enviada literal (159 leads).
 * Remove o placeholder e arruma o rastro de espaço/pontuação pendurada
 * ("Olá , tudo bem?" → "Olá, tudo bem?").
 */
function stripUnresolvedPlaceholders(text) {
  return String(text || '')
    .replace(/\{\{\s*[\w.]+\s*\}\}/g, '')
    .replace(/[ \t]+([,;.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ─── Opt-out ─────────────────────────────────────────────────────────────────
function _normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

const OPT_OUT_KEYWORDS = [
  'STOP',
  'SAIR',
  'PARAR',
  'SAIA',
  'PARE',
  'NAO QUERO',
  'NAO QUERO RECEBER',
  'CANCELAR',
  'CANCELA',
  'REMOVER',
  'DESCADASTRAR',
  'DESINSCREVER',
  'OPT OUT',
  'OPTOUT',
];

/**
 * Detecta se uma mensagem inbound é um pedido de opt-out.
 * Comparação por palavra isolada + prefixo + igualdade, sobre texto normalizado
 * (acentos removidos, caixa alta).
 */
function isOptOutMessage(text) {
  const t = _normalizeText(text);
  if (!t) return false;
  const tokens = t.split(/\s+/);
  return OPT_OUT_KEYWORDS.some((kw) => {
    const k = _normalizeText(kw);
    if (t === k) return true;
    if (t.startsWith(k + ' ') || t.startsWith(k + '!') || t.startsWith(k + '.')) return true;
    if (k.includes(' ')) return t.includes(k);
    return tokens.includes(k);
  });
}

// ─── Guard de conteúdo (compartilhado pelos agentes do WhatsApp) ─────────────
// Afirmações proibidas em qualquer mensagem automatizada: preço/promoção/
// garantia (não temos esses dados — ver b2base-context.naoAFirmar).
const BLOCKLIST = /(r\$\s?\d|desconto|grátis|gratis|garantid|promoç|promocao|promoção|hoje apenas|últimas vagas|ultimas vagas)/i;

// ─── Guard de INGESTÃO de template (007) ────────────────────────────────────
// Templates de mensagem (WhatsApp/email) são validados na ENTRADA — não só na
// saída da IA — para que nenhum template com afirmação proibida, comprimento
// acima do canal ou placeholder desconhecido seja persistido e depois enviado.
const TEMPLATE_VARS = ['firstName', 'companyName', 'jobTitle', 'city', 'industry'];
const TEMPLATE_MAX_LEN = 600; // limite de comprimento do canal WhatsApp

function validateTemplateMessage(template, { maxLength = TEMPLATE_MAX_LEN } = {}) {
  const content = String(template || '').trim();
  if (!content) return { ok: false, reason: 'empty' };
  if (content.length > maxLength) return { ok: false, reason: 'too_long' };
  const placeholders = content.match(/\{\{\s*[\w.]+\s*\}\}/g) || [];
  const unknown = placeholders
    .map((p) => p.replace(/[{}\s]/g, ''))
    .find((key) => !TEMPLATE_VARS.includes(key));
  if (unknown) return { ok: false, reason: 'unknown_placeholder', detail: unknown };
  if (BLOCKLIST.test(content)) return { ok: false, reason: 'blocked_claim' };
  return { ok: true, reason: null };
}

/**
 * Ajusta uma mensagem ao limite do canal preservando frases inteiras
 * (FR-007): o corte é em fim de frase, depois em espaço — a BASE do texto
 * nunca é trocada por outro conteúdo.
 */
function truncateForWhatsApp(text, maxLength = TEMPLATE_MAX_LEN) {
  const content = String(text || '').trim();
  if (content.length <= maxLength) return content;
  const cut = content.slice(0, maxLength);
  const sentenceEnd = Math.max(
    cut.lastIndexOf('. '),
    cut.lastIndexOf('! '),
    cut.lastIndexOf('? ')
  );
  if (sentenceEnd > Math.floor(maxLength / 2)) return cut.slice(0, sentenceEnd + 1).trim();
  const space = cut.lastIndexOf(' ');
  return space > 0 ? cut.slice(0, space).trim() : cut.trim();
}

function normalizeForCompare(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// ─── Idempotência ────────────────────────────────────────────────────────────
function idempotencyKey(...parts) {
  return crypto
    .createHash('sha256')
    .update(parts.map((p) => String(p == null ? '' : p)).join('|'))
    .digest('hex')
    .slice(0, 32);
}

function stepIdempotencyKey(campaignId, prospectId, stepIndex) {
  return idempotencyKey(campaignId, prospectId, stepIndex);
}

/**
 * Normaliza um campo Json/string para lista de strings não-vazias (aceita
 * array JSON ou "a, b, c"). Usado nos contextos de IA (org-context.js).
 */
function asStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

module.exports = {
  normalizePhone,
  toChatId,
  phoneFromChatId,
  renderTemplate,
  stripUnresolvedPlaceholders,
  buildTemplateVars,
  isOptOutMessage,
  OPT_OUT_KEYWORDS,
  BLOCKLIST,
  validateTemplateMessage,
  truncateForWhatsApp,
  TEMPLATE_VARS,
  TEMPLATE_MAX_LEN,
  normalizeForCompare,
  asStringList,
  idempotencyKey,
  stepIdempotencyKey,
};
