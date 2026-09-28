// =============================================================================
// test/helpers/fake-prisma.js — fake in-memory do Prisma para os testes do
// motor de enriquecimento (estilo DI de test/lead-enrichment.test.js).
// Suporta apenas as operações que o motor usa, com matching por igualdade.
// =============================================================================

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function matches(record, where = {}) {
  // OR no topo (Prisma): algum dos ramos precisa casar.
  if (where.OR && Array.isArray(where.OR)) {
    const rest = { ...where };
    delete rest.OR;
    if (!where.OR.some((branch) => matches(record, branch))) return false;
    if (Object.keys(rest).length === 0) return true;
    return matches(record, rest);
  }
  // AND no topo (Prisma): todos os ramos precisam casar.
  if (where.AND && Array.isArray(where.AND)) {
    const rest = { ...where };
    delete rest.AND;
    if (!where.AND.every((branch) => matches(record, branch))) return false;
    if (Object.keys(rest).length === 0) return true;
    return matches(record, rest);
  }
  return Object.entries(where).every(([field, expected]) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      // Operadores do Prisma suportados pelo fake: { lt, lte, gt, gte, in, contains, equals }
      if ('in' in expected) return expected.in.includes(record[field]);
      if ('notIn' in expected) return !expected.notIn.includes(record[field]);
      if ('contains' in expected) {
        return String(record[field] ?? '')
          .toLowerCase()
          .includes(String(expected.contains).toLowerCase());
      }
      if ('equals' in expected) return record[field] === expected.equals;
      if ('array_contains' in expected) {
        const v = record[field];
        return Array.isArray(v) ? v.includes(expected.array_contains) : false;
      }
      // Comparação numérica quando o limite é número; data caso contrário.
      const coerce = (v) => (typeof v === 'number' ? Number(v) : new Date(v));
      if ('lt' in expected) return coerce(record[field]) < coerce(expected.lt);
      if ('lte' in expected) return coerce(record[field]) <= coerce(expected.lte);
      if ('gt' in expected) return coerce(record[field]) > coerce(expected.gt);
      if ('gte' in expected) return coerce(record[field]) >= coerce(expected.gte);
      return matches(record[field] || {}, expected);
    }
    // Coluna nullable nunca setada é `null` no Prisma real (undefined aqui)
    if (expected === null) return record[field] == null;
    return record[field] === expected;
  });
}

function applyData(record, data) {
  // Operadores numéricos do Prisma: { increment: n } / { decrement: n }
  for (const [field, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('increment' in value) {
        record[field] = (Number(record[field]) || 0) + Number(value.increment);
        continue;
      }
      if ('decrement' in value) {
        record[field] = (Number(record[field]) || 0) - Number(value.decrement);
        continue;
      }
    }
    record[field] = value;
  }
  record.updatedAt = new Date();
  return record;
}

/** Cria um model fake com as operações usadas pelo motor. */
function makeModel(name, uniqueFields = [], compositeUniques = []) {
  const rows = [];
  function assertUniques(data) {
    // Impõe @unique (006): duplicata → P2002, como no Prisma real.
    for (const field of uniqueFields) {
      const v = data[field];
      if (v != null && rows.some((r) => r[field] === v)) {
        const err = new Error(`fake-prisma: ${name}.${field} único violado (${v})`);
        err.code = 'P2002';
        throw err;
      }
    }
    // Impõe @@unique([...]) compostos (specs/011): (type, refId) do ledger,
    // actionKey de StudioActionRun, orgId+channel do saldo, consentimento.
    for (const composite of compositeUniques) {
      if (composite.some((f) => data[f] == null)) continue; // NULL não conflita (Postgres)
      const key = composite.map((f) => data[f]).join('\u0000');
      const dup = rows.some((r) => composite.every((f) => r[f] === data[f]));
      if (dup) {
        const err = new Error(`fake-prisma: ${name}.@@unique(${composite.join(', ')}) violado (${key.slice(0, 40)})`);
        err.code = 'P2002';
        throw err;
      }
    }
  }
  const model = {
    rows,
    async create({ data }) {
      assertUniques(data);
      const row = { id: data.id || makeId(name.slice(0, 3)) };
      rows.push(row);
      // Defaults do Prisma real: createdAt/updatedAt existem em toda linha.
      return applyData(row, { createdAt: new Date(), ...data });
    },
    async findUnique({ where }) {
      const field = Object.keys(where)[0];
      const key = Object.values(where)[0];
      // Where composto (@@unique "a_b"): { orgId_name: { orgId, name } }.
      if (key && typeof key === 'object' && !Array.isArray(key)) {
        const fields = field.split('_');
        return rows.find((r) => fields.every((f) => r[f] === key[f])) || null;
      }
      return rows.find((r) => r[field] === key) || null;
    },
    async findFirst({ where = {}, orderBy } = {}) {
      let found = rows.filter((r) => matches(r, where));
      if (orderBy && orderBy.createdAt === 'desc') {
        found = [...found].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      }
      return found[0] || null;
    },
    async findMany({ where = {}, orderBy, take } = {}) {
      let found = rows.filter((r) => matches(r, where));
      if (orderBy && orderBy.createdAt === 'desc') {
        found = [...found].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      }
      return take != null ? found.slice(0, Math.max(0, Number(take))) : found;
    },
    async update({ where, data }) {
      const key = Object.values(where)[0];
      const field = Object.keys(where)[0];
      const row = rows.find((r) => r[field] === key);
      if (!row) throw new Error(`fake-prisma: ${name} não encontrado para update (${field}=${key})`);
      return applyData(row, data);
    },
    async upsert({ where, create, update }) {
      const key = Object.values(where)[0];
      const field = Object.keys(where)[0];
      const existing = rows.find((r) => r[field] === key);
      if (existing) return model.update({ where, data: update });
      return model.create({ data: { ...create, [field]: key } });
    },
    async updateMany({ where = {}, data }) {
      const matched = rows.filter((r) => matches(r, where));
      for (const r of matched) applyData(r, data);
      return { count: matched.length };
    },
    async createMany({ data }) {
      for (const item of data) await model.create({ data: item });
      return { count: data.length };
    },
    async count({ where = {} } = {}) {
      return rows.filter((r) => matches(r, where)).length;
    },
    async deleteMany({ where = {} } = {}) {
      const before = rows.length;
      for (const r of rows.filter((x) => matches(x, where))) {
        rows.splice(rows.indexOf(r), 1);
      }
      return { count: before - rows.length };
    },
  };
  return model;
}

function createFakePrisma() {
  return {
    organization: makeModel('organization'),
    user: makeModel('user'),
    activity: makeModel('activity'),
    prospect: makeModel('prospect'),
    // Campaign Studio (specs/010) — modelos do Studio + execuções de canal
    studioCampaign: makeModel('studioCampaign'),
    studioSegment: makeModel('studioSegment', [], [['orgId', 'name']]),
    studioAudienceSnapshot: makeModel('studioAudienceSnapshot'),
    studioAudienceMember: makeModel('studioAudienceMember'),
    studioContent: makeModel('studioContent'),
    studioMaterial: makeModel('studioMaterial'),
    studioPersonalization: makeModel('studioPersonalization'),
    studioJourney: makeModel('studioJourney'),
    studioJourneyLead: makeModel('studioJourneyLead'),
    studioExperiment: makeModel('studioExperiment'),
    studioBrandProfile: makeModel('studioBrandProfile'),
    studioComplianceReview: makeModel('studioComplianceReview'),
    studioReplyClassification: makeModel('studioReplyClassification'),
    studioMetricDaily: makeModel('studioMetricDaily', ['campaignId_day_channel_variantLabel_stepIndex']),
    studioAgentProposal: makeModel('studioAgentProposal'),
    studioRecommendation: makeModel('studioRecommendation'),
    studioTemplate: makeModel('studioTemplate'),
    studioChatMessage: makeModel('studioChatMessage'),
    studioChatTrace: makeModel('studioChatTrace'),
    // Campaign Studio Cockpit (specs/011) — orçamento de reputação, actions
    // idempotentes e consentimento WhatsApp (unique composto no ledger).
    studioReputationAccount: makeModel('studioReputationAccount', [], [['orgId', 'channel']]),
    studioReputationEvent: makeModel('studioReputationEvent', [], [['type', 'refId']]),
    studioActionRun: makeModel('studioActionRun', ['actionKey']),
    studioLeadConsent: makeModel('studioLeadConsent', [], [['orgId', 'prospectId', 'channel']]),
    outreachCampaign: makeModel('outreachCampaign'),
    outreachContact: makeModel('outreachContact'),
    outreachMessage: makeModel('outreachMessage'),
    outreachEvent: makeModel('outreachEvent'),
    outreachTemplate: makeModel('outreachTemplate'),
    whatsappCampaign: makeModel('whatsappCampaign'),
    whatsappSequenceStep: makeModel('whatsappSequenceStep'),
    whatsappCampaignContact: makeModel('whatsappCampaignContact'),
    suppressionList: makeModel('suppressionList'),
    leadChannelState: makeModel('leadChannelState'),
    emailAccount: makeModel('emailAccount'),
    whatsappAccount: makeModel('whatsappAccount'),
    deepAnalysis: makeModel('deepAnalysis'),
    commercialSettings: makeModel('commercialSettings'),
    enrichmentTaskRetryEvent: makeModel('enrichmentTaskRetryEvent'),
    opsNotification: makeModel('opsNotification', ['dedupKey']),
    enrichmentJob: makeModel('enrichmentJob'),
    enrichmentTask: makeModel('enrichmentTask'),
    enrichmentResult: makeModel('enrichmentResult'),
    enrichmentEvidence: makeModel('enrichmentEvidence'),
    rawRecord: makeModel('rawRecord'),
    // Contratos legados (worker Python / ponte deepgraph)
    enrichmentRequest: makeModel('enrichmentRequest'),
    cnpjEnrichment: makeModel('cnpjEnrichment'),
    // Discovery Engine (specs/006-discovery-engine)
    discoveryJob: makeModel('discoveryJob'),
    discoveryProviderRun: makeModel('discoveryProviderRun'),
    discoveryEntity: makeModel('discoveryEntity'),
    discoveryRelationship: makeModel('discoveryRelationship'),
    discoveryEvidence: makeModel('discoveryEvidence'),
    discoveryCandidate: makeModel('discoveryCandidate'),
    discoverySignal: makeModel('discoverySignal'),
  };
}

/** Bus fake do JetStream: captura publicações para asserção. */
function createFakeJs() {
  const published = [];
  return {
    published,
    async publish(subject, data, opts) {
      published.push({ subject, data, opts, at: published.length });
      return { seq: published.length };
    },
  };
}

/** Mensagem fake no formato que o runtime consome (interface ack/nak/term). */
function createFakeMessage(payload, { trace = [] } = {}) {
  const contracts = require('../../enrichment-contracts');
  const msg = {
    data: contracts.serializePayload(payload),
    ack: async () => trace.push('ack'),
    nak: async (delay) => trace.push(['nak', delay]),
    term: async () => trace.push('term'),
  };
  msg.trace = trace;
  return msg;
}

module.exports = { createFakePrisma, createFakeJs, createFakeMessage, makeId };
