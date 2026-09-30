'use strict';

/**
 * studio/segment-service.js — segmentos do Studio (specs/010, T025; US2).
 *
 * Catálogo FECHADO de campos/operadores (pesquisa D3): os critérios são um
 * documento JSON versionado traduzido para `where` do Prisma por whitelist —
 * nunca SQL de usuário. Segmento por linguagem natural (FR-014) produz o
 * MESMO documento, com os critérios explicados (studio/ai/segment-nl.js).
 *
 * Nota v1: CNAE entra no catálogo quando o enriquecimento passar a
 * normalizá-lo no Prospect (spec FR-008: "CNAE quando disponível").
 */

const REGIONS = {
  Norte: ['AC', 'AP', 'AM', 'PA', 'RO', 'RR', 'TO'],
  Nordeste: ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'],
  'Centro-Oeste': ['DF', 'GO', 'MT', 'MS'],
  Sudeste: ['ES', 'MG', 'RJ', 'SP'],
  Sul: ['PR', 'RS', 'SC'],
};

const { normalizeText } = require('../search-text');

/** Catálogo fechado: campo → operadores permitidos. */
const FIELD_CATALOG = {
  industry: ['contains', 'equals'],
  companyName: ['contains', 'equals'], // razão social (Epic 1, FR4)
  tradeName: ['contains', 'equals'], // nome fantasia (Epic 1, FR4)
  city: ['contains', 'equals'],
  state: ['equals', 'in'],
  region: ['equals', 'in'], // derivada do estado (REGIONS)
  revenueEstimate: ['gte', 'lte'],
  employees: ['gte', 'lte'],
  opportunityScore: ['gte', 'lte'],
  verdict: ['equals', 'in'], // contact | no_contact
  status: ['equals', 'in'],
  enrichmentStatus: ['equals', 'in'],
  creditRiskScore: ['gte', 'lte'],
  contactedChannels: ['array_contains'], // canal dentro do Json ["email","whatsapp"]
  lastContact: ['gte', 'lte'], // datas ISO
  createdAt: ['gte', 'lte'],
};

/**
 * Campos de texto livre que compõem `Prospect.searchText` (Epic 1, FR4).
 * Só eles ganham a busca normalizada por `searchText contains` — `contains`
 * nos demais campos (status etc.) mantém a semântica literal de sempre.
 */
const SEARCHTEXT_FIELDS = new Set(['industry', 'companyName', 'tradeName']);

/**
 * Termos atômicos normalizados de um valor de busca (Epic 1, FR4/FR6):
 * frase composta vira lista de termos ("indústrias metalmecânicas" →
 * ["industrias", "industria", "metalmecanicas", "metalmecanica"]), já em
 * caixa baixa e sem acento — igual ao searchText do Prospect. Plural simples
 * gera variantes extras (OR — só aumenta recall, nunca inventa lead).
 */
function termVariants(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  // Mínimo 2 caracteres: siglas reais da base ("TI", "RH") não podem sumir.
  const terms = normalized.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
  const variants = new Set();
  for (const term of terms) {
    variants.add(term);
    if (term.length > 4 && term.endsWith('es')) variants.add(term.slice(0, -2));
    if (term.length > 3 && term.endsWith('s')) variants.add(term.slice(0, -1));
  }
  return [...variants];
}

function badRequest(message) {
  const err = new Error(message);
  err.code = 'INVALID_CRITERIA_FIELD';
  err.status = 400;
  return err;
}

function validateCondition(condition) {
  const { field, op, value } = condition || {};
  const allowed = FIELD_CATALOG[field];
  if (!allowed) throw badRequest(`Campo fora do catálogo: ${field}`);
  if (!allowed.includes(op)) throw badRequest(`Operador inválido para ${field}: ${op}`);
  if (value === undefined) throw badRequest(`Condição sem valor: ${field}`);
}

function validateCriteria(criteria) {
  if (!criteria || !Array.isArray(criteria.groups)) {
    throw badRequest('Critérios inválidos: groups ausente.');
  }
  for (const group of criteria.groups) {
    if (!['AND', 'OR'].includes(group.op)) throw badRequest(`Grupo com operador inválido: ${group.op}`);
    if (!Array.isArray(group.conditions)) throw badRequest('Grupo sem conditions.');
    for (const condition of group.conditions) validateCondition(condition);
  }
  return true;
}

function translateCondition({ field, op, value }) {
  // Região é derivada: expande para os estados correspondentes.
  if (field === 'region') {
    const names = Array.isArray(value) ? value : [value];
    const states = [];
    for (const name of names) {
      const list = REGIONS[name];
      if (!list) throw badRequest(`Região desconhecida: ${name}`);
      states.push(...list);
    }
    return { state: { in: states } };
  }
  if (field === 'lastContact' || field === 'createdAt') {
    return { [field]: { [op]: new Date(value) } };
  }
  // Contains é insensível a caixa: o LLM e o usuário escrevem "tecnologia",
  // a base tem "Tecnologia" — casar sempre (Postgres default é sensível).
  if (op === 'contains') {
    const literal = { [field]: { contains: value, mode: 'insensitive' } };
    // Epic 1 (FR4): nos campos do searchText, o termo é normalizado
    // (lower + sem acento) e quebrado em termos atômicos consultando
    // `Prospect.searchText` — acento/grafia/frase composta deixam de
    // impedir o casamento. O OR com o campo estrutural preserva o caso
    // antigo (linhas ainda sem backfill do searchText).
    if (!SEARCHTEXT_FIELDS.has(field)) return literal;
    const branches = [literal];
    for (const term of termVariants(value)) {
      branches.push({ searchText: { contains: term } });
    }
    return branches.length === 1 ? literal : { OR: branches };
  }
  // Epic 1 (FR4): `equals` nos campos do searchText também é tolerante a
  // acento — o OR com o searchText normalizado casa "Metalúrgica" a partir
  // de "metalurgica" (o literal preserva linhas ainda sem backfill).
  if (op === 'equals' && SEARCHTEXT_FIELDS.has(field)) {
    return { OR: [{ [field]: { equals: value } }, { searchText: { equals: normalizeText(value) } }] };
  }
  return { [field]: { [op]: value } };
}

/** Documento de critérios → `where` do Prisma (grupos combinados por AND). */
function translateCriteria(criteria) {
  validateCriteria(criteria);
  const AND = criteria.groups.map((group) => {
    const conds = group.conditions.map(translateCondition);
    // Epic 1 (FR4): condições de texto viram {OR:[...]} cada uma — num grupo
    // AND com 2+ delas, o assign plano MESCLARIA a chave `OR` e a primeira
    // condição DESAPARECERIA do where (audiência inflada). Nesse caso o nest
    // correto é {AND: conds}. Grupo OR não mescla (cada cond já é um ramo) e
    // uma condição só mantém a forma de sempre.
    if (
      group.op === 'AND' &&
      conds.length > 1 &&
      conds.some((c) => Object.prototype.hasOwnProperty.call(c, 'OR'))
    ) {
      return { AND: conds };
    }
    return group.op === 'AND' ? Object.assign({}, ...conds) : { OR: conds };
  });
  return { AND };
}

/** Where completo (org + critérios) — escopo de org sempre presente. */
function buildWhere(orgId, criteria) {
  return { orgId, ...translateCriteria(criteria) };
}

// ── Importação de lista (FR-010) ────────────────────────────────────────────

function normalizeCnpj(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 11 ? digits : null;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

/**
 * Resolve uma lista colada/upload (CNPJs e e-mails) contra os prospects da
 * org. NÃO cria prospects — retorna matched/unmatched (FR-010).
 */
async function resolveList(prisma, orgId, items) {
  const entries = []; // {raw, kind, value}
  for (const raw of items || []) {
    const asCnpj = normalizeCnpj(raw);
    if (asCnpj) {
      entries.push({ raw: String(raw), kind: 'cnpj', value: asCnpj });
      continue;
    }
    const asEmail = normalizeEmail(raw);
    if (asEmail) {
      entries.push({ raw: String(raw), kind: 'email', value: asEmail });
      continue;
    }
    entries.push({ raw: String(raw), kind: 'unmatched', value: null });
  }

  const cnpjs = entries.filter((e) => e.kind === 'cnpj').map((e) => e.value);
  const emails = entries.filter((e) => e.kind === 'email').map((e) => e.value);

  const matchedIds = new Set();
  if (cnpjs.length > 0) {
    const byCnpj = await prisma.prospect.findMany({ where: { orgId, cnpj: { in: cnpjs } } });
    byCnpj.forEach((p) => matchedIds.add(p.id));
    // CNPJ armazenado formatado: fallback por comparação de dígitos.
    const all = await prisma.prospect.findMany({ where: { orgId } });
    for (const p of all) {
      const digits = normalizeCnpj(p.cnpj);
      if (digits && cnpjs.includes(digits)) matchedIds.add(p.id);
    }
  }
  if (emails.length > 0) {
    const byCnpjEmail = await prisma.prospect.findMany({
      where: { orgId, cnpjEmail: { in: emails } },
    });
    byCnpjEmail.forEach((p) => matchedIds.add(p.id));
    const byImportKey = await prisma.prospect.findMany({
      where: { orgId, importKey: { in: emails } },
    });
    byImportKey.forEach((p) => matchedIds.add(p.id));
  }

  // Um item da lista só "matcha" se resolveu a um prospect da org; o
  // resultado é por prospectId (matched), o resto volta como unmatched.
  const matched = new Set();
  const unmatched = [];
  for (const entry of entries) {
    if (entry.kind === 'unmatched') {
      unmatched.push(entry.raw);
      continue;
    }
    const hits =
      entry.kind === 'cnpj'
        ? await prisma.prospect.findMany({ where: { orgId, cnpj: entry.value } })
        : [
            ...(await prisma.prospect.findMany({ where: { orgId, cnpjEmail: entry.value } })),
            ...(await prisma.prospect.findMany({ where: { orgId, importKey: entry.value } })),
          ];
    const anyHit = hits.some((p) => matchedIds.has(p.id));
    if (anyHit) {
      hits.filter((p) => matchedIds.has(p.id)).forEach((p) => matched.add(p.id));
    } else {
      unmatched.push(entry.raw);
    }
  }
  return { matched: [...matched], unmatched };
}

module.exports = {
  REGIONS,
  FIELD_CATALOG,
  SEARCHTEXT_FIELDS,
  normalizeText,
  termVariants,
  validateCriteria,
  translateCriteria,
  buildWhere,
  resolveList,
};
