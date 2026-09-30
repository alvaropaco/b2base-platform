---
title: 'Epic 1 confiabilidade — turno resiliente, memória de decisão e segmentação que casa'
type: 'feature'
ticket: ''
created: '2026-09-30'
status: 'built'
baseline_revision: 'c58c1b0564feeb4b446dcf3abc276838d05597ee'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
context:
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/specs/spec-studio-campaign-reliability/diagnosis.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** O turno do agente de campanhas morre em "Tive um problema técnico" sem recuperação nem errorCode (a causa real é descartada); a audiência descrita em linguagem natural casa 0 de 505 leads e o agente re-insiste no mesmo critério; decisões fechadas pelo vendedor são re-perguntadas; `confirm_material` falha quando o modelo cita o nome em vez do id.

**Approach:** Endurecer a cadeia LLM (retry por estágio, erro logado com stack, `errorCode`+stack no trace, degradação que diz o que NÃO mudou), persistir e re-injetar a decisão fechada da audiência no prompt, tornar o matching de segmento tolerante (termos atômicos, sem acento, catálogo com `companyName`/`tradeName`, `segment-nl` ancorado na base real) com recuperação determinística de 0-match, e resolver `confirm_material` por nome na org. Fonte dos ACs: stories 1.1–1.5 de `_bmad-output/planning-artifacts/epics.md` (FR1–FR6, FR15).

## Boundaries & Constraints

**Always:**
- Erro visível: nenhum catch descarta a causa — `_err` logado com stack; falha de LLM/JSON persiste `errorCode` no `StudioChatTrace` (NFR4/spec).
- Testes `node --test` + fake-prisma com stub de LLM (`overrides.aiDeps`) por comportamento, nunca texto exato.
- Migrações só via `prisma migrate`; multi-tenancy `orgId`; `requirePremiumOrg` onde os pares têm.
- `actions.v1` sem breaking change (AD-6); guard-rails (saldo/consentimento) intocados.
- Tom mordomo/zero jargão nas mensagens de degradação (UX-DR4).

**Never:**
- Não contornar guard-rails nem inflar audiência com leads irrelevantes só para "casar" (spec Constraint).
- Não trocar o gateway/modelo de LLM nem o contrato `actions.v1` das 11 actions existentes.
- Fora de escopo: captura de leads (Epic 2), evals/judge (Epic 4), fila/audiência em voo (Epic 3).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| JSON inválido 3× | LLM devolve não-JSON em parse+reparo | turno degrada explicando o que NÃO foi alterado + próximo passo; trace `status failed` com `errorCode`+stack | nunca frase genérica sem contexto |
| Timeout LiteLLM | LLM aborta em 30s | retry por estágio; no esgotamento, degradação explicável; `errorCode` não-nulo | erro real logado com stack |
| Decisão já tomada | vendedor fechou "só industrial" | turno seguinte NÃO re-pergunta; prompt carrega os critérios persistidos | — |
| Pedido industrial | base com "Metalúrgica Taunus", industry CNAE | materializa ≥50 leads (D5); acento/grafia não impedem | — |
| 0-match | filtro casa 0 leads | aviso + diagnóstico do porquê + proposta de critério materialmente diferente (nunca o mesmo `where` 2×) | nunca infla audiência |
| confirm por nome | modelo manda `materialName`/nome em vez de id | resolve na org por sourceRef/produto; ambíguo pede desambiguação | 404 só se nada casar |

</frozen-after-approval>

## Code Map

- `studio/ai/chat-agent.js` -- `orchestrate` :123-190; `catch (_err)` :183-189 engole o erro e devolve "Tive um problema técnico"; `buildStateBlock` :73-90 (só audienceCount); SYSTEM_PROMPT :26-71.
- `studio/ai/json.js` -- `callLlmJson` :77-113 (2 tentativas + reparo); `parseModelJson` :32-66; falha final `LLM_JSON_FAILED` :109-112.
- `llm-client.js` -- timeout 30s :107-133; abort lança Error SEM `err.code` → errorCode null na telemetria (`chat-agent.js:152-162`).
- `studio/chat-routes.js` -- `runChatTurn` :687 (catch :742-755 persiste trace `failed` e rethrow; card de erro de action :777-781); `persistChatTrace` :646-676; `GET /campaigns/:id/traces` :905-934; `currentExtras` :92-207 (só includedCount); `set_audience` :255-292 (`segmentService.buildWhere` :258, materializa :261-264, grava StudioSegment com criteria+naturalLanguageInput :270-287); `confirm_material` :341-346 (só por id exato, 404); card 0-match `buildAudienceCard` :560-571 (`emptyMatch`) + aviso :796-803; params do hash :37-38.
- `studio/segment-service.js` -- `FIELD_CATALOG` :24-39 (SEM companyName/tradeName); `translateCondition` :68-89 (`contains` insensitive :85-87 — case, não acento); `buildWhere`.
- `studio/ai/segment-nl.js` -- `fromPrompt` :15-67 (catálogo no prompt :19-21; sem few-shot da base; gera frase composta literal).
- `studio/campaign-service.js` -- `materializeAudience` :136-166 (snapshot com includedCount; caminho manual :149-158).
- `prisma/schema.prisma` -- `StudioChatTrace` :1476-1497 (errorCode :1490; SEM coluna de stack); `Prospect` :103-170 (industry String?, companyName, tradeName).
- `studio/actions/manifest.v1.js` -- `confirm_material` :30 (idempotency params); actionKey :46-58; validate :102-109.
- Testes -- stub de LLM: `test/studio-chat.test.js:95-110` (`overrides.aiDeps.callLlm` por palavra-chave do prompt) e `test/studio-agent.test.js:52`; caminhos de reparo JSON em `test/studio-llm-repair.test.js` / `test/studio-ai-json.test.js`; fake-prisma suporta `studioChatTrace`.
- Contexto pós-onda-criação-sem-bloqueios (NÃO quebrar): actions `attach_files`/`edit_content` (:33-36 manifest), `updateContents`, certificado `forDispatch`, `connectedSendChannels`.

## Tasks & Acceptance

**Execution:**
- [ ] `llm-client.js` + `studio/ai/json.js` + `studio/ai/chat-agent.js` -- retry por estágio (parse → validação) com contagem própria por estágio; `err.code='LLM_TIMEOUT'` no abort; `_err` SEMPRE logado com stack; no esgotamento, `orchestrate` devolve degradação estruturada `{degraded:true, unchanged:[<fases tocadas>], nextStep}` — a UI renderiza CHIPS leigos ("seus leads não foram tocados ✓ · tenta de novo em 1 minuto"), nunca "problema técnico" seco -- FR1/UX-DR4.
- [ ] `prisma/schema.prisma` (migrate) + `studio/chat-routes.js` -- coluna `StudioChatTrace.errorStack String?`; `persistChatTrace` grava `errorCode`+`errorStack` nos caminhos failed e degraded; `GET /campaigns/:id/traces` retorna ambos -- FR3.
- [ ] `studio/chat-routes.js` + `studio/ai/chat-agent.js` -- memória de decisão (FR2): `currentExtras` injeta `criteriosAudiencia` (criteria + naturalLanguageInput do último StudioSegment + contagem do snapshot ativo) e `buildStateBlock` os expõe ao prompt como FATO — regra de ouro da barra do dono: **pergunta uma vez, nunca mais**; turnos posteriores não re-perguntam fase concluída.
- [ ] `studio/segment-service.js` -- catálogo ganha `companyName`/`tradeName` (FR4); `translateCondition` normaliza termos (lower + sem acento) e consulta `Prospect.searchText` (OR com os campos estruturados); termos atômicos (frase composta vira lista de termos).
- [ ] `prisma/schema.prisma` (migrate) + hooks de escrita -- `Prospect.searchText String?` = industry+companyName+tradeName normalizados; backfill idempotente na migração; mantido em create/update/import CSV/enriquecimento -- FR4.
- [ ] `studio/ai/segment-nl.js` -- prompt ancorado na base real: amostra (≤30 valores) de `industry`/`companyName` da org como few-shot + instrução de termos atômicos -- FR5.
- [ ] `studio/chat-routes.js` -- recuperação determinística de 0-match (FR6): ao materializar 0, diagnóstico do porquê (campo consultado vs amostra real da org) + proposta de critério materialmente diferente (hash do `where` comparado às tentativas — nunca repetir) entregue como AÇÃO DE 1 CLIQUE no card ("não achei X, mas achei 57 similares — [usar este filtro]" — zero decisão para o vendedor); 2ª proposta também 0 → nova diferença, sem loop.
- [ ] `studio/chat-routes.js` -- F2 (FR15): `confirm_material` resolve por id OU nome na org (match normalizado sobre `sourceRef` e `extraction.product`); ambíguo → card de desambiguação (sem falha); params do hash continua `{materialId}` com o id RESOLVIDO (chave estável) -- FR15.
- [ ] `test/*.test.js` -- suítes com stub LLM: JSON inválido/timeout → degradação + trace (Story 1.1); decisão não re-perguntada (1.2); matching acento/grafia/companyName + ≥50 leads na base fixa de QA-like fixture (1.3); 0-match → proposta diferente sem repetir where (1.4); F2 id/nome/ambíguo (1.5); CENÁRIOS EXTREMOS (barra do dono): cadastro todo null, tudo acentuado, 505 leads, material com nome ambíguo -- NFR5/FR14 base.

**Acceptance Criteria:**
- Given falha de LLM simulada (timeout ou JSON inválido 3×), when o turno executa, then a resposta explica o que NÃO foi alterado + próximo passo, `StudioChatTrace` tem `errorCode`+`errorStack`, e a causa é logada com stack no servidor.
- Given decisão fechada ("só industrial"), when o turno seguinte executa, then o agente não re-pergunta e referencia os critérios (injetados do estado persistido).
- Given base com "Metalúrgica Taunus" (industry CNAE com acento), when "indústrias metalmecânicas", then materializa com leads; "metalurgica" sem acento casa.
- Given filtro que casa 0, when o turno seguinte roda, then diagnóstico + proposta materialmente diferente (hash distinto, nunca o mesmo `where`).
- Given material citado pelo nome, when `confirm_material` executa, then resolve na org; ambíguo pede desambiguação; inexistente → 404 explicável.
- Given base fixa com 505 leads do cenário do dono, when pedido industrial, then ≥50 leads (D5).

## Implementation Notes

_(vazio no planning — preencher na implementação)_

## Plan Change Log

_(vazio até o primeiro loopback de review)_

## Review Triage Log

_(vazio até o primeiro passe de review)_

### 2026-09-30 — Review pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment)
- verdicts: 43 findings — high 4, medium 13, low 12, false/reject 8, defer 4, carried/descritivos 2 — maybe-false 0
- findings (B=blind-hunter, E=edge-case-hunter, V=verification-gap, IN=intent-alignment; patches agrupados por raiz):
  - [high] [patch] E1 — AND com 2 contains de texto no mesmo grupo: `Object.assign` mescla a chave `OR`, a 1ª condição DESAPARECE do where (audiência inflada) — confirmado empiricamente — fix: nest `{ AND: conds }` quando qualquer condição gerar OR.
  - [high] [patch] B1/B12/IN-D2 — "ação de 1 clique" do 0-match e candidatos de desambiguação não existem na UI (SPA intocada; card genérico) — o plano (task FR6 + decisão da party) exige o clique — fix: renderizar `suggestedFilter` como chip acionável e `material_ambiguous.candidates` como chips em CampaignChat + tipar ChatCard.
  - [high] [patch] B2 — falha de LLM DENTRO de actions (set_audience/generate_content) vira card com jargão cru ("estágio parse esgotado...") e trace `succeeded` com errorCode null — fix: mapear LLM_JSON_FAILED/LLM_TIMEOUT para mensagem mordomo + errorCode/errorStack no trace (status degraded).
  - [medium] [patch] B4/E2/V-other1/IN-D5 — memória de decisão usa o último StudioSegment da ORG (inclui 0-match e segmentos manuais/outras campanhas) emparelhado com contagem do snapshot desta campanha — fix: FATO só quando a campanha tem snapshot ativo; caso contrário vai como histórico recente, sem proibição de re-pergunta; nunca injetar critério que materializou 0.
  - [medium] [patch] B5/E8 — `callLlmJson` re-tenta QUALQUER erro (inclui 401/403) e sem deadline total (3×30s por estágio × estágios = minutos) — fix: só re-tentar infra (LLM_TIMEOUT/LLM_HTTP_ERROR/网络) e deadline suave por chamada.
  - [medium] [patch] B6/E6 — `orgTextSample` sem orderBy (amostra não determinística) e diagnóstico diz "Sua base tem N" com N≤1000 — fix: orderBy estável + copy honesta de amostra.
  - [medium] [patch] B7/E3 — proposta de 0-match pode casar 0 (não filtra matchedCount>0) — fix: preferir proposta com matched>0 (o count já é calculado).
  - [medium] [patch] B9/E4 — `equals` nos campos novos segue sensível a acento — fix: branch normalizado (`searchText equals`) para SEARCHTEXT_FIELDS.
  - [medium] [patch] B11/V2 — hooks de escrita do searchText sem NENHUM teste (testes semeiam à mão) — fix: teste do discovery import + enriquecimento afirmando searchText.
  - [medium] [patch] E12/V3 — `mcp-server.js create_prospect` grava sem searchText (porta de entrada viva) — fix: espelhar `withSearchText` dos irmãos.
  - [medium] [patch] B3 — `catch (_e)` silenciosos em currentExtras/orgBaseSamples/orgTextSample/previousWhereHashes violam o "Always" congelado (erro visível) — fix: log com `_e`.
  - [medium] [patch] V1 — teste do timeout fabrica o próprio err.code; `llm-client.js` nunca executa em teste — fix: teste direto do módulo com fetch stubado afirmando LLM_TIMEOUT/LLM_HTTP_ERROR.
  - [low] [patch] B8 — termos <3 ("TI", "RH") somem do matching — fix: mínimo 2.
  - [low] [patch] E5 — previousWhereHashes take:50 deixa hashes caírem — fix: 200.
  - [low] [patch] E9 — timeouts de rede do undici (UND_ERR_*) não viram LLM_TIMEOUT — fix: mapear.
  - [low] [patch] E11 — hash de set_audience mudou (criteria) → replays pré-deploy re-executam 1× — fix: chave legada quando criteria ausente.
  - [low] [patch] B14/B17 — comentário "2 tentativas" defasado; `llmCode` morto; unchangedPhases sem "materiais" — fix: cosmetic direto.
  - [low] [defer] B10/E7/V4/IN-D6 — equivalência backfill SQL × NFD-strip fora dos diacríticos PT + nada automatizado roda o SQL — implementador JÁ aplicou e conferiu o backfill no Postgres de dev desta sessão; harness de Postgres real não existe — deploy checklist: revalidar linha backfillada vs buildSearchText.
  - [low] [defer] B15 — flake pré-existente de horário no studio-scheduler (falha confirmada no baseline via stash nesta sessão).
  - [medium] [defer] IN-D1 — propensão do modelo REAL (emitir termos atômicos / mandar nome) não é exercitada com stub — medição pertence à malha de evals (Epic 4, eval-matrix).
  - [false] [reject] B13 — varredura de materiais da org por confirmação — org de vendedor tem dezenas, não milhares; improvável doer.
  - [false] [reject] E10 — race de edição concorrente no enriquecimento (transação) — improvável no dia a dia, fix ramificado.
  - [false] [reject] B16 — errorStack exposto no /traces sem consumidor — endpoint autenticado da própria org (o dono diagnostica); comentário atualizável no patch B14.
  - [false] [reject] E13 — plano dizia `criteriosAudiencia`, código usa `audienceCriteria` — naming interno consistente código+teste.
  - [false] [reject] E14 — matriz dizia trace "failed", código grava "degraded" — degradado É o registro honesto do turno que degradou; causa preservada do mesmo jeito.
  - [low] [reject] IN-D3 — "nunca re-pergunta" via prompt+FATO é probabilístico com LLM real — é o mecanismo que o plano escolheu; determinismo onde dá (estado).
  - [low] [reject] IN-D4 — re-insistência do agente limitada por idempotência, não por where-hash — replay AD-6 é intocável; card de recuperação cobre o vendedor.
  - **Patches aplicados (mesma data, pelo implementador do passo 3):** os 17 grupos `[patch]` corrigidos — AND-nest no translateCriteria (bug de audiência inflada); equals normalizado; termVariants ≥2; UI do 0-match (chip "Usar este filtro (N leads)") e desambiguação em chips clicáveis (CampaignChat + vitest); action com falha de LLM → card mordomo + trace degraded; memória de decisão escopada (FATO só com lastCount>0 e snapshot ativo; resto vira histórico); retry só de infra + deadline 75s; orgTextSample estável e honesto; propostas que casam 0 puladas; catches silenciosos logados; take 200; UND_ERR mapeado; hash legado pré-deploy; MCP create_prospect com searchText; testes dos hooks (enriquecimento/discovery); comentários e chip de materiais. Verificação pós-patch: 770/771 (1 flake de horário pré-existente, confirmado no baseline), build web ok, prisma validate ok.

## Design Notes

- **Acento sem extensão nova (constituição VI):** `Prospect.searchText` (lower + NFD-strip) preenchido por backfill na migração e mantido nos hooks de escrita (import CSV, enriquecimento, create/update). `translateCondition` normaliza o termo e faz OR `searchText contains` + campos estruturados. Evita `unaccent` (extension pode não existir no Postgres gerenciado) e mantém o where em Prisma puro.
- **Recuperação de 0-match comparável:** guardar `sha256(JSON(where))` das tentativas no estado do turno; proposta nova só vale se o hash difere de TODAS as anteriores — "materialmente diferente" é computável (FR6).
- **F2 sem quebrar idempotência:** o hash de `StudioActionRun` continua por `materialId` — agora o id RESOLVIDO; resolução por nome acontece antes, é determinística (normalização + match único) e ambiguidade NUNCA resolve sozinha.
- **Barra do dono (checkpoint 2026-09-30):** a preocupação é a JORNADA inteira sem erros e sem fazer o usuário decidir — Epic 1 é o primeiro ponto; jornada completa fecha no Epic 3 (fila/Monitor) e vira portão permanente no Epic 4 (journey E2E bloqueante). Métricas internas (≥50 leads) são teste nosso, não decisão do usuário.
- **Degradação honesta:** `unchanged` lista as fases que o turno TOCOU e não conseguiu concluir (ex.: "audiência não foi alterada") — nunca confirmação falsa (UX-DR4).

## Verification

**Commands:**
- `pnpm test` -- expected: suítes novas verdes + `studio-chat`, `studio-agent`, `studio-llm-repair`, `studio-ai-json`, `studio-segments`, `studio-actions`, `studio-compliance` sem regressão
- `pnpm -C apps/web build` -- expected: compila sem erro (nenhum toque na SPA é obrigatório)
- `npx prisma validate` + migração aplicável (`db:migrate`) -- expected: válida, backfill idempotente

**Manual checks (opcional):**
- Transcrição do dono reproduzível: "indústrias metalmecânicas" materializa audiência; "Tive um problema técnico" não volta a aparecer como beco sem saída.
