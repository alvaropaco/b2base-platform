const test = require('node:test');
const assert = require('node:assert');

const twilio = require('../twilio-lookup');
const contracts = require('../enrichment-contracts');
const { createNoopRegistry } = require('../enrichment-provider-registry');
const {
  executors,
  createDigitalPresenceWorker,
  gateWhatsApp,
} = require('../workers/digital-presence');
const { createCompanyDeepWorker } = require('../workers/company-deep');

const LOGGER = { info() {}, warn() {}, error() {}, child() { return this; } };
const DP_TASK = {
  input: { domain: 'acme.com.br' },
  orgId: 'o', jobId: 'j', prospectId: 'p', entityKey: 'prospect:p', entityType: 'prospect',
  capability: 'company.digital_presence', taskId: 't', taskKey: 'k', attempt: 1, timeoutMs: 5000,
};

const HTML_WA = '<html><body><a href="https://wa.me/11987654321">Fale no WhatsApp</a></body></html>';

function mockFetch(body) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, signal: opts.signal });
    return { ok: true, status: 200, json: async () => body, text: async () => body };
  };
  return { calls, restore() { global.fetch = orig; } };
}

/** Registry de mentira: conta acquire/recordOutcome/release. */
function fakeRegistry({ acquireResult } = {}) {
  const seen = { acquire: [], outcomes: [], released: 0 };
  return {
    seen,
    acquire: async (provider) => {
      seen.acquire.push(provider);
      if (acquireResult) return acquireResult;
      return { ok: true, ticket: { provider, release: async () => { seen.released += 1; } } };
    },
    recordOutcome: async (provider, o) => { seen.outcomes.push({ provider, ...o }); },
    getState: async (p) => ({ provider: p, state: 'HEALTHY' }),
  };
}

function twilioStub({ configured = true, lookup = async () => ({ ok: true, lineType: 'mobile', valid: true }) } = {}) {
  return { isConfigured: () => configured, lookupPhoneNumber: lookup, evaluateWhatsAppNumber: twilio.evaluateWhatsAppNumber };
}

// ── Política (evaluateWhatsAppNumber) ───────────────────────────────────────

test('política: mobile e VoIP passam; fixo/tollFree/voicemail bloqueiam', () => {
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: true, valid: true, lineType: 'mobile' }).decision, 'ALLOW');
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: true, valid: true, lineType: 'fixedVoip' }).decision, 'ALLOW');
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: true, valid: true, lineType: 'nonFixedVoip' }).decision, 'ALLOW');
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: true, valid: true, lineType: 'landline' }).decision, 'BLOCK');
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: true, valid: true, lineType: 'tollFree' }).decision, 'BLOCK');
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: true, valid: true, lineType: 'voicemail' }).decision, 'BLOCK');
});

test('política: número inválido bloqueia; dado incerto/ausente é fail-open', () => {
  assert.strictEqual(
    twilio.evaluateWhatsAppNumber({ ok: true, valid: false, validationErrors: ['TOO_SHORT'], lineType: null }).decision,
    'BLOCK'
  );
  // Twilio fora / sem line_type_intelligence / sem resposta → ALLOW (fail-open)
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: false, reason: 'HTTP_500' }).decision, 'ALLOW');
  assert.strictEqual(twilio.evaluateWhatsAppNumber({ ok: true, valid: true, lineType: null }).decision, 'ALLOW');
  assert.strictEqual(twilio.evaluateWhatsAppNumber(null).decision, 'ALLOW');
});

// ── Cliente (lookupPhoneNumber) ─────────────────────────────────────────────

test('lookupPhoneNumber: monta URL E164-encodeada + Basic auth e parseia resposta', async (t) => {
  process.env.TWILIO_ACCOUNT_SID = 'ACXXX';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  t.after(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
  const mock = mockFetch({
    phone_number: '+5511987654321',
    valid: true,
    line_type_intelligence: { type: 'mobile', carrier_name: 'Vivo', mobile_country_code: '724', mobile_network_code: '06' },
  });
  try {
    const res = await twilio.lookupPhoneNumber('+5511987654321', { fetchImpl: global.fetch });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.lineType, 'mobile');
    assert.strictEqual(res.carrierName, 'Vivo');
    assert.strictEqual(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.includes('/PhoneNumbers/%2B5511987654321'));
    assert.ok(mock.calls[0].url.includes('Fields=line_type_intelligence'));
    assert.strictEqual(mock.calls[0].headers.Authorization, `Basic ${Buffer.from('ACXXX:tok').toString('base64')}`);
  } finally {
    mock.restore();
  }
});

test('lookupPhoneNumber: sem credenciais → NOT_CONFIGURED; HTTP 500 → ok:false', async () => {
  const saved = { ...process.env };
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET']) delete process.env[k];
  try {
    assert.strictEqual(twilio.isConfigured(), false);
    const unconfigured = await twilio.lookupPhoneNumber('+5511987654321', { fetchImpl: global.fetch });
    assert.strictEqual(unconfigured.ok, false);
    assert.strictEqual(unconfigured.reason, 'NOT_CONFIGURED');
  } finally {
    process.env = saved;
  }
});

// ── Gate no executor (company.digital_presence) ─────────────────────────────

function executorDeps({ twilio: t, registry } = {}) {
  return {
    signal: null,
    logger: LOGGER,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => HTML_WA }),
    deps: { twilioLookup: t, registry },
  };
}

test('gate: Twilio não configurado → promove como antes, sem tocar o registry', async () => {
  const registry = fakeRegistry();
  const out = await executors['company.digital_presence'](DP_TASK, executorDeps({ twilio: twilioStub({ configured: false }), registry }));
  assert.strictEqual(out.status, 'COMPLETED');
  assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321');
  assert.strictEqual(registry.seen.acquire.length, 0);
  assert.ok(!out.facts.some((f) => f.attribute === 'contact.whatsapp_line_type'));
});

test('gate: mobile → promove com evidência twilio e outcome ok no registry', async () => {
  const registry = fakeRegistry();
  const out = await executors['company.digital_presence'](DP_TASK, executorDeps({ twilio: twilioStub(), registry }));
  assert.strictEqual(out.status, 'COMPLETED');
  assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321');
  assert.deepStrictEqual(registry.seen.acquire, ['twilio.lookup']);
  assert.strictEqual(registry.seen.released, 1);
  assert.strictEqual(registry.seen.outcomes[0].ok, true);
  const lti = out.facts.find((f) => f.attribute === 'contact.whatsapp_line_type');
  assert.ok(lti && lti.value === 'mobile' && lti.evidence.sourceType === 'twilio');
});

test('gate: landline → whatsapp_rejected, manager não promove e lead fica com a Receita', async () => {
  const registry = fakeRegistry();
  const out = await executors['company.digital_presence'](
    DP_TASK,
    executorDeps({ twilio: twilioStub({ lookup: async () => ({ ok: true, valid: true, lineType: 'landline', carrierName: 'Oi Fixo' }) }), registry })
  );
  assert.strictEqual(out.status, 'COMPLETED');
  assert.strictEqual(out.data.digital_presence.whatsapp, null);
  assert.strictEqual(out.data.digital_presence.whatsapp_rejected, '+5511987654321');
  assert.ok(out.data.digital_presence.rejected_reason.startsWith('LINE_TYPE:landline'));
  assert.deepStrictEqual(out.data.contacts, []);
  assert.ok(out.facts.some((f) => f.attribute === 'contact.whatsapp.rejected'));
});

test('gate: número inválido (valid:false) → rejected_reason INVALID_NUMBER e contacts vazio', async () => {
  const registry = fakeRegistry();
  const out = await executors['company.digital_presence'](
    DP_TASK,
    executorDeps({ twilio: twilioStub({ lookup: async () => ({ ok: true, valid: false, validationErrors: ['TOO_SHORT'], lineType: null }) }), registry })
  );
  assert.strictEqual(out.status, 'COMPLETED');
  assert.strictEqual(out.data.digital_presence.whatsapp, null);
  assert.strictEqual(out.data.digital_presence.whatsapp_rejected, '+5511987654321');
  assert.ok(out.data.digital_presence.rejected_reason.startsWith('INVALID_NUMBER:TOO_SHORT'));
  assert.deepStrictEqual(out.data.contacts, []);
  assert.ok(out.facts.some((f) => f.attribute === 'contact.whatsapp.rejected' && f.evidence.sourceType === 'twilio'));
  assert.ok(!out.facts.some((f) => f.attribute === 'contact.whatsapp_line_type'));
});

test('gate: Twilio fora (HTTP 500) → fail-open promove e registra outcome ruim', async () => {
  const registry = fakeRegistry();
  const out = await executors['company.digital_presence'](
    DP_TASK,
    executorDeps({ twilio: twilioStub({ lookup: async () => ({ ok: false, reason: 'HTTP_500' }) }), registry })
  );
  assert.strictEqual(out.status, 'COMPLETED');
  assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321');
  assert.strictEqual(registry.seen.outcomes[0].ok, false);
  assert.ok(!out.facts.some((f) => f.attribute === 'contact.whatsapp_line_type'));
});

test('gate: circuito aberto (acquire recusa) → fail-open sem chamar lookup', async () => {
  const registry = fakeRegistry({ acquireResult: { ok: false, reason: 'PROVIDER_CIRCUIT_OPEN', retryAfterMs: 30000 } });
  let lookedUp = 0;
  const out = await executors['company.digital_presence'](
    DP_TASK,
    executorDeps({ twilio: twilioStub({ lookup: async () => { lookedUp += 1; return { ok: true, lineType: 'landline' }; } }), registry })
  );
  assert.strictEqual(out.status, 'COMPLETED');
  assert.strictEqual(out.data.digital_presence.whatsapp, '+5511987654321');
  assert.strictEqual(lookedUp, 0);
});

test('gateWhatsApp direto: exceção do lookup → ALLOW (nunca derruba a task)', async () => {
  const registry = fakeRegistry();
  const verdict = await gateWhatsApp('+5511987654321', {
    deps: { twilioLookup: twilioStub({ lookup: async () => { throw new Error('boom'); } }), registry },
    logger: LOGGER,
  });
  assert.strictEqual(verdict.decision, 'ALLOW');
  assert.strictEqual(verdict.reason, 'TWILIO_ERROR');
  assert.strictEqual(registry.seen.released, 1);
});

// ── Wiring: createDigitalPresenceWorker registra executor ANTES do return ───
// (regressão de c89e8d4e: registro depois do return = worker consumia nada)

function makePrismaMock() {
  return {
    enrichmentResult: {
      findUnique: async () => null,
      upsert: async ({ create }) => ({ id: create.taskId }),
    },
    enrichmentEvidence: { createMany: async () => ({ count: 0 }) },
    enrichmentTask: { upsert: async () => ({}), update: async () => ({}) },
  };
}

test('wiring: processMessage executa o company.digital_presence registrado', async () => {
  const captured = [];
  const mock = mockFetch(HTML_WA);
  try {
    const runtime = createDigitalPresenceWorker({
      prisma: makePrismaMock(),
      js: null,
      deps: {
        logger: LOGGER,
        registry: createNoopRegistry(),
        publisher: async (result) => { captured.push(result); },
        execDeps: { registry: createNoopRegistry(), twilioLookup: twilioStub() },
      },
    });
    const acked = [];
    const msg = {
      data: contracts.serializePayload({ ...DP_TASK, version: contracts.VERSION }),
      ack: async () => { acked.push(1); },
      nak: async () => { throw new Error('não deveria nak'); },
      term: async () => { throw new Error('não deveria term'); },
    };
    const out = await runtime.processMessage(msg);
    assert.strictEqual(out.status, 'COMPLETED');
    assert.strictEqual(acked.length, 1);
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].status, 'COMPLETED');
    assert.strictEqual(captured[0].data.digital_presence.whatsapp, '+5511987654321');
  } finally {
    mock.restore();
  }
});

test('wiring: company-deep injeta execDeps — gate roda também no worker da família company', async () => {
  const captured = [];
  const gateRegistry = fakeRegistry();
  const mock = mockFetch(HTML_WA);
  try {
    const runtime = createCompanyDeepWorker({
      prisma: makePrismaMock(),
      js: null,
      deps: {
        logger: LOGGER,
        registry: createNoopRegistry(),
        publisher: async (result) => { captured.push(result); },
        execDeps: { registry: gateRegistry, twilioLookup: twilioStub({ lookup: async () => ({ ok: true, valid: true, lineType: 'landline' }) }) },
      },
    });
    const msg = {
      data: contracts.serializePayload({ ...DP_TASK, version: contracts.VERSION }),
      ack: async () => {},
      nak: async () => { throw new Error('não deveria nak'); },
      term: async () => { throw new Error('não deveria term'); },
    };
    const out = await runtime.processMessage(msg);
    assert.strictEqual(out.status, 'COMPLETED');
    assert.strictEqual(captured[0].data.digital_presence.whatsapp, null);
    assert.strictEqual(captured[0].data.digital_presence.whatsapp_rejected, '+5511987654321');
    // O gate passou pelo provider 'twilio.lookup' (acquire + release), não fail-open.
    assert.deepStrictEqual(gateRegistry.seen.acquire, ['twilio.lookup']);
    assert.strictEqual(gateRegistry.seen.released, 1);
  } finally {
    mock.restore();
  }
});

// Branch de PRODUÇÃO: sem execDeps, sem stub — o worker usa o registry de
// deps.registry e o default require('../twilio-lookup') com credenciais de env.
test('wiring produção: company-deep sem execDeps puxa twilio-lookup default + env (gate ativo)', async (t) => {
  process.env.TWILIO_ACCOUNT_SID = 'ACXXX';
  process.env.TWILIO_AUTH_TOKEN = 'tok';
  t.after(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
  });
  // Um mock por URL: o crawl do site serve HTML com wa.me; o Lookup do Twilio
  // responde landline (o global.fetch atende os dois neste formato).
  const orig = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('lookups.twilio.com')) {
      return { ok: true, status: 200, json: async () => ({ valid: true, line_type_intelligence: { type: 'landline' } }) };
    }
    return { ok: true, status: 200, text: async () => HTML_WA };
  };
  const captured = [];
  const sharedRegistry = fakeRegistry(); // produção: runtime e gate compartilham
  try {
    const runtime = createCompanyDeepWorker({
      prisma: makePrismaMock(),
      js: null,
      deps: {
        logger: LOGGER,
        registry: sharedRegistry,
        publisher: async (result) => { captured.push(result); },
      },
    });
    const msg = {
      data: contracts.serializePayload({ ...DP_TASK, version: contracts.VERSION }),
      ack: async () => {},
      nak: async () => { throw new Error('não deveria nak'); },
      term: async () => { throw new Error('não deveria term'); },
    };
    const out = await runtime.processMessage(msg);
    assert.strictEqual(out.status, 'COMPLETED');
    assert.strictEqual(captured[0].data.digital_presence.whatsapp, null);
    assert.strictEqual(captured[0].data.digital_presence.whatsapp_rejected, '+5511987654321');
    // Mesmo registry atende runtime (site.crawl) e gate (twilio.lookup).
    assert.deepStrictEqual(sharedRegistry.seen.acquire, ['site.crawl', 'twilio.lookup']);
    assert.strictEqual(sharedRegistry.seen.released, 2);
    assert.ok(sharedRegistry.seen.outcomes.some((o) => o.provider === 'twilio.lookup' && o.ok === true));
  } finally {
    global.fetch = orig;
  }
});
