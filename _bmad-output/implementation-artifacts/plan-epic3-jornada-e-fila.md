---
title: 'Epic 3 confiabilidade — jornada que conclui e fila consistente'
type: 'feature'
ticket: ''
created: '2026-10-01'
status: 'in-progress'
baseline_revision: '46bbaa8a'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
warnings: []
context:
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/specs/spec-studio-campaign-reliability/SPEC.md'
  - '_bmad-output/specs/spec-studio-campaign-reliability/eval-matrix.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A jornada de criação de campanha não tem estado server-side — o "próximo passo" é derivado só no cliente (Rail/chips), o modelo pode emitir atalho (agendar sem conteúdo) e nada rejeita; e quando a audiência encolhe DEPOIS da matrícula, a fila continua com os contatos removidos (nada sincroniza), sem sinal no Monitor. A jornada completa nunca foi executada ponta a ponta na conta QA.

**Approach:** Estado de jornada explícito e persistido (`StudioCampaign.journey` Json: fase corrente + fases concluídas, com a decisão fechada FR2 marcando audiência como concluída), guard server-side que rejeita atalho de fase à frente com explicação do que falta (card `journey_block`), prompt do orchestrate informado da fase (valida a próxima ação válida); sincronização fila×seleção dentro de `materializeAudience` (cancela contatos não enviados fora da nova seleção + estorno idempotente por refId determinístico; motores já respeitam contato `CANCELLED`); divergência audiência×fila exposta no `GET /queue` e explicada no Monitor sem jargão; cenário `journey-e2e` (dataset `journey-v1`) na suíte L1 com asserções comportamentais novas (`cardOrder`, `audienceCountAtLeast`, `certificateGreen`, `actionNotRepeated`).

## Boundaries & Constraints

**Always:**
- `actions.v1` sem breaking change; `StudioActionRun` idempotência intocada (guard roda antes, bloqueio não grava replay).
- Onda "criação sem bloqueios" preservada: conteúdo/materiais continuam permitidos fora de ordem (soft) — o guard BLOQUEIA só salto à frente com pré-requisito ausente (ex.: `set_schedule` sem conteúdo). Nada reintroduz gaveta/bloqueio de UI.
- Ledger íntegro: estorno por item com refId determinístico (`sync:{campaignId}:{channel}:{contactId}`), idempotente pela unique `(type, refId)`; messageId estável; zero reenvio (motores já cancelam em contato terminal — `outreach-workers.js:551`).
- Motores 010/011, contratos NATS `*.v1` e guard-rails (saldo, consentimento) intocados.
- Multi-tenancy `orgId`; erro visível (`_err`); testes `node --test` por comportamento (fake-prisma + LLM stubado).
- Monitor sem jargão (UX-DR2/DR4): divergência em linguagem de vendedor.

**Never:**
- Não bloquear ação de fase anterior/igual (revisão de objetivo/audiência/conteúdo continua livre).
- Não cancelar mensagem já `SENT` (não dá para des-enviar; histórico fica).
- Não inventar fase: derivação server-side espelha a do cliente (`currentRailStep`), persistida como explicitação — não como fonte nova de verdade.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Turno avança em ordem | campanha nova, set_objective→set_audience(>0)→generate_content→set_schedule | `journey` persiste fase + conclusões (audiência marcada pela decisão fechada com count>0) | — |
| Atalho inválido | `set_schedule` sem nenhum conteúdo | card `journey_block` com o que falta (sem jargão); turnos seguem; trace registra a action | bloqueio NÃO grava `StudioActionRun` |
| Chip de voo sem conteúdo | POST /actions `set_schedule` | mesma recusa explicável (card), 200 | — |
| Audiência encolhe após matrícula | 3 matriculados → snapshot novo com 2 | 1 contato fora → CANCELLED + estorno 1 unidade; zero envio ao removido; replay de sync não duplica estorno | falha de estorno não quebra sync (log `_err`) |
| Removido com mensagem SCHEDULED | job Bull já agendado | contato CANCELLED → worker pula + estorna (idempotente), messageId estável | — |
| Sem execução criada | snapshot muda antes da matrícula | sync é no-op (nada a cancelar) | — |
| Divergência na janela | Monitor abre durante sincronização | banner com quantos e por quê; some quando divergence=0 | — |
| Replay de action | mesma actionId/params | replay existente intocado (guard só roda na 1ª execução) | — |

</frozen-after-approval>

## Code Map

- `studio/chat-routes.js` -- `runAction` :330 (guard entra após `manifest.validate`, antes do ramo capture/runIdempotent); `runChatTurn` :1203 (ACTION_ORDER :1291; campanha mutada in-turn — `set_objective` muta `campaign.objective` :435); POST `/campaigns/:id/actions` :1505 (chips — mesmo runAction); `set_audience` handler :439 (materializa + FR2 grava `StudioSegment.lastCount` :474-490); `set_schedule` :595-615 (janelas + `assertTransition`).
- `studio/campaign-service.js` -- `materializeAudience` :136-172 (hook do sync — cobre POST /audience, set_audience e select_leads que materializam); `refundUnsentOnCancel` :479 (padrão de estorno em bloco/`refId` determinístico a espelhar); `TRANSITIONS` :28-38.
- `studio/reputation.js` -- writer único do ledger; `debit()` :216, `credit()` :297, `refundSend` :345 (refId=messageId), `refundBatch` :360 (refId=batchId); unique `(type, refId)` schema.prisma:1563.
- Fila -- `studio/channel-bridge.js` `enrollAudience` :280-323 (OutreachContact/WA `QUEUED`), `enqueueBatch` :390-479 (débito por lote); `outreach-workers.js` `processSend` :521 (contato `CANCELLED` → cancela+estorna :551-556); `whatsapp-workers.js` :593-637 (checar guard terminal no send); `studio/campaign-routes.js` GET `/queue` :297-366 (ponto de extensão da divergência) e cancel :212-230 (padrão de status cancelados).
- Estado/derivação -- `apps/web/src/studio/StudioApp.tsx` `currentRailStep` :73-91 (espelhar server-side); `CampaignMonitorView.tsx` :276 (audiência vs fila — banner da divergência), `fetchQueue` api.ts:331.
- Certificado -- `studio/certificate.js` `evaluate()` :126 (itens ok/pending/block; fase certificado).
- Prompt -- `studio/ai/chat-agent.js` `SYSTEM_PROMPT` :27-85, `buildStateBlock` :87-109 (linha JORNADA da fase + válidas).
- Schema -- `prisma/schema.prisma` `StudioCampaign` :1113-1148 (novo `journey Json?`); fake-prisma suporta update/create genéricos.
- Eval -- `eval/lib.js` `evaluateAssertion` :47-94 (novos tipos); `eval/run-conversations.js` :36-41,131-133 (datasets/gate); `eval/conversations/core.json` (padrão de caso).
- Testes -- padrão `test/studio-chat.test.js` (LLM stub por marcador :22-89, `startServer` :91-126); fake-prisma `test/helpers/fake-prisma.js` (`studioAudienceSnapshot/Member`, `outreachContact`, `studioReputationEvent` com unique type+refId :203).

## Tasks & Acceptance

**Execution:**
- [ ] `prisma/schema.prisma` + migrate `20261001090000_studio_campaign_journey` -- `StudioCampaign.journey Json?` -- 3.1.
- [ ] `studio/journey.js` (novo) -- `PHASES`; `computeJourney(campaign, {hasContent, hasSchedule, snapshotCount})` (espelha `currentRailStep`); `recordJourney(prisma, campaign, {event})` persiste `{phase, completed:{...}, updatedAt}` (decisão fechada FR2 → audiência concluída); `guardAction(actionType, journey, {hasContent})` → `{ok, block?{missing[]}}` — só salto à frente com pré-requisito ausente bloqueia (`set_schedule` exige conteúdo) -- 3.1.
- [ ] `studio/chat-routes.js` -- guard em `runAction` (card `journey_block` com o que falta, sem jargão; sem gravar run); `recordJourney` após sucesso de set_objective/set_audience(>0)/geração de conteúdo/set_schedule/status scheduled; linha JORNADA em `buildStateBlock` + regra no `SYSTEM_PROMPT` (avança em ordem; servidor explica atalho) -- 3.1.
- [ ] `studio/campaign-service.js` -- `syncQueueWithAudience(prisma, campaign, includedProspectIds)`: por execução (email/WA), contatos não enviados (`SELECTED|QUEUED|GENERATING|SCHEDULED`) fora da seleção → `CANCELLED`/`cancelReason:'removido_da_selecao'` + estorno unitário idempotente (`sync:{campaignId}:{channel}:{contactId}`); chamado ao fim de `materializeAudience` (no-op sem execução); falha de estorno logada, não quebra -- 3.2.
- [ ] `studio/campaign-routes.js` GET `/queue` -- `divergence: {count, byChannel, reason}` = contatos NÃO cancelados/enviados fora da seleção ativa (explicável) -- 3.3.
- [ ] `apps/web` `CampaignMonitorView.tsx` -- banner da divergência (quantos e por quê, tokens 011, some quando 0) -- 3.3.
- [ ] `eval/lib.js` -- asserções `cardOrder`, `audienceCountAtLeast`, `certificateGreen`, `actionNotRepeated`; `eval/conversations/journey-v1.json` -- cenário `journey-e2e` (objetivo→audiência industrial→conteúdo 2 canais→agenda→certificado) com asserções de ordem canônica, `audienceCountAtLeast: 50` (D5) e `certificateGreen` -- 3.4.
- [ ] `test/journey-state.test.js` + `test/queue-enrollment.test.js` (suítes L0 nomeadas pela matriz) + ajustes nos testes existentes que emitirem atalho -- 3.1/3.2.

**Acceptance Criteria:**
- Given campanha nova, when turnos avançam, then fase corrente persistida e orchestrate informado das válidas.
- Given `set_schedule` sem conteúdo (chat ou chip), then recusa explicável do que falta; ação de fase ≤ corrente nunca bloqueada.
- Given decisão fechada FR2 (set_audience count>0), then fase audiência marcada concluída.
- Given 3 matriculados e seleção encolhe para 2, then fila sincroniza: removido CANCELLED + estorno único (replay não duplica), zero envio ao removido, messageId estável, `StudioActionRun` intacto.
- Given divergência na janela, then Monitor explica quantos e por quê e some após sincronização.
- Given dataset `journey-v1`, when `journey-e2e` roda, then asserções de ordem canônica + `audienceCountAtLeast` + `certificateGreen` definidas (verde contra QA conta em 3 execuções após deploy).

## Implementation Notes

_(preenchido na implementação — 2026-10-01)_

- **`studio/journey.js`**: derivação server-side espelha `currentRailStep` (SPA) com nomes canônicos da
  spec; audiência decidida = DECISÃO FECHADA FR2 (materialização com count > 0) — regra ÚNICA, usada
  tanto na persistência quanto no preview do prompt (review E3-L7). `syncJourney` é resiliente
  (review E3-M3): count/update em try/catch — falha de persistência loga com stack e NÃO reclassifica
  a run como failed (retry duplicaria conteúdo). Guard: só `set_schedule` sem conteúdo bloqueia
  (caso canônico da spec); revisão de fase ≤ corrente nunca bloqueia (onda "sem bloqueios" preservada).
- **Guard** em `runAction` DEPOIS de `manifest.validate` e ANTES do ramo capture/`runIdempotent` —
  bloqueio vira card `journey_block` (missing + nextAction), NUNCA grava `StudioActionRun` (replay
  posterior executa de verdade). Chips (POST `/actions`) passam pelo mesmo caminho.
- **Call sites de `syncJourney`**: set_objective (mark 'objetivo'), set_audience/select_leads
  (mark 'audiencia' só com count > 0), generate_content (mark 'conteudo'), set_schedule (mark
  'agenda' + 'certificado' quando status vira scheduled).
- **Sync de fila** (`syncQueueWithAudience` dentro de `materializeAudience` — ponto único por onde
  toda mudança de seleção passa): cancela por `updateMany` com guard de status (review E3-H1 — quem
  caiu em SENDING/SENT entre a leitura e a escrita NÃO é mexido); estorno unitário (refId
  `sync:{campaignId}:{canal}:{contactId}`) só para contato LIBERADO (débito = liberação do lote,
  `enqueueBatch`) e SEM mensagem própria.
- **Corrida sync×worker fechada na raiz** (review E3-M2): o branch de contato terminal dos DOIS
  motores usa o MESMO refId do sync quando `cancelReason === 'removido_da_selecao'`
  (`_refundForTerminalContact` no e-mail com `studioCampaignId` no select do campaign;
  `_refundForSyncedContact` no WhatsApp carregando `WhatsAppCampaign.studioCampaignId`) — unique
  `(type, refId)` deduplica entre os caminhos; demais terminais seguem AD-13 por messageId.
- **Divergência no `/queue`** (Story 3.3): computada viva, SEM `SENDING` (review E3-L4 — quem está
  em envio vai receber; copy honesta) e snapshot com `orderBy createdAt desc take 1` (E3-L5). Banner
  amber no Monitor some sozinho quando a conta fecha.
- **Eval (Story 3.4)**: asserções novas em `eval/lib.js` (`cardOrder` subsequência,
  `cardPresentUnique`, `audienceCountAtLeast`, `certificateGreen` strict:false = pronto-para-voo sem
  bloqueio, `actionNotRepeated` via traces); runner ganha `caseDef.channels`, `caseDef.calls` (HTTP
  da zona de decisão), `traces`+`certificate` no ctx; client ganha `getCertificate`/`callJson`.
  Dataset `journey-v1` (turno 4 = proxy de não-re-pergunta).
- **Verificação**: 821 testes root (820 pass + 1 flake pré-existente `studio-scheduler.test.js:240`
  — depende do relógio, falha entre 9h–12h SP; documentado na memória), 111 web, build ok, prisma
  validate ok. Falha de `--test-force-exit` necessária (servidores keep-alive).

## Plan Change Log

_(vazio até o primeiro loopback de review)_

## Review Triage Log

### 2026-10-01 — Review pass 1 (quick, ecc:code-reviewer) — 7 findings: high 1, medium 2, low 4
- [high] [patch] E3-H1 — update incondicional do sync pode clobber SENDING/SENT (e-mail enviado
  viraria CANCELLED; WA pode sobrescrever CANCELLED com SENDING) — fix: `updateMany` com guard
  `status in UNSENT` + skip quando count=0.
- [medium] [patch] E3-M2 — corrida de duplo estorno sync×worker (refIds distintos não deduplicam) —
  fix: branch terminal dos motores usa o refId determinístico do sync quando
  `cancelReason='removido_da_selecao'`.
- [medium] [patch] E3-M3 — falha de syncJourney derruba action com efeito já aplicado (retry
  duplicaria conteúdo) — fix: try/catch interno com log e retorno `stale`.
- [low] [patch] E3-L4 — banner contava SENDING que o sync nunca remove (copy falsa) — fix: SENDING
  fora da divergência.
- [low] [patch] E3-L5 — snapshot ativo sem orderBy — fix: `createdAt desc take 1`.
- [low] [patch] E3-L6 — fase 'objetivo' nunca persistida — fix: syncJourney no set_objective.
- [low] [patch] E3-L7 — duas regras de audiência decidida — fix: regra única (decisão fechada FR2).
- Verificação pós-patch: 820/821 (flake de horário pré-existente), web 111, build ok.

## Design Notes

- **Estado explícito, não fonte nova de verdade:** a fase é DERIVADA do estado materializado (mesma derivação do cliente) e PERSISTIDA como explicitação (`journey.completed` marca com timestamp; a decisão fechada FR2 marca audiência). O guard usa estado real (conteúdo existe?) — nunca confia só no Json.
- **Bloqueio mínimo:** só salto à frente com pré-requisito ausente. A onda "sem bloqueios" liberou conteúdo/materiais fora de ordem — isso fica. O exemplo canônico (agendar sem conteúdo) é o caso de atalho que gera campanha quebrada na aprovação.
- **Sync dentro de materializeAudience:** ponto único por onde TODA mudança de seleção passa (rota, chat, chips) — a fila nunca diverge além da janela de uma request. Cancelamento por status + cancelReason próprio; motores já tratam contato terminal (estorno idempotente por messageId), então job Bull em voo vira no-op.
- **Divergência é computada viva no /queue** (não armazenada): a janela é real (envios em voo), o banner some sozinho quando a conta fecha — sem estado para esquecer de limpar.

## Verification

**Commands:**
- `pnpm test` -- esperado: `journey-state` + `queue-enrollment` verdes; suítes studio-*/outreach-* sem regressão (flake conhecido: `studio-scheduler.test.js:240` de manhã).
- `npx prisma validate` -- esperado: válido.
- `pnpm -C apps/web build` -- esperado: compila (banner novo).
- Pós-deploy: `B2BASE_EVAL_CASES=eval/conversations/journey-v1.json pnpm run eval:chat` ×3 -- esperado: verde nas 3.

**Manual checks (opcional):**
- Monitor com campanha em voo e seleção encolhida: banner aparece e some.
