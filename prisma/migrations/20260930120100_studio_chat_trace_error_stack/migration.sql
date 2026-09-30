-- Epic 1 (FR3/NFR4): stack do erro real no trace do chat — nenhum catch
-- descarta a causa; falha de LLM/JSON persiste errorCode + errorStack,
-- consultável via GET /campaigns/:id/traces.
ALTER TABLE "StudioChatTrace" ADD COLUMN "errorStack" TEXT;
