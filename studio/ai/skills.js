'use strict';

/**
 * studio/ai/skills.js — guias de marketing/vendas vendored para os agentes.
 *
 * Fontes (MIT, ver agents/skills/README.md):
 *  - github.com/coreyhaines31/marketingskills  → agents/skills/marketing/*.md
 *  - github.com/louisblythe/Sales-Skills       → agents/skills/sales/*.md
 *
 * `selectFor(userMessage)` devolve o bloco de prompt com os 2 guias mais
 * pertinentes ao pedido (match por palavras-chave da descrição) ou null.
 * Injeção limitada: índice só de frontmatter; conteúdo truncado por guia.
 */

const fs = require('fs');
const path = require('path');

const SKILLS_ROOT = path.join(__dirname, '..', '..', 'agents', 'skills');
const COLLECTIONS = ['marketing', 'sales'];
const MAX_SKILLS = 2;
const MAX_CHARS_PER_SKILL = 4000;

let index = null;

function stripAccents(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokens(text) {
  return new Set(
    stripAccents(text)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
  );
}

/** Frontmatter minimal: name/description do cabeçalho YAML do SKILL.md. */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(name|description):\s*(.+)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return meta;
}

function buildIndex() {
  const entries = [];
  for (const collection of COLLECTIONS) {
    const dir = path.join(SKILLS_ROOT, collection);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch (_e) {
      continue; // coleção ausente: segue sem ela
    }
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const meta = parseFrontmatter(raw);
        const name = meta.name || file.replace(/\.md$/, '');
        const description = meta.description || '';
        entries.push({
          collection,
          name,
          description,
          searchText: stripAccents(`${name} ${description}`),
          filePath: path.join(dir, file),
        });
      } catch (_e) { /* arquivo ilegível: ignora */ }
    }
  }
  return entries;
}

/** Bloco de prompt com os guias mais pertinentes (ou null se nenhum casar). */
function selectFor(userMessage) {
  if (!index) index = buildIndex();
  if (index.length === 0) return null;

  const messageTokens = tokens(userMessage || '');
  if (messageTokens.size === 0) return null;

  const scored = [];
  for (const entry of index) {
    const entryTokens = tokens(entry.searchText);
    let score = 0;
    for (const token of messageTokens) {
      if (entryTokens.has(token)) score += 1;
      else if ([...entryTokens].some((t) => t.startsWith(token.slice(0, 5)))) score += 0.5;
    }
    if (score >= 2) scored.push({ entry, score });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  const blocks = [];
  for (const { entry } of scored.slice(0, MAX_SKILLS)) {
    let content = '';
    try {
      content = fs.readFileSync(entry.filePath, 'utf8');
    } catch (_e) {
      continue;
    }
    content = content.replace(/^---\n[\s\S]*?\n---/, '').trim();
    if (content.length > MAX_CHARS_PER_SKILL) {
      content = `${content.slice(0, MAX_CHARS_PER_SKILL)}\n…(guia truncado)`;
    }
    blocks.push(`### Guia: ${entry.name} (coleção: ${entry.collection})\n${content}`);
  }
  if (blocks.length === 0) return null;
  return `GUIAS DE ESPECIALISTA (aplique quando relevante ao pedido do usuário):\n\n${blocks.join('\n\n---\n\n')}`;
}

function listSkills() {
  if (!index) index = buildIndex();
  return index.map(({ collection, name, description }) => ({ collection, name, description }));
}

module.exports = { selectFor, listSkills };
