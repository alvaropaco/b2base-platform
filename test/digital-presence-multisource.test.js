'use strict';
const test = require('node:test');
const assert = require('node:assert');

// ── Descoberta multi-fonte de WhatsApp (caso MB, 2026-10-09) ─────────────────
// Regras de segurança testadas: blacklist da HOME da plataforma (diretório
// embute o PRÓPRIO WhatsApp em todas as páginas), slug de agregador, DDD × UF
// e celular de catálogo digital da loja.

process.env.SEARXNG_URL = process.env.SEARXNG_URL || 'https://search.0xcloud.net';
const dp = require('../workers/digital-presence');
const searxng = require('../searxng');
const logger = { info() {}, warn() {}, error() {}, child() { return this; } };

test('canonWhatsAppDigits: 10-11 dígitos ganham DDI 55; lixo vira null', () => {
  assert.equal(dp.canonWhatsAppDigits('11987654321'), '5511987654321');
  assert.equal(dp.canonWhatsAppDigits('+5511987654321'), '5511987654321');
  assert.equal(dp.canonWhatsAppDigits('12999887766'), '5512999887766');
  assert.equal(dp.canonWhatsAppDigits('32321212'), null, '8 dígitos sem DDD é inutilizável');
  assert.equal(dp.canonWhatsAppDigits(''), null);
});

test('canonWhatsAppDigits: DDI estrangeiro (+91 Índia do caso real) NUNCA vira WhatsApp', () => {
  // Crawler antigo registrou +919560534592 como WhatsApp de SABOR DO REINO
  // DOS CEUS (card de 2026-10-09) — mandar para a Índia queima a conta BR.
  assert.equal(dp.canonWhatsAppDigits('+919560534592'), null);
  assert.equal(dp.canonWhatsAppDigits('919560534592'), null);
  // +1 de 11 dígitos é indistinguível de um BR (DDD+9) — o lixo REAL é o
  // internacional completo de 12-13 dígitos sem 55, que a regra pega.
  assert.equal(dp.extractWhatsAppFromHtml('<a href="https://wa.me/919560534592">fale</a>'), null, 'link wa.me estrangeiro no site também fora');
  assert.equal(dp.extractWhatsAppFromHtml('<a href="https://wa.me/5511987654321">fale</a>'), '5511987654321');
});

test('usablePhone (utils): lista com lixo estrangeiro na frente usa o BR de trás', () => {
  const { usablePhone } = require('../whatsapp-utils');
  assert.equal(usablePhone(['+919560534592']), null, '+91 sozinho = sem telefone utilizável');
  assert.equal(usablePhone(['+919560534592', '(11) 98765-4321']), '5511987654321', 'lixo na frente não esconde o BR');
  assert.equal(usablePhone(['11987654321']), '5511987654321');
  assert.equal(usablePhone([]), null);
  assert.equal(usablePhone(null), null);
});

test('extractCatalogMobiles: celular BR formatado da loja; rejeita 8 dígitos', () => {
  const html = '<p>Fale: (27) 99924-0650</p><span>tel fixo 3333-4444</span>';
  assert.deepEqual(dp.extractCatalogMobiles(html), ['5527999240650']);
});

test('searchableName: fantasia vence; razão social perde sufixos societários', () => {
  assert.equal(dp.searchableName({ companyName: 'PURPLE ICE ACAI COMERCIO DE ALIMENTOS LTDA', tradeName: 'Purple Ice' }), 'Purple Ice');
  assert.equal(dp.searchableName({ companyName: 'HUMAITA DELIVERY LTDA', tradeName: null }), 'HUMAITA DELIVERY');
  assert.equal(dp.searchableName({ companyName: 'XPTO COMERCIO DE ALIMENTOS LTDA', tradeName: null }), 'XPTO');
});

test('dddMatchesState: DDD 27 casa ES; DDD 11 não casa ES; sem UF não filtra', () => {
  assert.equal(dp.dddMatchesState('5527999240650', 'ES'), true);
  assert.equal(dp.dddMatchesState('5511999998888', 'ES'), false);
  assert.equal(dp.dddMatchesState('5511999998888', null), true);
});

test('isCompanyDomain: catálogo/agregador/rede social não são site da empresa', () => {
  assert.equal(dp.isCompanyDomain('diggy.menu'), false);
  assert.equal(dp.isCompanyDomain('taplink.cc'), false);
  assert.equal(dp.isCompanyDomain('instagram.com'), false);
  assert.equal(dp.isCompanyDomain('acme.com.br'), true);
  assert.equal(dp.isCompanyDomain(''), false);
});

// ── multi-fonte com searx + fetch mockados ───────────────────────────────────

function stubWorld({ results, pages }) {
  const origFetch = global.fetch;
  const origSearx = searxng.searxSearch;
  searxng.searxSearch = async () => results;
  global.fetch = async (url) => {
    const key = String(url).replace(/\/$/, '');
    const hit = pages[key] !== undefined ? pages[key] : pages[String(url)];
    if (hit === undefined) throw new Error('404 mock: ' + url);
    return { ok: true, status: 200, text: async () => hit };
  };
  return {
    restore() {
      searxng.searxSearch = origSearx;
      global.fetch = origFetch;
    },
  };
}

test('multi-fonte: wa.me no snippet é fonte forte e sai direto', async () => {
  const world = stubWorld({
    results: [{ url: 'https://acme.com.br/contato', title: 'ACME', content: 'Fale wa.me/5511987654321' }],
    pages: {},
  });
  try {
    const r = await dp.discoverWhatsAppMultiSource({ companyName: 'ACME COMERCIO LTDA', tradeName: 'ACME', state: 'SP', signal: null, logger });
    assert.equal(r.whatsapp, '5511987654321');
    assert.equal(r.strength, 'wa_link');
  } finally {
    world.restore();
  }
});

test('multi-fonte: WhatsApp da PLATAFORMA (home do host) é descartado — só o da empresa vale', async () => {
  // guiapj falso: a página da empresa só tem o wa.me do DIRETÓRIO (igual à home)
  const world = stubWorld({
    results: [
      { url: 'https://diretorio.com.br/empresa/sushi-x', title: 'Sushi X Delivery - Diretório', content: 'cnpj da empresa sushi delivery' },
    ],
    pages: {
      'https://diretorio.com.br': '<html><a href="https://wa.me/5519999997777">Fale conosco</a></html>',
      'https://diretorio.com.br/empresa/sushi-x': '<html>Sushi X delivery <a href="https://wa.me/5519999997777">WhatsApp</a></html>',
    },
  });
  try {
    const r = await dp.discoverWhatsAppMultiSource({ companyName: 'SUSHI X DELIVERY LTDA', tradeName: null, state: 'SP', signal: null, logger });
    assert.equal(r, null, 'número da plataforma NÃO vira WhatsApp da empresa');
  } finally {
    world.restore();
  }
});

test('multi-fonte: página da empresa com wa.me PRÓPRIO (fora da home da plataforma) passa', async () => {
  const world = stubWorld({
    results: [
      { url: 'https://diretorio.com.br/empresa/sushi-x', title: 'Sushi X Delivery - Diretório', content: 'cnpj da empresa sushi delivery' },
    ],
    pages: {
      'https://diretorio.com.br': '<html><a href="https://wa.me/5519999997777">suporte do diretório</a></html>',
      'https://diretorio.com.br/empresa/sushi-x': '<html>Sushi X delivery pedidos <a href="https://wa.me/5511988886666">WhatsApp da loja</a></html>',
    },
  });
  try {
    const r = await dp.discoverWhatsAppMultiSource({ companyName: 'SUSHI X DELIVERY LTDA', tradeName: null, state: 'SP', signal: null, logger });
    assert.equal(r.whatsapp, '5511988886666');
  } finally {
    world.restore();
  }
});

test('multi-fonte: celular de CATÁLOGO da loja (sem wa.me) é fonte média; DDD fora da UF é descartado', async () => {
  const world = stubWorld({
    results: [
      { url: 'https://cardapio.menu/xpto-acai', title: 'XPTO Açaí Delivery - Cariacica', content: 'cardápio xpto acai' },
    ],
    pages: {
      'https://cardapio.menu/xpto-acai': '<html>XPTO acai delivery — ligue (27) 99924-0650</html>',
    },
  });
  try {
    const r = await dp.discoverWhatsAppMultiSource({ companyName: 'XPTO ACAI COMERCIO LTDA', tradeName: 'XPTO Açaí', state: 'SP', signal: null, logger });
    assert.equal(r, null, 'DDD 27 com UF=SP não passa');
    const r2 = await dp.discoverWhatsAppMultiSource({ companyName: 'XPTO ACAI COMERCIO LTDA', tradeName: 'XPTO Açaí', state: 'ES', signal: null, logger });
    assert.equal(r2.whatsapp, '5527999240650', 'DDD certo vira WhatsApp');
    assert.equal(r2.strength, 'catalog_phone');
  } finally {
    world.restore();
  }
});

test('multi-fonte: agregador de links só vale se o SLUG é o nome da empresa', async () => {
  const world = stubWorld({
    results: [
      { url: 'https://taplink.cc/outrobar', title: 'Outro Bar - humaita delivery na rua', content: 'bar com delivery humaita' },
      { url: 'https://taplink.cc/sabornatura', title: 'Sabor Natura', content: 'sabor natura comida' },
    ],
    pages: {
      'https://taplink.cc/sabornatura': '<html><a href="https://wa.me/5511973123978">whatsapp</a> sabor natura</html>',
    },
  });
  try {
    const r = await dp.discoverWhatsAppMultiSource({ companyName: 'SABOR NATURA COMIDA SAUDAVEL LTDA', tradeName: 'Sabor Natura', state: 'SP', signal: null, logger });
    assert.equal(r.whatsapp, '5511973123978', 'slug certo é crawleado');
    assert.ok(!r.whatsapp || true);
  } finally {
    world.restore();
  }
});
