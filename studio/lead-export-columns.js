'use strict';

/**
 * studio/lead-export-columns.js — catálogo de colunas da planilha de leads
 * (action export_leads). Fonte ÚNICA compartilhada pela validação do
 * manifest v1 (contrato fechado) e pelo handler do chat (extração do valor
 * por lead) — apelido aceito e rótulo do PDF nunca divergem.
 */

const LEAD_EXPORT_COLUMNS = {
  nome: { label: 'Nome', aliases: ['nome', 'empresa', 'name', 'company'] },
  contato: { label: 'Contato', aliases: ['contato', 'contact', 'responsavel', 'responsável'] },
  whatsapp: { label: 'WhatsApp', aliases: ['whatsapp', 'telefone', 'phone', 'celular', 'zap', 'wpp'] },
  email: { label: 'E-mail', aliases: ['email', 'e-mail', 'mail'] },
  cnpj: { label: 'CNPJ', aliases: ['cnpj'] },
  cidade: { label: 'Cidade', aliases: ['cidade', 'city'] },
  estado: { label: 'Estado', aliases: ['estado', 'uf', 'state'] },
  setor: { label: 'Setor', aliases: ['setor', 'segmento', 'ramo', 'industry'] },
  porte: { label: 'Porte', aliases: ['porte', 'tamanho', 'employees', 'funcionarios', 'funcionários'] },
  score: { label: 'Score', aliases: ['score', 'pontuacao', 'pontuação', 'oportunidade'] },
};

/** O ask canônico do dono (2026-10-15): nome, WhatsApp e e-mail. */
const DEFAULT_EXPORT_COLUMNS = ['nome', 'whatsapp', 'email'];

/** Apelido → chave canônica; null quando a coluna não existe no catálogo. */
function canonicalColumn(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return null;
  for (const [canonical, spec] of Object.entries(LEAD_EXPORT_COLUMNS)) {
    if (spec.aliases.includes(key)) return canonical;
  }
  return null;
}

/**
 * Pedido do modelo → lista canônica, sem duplicatas, na ordem pedida.
 * Sem pedido (ou vazio) → o trio default. Desconhecidas caem fora (a
 * validação do manifest já recusou com a lista do que existe — aqui é
 * defesa em profundidade do handler).
 */
function normalizeExportColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) return [...DEFAULT_EXPORT_COLUMNS];
  const out = [];
  for (const raw of columns) {
    const canonical = canonicalColumn(raw);
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out.length ? out : [...DEFAULT_EXPORT_COLUMNS];
}

/** Rótulos na ordem canônica (cabeçalho do PDF e do card). */
function columnLabels(columns) {
  return columns.map((c) => LEAD_EXPORT_COLUMNS[c].label);
}

module.exports = { LEAD_EXPORT_COLUMNS, DEFAULT_EXPORT_COLUMNS, canonicalColumn, normalizeExportColumns, columnLabels };
