const BRASIL_API_BASE_URL = 'https://brasilapi.com.br/api/cnpj/v1';
// Feature 005: roteamento do card pós-enriquecimento (premium → Análise profunda).
const { getOrgPlan } = require('./plan');
const pipelineTransitions = require('./pipeline-transitions');
// Epic 1 (FR4): searchText normalizado do Prospect mantido no enriquecimento.
const { withSearchText } = require('./search-text');

function normalizeCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '');
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')
  );
}

function extractPhones(data) {
  return [
    data.ddd_telefone_1,
    data.ddd_telefone_2,
    data.telefone,
  ]
    .filter(Boolean)
    .map((phone) => String(phone).trim())
    .filter((phone, index, arr) => phone && arr.indexOf(phone) === index);
}

function extractPartners(data) {
  const qsa = Array.isArray(data.qsa) ? data.qsa : [];
  return qsa.map((partner) => compactObject({
    name: partner.nome_socio || partner.nome || partner.nome_representante_legal,
    qualification: partner.qualificacao_socio || partner.qualificacao || partner.qualificacao_representante_legal,
    country: partner.pais,
    ageRange: partner.faixa_etaria,
    joinedAt: partner.data_entrada_sociedade,
  }));
}

function mapBrasilApiPayload(data) {
  const phones = extractPhones(data);
  const partners = extractPartners(data);

  return {
    companyName: data.razao_social || data.nome_fantasia || undefined,
    tradeName: data.nome_fantasia || undefined,
    industry: data.cnae_fiscal_descricao || data.descricao_tipo_de_logradouro || undefined,
    cnpjEmail: data.email || undefined,
    cnpjPhones: phones,
    cnpjPartners: partners,
    cnpjRawData: data,
    cnpjOpenedAt: parseDate(data.data_inicio_atividade),
    cnpjLegalNature: data.natureza_juridica || undefined,
    enrichmentStatus: 'enriched',
    enrichmentSource: 'brasilapi.cnpj.v1',
    enrichmentError: null,
    enrichedAt: new Date(),
  };
}

async function fetchBrasilApiCnpj(cnpj) {
  const normalized = normalizeCnpj(cnpj);
  if (normalized.length !== 14) {
    throw new Error('Invalid CNPJ. Expected 14 digits.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${BRASIL_API_BASE_URL}/${normalized}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'B2Base-Platform/1.0 (+https://localhost)',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return { found: false, status: 'unavailable', error: 'CNPJ not found in BrasilAPI' };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`BrasilAPI CNPJ lookup failed: HTTP ${response.status} ${body.slice(0, 160)}`);
    }

    return { found: true, data: await response.json() };
  } finally {
    clearTimeout(timeout);
  }
}

async function enrichProspectWithCnpj(prisma, prospectOrId) {
  const prospect = typeof prospectOrId === 'string'
    ? await prisma.prospect.findUnique({ where: { id: prospectOrId } })
    : prospectOrId;

  if (!prospect) {
    throw new Error('Prospect not found for enrichment');
  }
  try {
    const lookup = await fetchBrasilApiCnpj(prospect.cnpj);

    if (!lookup.found) {
      await prisma.prospect.update({
        where: { id: prospect.id },
        data: {
          enrichmentStatus: lookup.status,
          enrichmentSource: 'brasilapi.cnpj.v1',
          enrichmentError: lookup.error,
          enrichedAt: new Date(),
        },
      });
      // Sem dados do CNPJ: pontua com os sinais disponíveis.
      const { recalcLeadScore } = require('./opportunity-score');
      const fresh = await prisma.prospect.findUnique({ where: { id: prospect.id } });
      return recalcLeadScore(prisma, fresh);
    }

    const enrichment = mapBrasilApiPayload(lookup.data);

    // Scoring real do lead (0–100). Só quando a esteira NATS ainda não
    // pontuou este prospect — o `commercial_potential` do pipeline externo
    // tem precedência e nunca é sobrescrito pelo fallback.
    let opportunityScore;
    if (prospect.enrichmentSource !== 'nats.enrichment') {
      const { computeOpportunityScore } = require('./opportunity-score');
      const profile = await prisma.commercialSettings
        .findUnique({ where: { orgId: prospect.orgId } })
        .catch(() => null);
      const mergedProspect = { ...prospect, industry: enrichment.industry || prospect.industry };
      opportunityScore = computeOpportunityScore({
        cnpjData: lookup.data,
        prospect: mergedProspect,
        profile,
      }).score;
    }

    const data = compactObject({
      companyName: enrichment.companyName || prospect.companyName,
      tradeName: enrichment.tradeName,
      industry: enrichment.industry || prospect.industry,
      cnpjEmail: enrichment.cnpjEmail,
      cnpjPhones: enrichment.cnpjPhones,
      cnpjPartners: enrichment.cnpjPartners,
      cnpjRawData: enrichment.cnpjRawData,
      cnpjOpenedAt: enrichment.cnpjOpenedAt,
      cnpjLegalNature: enrichment.cnpjLegalNature,
      ...(opportunityScore != null ? { opportunityScore } : {}),
      enrichmentStatus: enrichment.enrichmentStatus,
      enrichmentSource: enrichment.enrichmentSource,
      enrichedAt: enrichment.enrichedAt,
    });
    data.enrichmentError = null;
    // Epic 1 (FR4): o enriquecimento gravou identidade/setor — searchText
    // recalculado da LINHA FINAL (patch ∪ linha) para o matching de segmento.
    Object.assign(data, withSearchText(data, prospect));

    // Feature 005: premium pousa em "Análise profunda" (análise de IA dispara
    // no gatilho de entrada do estágio); demais planos seguem para "Prontas
    // para contato" como antes.
    const nextStatus = pipelineTransitions.statusAfterEnrichment(
      // Status PÓS-conclusão (o update abaixo grava data.enrichmentStatus).
      { ...prospect, enrichmentStatus: enrichment.enrichmentStatus || 'enriched' },
      await getOrgPlan(prisma, prospect.orgId)
    );
    const updated = await prisma.prospect.update({
      where: { id: prospect.id },
      data: {
        ...data,
        ...(nextStatus
          ? {
              status: nextStatus,
              ...(nextStatus === 'deep_analysis' ? { analysisStatus: 'not_started' } : {}),
            }
          : {}),
      },
    });

    // Feature 005: card pousou em "Análise profunda" (premium) — dispara a
    // análise de IA. Fire-and-forget: falha aqui não afeta o enriquecimento.
    if (nextStatus === 'deep_analysis') {
      try {
        const runner = require('./deep-analysis').getSharedRunner(prisma);
        const enqueued = await runner.enqueue(updated, { trigger: 'auto' });
        if (enqueued.started) enqueued.done.catch(() => {});
      } catch (analysisErr) {
        console.error('[deep-analysis] gatilho pós-enriquecimento falhou:', analysisErr.message);
      }
    }

    // Suíte multicanal: dispara campanhas configuradas com gatilho
    // pós-enriquecimento (email/WhatsApp). Fire-and-forget — falha aqui
    // nunca derruba o fluxo de enriquecimento.
    require('./campaign-suite')
      .onLeadEnriched(prisma, updated)
      .catch((err) => console.error('[suite] erro pós-enriquecimento:', err.message));

    return updated;
  } catch (error) {
    return prisma.prospect.update({
      where: { id: prospect.id },
      data: {
        enrichmentStatus: 'error',
        enrichmentSource: 'brasilapi.cnpj.v1',
        enrichmentError: error.message,
        enrichedAt: new Date(),
      },
    });
  }
}

function buildEnrichmentWhere({ from, to, status, orgId } = {}) {
  const where = {};

  if (orgId) {
    where.orgId = orgId;
  }

  if (from || to) {
    where.enrichedAt = {};
    if (from) {
      where.enrichedAt.gte = /^\d{4}-\d{2}-\d{2}$/.test(String(from))
        ? new Date(`${from}T00:00:00.000Z`)
        : new Date(from);
    }
    if (to) {
      where.enrichedAt.lte = /^\d{4}-\d{2}-\d{2}$/.test(String(to))
        ? new Date(`${to}T23:59:59.999Z`)
        : new Date(to);
    }
  }

  if (status && status !== 'all') {
    where.enrichmentStatus = status;
  }

  return where;
}

function formatEnrichedProspect(prospect) {
  return {
    id: prospect.id,
    cnpj: prospect.cnpj,
    companyName: prospect.companyName,
    tradeName: prospect.tradeName,
    industry: prospect.industry,
    status: prospect.status,
    opportunityScore: prospect.opportunityScore,
    email: prospect.cnpjEmail,
    phones: Array.isArray(prospect.cnpjPhones) ? prospect.cnpjPhones : [],
    partners: Array.isArray(prospect.cnpjPartners) ? prospect.cnpjPartners : [],
    openedAt: prospect.cnpjOpenedAt,
    legalNature: prospect.cnpjLegalNature,
    enrichmentStatus: prospect.enrichmentStatus,
    enrichmentSource: prospect.enrichmentSource,
    enrichmentError: prospect.enrichmentError,
    enrichedAt: prospect.enrichedAt,
    createdAt: prospect.createdAt,
  };
}

async function listEnrichedProspects(prisma, filters = {}) {
  const prospects = await prisma.prospect.findMany({
    where: buildEnrichmentWhere(filters),
    orderBy: { enrichedAt: 'desc' },
  });

  return prospects.map(formatEnrichedProspect);
}

module.exports = {
  normalizeCnpj,
  fetchBrasilApiCnpj,
  enrichProspectWithCnpj,
  hydrateFirmographics,
  listEnrichedProspects,
  formatEnrichedProspect,
};

// Hidrata apenas a firmografia (razão social, nome fantasia, e-mail, telefones,
// sócios, natureza jurídica, abertura, cidade/UF) via BrasilAPI, SEM tocar em
// enrichmentStatus/enrichmentSource/enrichmentVersion/opportunityScore — esses
// pertencem à esteira NATS (scoring). Usado como complemento ao pipeline.
async function hydrateFirmographics(prisma, prospectOrId) {
  const prospect = typeof prospectOrId === 'string'
    ? await prisma.prospect.findUnique({ where: { id: prospectOrId } })
    : prospectOrId;

  if (!prospect) return null;

  try {
    const lookup = await fetchBrasilApiCnpj(prospect.cnpj);
    if (!lookup.found) return prospect;

    const data = lookup.data;
    const phones = extractPhones(data);
    const partners = extractPartners(data);

    const merge = (current, incoming) => {
      if (current === null || current === undefined || current === '' || current === false) {
        return incoming;
      }
      return current;
    };

    const hasCurrentPhones = Array.isArray(prospect.cnpjPhones) && prospect.cnpjPhones.length > 0;
    const hasCurrentPartners = Array.isArray(prospect.cnpjPartners) && prospect.cnpjPartners.length > 0;

    const update = compactObject({
      companyName: merge(prospect.companyName, data.razao_social || data.nome_fantasia),
      tradeName: merge(prospect.tradeName, data.nome_fantasia),
      industry: merge(prospect.industry, data.cnae_fiscal_descricao),
      city: merge(prospect.city, data.municipio),
      state: merge(prospect.state, data.uf),
      cnpjEmail: merge(prospect.cnpjEmail, data.email),
      cnpjOpenedAt: merge(prospect.cnpjOpenedAt, parseDate(data.data_inicio_atividade)),
      cnpjLegalNature: merge(prospect.cnpjLegalNature, data.natureza_juridica),
      cnpjRawData: merge(prospect.cnpjRawData, data),
    });

    if (!hasCurrentPhones && phones.length > 0) update.cnpjPhones = phones;
    if (!hasCurrentPartners && partners.length > 0) update.cnpjPartners = partners;

    if (Object.keys(update).length === 0) return prospect;

    return prisma.prospect.update({
      where: { id: prospect.id },
      data: update,
    });
  } catch (error) {
    console.error(`[firmographics] falha ao hidratar ${prospect.id}: ${error.message}`);
    return prospect;
  }
}
