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

// ── Crawl interno (2026-10-15): entrar no site para achar o WhatsApp ────────

test('8) WhatsApp SÓ na página profunda (/atendimento linkada da home) → confirmado 95 com a fonte certa', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    // ORDEM IMPORTA: prefixo mais específico primeiro (o stub casa por startsWith).
    'https://acme.com.br/atendimento': '<html><title>Atendimento</title><a href="https://wa.me/5511977776666">Chama no WhatsApp</a></html>',
    'https://acme.com.br': '<html><title>Acme</title><nav><a href="/atendimento">Atendimento</a><a href="/sobre">Sobre</a></nav><p>Home sem número.</p></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'confirmado', 'crawl interno achou o wa.me da página profunda');
    assert.equal(r.whatsapp, '+5511977776666');
    assert.ok(r.score >= 95, `score ${r.score} ≥ 95 (site oficial confirmado)`);
    assert.ok(r.fontes[0].url.includes('/atendimento'), `fonte é a página profunda, veio: ${r.fontes[0].url}`);
    assert.ok(r.fontes[0].trecho.includes('wa.me'), 'trecho literal da fonte');
  } finally { world.restore(); }
});

test('9) home já tem wa.me → crawl SEGUE para colher o e-mail da interna (não para na 1ª wa.me)', async () => {
  // Matrix (spec ampliar-crawl-sites-whatsapp-email): "WA na home, e-mail na
  // interna" → WhatsApp promovido E corporate_email da interna coletado.
  const fetched = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return { ok: true, status: 200, json: async () => BRASILAPI, text: async () => JSON.stringify(BRASILAPI) };
    }
    if (u.includes('/sobre')) {
      return { ok: true, status: 200, text: async () => '<html><title>Sobre a Acme</title><a href="mailto:contato@acme.com.br">e-mail</a></html>' };
    }
    return { ok: true, status: 200, text: async () => '<html><a href="https://wa.me/5511987654321">WhatsApp</a><a href="/sobre">Sobre</a></html>' };
  };
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'confirmado');
    assert.equal(r.whatsapp, '+5511987654321', 'WhatsApp da home confirmado como antes');
    assert.ok(fetched.some((u) => u.includes('/sobre')), 'crawl segue DEPOIS de achar o wa.me');
    assert.equal(r.email, 'contato@acme.com.br', 'e-mail da página INTERNA é colhido');
  } finally { global.fetch = orig; }
});

test('10) crawl ignora lixo (facebook, /wp-admin, .pdf) e segue só links de contato do MESMO domínio', async () => {
  const fetched = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return { ok: true, status: 200, json: async () => BRASILAPI, text: async () => JSON.stringify(BRASILAPI) };
    }
    fetched.push(u);
    const html = u.includes('/fale-conosco-completo')
      ? '<html><a href="https://wa.me/5511966665555">WhatsApp comercial</a></html>'
      : '<html><a href="https://facebook.com/acme">FB</a><a href="/wp-admin">admin</a><a href="/catalogo.pdf">catálogo</a><a href="https://outradono.com.br/contato">outro dono</a><a href="/fale-conosco-completo">Fale conosco</a></html>';
    return { ok: true, status: 200, text: async () => html };
  };
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.whatsapp, '+5511966665555', 'wa.me da página profunda encontrada');
    assert.ok(!fetched.some((u) => /facebook|wp-admin|catalogo\.pdf|outradono/.test(u)), `lixo não é visitado: ${fetched.join(', ')}`);
    assert.ok(fetched.some((u) => u.includes('/fale-conosco-completo')), 'link de contato do MESMO domínio é seguido');
  } finally { global.fetch = orig; }
});

test('11) extractInternalLinks: prioriza contato na URL/texto e ignora assets/externos', () => {
  const html = [
    '<a href="/sobre-nos">Sobre nós</a>',
    '<a href="https://acme.com.br/fale-conosco">Fale conosco</a>',
    '<a href="https://wa.me/5511999998888">zap direto</a>',
    '<a href="/banner.png">imagem</a>',
    '<a href="mailto:contato@acme.com.br">email</a>',
    '<a href="https://parceiro.com/contato">parceiro</a>',
    '<a href="#contato">âncora</a>',
  ].join('');
  const links = discovery.extractInternalLinks(html, 'https://acme.com.br/', 'acme.com.br');
  const urls = links.map((l) => l.url);
  assert.ok(urls.some((u) => u.includes('/fale-conosco')), 'link de contato interno presente');
  assert.ok(urls.some((u) => u.includes('/sobre-nos')), 'link interno comum presente');
  assert.ok(!urls.some((u) => u.includes('wa.me')), 'link EXTERNO (wa.me) não é crawled');
  assert.ok(!urls.some((u) => u.includes('parceiro.com')), 'domínio de fora não é seguido');
  assert.ok(!urls.some((u) => u.includes('.png')), 'asset não é seguido');
  const fale = links.find((l) => l.url.includes('/fale-conosco'));
  const sobre = links.find((l) => l.url.includes('/sobre-nos'));
  assert.ok(fale.prio > sobre.prio, `prioridade de contato (${fale.prio}) > comum (${sobre.prio})`);
});

// ── Ampliação do crawl (spec ampliar-crawl-sites-whatsapp-email) ────────────

test('12) wa_candidates ordenado por score: wa_link (95) > wa_contexto (85); 1º = whatsapp (compat)', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    // ORDEM IMPORTA: prefixo mais específico primeiro (o stub casa por startsWith).
    'https://acme.com.br/atendimento': '<html><title>Atendimento</title><p>WhatsApp (11) 97654-3210 com a equipe</p></html>',
    'https://acme.com.br': '<html><title>Acme</title><a href="https://wa.me/5511987654321">Fale no WhatsApp</a><a href="/atendimento">Atendimento</a></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'confirmado');
    assert.ok(Array.isArray(r.wa_candidates) && r.wa_candidates.length >= 2, 'dois candidatos expostos p/ a cadeia');
    assert.equal(r.wa_candidates[0].whatsapp, r.whatsapp, '1º candidato É o whatsapp atual (compat)');
    assert.equal(r.wa_candidates[0].whatsapp, '+5511987654321');
    assert.equal(r.wa_candidates[0].score, 95, 'wa_link confirmado primeiro');
    assert.equal(r.wa_candidates[1].whatsapp, '+5511976543210');
    assert.equal(r.wa_candidates[1].score, 85, 'wa_contexto confirmado depois');
    assert.ok(r.wa_candidates[0].score >= r.wa_candidates[1].score, 'ordenado por score desc');
    assert.ok(r.wa_candidates.length <= discovery.WA_CANDIDATES_MAX, 'teto da lista da cadeia');
    assert.ok(r.wa_candidates.every((c) => c.url && c.trecho), 'candidato carrega fonte (url + trecho literal)');
  } finally { world.restore(); }
});

test('13) página gigante (>512KB) é cortada no cap: wa.me além do cap NÃO é lido; início parseado', async () => {
  const pad = 'x'.repeat(600 * 1024);
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': `<html><title>Acme</title><a href="mailto:contato@acme.com.br">e-mail</a>${pad}<a href="https://wa.me/5511987654321">Zap</a></html>`,
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.email, 'contato@acme.com.br', 'INÍCIO da página é parseado (e-mail dentro do cap)');
    assert.equal(r.whatsapp, null, 'wa.me além do cap de bytes não é lido');
    assert.equal(r.status, 'nao_encontrado');
  } finally { world.restore(); }
});

test('14) cap de bytes via STREAM: corpo >512KB corta no teto; wa.me dentro do cap passa', async () => {
  const enc = new TextEncoder();
  const pad = 'y'.repeat(600 * 1024);
  const streamOf = (...chunks) => new ReadableStream({
    start(c) { for (const k of chunks) c.enqueue(enc.encode(k)); c.close(); },
  });
  const fetchFactory = (chunks) => async () => ({ ok: true, status: 200, body: streamOf(...chunks) });
  const identidade = { dominio: 'acme.com.br', dominio_confirmado: true, uf: 'SP', nome_busca: 'Acme' };
  // wa.me só no FIM (depois de 600KB) → cortado pelo cap.
  const fetchAlem = fetchFactory(['<html>', pad, '<a href="https://wa.me/5511987654321">Zap</a></html>']);
  const siteAlem = await discovery.collectFromSite(identidade, { fetchImpl: fetchAlem, signal: null, logger });
  assert.equal(siteAlem.candidates.filter((c) => c.tipo === 'wa_link').length, 0, 'wa.me além do cap não entra');
  // wa.me no INÍCIO → lido mesmo com o corpo gigante.
  const fetchDentro = fetchFactory(['<html><a href="https://wa.me/5511987654321">Zap</a>', pad, '</html>']);
  const siteDentro = await discovery.collectFromSite(identidade, { fetchImpl: fetchDentro, signal: null, logger });
  assert.ok(siteDentro.candidates.some((c) => c.tipo === 'wa_link' && c.raw === '5511987654321'), 'wa.me dentro do cap é lido');
});

test('15) teto do crawl com orçamento: até 12 páginas extras (5→12), sem repetir URL', async () => {
  const fetched = [];
  const links = Array.from({ length: 20 }, (_, i) => `<a href="/pagina-${i + 1}">Pagina ${i + 1}</a>`).join('');
  const fetchImpl = async (url) => {
    const u = String(url);
    fetched.push(u);
    const html = /\/pagina-/.test(u)
      ? '<html><title>Acme</title><p>sem contatos aqui</p></html>'
      : `<html><title>Acme</title>${links}</html>`;
    return { ok: true, status: 200, text: async () => html };
  };
  const identidade = { dominio: 'acme.com.br', dominio_confirmado: true, uf: 'SP', nome_busca: 'Acme' };
  const site = await discovery.collectFromSite(identidade, { fetchImpl, signal: null, logger, startedAt: Date.now() });
  const extras = fetched.filter((u) => /\/pagina-/.test(u));
  assert.equal(extras.length, discovery.CRAWL_MAX_EXTRA_PAGES, 'crawl visita exatamente o teto de páginas extras (12)');
  assert.equal(new Set(extras).size, extras.length, 'nenhuma página repetida');
  assert.ok(site.pages.length >= discovery.CRAWL_MAX_EXTRA_PAGES + 3, '3 caminhos fixos + 12 extras em site.pages');
});

test('16) e-mail em TEXTO PURO (sem mailto) é extraído (EMAIL_RE no caminho bare-text)', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': '<html><title>Acme</title><p>Fale com a gente: comercial@acme.com.br</p></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.email, 'comercial@acme.com.br', 'e-mail literal no TEXTO da página é colhido');
    assert.equal(r.email_fonte_tipo, 'site_oficial');
  } finally { world.restore(); }
});

test('17) wa_candidates dedupe por E.164: mesmo número em 2 páginas entra 1×', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br/atendimento': '<html><title>Atendimento</title><a href="https://wa.me/5511987654321">Zap</a></html>',
    'https://acme.com.br': '<html><title>Acme</title><a href="https://wa.me/5511987654321">Fale no WhatsApp</a><a href="/atendimento">Atendimento</a></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'confirmado');
    assert.equal(r.whatsapp, '+5511987654321');
    assert.equal(r.wa_candidates.length, 1, 'mesmo E.164 em várias páginas = 1 candidato na cadeia');
    assert.equal(r.wa_candidates[0].whatsapp, r.whatsapp);
  } finally { world.restore(); }
});

test('18) candidato nao_confirmado (DDD incompatível) NÃO entra na cadeia', async () => {
  const world = stubFetch({
    brasilapi: BRASILAPI,
    'https://acme.com.br': '<html><title>Acme</title><a href="https://wa.me/5541999888777">WhatsApp</a></html>',
  });
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.status, 'nao_confirmado', '95-30=65 fica fora dos confirmados');
    assert.ok(r.nao_confirmado, 'fila de revisão manual');
    assert.deepEqual(r.wa_candidates, [], 'cadeia do gate só leva candidatos CONFIRMADOS');
  } finally { world.restore(); }
});

test('19) e-mail DETERMINÍSTICO: vence o da HOME, não o que completar primeiro', async () => {
  // /contato resolve NA HORA; a home só no próximo tick — sem ordem de
  // submissão, o marketing@ (que completava primeiro) vencia o emailPick.
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return { ok: true, status: 200, json: async () => BRASILAPI, text: async () => JSON.stringify(BRASILAPI) };
    }
    if (u.includes('/contato')) {
      return { ok: true, status: 200, text: async () => '<html><title>Contato</title><a href="mailto:marketing@acme.com.br">e-mail</a></html>' };
    }
    if (u === 'https://acme.com.br/' || u === 'https://acme.com.br') {
      return new Promise((resolve) => setImmediate(() => resolve({
        ok: true, status: 200, text: async () => '<html><title>Acme</title><a href="mailto:contato@acme.com.br">e-mail</a></html>',
      })));
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const r = await discovery.discoverLeadContact(null, makeProspect(), { signal: null, logger });
    assert.equal(r.email, 'contato@acme.com.br', 'prioridade home → /contato → /fale-conosco, INDEPENDENTE do timing');
    assert.notEqual(r.email, 'marketing@acme.com.br', 'a página que COMPLETOU primeiro não vence');
  } finally { global.fetch = orig; }
});
