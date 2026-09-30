'use strict';

/**
 * jobs/embeddings-backfill.js — backfill idempotente/resumável dos embeddings
 * de captura (Epic 2, FR7/D1).
 *
 * MESMO padrão do `cnpj-data-publisher` (processing/embedder.py): só linhas
 * com `captureEmbedding IS NULL` entram no lote, então re-executar CONTINUA de
 * onde parou (resumável) e o resultado é o mesmo (idempotente). Roda no boot
 * com teto por execução (fire-and-forget, não fatal — padrão sanitize-legacy
 * do server-prod.js); desabilitar com STUDIO_EMBEDDINGS_BACKFILL=off.
 *
 * A coluna vetorial é `Unsupported` no Prisma: leitura e escrita SEMPRE via
 * $queryRaw/$executeRaw parametrizado (a forma texto do pgvector é
 * `[v1,v2,...]` — toPgVector, embedder.py::_to_pgvector).
 */

const { createEmbeddingsClient, toPgVector } = require('../studio/ai/embeddings');

const DEFAULT_BATCH = 128; // publisher: EMBEDDING_BATCH_SIZE
const DEFAULT_MAX_ROWS_PER_RUN = 500; // teto por boot — o próximo boot retoma

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Executa um passe do backfill. Retorna { skipped } quando o cliente de
 * embeddings está desabilitado (sem LITELLM_URL — nada a fazer, captura segue
 * lexical-only), { embedded, stuckIds } quando o MESMO lote falha 2× seguidas
 * (o passe ENCERRA com log — jogar o erro mataria o boot forever e o cursor
 * nunca avançaria), senão { embedded, pending, done }.
 */
async function runEmbeddingsBackfill(prisma, { batchSize, maxRows, embeddings: embeddingsDep } = {}) {
  const embeddings = embeddingsDep || createEmbeddingsClient();
  if (!embeddings.isConfigured()) {
    return { skipped: true, reason: 'embeddings_not_configured' };
  }
  const batch = Math.min(Number(batchSize) > 0 ? Number(batchSize) : envInt('STUDIO_EMBEDDING_BACKFILL_BATCH', DEFAULT_BATCH), 128);
  const cap = Number(maxRows) > 0 ? Number(maxRows) : envInt('STUDIO_EMBEDDING_BACKFILL_MAX_ROWS', DEFAULT_MAX_ROWS_PER_RUN);

  let embedded = 0;
  let stuckIds = null;
  while (embedded < cap) {
    // Só NULL e texto utilizável — reexecução nunca reprocessa (resumável) e
    // o alinhamento texto↔vetor do lote é garantido (searchText não vazio).
    const rows = await prisma.$queryRaw`
      SELECT id, "searchText" FROM "Prospect"
      WHERE "captureEmbedding" IS NULL
        AND "searchText" IS NOT NULL AND length(trim("searchText")) > 0
      ORDER BY "createdAt"
      LIMIT ${Math.min(batch, cap - embedded)}`;
    if (!rows.length) break;
    let vectors;
    try {
      vectors = await embeddings.embedTexts(rows.map((r) => r.searchText));
      if (!Array.isArray(vectors) || vectors.length !== rows.length) {
        const err = new Error(`backfill: embeddings desalinhados (${vectors && vectors.length} vetores para ${rows.length} linhas)`);
        err.code = 'EMBEDDINGS_SHAPE';
        throw err;
      }
    } catch (err) {
      const ids = rows.map((r) => String(r.id));
      if (stuckIds && stuckIds.length === ids.length && stuckIds.every((id, i) => id === ids[i])) {
        // MESMO lote falhou 2× seguidas: encerra o passe (o próximo boot
        // retoma) — nunca re-selecionar o mesmo lote NULL para sempre.
        console.error(`[embeddings-backfill] mesmo lote falhou 2× — encerrando o passe (${ids.length} linha(s) travada(s)):`, err.message);
        return { embedded, stuckIds: ids };
      }
      console.error('[embeddings-backfill] lote falhou — 1 tentativa restante antes de encerrar:', err.message);
      stuckIds = ids;
      continue; // re-seleciona: as linhas seguem NULL → MESMO lote volta
    }
    stuckIds = null;
    for (let i = 0; i < rows.length; i += 1) {
      // Guarda IS NULL no WHERE: corrida com outra execução não reescreve.
      await prisma.$executeRaw`
        UPDATE "Prospect" SET "captureEmbedding" = ${toPgVector(vectors[i])}::vector
        WHERE id = ${rows[i].id} AND "captureEmbedding" IS NULL`;
      embedded += 1;
    }
  }
  const [{ pending }] = await prisma.$queryRaw`
    SELECT count(*)::int AS pending FROM "Prospect"
    WHERE "captureEmbedding" IS NULL AND "searchText" IS NOT NULL AND length(trim("searchText")) > 0`;
  return { embedded, pending: Number(pending), done: Number(pending) === 0 };
}

module.exports = { runEmbeddingsBackfill };
