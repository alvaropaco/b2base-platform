// =============================================================================
// enrichment-capabilities.js — catálogo declarativo de capabilities do motor
// distribuído (specs/001-distributed-enrichment). Metadados (tier, limites,
// providers, schema de entrada, regras de expansão) vivem AQUI; a lógica de
// execução é registrada pelos workers (workers/*.js) via registerExecutors —
// adicionar capability nova NÃO exige mudar o manager nem o runtime (FR-016).
//
// Gating por plano (FR-030/033): trial executa só `tier: 'basic'`;
// premium executa basic + premium. `enabled: false` nunca é planejável
// (capabilities do porte ficam desligadas até a Fase 11).
// =============================================================================

// ── Validador simples de input por descritor ───────────────────────────────
// schema: { campo: 'string' | 'number' | 'boolean' | 'any' | {type, required} }
// Campos declarados com required:true são obrigatórios; tipos conferidos.

function makeValidator(schema) {
  return function validateInput(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'input deve ser objeto' };
    }
    for (const [field, spec] of Object.entries(schema)) {
      const type = typeof spec === 'string' ? spec : spec.type;
      const required = typeof spec === 'object' ? spec.required !== false : true;
      const value = input[field];
      if (value === undefined || value === null || value === '') {
        if (required) return { ok: false, code: 'INVALID_INPUT', message: `campo obrigatório ausente: ${field}` };
        continue;
      }
      if (type !== 'any' && typeof value !== type) {
        return { ok: false, code: 'INVALID_INPUT', message: `campo ${field} deve ser ${type}` };
      }
    }
    return { ok: true };
  };
}

// ── Catálogo ────────────────────────────────────────────────────────────────
// `expand`: quando o result produzir o fato `whenFact`, o MANAGER pode criar
// uma task `spawn` (declarativo — worker nunca orquestra, research R7).
// `providers`: ordem = preferência; a decisão de saúde/limite é do registry (US4).

// Estágio 'port': capability portada para o motor (Fase 11) mas só ELEGÍVEL
// com ENRICHMENT_CATALOG_FULL=true — rollout controlado, paridade em staging
// antes do tráfego real (T058/research R11).
const CATALOG_FULL = () => String(process.env.ENRICHMENT_CATALOG_FULL || 'false') === 'true';

const CAPABILITIES = {
  'identity.domain.verify': {
    family: 'identity',
    tier: 'basic',
    enabled: true,
    entityType: ['prospect', 'company', 'domain'],
    timeoutMs: 15000,
    maxAttempts: 3,
    priority: 1,
    providers: ['dns.direct'],
    inputSchema: { domain: 'string' },
    expand: [
      { whenFact: 'company.domain_active', spawn: 'search.news' },
    ],
  },

  'identity.cnpj.basic': {
    family: 'identity',
    tier: 'basic',
    enabled: true,
    entityType: ['prospect', 'company'],
    timeoutMs: 20000,
    maxAttempts: 3,
    priority: 1,
    providers: ['brasilapi.cnpj'],
    inputSchema: { cnpj: 'string' },
    expand: [
      { whenFact: 'company.domain', spawn: 'identity.domain.verify' },
    ],
  },

  'company.digital_presence': {
    // QA 2026-10-07: extrai o WhatsApp do SITE da empresa (wa.me /
    // api.whatsapp.com) — o melhor número para disparo; o enrichment-manager
    // aplica na FRENTE de cnpjPhones. Basic: todos os planos precisam.
    // 2026-10-09 (caso MB): sem site, a descoberta multi-fonte varre snippets,
    // catálogo digital da loja e agregadores de link — mais lento, timeout 60s.
    family: 'company',
    tier: 'basic',
    enabled: true,
    entityType: ['prospect', 'company'],
    timeoutMs: 60000,
    maxAttempts: 2,
    priority: 2,
    providers: ['site.crawl'],
    inputSchema: {
      domain: { type: 'string', required: false },
      companyName: { type: 'string', required: false },
      tradeName: { type: 'string', required: false },
      state: { type: 'string', required: false },
    },
    expand: [],
  },

  'search.news': {
    family: 'search',
    tier: 'basic',
    enabled: true,
    entityType: ['prospect', 'company', 'person'],
    timeoutMs: 30000,
    maxAttempts: 2,
    priority: 2,
    providers: ['searxng'],
    inputSchema: { companyName: 'string', query: { type: 'string', required: false } },
    expand: [],
  },

  // ── Porte (Fase 11) — registradas, desligadas até a esteira migrar ────────
  'identity.cnpj.resolve': {
    // stage: 'port' — ver CATALOG_FULL acima
    family: 'identity',
    tier: 'basic',
    enabled: 'port',
    entityType: ['prospect', 'company'],
    timeoutMs: 60000,
    maxAttempts: 2,
    priority: 0,
    providers: ['searxng.rfb'],
    inputSchema: { companyName: 'string', city: { type: 'string', required: false }, state: { type: 'string', required: false } },
    expand: [
      { whenFact: 'company.cnpj', spawn: 'identity.cnpj.basic' },
      { whenFact: 'company.domain', spawn: 'identity.domain.verify' },
    ],
  },

  'search.legal': {
    // stage: 'port' — ver CATALOG_FULL acima
    family: 'search',
    tier: 'premium',
    enabled: 'port',
    entityType: ['prospect', 'company', 'person'],
    timeoutMs: 45000,
    maxAttempts: 2,
    priority: 2,
    providers: ['searxng'],
    inputSchema: { companyName: 'string', query: { type: 'string', required: false } },
    expand: [],
  },

  'company.profile.deep': {
    // stage: 'port' — ver CATALOG_FULL acima
    family: 'company',
    tier: 'premium',
    enabled: 'port',
    entityType: ['prospect', 'company'],
    timeoutMs: 90000,
    maxAttempts: 2,
    priority: 2,
    providers: ['pdl'],
    inputSchema: { companyName: 'string', website: { type: 'string', required: false }, domain: { type: 'string', required: false } },
    expand: [],
  },

  'company.logo': {
    // stage: 'port' — ver CATALOG_FULL acima
    family: 'company',
    tier: 'premium',
    enabled: 'port',
    entityType: ['prospect', 'company', 'domain'],
    timeoutMs: 15000,
    maxAttempts: 2,
    priority: 3,
    providers: ['google.favicon'],
    inputSchema: { domain: 'string' },
    expand: [],
  },

  'company.deepgraph': {
    // stage: 'port' — ver CATALOG_FULL acima
    family: 'company',
    tier: 'premium',
    enabled: 'port',
    entityType: ['prospect', 'company'],
    timeoutMs: 300000, // varredura OSINT profunda (worker Python) pode levar minutos
    maxAttempts: 2,
    priority: 1,
    providers: ['python.worker.graph'],
    inputSchema: { cnpj: { type: 'string', required: false }, companyName: 'string' },
    expand: [],
  },
};

// ── Registro de executores (preenchido pelos workers/*.js) ─────────────────
const EXECUTORS = new Map();

/** Workers registram suas implementações; runtime consulta por capability. */
function registerExecutors(map) {
  for (const [name, fn] of Object.entries(map)) {
    if (!CAPABILITIES[name]) throw new Error(`registerExecutors: capability desconhecida "${name}"`);
    EXECUTORS.set(name, fn);
  }
}

function getExecutor(name) {
  return EXECUTORS.get(name) || null;
}

// ── API de consulta (usada por manager, runtime e testes) ──────────────────

function getCapability(name) {
  const def = CAPABILITIES[name];
  if (!def) return null;
  const enabled = def.enabled === true || (def.enabled === 'port' && CATALOG_FULL());
  return { capability: name, ...def, enabled, validateInput: makeValidator(def.inputSchema) };
}

function listCapabilities() {
  return Object.keys(CAPABILITIES).map(getCapability);
}

/** Elegíveis para um plano: habilitadas + tier permitido (função pura — FR-030). */
function eligibleCapabilities({ plan = 'trial' } = {}) {
  return listCapabilities()
    .filter((c) => c.enabled)
    .filter((c) => c.tier === 'basic' || plan === 'premium')
    .map((c) => c.capability);
}

/** Famílias do catálogo INTEIRO (workers existem mesmo com capabilities
 *  desligadas até o porte — ex.: family company/company-deep.js). */
function capabilityFamilies() {
  return [...new Set(listCapabilities().map((c) => c.family))];
}

function validateCapabilityInput(name, input) {
  const def = getCapability(name);
  if (!def) return { ok: false, code: 'INVALID_INPUT', message: `capability desconhecida: ${name}` };
  return def.validateInput(input);
}

/** Regras de expansão de uma capability (clonadas — caller não muta o catálogo). */
function expandRulesFor(name) {
  const def = CAPABILITIES[name];
  return def && def.expand ? def.expand.map((r) => ({ ...r })) : [];
}

/** Mascaramento server-side de fatos (US3/FR-033): leitura de trial não
 *  expõe capabilities premium. Função pura — NÃO muta o input. */
function filterFactsForPlan(factsData, plan) {
  if (!factsData || !factsData.entities || plan === 'premium') return factsData;
  return {
    ...factsData,
    entities: factsData.entities.map((entity) => ({
      ...entity,
      capabilities: Object.fromEntries(
        Object.entries(entity.capabilities || {}).filter(([name]) => {
          const def = CAPABILITIES[name];
          return !def || def.tier === 'basic';
        })
      ),
    })),
  };
}

module.exports = {
  CAPABILITIES,
  filterFactsForPlan,
  getCapability,
  listCapabilities,
  eligibleCapabilities,
  capabilityFamilies,
  validateCapabilityInput,
  expandRulesFor,
  registerExecutors,
  getExecutor,
  makeValidator,
};
