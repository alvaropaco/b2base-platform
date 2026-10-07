const test = require('node:test');
const assert = require('node:assert');
const caps = require('../enrichment-capabilities');

test('catálogo: toda capability tem metadados obrigatórios', () => {
  for (const name of caps.listCapabilities().map((c) => c.capability)) {
    const def = caps.getCapability(name);
    assert.ok(def.family, `${name}.family`);
    assert.ok(['basic', 'premium'].includes(def.tier), `${name}.tier`);
    assert.ok(typeof def.enabled === 'boolean', `${name}.enabled`);
    assert.ok(Array.isArray(def.entityType) && def.entityType.length, `${name}.entityType`);
    assert.ok(def.timeoutMs > 0, `${name}.timeoutMs`);
    assert.ok(def.maxAttempts > 0, `${name}.maxAttempts`);
    assert.ok(def.priority >= 0 && def.priority <= 3, `${name}.priority`);
    assert.ok(Array.isArray(def.providers) && def.providers.length, `${name}.providers`);
    assert.ok(typeof def.validateInput === 'function', `${name}.validateInput`);
  }
});

test('catálogo: capabilities habilitadas da fase 1 presentes; porte desabilitado', () => {
  const names = caps.listCapabilities().map((c) => c.capability);
  for (const n of ['identity.domain.verify', 'identity.cnpj.basic', 'search.news']) {
    assert.ok(names.includes(n), n);
    assert.strictEqual(caps.getCapability(n).enabled, true, n);
  }
  for (const n of ['identity.cnpj.resolve', 'search.legal', 'company.profile.deep', 'company.logo', 'company.deepgraph']) {
    assert.ok(names.includes(n), n);
    assert.strictEqual(caps.getCapability(n).enabled, false, n);
  }
  // Os premium do porte são premium; cnpj.resolve é a porta de entrada (basic).
  for (const n of ['search.legal', 'company.profile.deep', 'company.logo', 'company.deepgraph']) {
    assert.strictEqual(caps.getCapability(n).tier, 'premium', n);
  }
});

test('validateCapabilityInput: input inválido → INVALID_INPUT', () => {
  assert.strictEqual(caps.validateCapabilityInput('identity.domain.verify', { domain: 'exemplo.com.br' }).ok, true);
  const missing = caps.validateCapabilityInput('identity.domain.verify', {});
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'INVALID_INPUT');
  const wrongType = caps.validateCapabilityInput('identity.domain.verify', { domain: 42 });
  assert.strictEqual(wrongType.code, 'INVALID_INPUT');
  const unknown = caps.validateCapabilityInput('capability.inexistente', {});
  assert.strictEqual(unknown.code, 'INVALID_INPUT');
});

test('eligibleCapabilities: gating por plano (FR-030/033) e enabled', () => {
  const trial = caps.eligibleCapabilities({ plan: 'trial' });
  const premium = caps.eligibleCapabilities({ plan: 'premium' });
  assert.deepStrictEqual(trial.sort(), ['company.digital_presence', 'identity.cnpj.basic', 'identity.domain.verify', 'search.news']);
  assert.ok(premium.length >= trial.length);
  // enabled:false nunca é elegível, nem para premium.
  assert.ok(!caps.eligibleCapabilities({ plan: 'premium' }).includes('company.deepgraph'));
  assert.ok(premium.includes('search.news'));
});

test('regras expand: declarativas com whenFact + spawn de capability existente', () => {
  for (const def of caps.listCapabilities()) {
    for (const rule of def.expand || []) {
      assert.ok(rule.whenFact, `${def.capability}.expand.whenFact`);
      assert.ok(caps.getCapability(rule.spawn), `${def.capability}.expand.spawn → ${rule.spawn} existe`);
      assert.ok(caps.getCapability(rule.spawn).enabled || rule.spawn, `${def.capability}.expand.spawn habilitável`);
    }
  }
  const def = caps.getCapability('identity.cnpj.basic');
  assert.ok((def.expand || []).some((r) => r.spawn === 'identity.domain.verify'));
});

test('expandRulesFor: regras por capability ordenadas e clonadas', () => {
  const rules = caps.expandRulesFor('identity.cnpj.basic');
  assert.ok(Array.isArray(rules));
  const again = caps.expandRulesFor('identity.cnpj.basic');
  assert.deepStrictEqual(rules, again);
  assert.notStrictEqual(rules, again); // clone — caller não muta o catálogo
});

test('capabilityFamilies: famílias distintas para os workers', () => {
  const families = caps.capabilityFamilies();
  for (const f of ['identity', 'search', 'company']) assert.ok(families.includes(f));
});

// ── US3 — masking de fatos premium para trial (endpoint layer, função pura) ─

test('filterFactsForPlan: remove capabilities premium da leitura de trial', () => {
  const data = {
    prospectId: 'p-1',
    entities: [{
      entityKey: 'prospect:p-1', entityType: 'prospect',
      capabilities: {
        'identity.cnpj.basic': { status: 'COMPLETED', data: { cnpj: 'x' } },
        'company.profile.deep': { status: 'COMPLETED', data: { employees: 350 } },
        'search.news': { status: 'COMPLETED', data: { news: [] } },
      },
    }],
  };
  const filtered = caps.filterFactsForPlan(data, 'trial');
  assert.ok(filtered.entities[0].capabilities['identity.cnpj.basic']);
  assert.ok(!filtered.entities[0].capabilities['company.profile.deep']);
  assert.strictEqual(filtered.entities[0].capabilities['search.news'].status, 'COMPLETED');
  // Premium não é afetado.
  const untouched = caps.filterFactsForPlan(data, 'premium');
  assert.ok(untouched.entities[0].capabilities['company.profile.deep']);
  // Input não é mutado.
  assert.ok(data.entities[0].capabilities['company.profile.deep']);
});
