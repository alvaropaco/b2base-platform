-- Epic 2 (FR7/D1/FR9/NFR4): infraestrutura de captura híbrida de leads.
--
-- captureSource — proveniência da CAPTURA por lead ('base-propria' |
-- 'mcp-cnpj'): coluna, não convenção — auditável e consultável para o limite
-- diário por org (FR9/D2).
--
-- captureEmbedding — embedding pgvector(1536) do searchText (mesmo padrão do
-- cnpj-data-publisher: LiteLLM /v1/embeddings, model 'gemini-embedding',
-- 1536 dims). A extensão `vector` é criada aqui (padrão do publisher; o
-- Postgres self-hosted da plataforma suporta — validado no cluster
-- 2026-09-30). O backfill dos vetores é idempotente/resumável e vive na
-- aplicação (jobs/embeddings-backfill.js), não na migração.
--
-- Índice: contagem do limite diário por org/dia. Índice ANN do vetor (HNSW)
-- é DEFERRED (Design Notes do plano): base pequena faz varredura com `<=>`;
-- criar HNSW apenas a partir de ~100k+ linhas.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "Prospect" ADD COLUMN "captureSource" TEXT;
ALTER TABLE "Prospect" ADD COLUMN "captureEmbedding" vector(1536);

CREATE INDEX "Prospect_orgId_captureSource_createdAt_idx" ON "Prospect"("orgId", "captureSource", "createdAt");
