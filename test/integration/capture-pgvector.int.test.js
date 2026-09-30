// Teste de integração opt-in do pgvector da captura (Epic 2, FR7/D1).
// Só roda com um Postgres COM pgvector apontado por CAPTURE_PGVECTOR_DATABASE_URL
// (ex.: postgresql://user:pass@localhost:5432/b2base_pgvector_test); sem a env,
// pula automaticamente — a suíte de unidades (fake-prisma) cobre o resto.
//
// O que valida (SQL REAL, nunca executado nos testes de unidade):
//   1. a migração 20260930133000_prospect_capture_hybrid aplica limpa
//      (CREATE EXTENSION vector + colunas + índice);
//   2. round-trip do pgvector: linha com searchText → backfill escreve o
//      vetor (forma texto `[v1,v2,...]` cast ::vector) → defaultVectorSearch
//      encontra o id por `<=>` (cosine).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DATABASE_URL = process.env.CAPTURE_PGVECTOR_DATABASE_URL;
const MIGRATION = path.join(
  __dirname, '..', '..', 'prisma', 'migrations', '20260930133000_prospect_capture_hybrid', 'migration.sql'
);

/** Stub de prisma com $queryRaw/$executeRaw sobre o Client real do pg. */
function pgPrismaAdapter(client) {
  const toSql = (strings) => strings.reduce(
    (sql, piece, i) => (i === 0 ? piece : `${sql}$${i}${piece}`),
    ''
  );
  return {
    async $queryRaw(strings, ...values) {
      const res = await client.query(toSql(strings), values);
      return res.rows;
    },
    async $executeRaw(strings, ...values) {
      const res = await client.query(toSql(strings), values);
      return res.rowCount;
    },
  };
}

test('captura: migração pgvector aplica e defaultVectorSearch/backfill fazem round-trip', { skip: !DATABASE_URL && 'CAPTURE_PGVECTOR_DATABASE_URL ausente' }, async () => {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    // Mesa mínima com as colunas que a migração e o caminho de captura tocam —
    // o resto do Prospect não participa do SQL vetorial.
    await client.query(`
      DROP TABLE IF EXISTS "Prospect";
      CREATE TABLE "Prospect" (
        id TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "searchText" TEXT,
        "captureSource" TEXT
      );
    `);

    // 1) A migração aplica limpa (extensão + colunas + índice).
    const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
    await client.query(migrationSql);
    const cols = await client.query(`
      SELECT column_name, udt_name FROM information_schema.columns
      WHERE table_name = 'Prospect' AND column_name IN ('captureSource', 'captureEmbedding')
      ORDER BY column_name`);
    assert.deepEqual(cols.rows.map((r) => [r.column_name, r.udt_name]).sort(), [
      ['captureEmbedding', 'vector'],
      ['captureSource', 'text'],
    ]);

    // 2) Linha com searchText e vetor NULL → backfill escreve o embedding.
    const prisma = pgPrismaAdapter(client);
    await client.query(`
      INSERT INTO "Prospect" (id, "orgId", "searchText")
      VALUES ('p-agro', 'org-1', 'comercio de equipamentos agricolas agro vale')
    `);
    const EMBEDDING = [0.5, -0.25, 0.75, 0.125];
    const { runEmbeddingsBackfill } = require('../../jobs/embeddings-backfill');
    const result = await runEmbeddingsBackfill(prisma, {
      embeddings: { isConfigured: () => true, embedTexts: async (texts) => texts.map(() => EMBEDDING) },
    });
    assert.equal(result.embedded, 1);
    assert.equal(result.done, true);
    const stored = await client.query(`SELECT "captureEmbedding" FROM "Prospect" WHERE id = 'p-agro'`);
    assert.match(String(stored.rows[0].captureEmbedding), /\[0\.5,-0\.25,0\.75,0\.125\]/, 'vetor persistido na forma texto do pgvector');

    // 3) defaultVectorSearch: `<=>` cosine com o MESMO vetor → o id volta
    //    (distância 0) e a query é org-scoped (outra org não vira).
    const { defaultVectorSearch } = require('../../studio/capture-service');
    const vectorSearch = defaultVectorSearch(prisma);
    const ids = await vectorSearch({ orgId: 'org-1', embedding: EMBEDDING, limit: 5 });
    assert.deepEqual(ids, ['p-agro']);
    const empty = await vectorSearch({ orgId: 'org-outra', embedding: EMBEDDING, limit: 5 });
    assert.deepEqual(empty, [], 'org-scoped: vetor de outra org nunca volta');
  } finally {
    await client.query(`DROP TABLE IF EXISTS "Prospect";`).catch(() => {});
    await client.query(`DROP EXTENSION IF EXISTS vector;`).catch(() => {});
    await client.end();
  }
});
