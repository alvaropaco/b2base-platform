'use strict';

/**
 * studio/capture-service.js — captura de leads (Epic 2, FR7/FR8/FR9; D1/D2).
 *
 * Busca HÍBRIDA sobre a base própria (D1):
 *   - lexical: termos atômicos normalizados (`segmentService.termVariants`)
 *     consultando `Prospect.searchText` (Epic 1) — espinha dorsal, SEMPRE roda;
 *   - semântica: embedding da query + pgvector `<=>` sobre
 *     `Prospect.captureEmbedding` — ampliar recall e FALHAR PARA BAIXO
 *     (lexical-only) quando o gateway de embeddings não responde.
 *
 * Quando a base própria não atende (< mínimo configurável), fallback MCP CNPJ
 * (`mcp-cnpj.js`, NFR7): 1 `searchCompanies` por captura, dedupe por CNPJ
 * (P2002 → findFirst), prospects criados com proveniência 'mcp-cnpj' e dados
 * SÓ do MCP — zero invenção de contato (FR9/NFR3).
 *
 * D2: disponível para trial e premium — este serviço NUNCA chama
 * requirePremiumOrg; o teto é o limite diário conservador por org.
 *
 * Multi-tenancy: `orgId` em TODA query. Nada aqui depende de LLM generativo —
 * a query do vendedor é o input direto.
 */

const { termVariants } = require('./segment-service');
const { normalizeText, buildSearchText } = require('../search-text');
const { createEmbeddingsClient, toPgVector } = require('./ai/embeddings');
const mcpCnpj = require('../mcp-cnpj');

const CAPTURE_SOURCES = ['base-propria', 'mcp-cnpj'];
const DEFAULT_MIN_OWN = 20; // base própria abaixo disso → fallback MCP
const DEFAULT_DAILY_LIMIT = 200; // conservador por org/dia (D2)
const DEFAULT_LIMIT = 25; // candidatos devolvidos por captura
const LEXICAL_SCAN_CAP = 400; // teto de leitura da fase lexical (rank em memória)

// Fuso do PRODUTO (mesmo default do outreach-rate-limiter): o limite diário e
// o "quando libera" (meia-noite) do card prometem meia-noite DESTE fuso.
function productTimeZone() {
  return process.env.OUTREACH_TIMEZONE || 'America/Sao_Paulo';
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Offset (min) do fuso no instante dado (DST-safe, helper Intl padrão). */
function tzOffsetMinutes(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return (asUtc - utcMs) / 60_000;
}

/**
 * Início do dia NO FUSO DO PRODUTO (não o do servidor): o card promete
 * "meia-noite" — o contador precisa zerar na mesma meia-noite que o vendedor
 * entende. Devolve o instante (Date) da meia-noite local do fuso do produto.
 */
function startOfToday() {
  const tz = productTimeZone();
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // YYYY-MM-DD no fuso do produto
  const naiveUtc = Date.parse(`${day}T00:00:00Z`);
  return new Date(naiveUtc - tzOffsetMinutes(naiveUtc, tz) * 60_000);
}

/**
 * Busca vetorial REAL (produção): pgvector cosine `<=>` via $queryRaw
 * parametrizado — coluna `Unsupported` no Prisma, SQL é a única porta.
 * Nos testes o fake-prisma não suporta $queryRaw: esta função vive atrás de
 * dependência injetável (`vectorSearch` em overrides).
 */
function defaultVectorSearch(prisma) {
  return async function vectorSearch({ orgId, embedding, limit }) {
    const rows = await prisma.$queryRaw`
      SELECT id FROM "Prospect"
      WHERE "orgId" = ${orgId} AND "captureEmbedding" IS NOT NULL
      ORDER BY "captureEmbedding" OPERATOR(public.<=>) ${toPgVector(embedding)}::public.vector
      LIMIT ${limit}`;
    return rows.map((r) => String(r.id));
  };
}

/** Filtros estruturais opcionais do params, aplicados em memória (fake-safe). */
function matchesOptionalFilters(prospect, { state, city, cnae }) {
  // Opt-out/descartado NUNCA volta na captura (consentimento segue na
  // materialização/envio — aqui só evita re-oferecer lead descartado).
  if (String(prospect.status || '') === 'discarded') return false;
  if (state && normalizeText(prospect.state || '') !== normalizeText(String(state))) return false;
  if (city && !normalizeText(prospect.city || '').includes(normalizeText(String(city)))) return false;
  if (cnae && !normalizeText(prospect.industry || '').includes(normalizeText(String(cnae)))) return false;
  return true;
}

/** Score lexical simples: quantos termos atômicos o searchText casa. */
function lexicalScore(prospect, terms) {
  const text = normalizeText(prospect.searchText || [prospect.industry, prospect.companyName, prospect.tradeName].filter(Boolean).join(' '));
  if (!text) return 0;
  let score = 0;
  for (const term of terms) if (text.includes(term)) score += 1;
  return score;
}

function createCaptureService(prisma, deps = {}) {
  const embeddings = deps.embeddings || createEmbeddingsClient();
  const embedTexts = deps.embedTexts || embeddings.embedTexts;
  const vectorSearch = deps.vectorSearch || defaultVectorSearch(prisma);
  const mcp = deps.mcp || mcpCnpj;

  const minOwn = () => envInt('STUDIO_CAPTURE_MIN_OWN', DEFAULT_MIN_OWN);
  const dailyLimit = () => envInt('STUDIO_CAPTURE_DAILY_LIMIT', DEFAULT_DAILY_LIMIT);

  /**
   * Fase 1 — base própria (híbrida). Devolve { ids, mode }: ids ordenados por
   * score lexical (matches semânticos entram no fim, sem repetir); mode é
   * 'hybrid' quando a semântica rodou, 'lexical-only' quando indisponível.
   */
  async function searchOwnBase({ orgId, query, filters, limit }) {
    const terms = termVariants(query);
    // Lexical: OR dos termos atômicos no searchText (mesma normalização) —
    // tolerante a acento/grafia de graça (Epic 1). OR no topo mantém o fake
    // e o Prisma equivalentes.
    const lexicalRows = terms.length
      ? await prisma.prospect.findMany({
          where: { orgId, OR: terms.map((term) => ({ searchText: { contains: term } })) },
          // Ordem estável: sem orderBy, um subconjunto arbitrário entraria no
          // cap de varredura e a captura viraria loteria.
          orderBy: { createdAt: 'asc' },
          take: LEXICAL_SCAN_CAP,
        })
      : [];
    const byId = new Map();
    for (const row of lexicalRows) {
      if (matchesOptionalFilters(row, filters)) byId.set(row.id, row);
    }

    let mode = 'lexical-only';
    try {
      const vectors = await embedTexts([query]);
      if (Array.isArray(vectors) && vectors.length === 1 && Array.isArray(vectors[0])) {
        const semanticIds = await vectorSearch({ orgId, embedding: vectors[0], limit: Math.max(limit, 100) });
        const missing = semanticIds.filter((id) => !byId.has(id));
        if (missing.length > 0) {
          const rows = await prisma.prospect.findMany({ where: { orgId, id: { in: missing } } });
          for (const row of rows) {
            if (matchesOptionalFilters(row, filters)) byId.set(row.id, row);
          }
        }
        mode = 'hybrid';
      }
    } catch (err) {
      // NFR4 (erro visível): degradação lexical-only LOGADA com a causa —
      // nunca descartada.
      console.error('[capture] busca semântica indisponível — seguindo lexical-only:', err.message);
    }

    // Rank determinístico: matches lexicais primeiro (mais termos = mais
    // relevante), semântico-only no fim, ordem estável dentro do grupo.
    const ranked = [...byId.values()].sort((a, b) => lexicalScore(b, terms) - lexicalScore(a, terms));
    return { ids: ranked.slice(0, limit).map((r) => r.id), mode, scored: ranked.map((r) => r.id) };
  }

  /** Fase MCP — cria prospects SÓ com dados retornados pelo MCP. */
  async function createFromMcp({ orgId, query, filters, limit, room }) {
    const companies = await mcp.searchCompanies({
      query,
      state: filters.state,
      city: filters.city,
      cnae: filters.cnae,
      limit: Math.min(limit, 50), // clamp do próprio cliente MCP
    });
    const created = [];
    let duplicates = 0;
    let skipped = 0;
    for (const company of Array.isArray(companies) ? companies : []) {
      if (created.length >= room) break; // limite diário manda (conservador)
      // Baixada/suspensa NÃO vira lead (base ativa é a audiência utilizável).
      if (company && company.isActive === false) {
        skipped += 1;
        continue;
      }
      const digits = String((company && company.cnpj) || '').replace(/\D/g, '');
      const name = String((company && (company.legalName || company.tradeName)) || '').trim();
      // Zero invenção (FR9/NFR3): sem CNPJ (chave do dedupe) ou sem nome
      // NÃO vira lead — nem com campos parciais inventados de contorno.
      if (digits.length !== 14 || !name) {
        skipped += 1;
        continue;
      }
      const formatted = mcp.formatCnpj(digits);
      let existing = await prisma.prospect.findFirst({
        where: { orgId, OR: [{ cnpj: formatted }, { cnpj: digits }] },
      });
      if (!existing) {
        const data = {
          orgId,
          cnpj: formatted,
          companyName: name,
          tradeName: company.tradeName || null,
          industry: company.industry || null, // descrição CNAE do MCP
          city: company.city || null,
          state: company.state || null,
          cnpjEmail: company.email || null, // só se o MCP retornou
          status: 'prospect',
          captureSource: 'mcp-cnpj',
          searchText: buildSearchText({
            industry: company.industry,
            companyName: name,
            tradeName: company.tradeName,
          }),
        };
        try {
          created.push(await prisma.prospect.create({ data }));
        } catch (err) {
          if (err && err.code === 'P2002') {
            // Corrida (@@unique orgId+cnpj): o vencedor existe — dedupe, não erro.
            existing = await prisma.prospect.findFirst({
              where: { orgId, OR: [{ cnpj: formatted }, { cnpj: digits }] },
            });
          } else {
            throw err;
          }
        }
      }
      if (existing) duplicates += 1;
    }
    return { created, duplicates, skipped };
  }

  /**
   * Captura completa. Retorna resultado estruturado (o card vive no
   * chat-routes) — recusas são RESULTADO explicável, nunca exceção:
   *   { status: 'captured' | 'no_results' | 'refused' | 'limit_reached', ... }
   *
   * CONTADOR DO LIMITE (o card reporta o número que a contagem DB reproduz):
   * só leads NOVOS criados hoje (createdAt >= meia-noite do fuso do produto +
   * captureSource != null) consomem o limite. Marcação de lote `base-propria`
   * NÃO soma no contador (re-marca mantém createdAt antigo — a contagem
   * `createdAt >= hoje` não o reproduziria) — por isso o lote marcado é
   * CLAMPEADO ao `room` restante (conservador) e `capturedToday` do resultado
   * nunca inclui re-marcações.
   */
  async function captureLeads({ orgId, query, state, city, cnae, limit } = {}) {
    const q = String(query || '').trim();
    if (!q) {
      const err = new Error('capture_leads exige `query` (termo do setor).');
      err.code = 'INVALID_CAPTURE_QUERY';
      throw err;
    }
    const filters = { state: state ? String(state).trim() : null, city: city ? String(city).trim() : null, cnae: cnae ? String(cnae).trim() : null };
    const max = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 100);

    // Limite diário (FR9/D2): contagem de capturados do dia por org —
    // rows com proveniência + createdAt de hoje (índice orgId+captureSource+createdAt).
    const cap = dailyLimit();
    const startOfDay = startOfToday();
    const capturedToday = await prisma.prospect.count({
      where: { orgId, captureSource: { in: CAPTURE_SOURCES }, createdAt: { gte: startOfDay } },
    });
    console.log(`[capture] org=${orgId} capturados hoje=${capturedToday}/${cap}`);
    if (capturedToday >= cap) {
      return {
        status: 'limit_reached',
        capturedToday,
        dailyLimit: cap,
        whenUnblocks: 'meia-noite',
      };
    }
    const room = cap - capturedToday;

    // Fase 1 — base própria.
    const own = await searchOwnBase({ orgId, query: q, filters, limit: max });

    if (own.ids.length >= minOwn()) {
      // Lote marcado CLAMPEADO ao room restante — marcar mais do que o limite
      // permite seria contabilidade fictícia. `captureSource: null`: NUNCA
      // sobrescrever proveniência (auditoria LGPD).
      const markedIds = own.ids.slice(0, room);
      await prisma.prospect.updateMany({
        where: { orgId, id: { in: markedIds }, captureSource: null },
        data: { captureSource: 'base-propria' },
      });
      return {
        status: 'captured',
        query: q,
        source: 'base-propria',
        mode: own.mode,
        baseOwnCount: own.ids.length,
        mcpCount: 0,
        duplicates: 0,
        prospectIds: own.ids,
        // RE-CONTAGEM: o card reporta o número que a contagem DB reproduz
        // EXATAMENTE (marcação de lead antigo não muda createdAt — não soma).
        capturedToday: await prisma.prospect.count({
          where: { orgId, captureSource: { in: CAPTURE_SOURCES }, createdAt: { gte: startOfDay } },
        }),
        dailyLimit: cap,
      };
    }

    // Fase 2 — fallback MCP (a base não atende o mínimo próprio).
    if (!mcp.isMcpConfigured()) {
      // QA 2026-10-02 (diretiva do dono: "sempre que eu falar pra adicionar
      // leads, ela faz"): MCP indisponível NUNCA esconde o que a base própria
      // JÁ encontrou — entrega o lote próprio com proveniência. Recusa ZERO
      // (explicável, sem inventar leads — FR9) só quando não achou NADA.
      if (own.ids.length > 0) {
        const markedIds = own.ids.slice(0, room);
        await prisma.prospect.updateMany({
          where: { orgId, id: { in: markedIds }, captureSource: null },
          data: { captureSource: 'base-propria' },
        });
        return {
          status: 'captured',
          query: q,
          source: 'base-propria',
          mode: own.mode,
          baseOwnCount: own.ids.length,
          mcpCount: 0,
          duplicates: 0,
          prospectIds: own.ids,
          mcpAvailable: false,
          capturedToday: await prisma.prospect.count({
            where: { orgId, captureSource: { in: CAPTURE_SOURCES }, createdAt: { gte: startOfDay } },
          }),
          dailyLimit: cap,
        };
      }
      return {
        status: 'refused',
        reason: 'mcp_not_configured',
        mode: own.mode,
        ownCount: own.ids.length,
        minOwn: minOwn(),
      };
    }
    try {
      const mcpResult = await createFromMcp({
        orgId,
        query: q,
        filters,
        limit: Math.min(max, 50),
        room,
      });
      // Lote da base própria também entra com proveniência — clamped ao que
      // sobrou do room e SEM sobrescrever proveniência existente.
      if (own.ids.length > 0) {
        const ownRoom = Math.max(0, room - mcpResult.created.length);
        await prisma.prospect.updateMany({
          where: { orgId, id: { in: own.ids.slice(0, ownRoom) }, captureSource: null },
          data: { captureSource: 'base-propria' },
        });
      }
      const createdIds = mcpResult.created.map((p) => p.id);
      const prospectIds = [...own.ids, ...createdIds];
      if (prospectIds.length === 0) {
        // MCP consultado mas só trouxe duplicados/inválidos/nada — zero-framing.
        return {
          status: 'no_results',
          query: q,
          mode: own.mode,
          baseOwnCount: 0,
          mcpCount: 0,
          duplicates: mcpResult.duplicates,
          skippedInvalid: mcpResult.skipped,
          capturedToday,
          dailyLimit: cap,
        };
      }
      return {
        status: 'captured',
        query: q,
        source: 'mcp-cnpj',
        mode: own.mode,
        baseOwnCount: own.ids.length,
        mcpCount: createdIds.length,
        duplicates: mcpResult.duplicates,
        skippedInvalid: mcpResult.skipped,
        prospectIds,
        // RE-CONTAGEM: o card reporta o número que a contagem DB reproduz
        // EXATAMENTE (leads criados agora têm createdAt de hoje — somam).
        capturedToday: await prisma.prospect.count({
          where: { orgId, captureSource: { in: CAPTURE_SOURCES }, createdAt: { gte: startOfDay } },
        }),
        dailyLimit: cap,
      };
    } catch (err) {
      // Erro do MCP: recusa explicável — NENHUM lead criado, causa logada (NFR4).
      console.error('[capture] MCP CNPJ falhou — recusa explicável:', err.stack || String(err));
      return {
        status: 'refused',
        reason: 'mcp_error',
        mode: own.mode,
        ownCount: own.ids.length,
        minOwn: minOwn(),
        message: String(err.message || err),
      };
    }
  }

  return { captureLeads, searchOwnBase, createFromMcp, minOwn, dailyLimit };
}

module.exports = {
  createCaptureService,
  defaultVectorSearch,
  toPgVector,
  CAPTURE_SOURCES,
  DEFAULT_MIN_OWN,
  DEFAULT_DAILY_LIMIT,
  DEFAULT_LIMIT,
};
