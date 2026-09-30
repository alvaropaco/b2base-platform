-- Epic 1 (FR4): `Prospect.searchText` = industry + companyName + tradeName em
-- caixa baixa e sem acento, para o matching de segmento tolerante a acento e
-- grafia (translateCondition consulta `searchText contains` com o termo já
-- normalizado pela MESMA regra — search-text.js: NFD-strip + lower).
--
-- ESCOPO da normalização em SQL: os DIACRÍTICOS DO PT-BR (mapa do translate()
-- abaixo). Não é equivalente geral ao NFD-strip da aplicação — linhas com
-- caracteres fora desse mapa (ex. diacríticos de outros idiomas) devem ser
-- RE-BACKFILLADAS pela aplicação (search-text.js), que normaliza completo.
--
-- Backfill IDEMPOTENTE: reexecutar produz o mesmo valor (recomputa de todos
-- os campos). O mapa de translate() cobre maiúsculas E minúsculas para não
-- depender do locale do `lower()` em collations C; o lower() externo só
-- precisa lidar com ASCII (universal).
ALTER TABLE "Prospect" ADD COLUMN "searchText" TEXT;

UPDATE "Prospect"
SET "searchText" = NULLIF(
  trim(lower(translate(
    concat_ws(
      ' ',
      nullif(trim(coalesce("industry", '')), ''),
      nullif(trim(coalesce("companyName", '')), ''),
      nullif(trim(coalesce("tradeName", '')), '')
    ),
    'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ',
    'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN'
  ))),
  ''
);
