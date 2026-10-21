'use strict';

/**
 * test/enrich-gate-crawl.test.js — correção do "enriquecimento não termina":
 *   1. gate Twilio no executor company.digital_presence (wiring reffeito — o
 *      refactor de 14/10 deixou o gate órfão; wa.me fixo/voicemail NÃO é
 *      promovido, indisponibilidade é fail-open);
 *   2. crawl interno respeita o orçamento do ESTÁGIO site relativo ao início
 *      do lead (não come o tempo de Places/Instagram/Twilio).
 */

const test = require('node:test');
const assert = require('node:assert');
const digitalPresence = require('../workers/digital-presence');
const discovery = require('../workers/contact-discovery');

const LOGGER = { info() {}, warn() {}, error() {}, child() { return this; } };

const DP_TASK = {
  input: { companyName: 'ACME RESTAURANTE LTDA', cnpj: '11111111000111', city: 'Guarulhos', state: 'SP', domain: 'acme.com.br' },
  orgId: 'org-1', jobId: 'job-1', prospectId: 'p-1', entityKey: 'prospect:p-1', entityType: 'prospect',
  capability: 'company.digital_presence', taskId: 't-1', taskKey: 'k-1', attempt: 1, timeoutMs: 60000,
};

const SITE_HTML = '<html><title>Acme</title><a href="https://wa.me/5511987654321">Fale no WhatsApp</a></html>';

// Fetch fake: BrasilAPI + site com wa.me na home; tudo mais 404.
function stubFetch(brasilapiEmail = '') {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return {
        ok: true, status: 200,
        json: async () => ({ cnpj: '11111111000111', razao_social: 'ACME RESTAURANTE LTDA', municipio: 'GUARULHOS', uf: 'SP', ddd_telefone_1: '', email: brasilapiEmail }),
      };
    }
    if (u.startsWith('https://acme.com.br')) return { ok: true, status: 200, text: async () => SITE_HTML };
    return { ok: false, status: 404, text: async () => '' };
  };
  return { restore() { global.fetch = orig; } };
}

function makeGateStubs(lookupResult) {
  const calls = { lookups: 0, outcomes: 0 };
  // Resultado fixo OU função por número (cadeia: 1º e 2º com destinos distintos).
  const resolve = typeof lookupResult === 'function' ? lookupResult : () => lookupResult;
  return {
    calls,
    deps: {
      twilioLookup: {
        isConfigured: () => true,
        lookupPhoneNumber: async (phoneE164) => { calls.lookups += 1; return { ok: true, ...resolve(phoneE164) }; },
        evaluateWhatsAppNumber: (res) => {
          if (res.valid === false) return { decision: 'BLOCK', reason: `INVALID_NUMBER:${(res.validationErrors || []).join('+') || 'INVALID'}` };
          const blocked = new Set(['fixedVoip', 'landline', 'tollFree', 'voicemail']);
          if (res.lineType && blocked.has(res.lineType)) return { decision: 'BLOCK', reason: `LINE_TYPE:${res.lineType}` };
          return { decision: 'ALLOW', reason: `LINE_TYPE:${res.lineType || 'unknown'}` };
        },
      },
      registry: {
        acquire: async () => ({ ok: true, ticket: { release: async () => {} } }),
        recordOutcome: async () => { calls.outcomes += 1; },
      },
    },
  };
}

test('gate Twilio: linha fixa (landline) → wa.me NÃO é promovido; motivo registrado; contacts vazio', async () => {
  const world = stubFetch();
  const { deps, calls } = makeGateStubs({ valid: true, lineType: 'landline' });
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps });
    assert.strictEqual(out.status, 'COMPLETED');
    assert.strictEqual(out.data.digital_presence.whatsapp, null, 'wa.me de linha FIXA não é promovido');
    assert.deepStrictEqual(out.data.contacts, []);
    assert.deepStrictEqual(out.facts, []);
    assert.ok(
      (out.data.digital_presence.motivo_descarte || []).some((m) => /twilio.*LINE_TYPE:landline/i.test(m)),
      'motivo do bloqueio registrado para revisão'
    );
    assert.strictEqual(calls.lookups, 1);
  } finally { world.restore(); }
});

test('gate Twilio: linha mobile → wa.me promovido normalmente (com fact e evidência)', async () => {
  const world = stubFetch();
  const { deps, calls } = makeGateStubs({ valid: true, lineType: 'mobile' });
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps });
    assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321');
    assert.strictEqual(out.data.contacts.length, 1);
    assert.ok(out.facts.length >= 1, 'fact com evidência da fonte');
    assert.strictEqual(calls.lookups, 1);
    assert.strictEqual(calls.outcomes, 1);
  } finally { world.restore(); }
});

test('fact contact.email: e-mail do SITE → confidence 0.8 e sourceType site_oficial (no executor)', async () => {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return { ok: true, status: 200, json: async () => ({ cnpj: '11111111000111', razao_social: 'ACME RESTAURANTE LTDA', municipio: 'GUARULHOS', uf: 'SP', ddd_telefone_1: '', email: '' }) };
    }
    if (u.startsWith('https://acme.com.br')) {
      return { ok: true, status: 200, text: async () => '<html><title>Acme</title><a href="https://wa.me/5511987654321">Fale no WhatsApp</a><a href="mailto:contato@acme.com.br">e-mail</a></html>' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  const { deps } = makeGateStubs({ valid: true, lineType: 'mobile' });
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps });
    const emailFact = out.facts.find((f) => f.attribute === 'contact.email');
    assert.ok(emailFact, 'fact contact.email emitido junto do whatsapp');
    assert.strictEqual(emailFact.value, 'contato@acme.com.br');
    assert.strictEqual(emailFact.confidence, 0.8);
    assert.strictEqual(emailFact.evidence.sourceType, 'site_oficial');
    assert.ok(emailFact.evidence.url.startsWith('https://acme.com.br'), 'evidence.url é a página do site');
    assert.strictEqual(out.data.digital_presence.corporate_email_fonte, emailFact.evidence.url);
  } finally { global.fetch = orig; }
});

test('fact contact.email: e-mail só na BrasilAPI (Receita) → confidence 0.6 e sourceType receita', async () => {
  const world = stubFetch('contato@acme.com.br');
  const { deps } = makeGateStubs({ valid: true, lineType: 'mobile' });
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps });
    const emailFact = out.facts.find((f) => f.attribute === 'contact.email');
    assert.ok(emailFact, 'fact contact.email emitido com fonte Receita');
    assert.strictEqual(emailFact.value, 'contato@acme.com.br');
    assert.strictEqual(emailFact.confidence, 0.6);
    assert.strictEqual(emailFact.evidence.sourceType, 'receita');
    assert.strictEqual(emailFact.evidence.url, 'https://brasilapi.com.br/api/cnpj/v1/11111111000111');
    assert.strictEqual(out.data.digital_presence.corporate_email_fonte, emailFact.evidence.url);
  } finally { world.restore(); }
});

test('fact contact.email: e-mail só na BIO do Instagram → confidence 0.7 e sourceType instagram', async () => {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return {
        ok: true, status: 200,
        json: async () => ({ cnpj: '11111111000111', razao_social: 'ACME RESTAURANTE LTDA', municipio: 'GUARULHOS', uf: 'SP', ddd_telefone_1: '', email: '' }),
      };
    }
    if (u.startsWith('https://acme.com.br')) {
      return { ok: true, status: 200, text: async () => '<html><title>Acme</title><a href="https://www.instagram.com/acmeoficial">Instagram</a></html>' };
    }
    if (u.startsWith('https://www.instagram.com/acmeoficial')) {
      return { ok: true, status: 200, text: async () => '<html><head><meta property="og:description" content="Acme Restaurante — eventos e delivery. 📩 contato@acme.com.br"/></head><body></body></html>' };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps: {} });
    const emailFact = out.facts.find((f) => f.attribute === 'contact.email');
    assert.ok(emailFact, 'fact contact.email emitido com fonte Instagram');
    assert.strictEqual(emailFact.value, 'contato@acme.com.br');
    assert.strictEqual(emailFact.confidence, 0.7, 'bio do Instagram vale 0.7 (entre site 0.8 e Receita 0.6)');
    assert.strictEqual(emailFact.evidence.sourceType, 'instagram');
    assert.ok(emailFact.evidence.url.includes('instagram.com'));
    assert.strictEqual(out.data.digital_presence.corporate_email, 'contato@acme.com.br');
  } finally { global.fetch = orig; }
});

test('gate Twilio SEM credenciais/registry → fail-open (promove como hoje)', async () => {
  const world = stubFetch();
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, {
      signal: null, logger: LOGGER, deps: { twilioLookup: { isConfigured: () => false }, registry: null },
    });
    assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321', 'sem Twilio configurado: fail-open');
  } finally { world.restore(); }
});

test('gate Twilio que LANÇA → nunca derruba a descoberta (fail-open por exceção)', async () => {
  const world = stubFetch();
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, {
      signal: null, logger: LOGGER,
      deps: {
        twilioLookup: { isConfigured: () => true },
        registry: { acquire: async () => { throw new Error('redis fora'); } },
      },
    });
    assert.strictEqual(out.status, 'COMPLETED');
    assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321', 'erro do gate não derruba o resultado');
  } finally { world.restore(); }
});

// ── crawl interno respeita o orçamento do ESTÁGIO site ─────────────────────

test('crawl: com startedAt no passado (estágio sem tempo) NENHUMA página extra é baixada', async () => {
  const fetched = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.startsWith('https://brasilapi.com.br/')) return { ok: true, status: 200, json: async () => ({}) };
    // Home SEM wa.me mas COM link de atendimento — sem prazo, o crawl seguiria.
    return { ok: true, status: 200, text: async () => '<html><a href="/atendimento">Atendimento</a></html>' };
  };
  try {
    const identidade = { dominio: 'acme.com.br', dominio_confirmado: true, uf: 'SP', nome_busca: 'Acme' };
    const site = await discovery.collectFromSite(identidade, {
      signal: null, logger: LOGGER,
      startedAt: Date.now() - 20 * 1000, // estágio site já estourou os 16s
    });
    assert.ok(!fetched.some((u) => u.includes('/atendimento')), 'crawl não roda sem orçamento');
    assert.ok(site.pages.every((p) => !p.url.includes('/atendimento')));
  } finally { global.fetch = orig; }
});

test('crawl: com startedAt fresco o orçamento do estágio permite as páginas extras', async () => {
  const fetched = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    fetched.push(u);
    if (u.startsWith('https://brasilapi.com.br/')) return { ok: true, status: 200, json: async () => ({}) };
    if (u.includes('/atendimento')) return { ok: true, status: 200, text: async () => '<html><a href="https://wa.me/5511987654321">Zap</a></html>' };
    return { ok: true, status: 200, text: async () => '<html><a href="/atendimento">Atendimento</a></html>' };
  };
  try {
    const identidade = { dominio: 'acme.com.br', dominio_confirmado: true, uf: 'SP', nome_busca: 'Acme' };
    const site = await discovery.collectFromSite(identidade, {
      signal: null, logger: LOGGER,
      startedAt: Date.now() - 2 * 1000, // estágio jovem: há orçamento para o crawl
    });
    assert.ok(fetched.some((u) => u.includes('/atendimento')), 'crawl roda com orçamento disponível');
    assert.ok(site.candidates.some((c) => c.tipo === 'wa_link'), 'wa.me da página profunda coletado');
  } finally { global.fetch = orig; }
});

// ── Cadeia do gate Twilio (spec ampliar-crawl-sites-whatsapp-email) ─────────

// Site com wa.me na home + wa.me em página interna (mesmo DDD 11/SP).
function stubFetchMulti(pagesByFrag) {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return {
        ok: true, status: 200,
        json: async () => ({ cnpj: '11111111000111', razao_social: 'ACME RESTAURANTE LTDA', municipio: 'GUARULHOS', uf: 'SP', ddd_telefone_1: '', email: '' }),
      };
    }
    for (const [frag, html] of Object.entries(pagesByFrag)) {
      if (u.includes(frag)) return { ok: true, status: 200, text: async () => html };
    }
    return { ok: false, status: 404, text: async () => '' };
  };
  return { restore() { global.fetch = orig; } };
}

test('cadeia: 1º landline rejeitado → 2º (mobile) promovido; exatos 2 lookups; rejeição registrada', async () => {
  const world = stubFetchMulti({
    // 2º candidato é wa_contexto (score 85) — o promovido NÃO herda o 95 do rejeitado.
    '/atendimento': '<html><title>Atendimento</title><p>WhatsApp (11) 97777-6666 com a equipe</p></html>',
    'acme.com.br': '<html><title>Acme</title><a href="https://wa.me/5511987654321">Fale no WhatsApp</a><a href="/atendimento">Atendimento</a></html>',
  });
  const { deps, calls } = makeGateStubs((phone) => (
    String(phone).endsWith('54321') ? { valid: true, lineType: 'landline' } : { valid: true, lineType: 'mobile' }
  ));
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps });
    assert.strictEqual(out.status, 'COMPLETED');
    assert.strictEqual(out.data.digital_presence.whatsapp, '+5511977776666', '2º candidato (mobile) promovido');
    assert.strictEqual(out.data.contacts.length, 1);
    assert.strictEqual(out.data.contacts[0].value, '+5511977776666');
    assert.strictEqual(out.data.digital_presence.score, 85, 'score do PROMOVIDO (wa_contexto), não o 95 do rejeitado');
    assert.strictEqual(out.data.contacts[0].confidence, 0.85, 'confiança derivada do score do promovido');
    assert.strictEqual(calls.lookups, 2, 'exatos 2 lookups (1º rejeitado, 2º aprovado)');
    assert.ok(
      (out.data.digital_presence.motivo_descarte || []).some((m) => m.includes('+5511987654321') && /LINE_TYPE:landline/i.test(m)),
      'evidence da rejeição do 1º registrada em motivo_descarte'
    );
    const rejeitados = out.data.digital_presence.whatsapp_rejeitados;
    assert.strictEqual(rejeitados.length, 1, 'evidence estruturada do 1º rejeitado');
    assert.strictEqual(rejeitados[0].whatsapp, '+5511987654321');
    assert.strictEqual(rejeitados[0].motivo, 'LINE_TYPE:landline');
    assert.ok(rejeitados[0].url && rejeitados[0].url.includes('acme.com.br'), 'evidence com url da fonte');
    const waFact = out.facts.find((f) => f.attribute === 'contact.whatsapp');
    assert.ok(waFact && waFact.value === '+5511977776666', 'fact referencia o PROMOVIDO');
    assert.strictEqual(waFact.evidence.sourceType, 'wa_contexto', 'sourceType é o do PROMOVIDO');
    assert.ok(waFact.evidence.url.includes('/atendimento'), 'fact aponta a fonte do promovido (não a do 1º)');
  } finally { world.restore(); }
});

test('cadeia: teto de 2 lookups — 2 rejeitados → sem promoção; 3º candidato não é consultado', async () => {
  const world = stubFetchMulti({
    '/atendimento': '<html><title>Atendimento</title><a href="https://wa.me/5511977776666">Zap 2</a></html>',
    '/orcamento': '<html><title>Orçamento</title><a href="https://wa.me/5511966665555">Zap 3</a></html>',
    'acme.com.br': '<html><title>Acme</title><a href="https://wa.me/5511987654321">Zap 1</a><a href="/atendimento">Atendimento</a><a href="/orcamento">Orçamento</a></html>',
  });
  const { deps, calls } = makeGateStubs({ valid: true, lineType: 'landline' }); // TODOS rejeitados
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps });
    assert.strictEqual(out.status, 'COMPLETED', 'rejeição não falha a task');
    assert.strictEqual(out.data.digital_presence.whatsapp, null, 'todos rejeitados → lead mantém o fixo da Receita');
    assert.deepStrictEqual(out.data.contacts, []);
    assert.strictEqual(calls.lookups, 2, 'teto de 2 lookups/lead (3º da lista nem entra)');
    assert.strictEqual(out.data.digital_presence.whatsapp_rejeitados.length, 2, 'evidence dos 2 rejeitados acumulada');
  } finally { world.restore(); }
});

test('cadeia: Twilio fora (circuito aberto) → fail-open no 1º SEM lookup extra', async () => {
  const world = stubFetchMulti({
    '/atendimento': '<html><title>Atendimento</title><a href="https://wa.me/5511977776666">Zap 2</a></html>',
    'acme.com.br': '<html><title>Acme</title><a href="https://wa.me/5511987654321">Zap 1</a><a href="/atendimento">Atendimento</a></html>',
  });
  const calls = { lookups: 0 };
  const deps = {
    twilioLookup: {
      isConfigured: () => true,
      lookupPhoneNumber: async () => { calls.lookups += 1; return { ok: false, reason: 'HTTP_500' }; },
      evaluateWhatsAppNumber: (res) => ({ decision: 'ALLOW', reason: `LOOKUP_UNAVAILABLE:${res.reason}` }),
    },
    // Registry com o circuito OPEN: acquire nega sem gastar lookup.
    registry: {
      acquire: async () => ({ ok: false, reason: 'PROVIDER_CIRCUIT_OPEN', retryAfterMs: 30000 }),
      recordOutcome: async () => {},
    },
  };
  try {
    const out = await digitalPresence.executors['company.digital_presence'](DP_TASK, { signal: null, logger: LOGGER, deps });
    assert.strictEqual(out.status, 'COMPLETED');
    assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321', 'fail-open: 1º promovido como hoje');
    assert.strictEqual(calls.lookups, 0, 'circuito aberto não gasta lookup (nem no 2º candidato)');
  } finally { world.restore(); }
});
