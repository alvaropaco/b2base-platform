'use strict';
const test = require('node:test');
const assert = require('node:assert');

// ── contact-discovery: número com FONTE e score (regra de ouro) ─────────────
// Nenhum número inventado: todo candidato precisa existir LITERALMENTE na
// fonte; identidade confirmada antes da busca; sem fonte → nao_encontrado.

process.env.GOOGLE_PLACES_API_KEY = ''; // sem Places: fonte pulada (honesto)
const discovery = require('../workers/contact-discovery');
const logger = { info() {}, warn() {}, error() {}, child() { return this; } };

const CNPJ = '11111111000111';
const BRASILAPI = {
  cnpj: CNPJ, razao_social: 'ACME RESTAURANTE LTDA', nome_fantasia: 'Acme',
  municipio: 'GUARULHOS', uf: 'SP', descricao_tipo_de_logradouro: 'RUA',
  logradouro: 'X', numero: '1', cep: '07000000', ddd_telefone_1: '', email: '',
};

function stubFetch(pages) {
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const key = String(url);
    if (key.startsWith('https://brasilapi.com.br/')) {
      return { ok: true, status: 200, json: async () => pages.brasilapi || BRASILAPI, text: async () => JSON.stringify(pages.brasilapi || BRASILAPI) };
    }
    for (const [prefix, html] of Object.entries(pages)) {
      if (key.startsWith(prefix)) {
        return { ok: true, status: 200, text: async () => html, json: async () => ({}) };
      }
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  return { restore() { global.fetch = orig; } };
}

function makeProspect(over = {}) {
  return { cnpj: CNPJ, companyName: 'ACME RESTAURANTE LTDA', tradeName: 'Acme', city: 'Guarulhos', state: 'SP', domain: 'acme.com.br', ...over };
}

test('1) wa.me no site oficial confirmado → CONFIRMADO score 95 com fonte e trecho', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': '<html><title>Acme Restaurante</title><a href="https://wa.me/5511987654321">Fale no WhatsApp</a></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'confirmado');
    assert.equal(r.whatsapp, '+5511987654321');
    assert.ok(r.score >= 95, `score ${r.score} ≥ 95`);
    assert.ok(r.fontes.length >= 1, 'fonte registrada');
    assert.equal(r.fontes[0].tipo, 'wa_link');
    assert.ok(r.fontes[0].url.includes('acme.com.br'), 'fonte é o site oficial');
    assert.ok(r.fontes[0].trecho.includes('wa.me'), 'trecho literal da fonte');
    assert.equal(r.identidade_usada.cnpj, CNPJ);
    assert.equal(r.identidade_usada.dominio_confirmado, true);
  } finally { world.restore(); }
});

test('2) homônimo em outra cidade/UF: número da homônima NÃO é salvo (DDD incompatível −30)', async () => {
  // Site do cadastro pertence a um homônimo de Curitiba (DDD 41); a
  // identidade confirmada é Guarulhos/SP → 95 − 30 = 65 → NÃO confirmado.
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': '<html><title>Acme Restaurante</title><a href="https://wa.me/5541999888777">WhatsApp</a></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, null, 'número da homônima NÃO vira WhatsApp do lead');
    assert.equal(r.status, 'nao_confirmado', 'fica para revisão manual');
    assert.ok(r.nao_confirmado, 'número fica na fila de revisão');
    assert.equal(r.nao_confirmado.whatsapp, '+5541999888777');
    assert.ok(r.motivo_descarte.some((m) => /DDD incompat/i.test(m)) || r.nao_confirmado.motivo, 'motivo sinalizado');
  } finally { world.restore(); }
});

test('3) empresa sem WhatsApp público → null + nao_encontrado (nada inventado)', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': '<html><title>Acme Restaurante</title><p>Venha nos visitar!</p></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, null);
    assert.equal(r.status, 'nao_encontrado');
    assert.equal(r.score, 0);
    assert.deepEqual(r.fontes, []);
  } finally { world.restore(); }
});

test('4) número só em IMAGEM (sem dígitos no HTML) → nao_encontrado, nada inventado', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': '<html><title>Acme</title><img src="/whatsapp-banner.png" alt="botão de contato"><a href="/contato"></a></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, null, 'número dentro de imagem não existe no HTML — nada inventado');
    assert.equal(r.status, 'nao_encontrado');
  } finally { world.restore(); }
});

test('5) só telefone do CNPJ → score 40 → nao_confirmado (não entra no cadastro)', async () => {
  const world = stubFetch({
    brasilapi: { ...BRASILAPI, ddd_telefone_1: '11987654321' },
    'https://acme.com.br': '<html><title>Acme</title><p>Sem telefone no site</p></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, null, 'CNPJ-sozinho não vira WhatsApp no cadastro');
    assert.equal(r.status, 'nao_confirmado');
    assert.equal(r.score, 40);
    assert.ok(r.nao_confirmado, 'fila de revisão manual');
  } finally { world.restore(); }
});

test('6) normalização: 0-DDD e formatos sujos viram o MESMO E.164; DDD inexistente descarta', async () => {
  const identidade = { uf: 'SP', dominio_confirmado: true, dominio: 'acme.com.br' };
  const cands = [
    { raw: '11987654321', tipo: 'wa_link', url: 'https://acme.com.br/', trecho: 'wa.me/5511987654321', host: 'acme.com.br' },
    { raw: '011987654321', tipo: 'wa_contexto', url: 'https://sub.acme.com.br/contato', trecho: '011 98765-4321', host: 'sub.acme.com.br' },
  ];
  const { normalized, descartes } = discovery.normalizeAndValidate(cands, identidade, { logger });
  assert.equal(descartes.length, 0);
  assert.equal(normalized.length, 2);
  assert.ok(normalized.every((c) => c.e164 === '+5511987654321'), 'E.164 idêntico');
  const { confirmados } = discovery.scoreCandidates(normalized, identidade);
  assert.equal(confirmados[0].e164, '+5511987654321');
  assert.ok(confirmados[0].corroborado, 'mesmo número em 2 trechos = corroborado (+15)');
  // DDD inexistente (10) é descartado na normalização
  const lixo = discovery.normalizeAndValidate([{ raw: '1098765432', tipo: 'cnpj', trecho: '10 98765432', host: 'x' }], identidade, { logger });
  assert.equal(lixo.normalized.length, 0, 'DDD 10 não existe → descartado');
  assert.ok(lixo.descartes.length >= 1, 'rejeitado na normalização (parse/DDD), nada inventado');
});

test('7) e-mail corporativo do site é coletado (fonte-literal) e noreply é filtrado', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': '<html><title>Acme</title><a href="mailto:contato@acme.com.br">e-mail</a><span>noreply@acme.com.br</span></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.email, 'contato@acme.com.br', 'melhor e-mail: prefixo de contato, noreply filtrado');
  } finally { world.restore(); }
});
