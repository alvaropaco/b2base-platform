-- Epic 2 (FR7/D1/FR9/NFR4): infraestrutura de captura híbrida de leads.
--
-- captureSource — proveniência da CAPTURA por lead ('base-propria' |
-- 'mcp-cnpj'): coluna, não convenção — auditável e consultável para o limite
-- diário por org (FR9/D2).
--
-- captureEmbedding — embedding pgvector(1536) do searchText (mesmo padrão do
-- cnpj-data-publisher: LiteLLM /v1/embeddings, model 'gemini-embedding',
-- 1536 dims). O backfill dos vetores é idempotente/resumável e vive na
-- aplicação (jobs/embeddings-backfill.js), não na migração.
--
-- INCIDENTE 2026-10-01/05 (bloqueou TODO deploy por 5 dias — P3009): a
-- extensão `vector` já vinha INSTALADA no banco, mas no schema `public`,
-- enquanto a conexão do app usa `search_path = salesintel` — o tipo
-- `vector(1536)` não resolvia e a migração morria ("type vector does not
-- exist"), derrubando o boot do app em crash loop (o pod velho continuou
-- servindo uma versão de 30/09). Correção: extensão criada EXPLICITAMENTE
-- em `public` e todas as referências ao tipo qualificadas — resolução
-- independe do search_path da conexão.
--
-- Índice: contagem do limite diário por org/dia. Índice ANN do vetor (HNSW)
-- é DEFERRED (Design Notes do plano): base pequena faz varredura com `<=>`;
-- criar HNSW apenas a partir de ~100k+ linhas.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

ALTER TABLE "Prospect" ADD COLUMN "captureSource" TEXT;
ALTER TABLE "Prospect" ADD COLUMN "captureEmbedding" public.vector(1536);

CREATE INDEX "Prospect_orgId_captureSource_createdAt_idx" ON "Prospect"("orgId", "captureSource", "createdAt");
