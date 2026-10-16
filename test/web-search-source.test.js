'use strict';

/**
 * test/web-search-source.test.js — AMPLIAÇÃO DA ÁREA DE BUSCA (2026-10-15):
 * o discovery vai além do site oficial — snippets de busca (SearXNG+DDG),
 * catálogo digital da loja (diggy.menu, instadelivery…) e agregadores de
 * link (taplink/linktr com slug do nome). Porta do caso MB (2026-10-09,
 * derrubado pelo refactor de 14/10) com os gates do pipeline novo:
 * identidade pelo nome (caso Ninas), DDD×UF, anti-alucinação por trecho
 * literal e blacklist do WhatsApp da PLATAFORMA (caso GuiaPJ).
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.GOOGLE_PLACES_API_KEY = ''; // Places pulado (honesto) — foco na busca web

const searxng = require('../searxng');
const discovery = require('../workers/contact-discovery');
const logger = { info() {}, warn() {}, error() {}, child() { return this; } };

const CNPJ = '22222222000133';
const BRASILAPI = {
  cnpj: CNPJ, razao_social: 'PIZZARIA DOM MARIO LTDA', nome_fantasia: 'Dom Mario',
  municipio: 'SANTOS', uf: 'SP', ddd_telefone_1: '', email: '',
};

function makeProspect(over = {}) {
  return { cnpj: CNPJ, companyName: 'PIZZARIA DOM MARIO LTDA', tradeName: 'Dom Mario', city: 'Santos', state: 'SP', domain: 'dommario.com.br', ...over };
}

/** Stub do global.fetch (BrasilAPI/site) E do módulo searxng (resultados). */
function stubWorld({ pages = {}, searx = [] } = {}) {
  const origFetch = global.fetch;
  const searxCalls = [];
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return { ok: true, status: 200, json: async () => BRASILAPI };
    }
    for (const [prefix, html] of Object.entries(pages)) {
      if (u.startsWith(prefix)) return { ok: true, status: 200, text: async () => html };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const origSearx = searxng.searxSearch;
  searxng.searxSearch = async (query) => {
    searxCalls.push(query);
    return typeof searx === 'function' ? searx(query) : (searx[searxCalls.length - 1] || []);
  };
  return {
    searxCalls,
    restore() {
      global.fetch = origFetch;
      searxng.searxSearch = origSearx;
    },
  };
}

test('1) wa.me em SNIPPET de busca (diretório) com identidade+DDD ok → confirmado 70 com a fonte', async () => {
  const world = stubWorld({
    pages: { 'https://dommario.com.br': '<html><title>Pizzaria Dom Mario</title><p>As melhores pizzas de Santos.</p></html>' },
    // Uma lista de resultados POR chamada de busca.
    searx: [[{ url: 'https://guiaexemplo.com.br/pizzaria-dom-mario', title: 'Pizzaria Dom Mario — Santos/SP', content: 'Peça pelo WhatsApp wa.me/5513987654321 — delivery em Santos' }]],
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'confirmado', 'wa.me do snippet com identidade ok é promovido');
    assert.equal(r.whatsapp, '+5513987654321');
    assert.equal(r.score, 70, 'não-oficial (diretório) = 70');
    assert.ok(r.fontes.some((f) => (f.url || '').includes('guiaexemplo.com.br')), 'fonte = URL do resultado da busca');
  } finally { world.restore(); }
});

test('2) snippet de OUTRA empresa (sem os tokens do nome) → nada é extraído (caso Ninas)', async () => {
  const world = stubWorld({
    pages: { 'https://dommario.com.br': '<html><title>Pizzaria Dom Mario</title><p>Home.</p></html>' },
    searx: [[{ url: 'https://guiaexemplo.com.br/pizzaria-outro', title: 'Pizzaria Bom Fogo — Santos/SP', content: 'WhatsApp wa.me/5513987654321 do Bom Fogo' }]],
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, null, 'número do restaurante ERRADO não é extraído');
    assert.equal(r.status, 'nao_encontrado');
  } finally { world.restore(); }
});

test('3) catálogo digital da loja (diggy.menu, título citando o nome) → WhatsApp confirmado', async () => {
  const world = stubWorld({
    pages: {
      // ORDEM IMPORTA (o stub casa por startsWith — específico primeiro).
      'https://diggy.menu/dommario': '<html><title>Pizzaria Dom Mario — cardápio</title><a href="https://wa.me/5513999998888">Peça no WhatsApp</a><span>ligue +55 13 99123-4567</span></html>',
      'https://diggy.menu/': '<html><title>Diggy</title><a href="https://wa.me/5511000000000">Suporte Diggy</a></html>',
      'https://dommario.com.br': '<html><title>Pizzaria Dom Mario</title><p>Home sem número.</p></html>',
    },
    searx: [
      [], // "dom mario whatsapp" vazio
      [{ url: 'https://diggy.menu/dommario', title: 'Dom Mario — Diggy Menu', content: 'cardápio e delivery' }],
    ],
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'confirmado', 'WhatsApp da loja no catálogo é confirmado');
    assert.equal(r.whatsapp, '+5513999998888', 'wa.me do cardápio (não o suporte da PLATAFORMA)');
    const fonte = r.fontes.find((f) => (f.url || '').includes('diggy.menu/dommario'));
    assert.ok(fonte, 'fonte = página do catálogo');
    void fonte;
  } finally { world.restore(); }
});

test('4) motores de busca VAZIOS e sem site → busca morta honesta (search_unavailable)', async () => {
  const world = stubWorld({
    pages: { 'https://dommario.com.br': '<html><title>Dom Mario</title><p>sem contato</p></html>' },
    searx: [],
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, null);
    assert.equal(r.status, 'nao_encontrado');
    assert.equal(r.search_unavailable, true, 'busca morta ≠ prova de inexistência (instabilidade)');
  } finally { world.restore(); }
});

test('5) site oficial JÁ rendeu wa.me → a busca web ampliada NEM roda (orçamento poupado)', async () => {
  const world = stubWorld({
    pages: { 'https://dommario.com.br': '<html><title>Dom Mario</title><a href="https://wa.me/5513987654321">Zap</a></html>' },
    searx: [{ url: 'https://guiaexemplo.com.br/x', title: 'x', content: 'wa.me/5511900000000' }],
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, '+5513987654321');
    assert.equal(r.score, 95, 'site confirmado vence');
    assert.equal(world.searxCalls.length, 0, 'nenhuma query de busca: o site já resolveu');
  } finally { world.restore(); }
});
