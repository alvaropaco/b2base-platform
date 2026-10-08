-- Saldo ÚNICO de envios (decisão do dono, 2026-10-08): e-mail e WhatsApp
-- passam a dividir o MESMO pool — a conta vira uma linha por org com
-- channel='unified'. Os tetos DIÁRIOS por canal (proteção de reputação)
-- continuam existindo como ritmo, derivados do estágio de rampa e contados
-- nas colunas novas emailSentToday/whatsappSentToday (reset diário).
--
-- Migração de dados: o saldo existente de cada org é PRESERVADO (soma das
-- duas contas); rampStage vira o MAIOR dos dois estágios; o estado de
-- domínio (elegibilidade do e-mail) vem da linha do e-mail. O ledger
-- (StudioReputationEvent) NÃO é tocado — histórico permanece por canal.
--
-- Teto da carteira recalculado pela rampa unificada (100→200→400→800) a
-- partir do estágio resultante, para não herdar teto de canal (ex.: 80 do
-- WhatsApp) como teto do pool.

ALTER TABLE "StudioReputationAccount" ADD COLUMN "emailSentToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StudioReputationAccount" ADD COLUMN "whatsappSentToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "StudioReputationAccount" ADD COLUMN "usageDay" TEXT;

INSERT INTO "StudioReputationAccount" (
  "id", "orgId", "channel", "balance", "floor", "ceiling", "rampStage",
  "emailSentToday", "whatsappSentToday", "usageDay",
  "domainAuthStatus", "domainAuthCheckedAt", "domainAuthDetail",
  "createdAt", "updatedAt"
)
SELECT
  'unified_' || m."orgId",
  m."orgId",
  'unified',
  m."balance",
  10, -- piso padrão do pool (STUDIO_REP_FLOOR default no writer)
  CASE m."stage" WHEN 0 THEN 100 WHEN 1 THEN 200 WHEN 2 THEN 400 ELSE 800 END,
  m."stage",
  0,
  0,
  NULL,
  COALESCE(e."domainAuthStatus", 'unverified'),
  e."domainAuthCheckedAt",
  COALESCE(e."domainAuthDetail", '{}'::jsonb),
  NOW(),
  NOW()
FROM (
  SELECT
    "orgId",
    SUM("balance") AS "balance",
    LEAST(MAX("rampStage"), 3) AS "stage"
  FROM "StudioReputationAccount"
  WHERE "channel" IN ('email', 'whatsapp')
  GROUP BY "orgId"
) m
LEFT JOIN "StudioReputationAccount" e
  ON e."orgId" = m."orgId" AND e."channel" = 'email'
WHERE NOT EXISTS (
  SELECT 1 FROM "StudioReputationAccount" u
  WHERE u."orgId" = m."orgId" AND u."channel" = 'unified'
);

-- Orgs que ainda não tinham conta nenhuma ganham a unified no primeiro uso
-- (ensureAccount do writer) — nada a fazer aqui.

-- As linhas por canal saem (saldo já somado na unified; auditoria vive no
-- ledger). Delta das colunas novas antes do drop é trivial (contadores do
-- dia; a reposição da virada recompõe o ritmo).
DELETE FROM "StudioReputationAccount" WHERE "channel" IN ('email', 'whatsapp');
