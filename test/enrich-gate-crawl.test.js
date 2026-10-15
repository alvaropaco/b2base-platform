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
function stubFetch() {
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://brasilapi.com.br/')) {
      return {
        ok: true, status: 200,
        json: async () => ({ cnpj: '11111111000111', razao_social: 'ACME RESTAURANTE LTDA', municipio: 'GUARULHOS', uf: 'SP', ddd_telefone_1: '', email: '' }),
      };
    }
    if (u.startsWith('https://acme.com.br')) return { ok: true, status: 200, text: async () => SITE_HTML };
    return { ok: false, status: 404, text: async () => '' };
  };
  return { restore() { global.fetch = orig; } };
}

function makeGateStubs(lookupResult) {
  const calls = { lookups: 0, outcomes: 0 };
  return {
    calls,
    deps: {
      twilioLookup: {
        isConfigured: () => true,
        lookupPhoneNumber: async () => { calls.lookups += 1; return { ok: true, ...lookupResult }; },
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
