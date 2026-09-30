---
title: 'Epic 2 confiabilidade — capturar leads do sistema e via CNPJ'
type: 'feature'
ticket: ''
created: '2026-09-30'
status: 'built'
baseline_revision: '5861cf0c4824ff354091c0dea53eafbfe5ebca82'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
warnings: ['oversized']
context:
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/specs/spec-studio-campaign-reliability/diagnosis.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** "Capture mais leads da base do sistema" não tem capacidade nenhuma por trás — a action não existe, não há busca semântica sobre a base, o MCP de CNPJ não é exposto ao chat, e leads capturados não registram proveniência nem passam pelo fluxo de consentimento.

**Approach:** Nova action aditiva `capture_leads` no `manifest.v1` com busca HÍBRIDA sobre a base própria (lexical via `Prospect.searchText` do Epic 1 + semântica via pgvector seguindo o padrão de embeddings do `cnpj-data-publisher` — LiteLLM `gemini-embedding`, dim 1536); quando a base não atende, captura via MCP CNPJ com dedupe por CNPJ; proveniência registrada (`base-propria`/`mcp-cnpj`); disponível para trial e premium (D2) com limite diário conservador por org; recusa explicável e zero invenção de contato.

## Boundaries & Constraints

**Always:**
- `actions.v1` sem breaking change — `capture_leads` entra ADITIVA (AD-6), idempotente por params.
- LGPD (NFR3): proveniência gravada por lead; proibido inventar dado de contato — só dados retornados pelo MCP/busca; consentimento/opt-out existentes (`StudioLeadConsent`) intocados.
- Busca híbrida D1: lexical (Prisma `searchText`) + embeddings pgvector — índice vetorial via `prisma migrate`; embeddings seguem o padrão do publisher (LiteLLM OpenAI-compatible `/embeddings`, modelo `gemini-embedding`, 1536 dims, batch).
- Multi-tenancy `orgId` em toda query; D2: captura disponível para TRIAL e premium.
- Erro visível (`_err` logado); testes `node --test` + fake-prisma por comportamento; queue/Redis: padrão singleton por nome (incidente 2026-09-30).
- Cards no tom mordomo com proveniência visível por lote ("da sua base" / "encontrado via CNPJ") — UX-DR3/epics.

**Never:**
- Não inventar leads/dados sem capacidade disponível (token/quota) — recusa explicável (FR9).
- Não repetir lead já capturado (dedupe por CNPJ/replay idempotente — FR8/AD-6).
- Fora de escopo: enriquecimento em massa, import de listas arbitrárias, fine-tune, Epic 4 (evals).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Busca híbrida lexical+semântica | "empresas de equipamentos agrícolas" | candidatos relevantes da base própria (searchText + embeddings), materializados com proveniência `base-propria` | sem embeddings configurados → só lexical, explicado no card |
| Sem embeddings / pgvector ausente | EMBEDDINGS indisponíveis | captura lexical-only funciona | card informa o modo |
| Base não atende | 0 (ou < mínimo) resultados próprios | captura via MCP CNPJ com proveniência `mcp-cnpj` | token/quota ausente → recusa explicável, NENHUM lead criado |
| CNPJ já existe | MCP retorna CNPJ presente na base | não duplica (dedupe por `cnpj`) | replay P2002 → findFirst |
| Limite diário | org bate `STUDIO_CAPTURE_DAILY_LIMIT` | bloqueio explicável com quando-libera (meia-noite) | volume registrado p/ monitoria |
| Replay de action | mesma `actionId`/params | card replayed, nenhum lead duplicado | idempotência `StudioActionRun` |

</frozen-after-approval>

## Code Map

- `studio/actions/manifest.v1.js` -- ACTIONS_V1 :26-36 (11 actions; adicionar `capture_leads` idempotency 'params'); `actionParams` em `chat-routes.js:33-75` (adicionar case); `ACTION_ORDER` :631-643 (ordem no fim, ex. 9).
- `studio/chat-routes.js` -- handlers de action em `executeAction` :325+ (padrão do card); `orgBaseSamples`/`orgTextSample` (Epic 1) reutilizáveis para diagnóstico; `requirePremiumOrg` :491/:1353 (capture_leads NÃO usa — D2).
- `mcp-cnpj.js` -- `searchCompanies` :232, `filterCompanies` :254, `getCompanyByCnpj` :282; token `CNPJ_MCP_TOKEN` (na secret b2base-secrets ✓), `CNPJ_MCP_URL` no deploy env ✓.
- `prisma/schema.prisma` -- `Prospect` :103-170 (`cnpj String?` = chave de dedupe; `searchText`; status default 'prospect'); SEM proveniência → novo campo.
- `services/cnpj-data-publisher/src/cnpj_data_publisher/processing/embedder.py` -- padrão de embeddings: POST `{base}/embeddings` OpenAI-compatible, `model=gemini-embedding`, batch 128, pgvector text-form `[v1,v2,...]`; `CREATE EXTENSION IF NOT EXISTS vector`.
- `llm-client.js` / env -- `LITELLM_URL=https://litellm.0xcloud.net` + `LITELLM_API_KEY` (secret) — MESMO gateway para `/embeddings`.
- `search-text.js` (Epic 1) -- `normalizeText` para o matching lexical.
- `studio/certificate.js:219` `grantConsent` / `StudioLeadConsent` -- fluxo de consentimento existente (capturado entra SEM consentimento automático; canais respeitam regras de sempre).
- Testes -- stub de LLM: `test/studio-chat.test.js:95`; fake-prisma NÃO suporta `$queryRaw` → busca semântica pgvector DEVE viver atrás de dependência injetável (`vectorSearch` em overrides) com implementação real via `prisma.$queryRaw`.

## Tasks & Acceptance

**Execution:**
- [ ] `prisma/schema.prisma` (migrate) -- `Prospect.captureSource String?` (`base-propria` | `mcp-cnpj`) + `Prospect.captureEmbedding vector(1536)?` com índice (migration SQL: `CREATE EXTENSION IF NOT EXISTS vector` + coluna + índice) -- FR7/D1/NFR4.
- [ ] `studio/ai/embeddings.js` (novo) -- cliente de embeddings Node: POST `{LITELLM_URL}/embeddings` (`LITELLM_API_KEY`, model `gemini-embedding` via env `STUDIO_EMBEDDING_MODEL`, batch ≤128, timeout, retry 1×); `embedTexts(texts) → number[][]`; desabilitado (retorna null) sem `LITELLM_URL` -- D1.
- [ ] `studio/capture-service.js` (novo) -- busca híbrida: lexical = `searchText contains` por termos atômicos (`termVariants`) org-scoped; semântica = `vectorSearch` injetável (`prisma.$queryRaw` com `<=>` cosine) sobre `captureEmbedding`; mescla dedup; mínimo configurável (`STUDIO_CAPTURE_MIN_OWN`, default 20) para decidir fallback MCP; limite diário por org (contagem `captureSource`+`createdAt>=início do dia`, env `STUDIO_CAPTURE_DAILY_LIMIT`, default 200) -- FR7/FR9/D2.
- [ ] `jobs/embeddings-backfill` -- job de backfill idempotente dos `captureEmbedding` NULL (batch, resumável — padrão embedder.py): roda no boot com teto por execução -- FR7.
- [ ] `studio/chat-routes.js` + `manifest.v1.js` -- action `capture_leads` (params `{query, state?, city?, cnae?, limit?}`): executa capture-service; card mordomo com contagem + proveniência por lote + chips de 1 clique (padrão `suggestedFilter` do Epic 1) para materializar audiência com os capturados; idempotência params; SEM requirePremiumOrg (D2) -- FR7/FR9/UX-DR3.
- [ ] `studio/capture-service.js` (MCP) -- fallback `mcp-cnpj.searchCompanies/filterCompanies` quando base própria < mínimo; dedupe por `cnpj` (P2002→findFirst); cria prospects com `captureSource:'mcp-cnpj'`, status 'prospect', dados SÓ do MCP; recusa explicável quando token ausente/erro MCP -- FR8/FR9/NFR3.
- [ ] `test/*.test.js` -- suítes: híbrida lexical+candidatos relevantes (fixture agrícola); lexical-only sem embeddings (explicado); fallback MCP com stub (`_setMcpForTests`) + dedupe CNPJ + zero invenção; limite diário (bloqueio explicável); replay idempotente; trial permitido (D2) -- FR7-9/NFR2/5.

**Acceptance Criteria:**
- Given base com "equipamentos agrícolas" (com acento/CNAE), when "capture leads de equipamentos agrícolas", then candidatos da base própria materializam com proveniência `base-propria` no card.
- Given embeddings indisponíveis, when captura executa, then lexical-only funciona e o card informa o modo.
- Given base própria abaixo do mínimo, when captura executa, then MCP CNPJ é consultado; leads novos com proveniência `mcp-cnpj`; CNPJ existente não duplica.
- Given token MCP ausente, when fallback tenta, then recusa explicável e nenhum lead criado.
- Given org no limite diário, when nova captura, then bloqueio explicável com quando-libera; volume registrado.
- Given replay da action, when executa de novo, then card replayed e zero duplicação.

## Implementation Notes

_(preenchido na implementação — 2026-09-30)_

- **Migração** (`20260930133000_prospect_capture_hybrid`): `CREATE EXTENSION IF NOT EXISTS vector` +
  `captureSource TEXT` + `captureEmbedding vector(1536)` + índice
  `Prospect_orgId_captureSource_createdAt_idx` (limite diário). Verificada por `prisma migrate diff
  --from-empty --to-schema-datamodel` (DDL idêntico ao gerado pelo Prisma). O `CREATE EXTENSION` é
  necessário porque o Prisma NÃO emite a extensão para tipos `Unsupported`. Índice ANN (HNSW) do
  vetor: **deferred** por Design Notes (varredura `<=>` basta; criar só a partir de ~100k+). O
  Postgres local de dev não tem pgvector — aplicação real vale no cluster (que suporta, validado
  2026-09-30).
- **`studio/ai/embeddings.js`**: endpoint `${LITELLM_URL}/v1/embeddings` (o publisher posta em
  `{base}/v1/embeddings`; mesmo gateway/gateway-path do chat). Desabilitado = `embedTexts` devolve
  `null` sem `LITELLM_URL`; retry 1×; batch ≤128; timeout `STUDIO_EMBEDDING_TIMEOUT_MS` (20s).
- **`studio/capture-service.js`**: lexical = `termVariants(query)` sobre `searchText contains`
  (OR no topo — fake-prisma e Prisma equivalentes); semântica atrás de `vectorSearch` injetável
  (`prisma.$queryRaw` com `<=>`, coluna `Unsupported` nunca passa pelo client do Prisma); filtros
  opcionais `state/city/cnae` aplicados em memória sobre os candidatos. Recusas (`mcp_not_configured`,
  `mcp_error`) e `limit_reached` são RESULTADO estruturado (card explicável), nunca exceção —
  recusa não grava NADA (nenhum `captureSource` marcado). `STUDIO_CAPTURE_MIN_OWN` (20) e
  `STUDIO_CAPTURE_DAILY_LIMIT` (200) lidos por chamada.
- **`mcp-cnpj.js`**: `_setMcpForTests`/`_resetMcpForTests` (padrão `_setBullForTests`) — override
  POR FUNÇÃO checado dentro de cada export (destructure no import não burla). Contrato do stub:
  registros JÁ mapeados (o que `searchCompanies` realmente devolve).
- **D2 no endpoint de chips** (`POST /campaigns/:id/actions`): o gate premium da rota passa a pular
  `capture_leads` (única action fora do gate); as demais mantêm `requirePremiumOrg` — coberto por
  teste (trial captura; `generate_content` no trial segue 403).
- **SYSTEM_PROMPT** (`chat-agent.js`): `capture_leads` ensinado ao orquestrador (gatilhos "capture
  mais leads", query = termo curto de setor) + linha no JSON schema; `ACTION_ORDER` = 9 (último),
  `ACTION_LABELS` = "Capturando leads…".
- **Card/SPA**: card `type: 'capture'` com `status` (`captured`/`refused`/`limit_reached`) e
  `suggestedFilter.prospectIds` (formato diferente do 0-match, mesmo campo). SPA ganhou
  `captureLeadsChip` (função pura, padrão FR6) → chip "Materializar audiência com os capturados"
  que roda `select_leads { set }` pela porta idempotente de chips.
- **Backfill** (`jobs/embeddings-backfill.js`): só linhas `captureEmbedding IS NULL` com
  `searchText` não vazio (resumável/idempotente), guarda `IS NULL` no UPDATE (corrida não
  reescreve), teto `STUDIO_EMBEDDING_BACKFILL_MAX_ROWS` (500/boot) — wired no `server-prod.js`
  fire-and-forget (padrão sanitize-legacy), off com `STUDIO_EMBEDDINGS_BACKFILL=off`.
- **Testes**: `test/studio-capture-leads.test.js` (10 testes: híbrida, lexical-only, MCP+dedupe+
  zero-invenção, P2002→findFirst, recusa sem token, limite diário, replay+trial D2, 400 sem query,
  embeddings, backfill) + `CampaignChat.capture.test.ts` (chip) + contrato do manifest atualizado
  para 12 actions. `pnpm test` (787) e vitest (108) verdes; `pnpm -C apps/web build` compila.

## Plan Change Log

_(vazio até o primeiro loopback de review)_

## Review Triage Log

_(vazio até o primeiro passe de review)_

### 2026-09-30 — Review pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment)
- verdicts: 37 findings — high 1, medium 8, low 14, false/reject 6, defer 2, carried/descritivos 6 — maybe-false 0
- findings (B=blind-hunter, E=edge-case-hunter, V=verification-gap, IN=intent-alignment; patches agrupados por raiz):
  - [high] [patch] B1/E9/E14/IN — furo no D2: capture_leads pula o gate premium mas o chip "Materializar audiência" emite select_leads, que CONTINUA gated → trial captura e leva 403 no único clique do card — fix: gate skip também para select_leads + teste trial chip→200.
  - [high] [patch] B2/E1/V-other2 — contabilidade do limite diário quebrada no ramo base-propria: lote não é clampeado ao `room` restante (pode marcar 100 com 1 vaga); re-marcados mantêm createdAt antigo e nunca entram no contador; card reporta número que a contagem DB não reproduz — fix: clamp + card usa contagem reproduzível + teste.
  - [medium] [patch] B4/V-other1 — provenância SOBRESCRITA: updateMany re-marca leads `mcp-cnpj` como `base-propria` — fix: só marcar onde captureSource IS NULL (auditoria LGPD preservada) + teste.
  - [medium] [patch] E2 — MCP pode devolver empresa BAIXADA (isActive=false) e vira lead novo — fix: skip + skipped++ + teste.
  - [medium] [patch] E5 — recusa/limite RECORRIDOS como replay permanente: mesma params após configurar o token devolve a recusa velha para sempre (StudioActionRun persiste 'succeeded') — fix: só 'captured' persiste replay; recusa/limite re-executam; teste do fluxo recusa→configura→funciona.
  - [medium] [patch] B3/E3 — card "Leads capturados" com ZERO leads (MCP só duplicados/inválidos) vira falso sucesso com copy quebrada (". Nada foi enviado…") — fix: status próprio "nada novo" com copy honesta + teste.
  - [medium] [patch] V2 — SQL pgvector REAL (defaultVectorSearch/backfill/migração) nunca executa em teste; quebra silenciosa = lexical-only para sempre sem sinal — fix: teste de integração opt-in (env-gated, padrão test/integration) + validação pós-deploy no cluster.
  - [medium] [patch] V1 — hash de idempotência do capture_leads sem teste (state/city/cnae/limit no hash): mesma query com state diferente colapsaria num card só — fix: teste das duas direções (diferente → executa; idêntico sem actionId → replay).
  - [medium] [patch] B5 — busca de captura não filtra status (leads discarded podem ser re-marcados e empurrados à audiência) — fix: excluir 'discarded' na fase própria; opt-out segue garantido na materialização/envio.
  - [low] [patch] E10/B12 — varredura lexical sem orderBy (subconjunto arbitrário >400) — fix: createdAt asc.
  - [low] [patch] E6 — STUDIO_EMBEDDING_TIMEOUT_MS ≤0 mata todo embedding — fix: guard >0.
  - [low] [patch] E7 — vetores com NaN/null do endpoint entram no pgvector — fix: validar Number.isFinite.
  - [low] [patch] B10 — retry de embeddings re-tenta qualquer erro (4xx/shape) sem delay — fix: só TIMEOUT/5xx re-tentam, delay 500ms.
  - [low] [patch] E8 — lote de backfill que falha 2× rethrowa e o cursor nunca avança — fix: encerrar o passe com log + ids stuck (próximo boot retenta).
  - [low] [patch] B7 — embedTexts filtra strings em branco e quebra o contrato "um vetor por texto na mesma ordem" — fix: enviar como veio (alinhamento garantido).
  - [low] [patch] E11/B6/E12/B17 — validate aceita query não-string ('[object Object]'); SPA quebra com prospectIds não-array; label do 0-match com contagem vazia; JSDoc órfã no ChatCard — fixes diretos.
  - [low] [patch] E13/B11 — "meia-noite" do limite no fuso do SERVIDOR (UTC) — fix: TZ do produto (America/Sao_Paulo) no startOfToday.
  - [low] [patch] B13/B15 — envs novas sem .env.example; limit_reached promete ação que não oferece — fix: documentar envs + reword honesto.
  - **Patches aplicados (mesma data, pelo implementador do passo 3):** os 16 grupos `[patch]` corrigidos — isenção D2 estendida a select_leads (chip do trial funciona, generate_content segue 403); limite diário com clamp ao room e `capturedToday` reproduzível pela contagem DB; proveniência nunca sobrescrita (guard captureSource IS NULL); isActive=false pulado; recusa/limite/no_results NÃO persistem replay (só captured persiste — re-executam ao tentar de novo); status `no_results` com copy honesta; integração pgvector opt-in (gate CAPTURE_PGVECTOR_DATABASE_URL); testes do hash nas duas direções; discarded excluído; lexical orderBy estável; embeddings (timeout guard, validação de vetor, retry só infra/5xx com delay, sem filtro de brancos); backfill encerra com stuckIds; validate typeof query; SPA (guard isArray, label sem contagem, JSDoc órfão removida); TZ do produto no startOfToday; copy sem nome de env; .env.example documentado. Verificação pós-patch: 797/797 (+ web), build ok, prisma validate ok.
  - [low] [defer] IN/V2 parcial — comportamento do MODELO REAL (emitir capture_leads por NL) e capacidade semântica com LLM real — medição pertence à malha de evals (Epic 4).
  - [low] [reject] B16 — memlog da party sem decisões do Epic 2 — rejeitado: registro é da orchestrator (wrap-up), não código.
  - [low] [reject] IN-consent — chip materializa leads MCP sem consentimento — rejeitado: por design (Leitura A); consentimento é enforced no envio (WhatsApp consent + opt-out na materialização), superfícies intocadas.
  - [false] [reject] B14/E-chat — "D2 sem teste no caminho de chat" / gate próprio do /chat — verificado: a rota /chat NÃO tem requirePremiumOrg (só generate_content por action); trial captura pela conversa.
  - [false] [reject] IN-D4 — re-insistência do agente... (não se aplica a este diff) — descartado na leitura.
  - carried: IN-superfície NL (prompt-only) = parcial do patch V1/testes; HNSW deferred é decisão do plano (Design Notes), não finding.

## Design Notes

- **Híbrida sem mágica:** lexical é a espinha dorsal (Epic 1 deixou `searchText` pronto — matching tolerante de graça); semântica só amplia recall e falha para baixo (lexical-only) quando o gateway de embeddings não responde. NADA da captura depende de LLM generativo — a query do vendedor é o input direto.
- **pgvector no migrate:** a migração roda `CREATE EXTENSION IF NOT EXISTS vector` (padrão do publisher; Postgres self-hosted da plataforma suporta — validado no cluster 2026-09-30). Índice: base pequena → varredura com `<=>` basta; índice HNSW só se a base crescer 100k+ (anotado como deferred).
- **Proveniência é coluna, não convenção:** `captureSource` na linha do Prospect — auditável e consultável para o limite diário (contagem por dia por org via índice `orgId, captureSource, createdAt`).
- **MCP só quando precisa:** a base própria é sempre tentada primeiro; MCP entra com o mínimo de chamadas (1 `searchCompanies` por captura) e NUNCA emite lead sem dados completos retornados.

## Verification

**Commands:**
- `pnpm test` -- expected: suítes novas verdes + `studio-chat`, `studio-actions`, `studio-certificate`, `outreach-queues` sem regressão
- `npx prisma validate` + migração aplicável (`db:migrate` quando houver Postgres) -- expected: válida; `CREATE EXTENSION vector` disponível (validado no cluster)
- `pnpm -C apps/web build` -- expected: compila (nenhum toque obrigatório na SPA)

**Manual checks (opcional):**
- "capture mais leads" no `/studio` real: card com proveniência; chip materializa audiência; recusa honesta sem token.
