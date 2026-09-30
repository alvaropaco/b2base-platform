'use strict';

/**
 * search-text.js — texto de busca normalizado do Prospect (Epic 1, FR4).
 *
 * `Prospect.searchText` = industry + companyName + tradeName em caixa baixa e
 * SEM acento, preenchido pelos hooks de escrita (import CSV, enriquecimento,
 * create/update) e pelo backfill idempotente da migração. O matching de
 * segmento (studio/segment-service.js) normaliza o termo buscado com a MESMA
 * função e consulta `searchText contains` — acento e grafia deixam de
 * impedir o casamento ("metalurgica" casa "Metalúrgica").
 *
 * Sem extensão nova no Postgres (constituição VI): `unaccent` não é
 * necessário porque a normalização acontece na aplicação (NFD-strip) e, no
 * backfill SQL, via translate() com o mapa de diacríticos equivalente.
 */

const DIACRITICS = /[\u0300-\u036f]/g;

/** lower + sem acento (NFD-strip) — mesma normalização do backfill SQL. */
function normalizeText(value) {
  const s = String(value ?? '');
  if (!s) return '';
  return s.normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

/**
 * searchText do Prospect: campos de identidade/setor concatenados com espaço.
 * null quando não há nenhum valor (match por contains nunca casa com null).
 */
function buildSearchText(prospect = {}) {
  const joined = [prospect.industry, prospect.companyName, prospect.tradeName]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return joined ? normalizeText(joined) : null;
}

/**
 * Patch de escrita: calcula o searchText da LINHA FINAL (base ∪ patch) —
 * updates parciais nunca perdem campos que o patch não toca. Valores
 * `undefined` no patch herdam da base; `null` limpa o campo (Prisma).
 */
function withSearchText(data = {}, base = {}) {
  const merged = {
    ...base,
    ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
  };
  return { searchText: buildSearchText(merged) };
}

module.exports = { normalizeText, buildSearchText, withSearchText };
