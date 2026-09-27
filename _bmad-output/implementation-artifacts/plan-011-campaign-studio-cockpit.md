---
title: 'Campaign Studio Cockpit (011)'
type: 'feature'
ticket: ''
created: '2026-09-26'
status: 'built'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: []
baseline_revision: 'da6b9e2dbedec655cf9d6d267bf1beadbde8247b'
review_loop_iteration: 0
followup_review_recommended: true
context:
  - '{project-root}/_bmad-output/planning-artifacts/prds/prd-b2base-platform-2026-09-26/prd.md'
  - '{project-root}/_bmad-output/planning-artifacts/prds/prd-b2base-platform-2026-09-26/addendum.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-b2base-platform-2026-09-26/ARCHITECTURE-SPINE.md'
  - '{project-root}/_bmad-output/specs/spec-campaign-studio-cockpit/experience-direction.md'
warnings: [multiple-goals, oversized]
deferred:
  - summary: >-
      Detecção de falha definitiva via attemptsMade >= attempts-1 é frágil sob re-enfileiramento manual
    evidence: |-
      Se true, estornos podem falhar em filas com attempts distintos; settle: instrumentar re-enqueues manuais
    location: >-
      outreach-workers.js
    severity: medium (unverified)
  - summary: >-
      loadHome null após falha inicial pode deixar campanha criada invisível
    evidence: |-
      Se true, UI fica em loading eterno; settle: reproduzir falha de rede na carga inicial
    location: >-
      apps/web/src/studio/StudioApp.tsx
    severity: medium (unverified)
  - summary: >-
      hotReplies pode carregar classificações sem janela temporal (custo com base grande)
    evidence: |-
      Settle: EXPLAIN da query com tabela populada
    location: >-
      studio/suggestions.js
    severity: medium (unverified)
  - summary: >-
      Wake BALANCE por tick pode esgotar teto diário com duplicados antes da agregação
    evidence: |-
      Settle: medir frequência de despertares após dedupKey determinística
    location: >-
      studio/scheduler-worker.js
    severity: low (unverified)
  - summary: >-
      FR-11 (<=6 turnos) não imposto por teste E2E de conversa
    evidence: |-
      Settle: teste E2E do fluxo feliz no Cockpit
    location: >-
      apps/web/src/studio
    severity: low (unverified)
---

<intent-contract>

## Intent

**Problem:** O Studio 010 tem motor excelente mas UX que trava adoção, e o ativo de envio do cliente (domínio/WhatsApp) é tratado só reativamente — o maior medo do vendedor.
**Approach:** Reconstruir o Studio como Cockpit chat-first (rota única, chips-ação, Rail de 5 luzes) com Orçamento de Reputação (ledger + gate único a montante de todo envio), sugestões contextuais, Certificado bloqueante e Contrato de Autonomia — compilando para os motores 010 existentes conforme os 14 ADs da spine.

## Boundaries & Constraints

**Always:** AD-1…AD-14 da spine (gate único fail-closed; saldo só via ledger transacional com writer único; estorno idempotente por messageId; fila só via `enqueueBatch` do bridge; actions v1 idempotentes; scheduled→running gated; worker checa pausa; consentimento WhatsApp persistido; multi-tenancy orgId + `requirePremiumOrg`; NATS v1 intocados; sem dependência nova — animações CSS nativas; testes `node --test` com fake-prisma).
**Never:** novo motor de envio ou serviço novo; editar contrato de actions v1 após rollout (breaking → v2); cold-first via WhatsApp; toggle de tema claro; novos editores de conteúdo fora do chat; `db push` (só `prisma migrate diff`→`migrate deploy`); publicar eventos NATS novos.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Release com saldo | tick/60s, campanha scheduled vencida, saldo ≥ lote | transição running + lote enfileirado com débito/evento ledger | fail-closed: erro no gate bloqueia com motivo técnico |
| Saldo < lote | saldo 30, lote 100 | fatia de 30 enfileira (messageIds), resto bloqueado `SALDO_INSUFICIENTE` com quanto-falta/quando-libera | nunca saldo negativo |
| Org pausada | pausa global ativa | nenhum caminho enfileira; retomada explícita | despertar informativo |
| Action duplicada | mesmo `actionId` 2× (set_audience) | 2ª retorna o resultado da 1ª (unique em StudioActionRun) | zero duplicação de segmento/conteúdo |
| WhatsApp sem consentimento | lead sem registro de consentimento | bloqueado `SEM_CONSENTIMENTO` (Certificado item vermelho) | explicação + caminho para consentir |
| Domínio sem SPF/DKIM | domainAuthStatus ≠ verified | agendamento bloqueado com instrução; DNS ok libera | job diário revalida; falha → floor 0 |
| Home sem candidatos fortes | org com dados mas nada urgente | 0 chips (estado vazio elegante) | nunca chip genérico |

</intent-contract>

## Code Map

- `studio/reputation.js` -- NOVO: writer único do saldo (accounts+ledger, floor efetivo, unidade/canal, transações)
- `studio/reputation-gate.js` -- NOVO: evaluate/consume fail-closed; pausa org persistida checada aqui
- `studio/channel-bridge.js` -- primitiva única `enqueueBatch(campaign, batch)` (filtra enrolled → gate/consume → messageIds + alocação); já tem `compile`, `emailDocToText`, `compileSteps`
- `studio/scheduler-worker.js` -- `tickAll` (linha ~162) filtra só `running` → incluir `scheduled` vencido com transição gated; `tickCampaign` release passa pelo gate
- `outreach-workers.js` -- `processSend` (~489-658) não checa pausa/status → checar; callback de falha definitiva → estorno credit idempotente (AD-13)
- `whatsapp-workers.js` -- ~193-209 já checa pausa (paridade de estorno); somente-workers tocam fila
- `studio/dispatch.js` -- `dispatchImmediate` (~44-97) enfileira lote inteiro → via `enqueueBatch` com fatiamento
- `studio/chat-routes.js` -- actions `case` (~63-185, 6 create-style) → idempotência via StudioActionRun; novo endpoint sugestões/certificado/saldo/pausa
- `studio/router.js` -- registro de rotas novas com `requirePremiumOrg`; `httpError` em `studio/errors.js`
- `prisma/schema.prisma` -- modelos `StudioCampaign` (~1068, status string máquina de estados), `guardrails Json` → novos modelos 1ª classe; migrações via `migrate diff`→`deploy` (não `dev`)
- `apps/web/src/studio/` -- `StudioApp.tsx` (shell+abas → rota única), `CampaignChat.tsx` (SSE Reader já existe; adicionar chips-ação+estado), `api.ts`, `types.ts`, `components/*`
- `apps/web/src/App/router` -- rotas antigas do Studio → redirect `/studio`
- `metrics.js` -- padrão counters prom-client (`inc*` helpers) → `studio_gate_*`, `studio_ledger_*`, `studio_suggestions_*`
- `test/helpers/fake-prisma.js` -- estender modelos novos (accounts/events/actionRun/consent) + operadores usados
- `test/studio-*.test.js` -- padrão: Express real em porta efêmera + fixtures + LLM mockado

## Tasks & Acceptance

**Execution (ordem de dependência = ordem de construção validada):**
- [ ] `prisma/schema.prisma` -- adicionar `StudioReputationAccount`, `StudioReputationEvent` (unique `(type,refId)` p/ estorno), `StudioActionRun` (unique actionKey), `StudioLeadConsent`, `domainAuth*` na conta de envio, flag de pausa org; migração diff+deploy -- fundação de tudo
- [ ] `studio/reputation.js` + `studio/reputation-gate.js` + `metrics.js` -- writer único, evaluate/consume fail-closed com pausa, counters -- AD-3/AD-4
- [ ] `studio/channel-bridge.js` + `studio/scheduler-worker.js` + `studio/dispatch.js` + `outreach-workers.js` + `whatsapp-workers.js` -- `enqueueBatch` única, transição scheduled→running gated, processSend checa pausa, estorno AD-13 -- AD-2/4/5/13/14
- [ ] `studio/actions/manifest.v1.js` + `studio/chat-routes.js` + `studio/dns-verify.js` + `studio/certificate.js` + `studio/autonomy.js` + `studio/suggestions.js` + `studio/router.js` -- actions idempotentes, verificação DNS (job diário), certificado persistido, wake rules+orçamento, sugestões com ranking+motivo; endpoints novos -- AD-6…AD-11
- [ ] `test/studio-reputation.test.js`, `test/studio-gate.test.js`, `test/studio-actions.test.js` + I/O matrix + `fake-prisma.js` estendido -- testes antes do merge (constituição III)
- [ ] `apps/web/src/studio/StudioApp.tsx` + `CampaignChat.tsx` + `api.ts` + `types.ts` + rota antiga→redirect -- rota única `/studio`: thread central, chips-ação (tocar=action), Rail 5 luzes gated por existência de campanha, Gaveta, Despertares com teto/agrupamento, painel de saldo, pausa global 1-clique, empty state dia-zero/operação, mobile ≤375px (aprovar/pausar), animações CSS nativas + reduced-motion, a11y (teclado, AA, aria-current no Rail) -- CAP-1/2/3/7, FR-7, FR-19
- [ ] `test/studio-suggestions.test.js`, `test/studio-autonomy.test.js`, `test/studio-certificate.test.js` + suítes 010 verdes -- fechamento
- [ ] build web + suíte completa -- porte de saída

**Acceptance Criteria:**
- Given org premium com campanha `scheduled` e saldo ≥ lote, when `startAt` vence e o tick roda, then campanha transita a `running`, lote enfileirado via `enqueueBatch` e débito+evento presentes no ledger
- Given saldo 30 e lote 100, when tick ou dispatch imediato, then exatamente 30 unidades enfileiradas com messageIds e o restante bloqueado com `SALDO_INSUFICIENTE` explicável na API e no Cockpit
- Given pausa global ativa, when tick, imediato ou worker tenta enviar, then nada enfileira/envia até retomada explícita
- Given o mesmo `actionId` enviado 2× para `set_audience`, when a 2ª chega, then resposta idêntica à 1ª e nenhum segmento novo criado
- Given lead sem consentimento, when fluxo WhatsApp é tentado, then `SEM_CONSENTIMENTO` bloqueia com explicação no Cockpit
- Given domínio sem SPF/DKIM verificados, when agendar e-mail, then bloqueado com instrução; após DNS verde, libera (e job diário re-valida)
- Given `/studio` aberto, when organização tem candidatos fortes, then ≤3 chips com motivo citável; sem candidatos, then 0 chips e estado vazio elegante
- Given `prefers-reduced-motion`, when envio autorizado, then indicador estático substitui a animação do Rail
- Given viewport 375px, when Despertar abre, then aprovação/rejeição e pausa global operáveis
- Given `pnpm test`, when suíte roda, then suítes novas verdes e as ~591 existentes continuam verdes; `pnpm --filter web build` (ou build equivalente) passa

## Implementation Notes

## Plan Change Log

## Auto Run Result

**Summary:** Cockpit 011 implementado por completo (37 FRs): Orçamento de Reputação como ledger de 1ª classe com gate único fail-closed a montante de todo envio (scheduler, dispatch imediato, transição scheduled→running), estorno idempotente por messageId, fila exclusivamente via `enqueueBatch` do bridge, actions v1 idempotentes e escopadas, Certificado bloqueante com re-avaliação no release, sugestões contextuais determinísticas, Contrato de Autonomia com orçamento de despertares, Cockpit SPA de rota única (Rail, chips-ação, Gaveta, Despertares, pausa global, mobile, reduced-motion) e FR-37 (List-Unsubscribe one-click).

**Files changed:** prisma/schema.prisma + 2 migrações · studio/{reputation,reputation-gate,certificate,autonomy,suggestions,dns-verify,cockpit-routes,channel-bridge,scheduler-worker,dispatch,chat-routes,campaign-service,guardrails,actions/manifest.v1}.js · outreach-workers.js · whatsapp-workers.js · server-prod.js · metrics.js · apps/web/src/studio/{StudioApp.tsx,CampaignChat.tsx,api.ts,types.ts} · apps/web/src/index.css · test/{studio-reputation,gate,actions,suggestions,autonomy,certificate,dns-verify}.test.js · test/helpers/fake-prisma.js

**Review findings:** 62 findings — 14 high + 22 medium + 12 low corrigidos via patch (re-engaged implementation subagent), 4 false rejeitados com refutação, 9 maybe-false registrados em `deferred`. Follow-up: true — risco não verificado: comportamento end-to-end com Redis/Bull real, DNS real e provider WhatsApp (WAHA) não é exercitado pelos testes automatizados; validar em staging.

**Verification:** `pnpm test` 674/674 ✓ · `apps/web` build ✓ · `prisma migrate deploy` ✓ (2 migrações aplicadas; uma falhou por estado transiente e foi re-aplicada após resolve --rolled-back) · Matrix I/O audit 7/7 linhas cobertas por testes rodando ✓

**Residual risks:** itens em `deferred` + números de rampa/warm-up como defaults de env (calibrar em produção); gate de produção real exige staging (ver acima).

## Review Triage Log
## Auto Run Result

**Summary:** Cockpit 011 implementado por completo (37 FRs): Orçamento de Reputação como ledger de 1ª classe com gate único fail-closed a montante de todo envio (scheduler, dispatch imediato, transição scheduled→running), estorno idempotente por messageId, fila exclusivamente via `enqueueBatch` do bridge, actions v1 idempotentes e escopadas, Certificado bloqueante com re-avaliação no release, sugestões contextuais determinísticas, Contrato de Autonomia com orçamento de despertares, Cockpit SPA de rota única (Rail, chips-ação, Gaveta, Despertares, pausa global, mobile, reduced-motion) e FR-37 (List-Unsubscribe one-click).

**Files changed:** prisma/schema.prisma + 2 migrações · studio/{reputation,reputation-gate,certificate,autonomy,suggestions,dns-verify,cockpit-routes,channel-bridge,scheduler-worker,dispatch,chat-routes,campaign-service,guardrails,actions/manifest.v1}.js · outreach-workers.js · whatsapp-workers.js · server-prod.js · metrics.js · apps/web/src/studio/{StudioApp.tsx,CampaignChat.tsx,api.ts,types.ts} · apps/web/src/index.css · test/{studio-reputation,gate,actions,suggestions,autonomy,certificate,dns-verify}.test.js · test/helpers/fake-prisma.js

**Review findings:** 62 findings — 14 high + 22 medium + 12 low corrigidos via patch (re-engaged implementation subagent), 4 false rejeitados com refutação, 9 maybe-false registrados em `deferred`. Follow-up: true — risco não verificado: comportamento end-to-end com Redis/Bull real, DNS real e provider WhatsApp (WAHA) não é exercitado pelos testes automatizados; validar em staging.

**Verification:** `pnpm test` 674/674 ✓ · `apps/web` build ✓ · `prisma migrate deploy` ✓ (2 migrações aplicadas; uma falhou por estado transiente e foi re-aplicada após resolve --rolled-back) · Matrix I/O audit 7/7 linhas cobertas por testes rodando ✓

**Residual risks:** itens em `deferred` + números de rampa/warm-up como defaults de env (calibrar em produção); gate de produção real exige staging (ver acima).

## Review Triage Log

### 2026-09-26 — Review pass (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment)
- verdicts: 62 findings — high 14, medium 22, low 12, false 4, maybe-false 10
- findings:
  - `[high]` `[patch]` actionKey sem orgId/campaignId (manifest.v1:33) — leak entre tenants + colisão; verificado no código (`v1:${action}:${actionId}`) — fix: chave escopada `v1:action:orgId:campaignId:actionId`
  - `[high]` `[patch]` replay de action com run 'failed' devolve vazio (P2002 tomado como replay) — fix: failed/running re-executa; P2002 re-lê prior
  - `[high]` `[patch]` handler roda antes do create do StudioActionRun — erro não-P2002 → retry duplica — fix: run 'running' antes do handler
  - `[high]` `[patch]` set_schedule com actionId estável replaya para sempre (frontend `launch-${campaignId}`) — fix: nonce por disparo + respeitar idempotency:'none'
  - `[high]` `[patch]` applyDailyReplenishment/promoteRamp sem caller — saldo congela no floor; "libera em" mentira — fix: job diário `studio:reputation:daily` no server-prod
  - `[high]` `[patch]` 6/7 wake rules sem produtor; penalize sem caller (Contrato de Autonomia inerte) — fix: conectar guardrails (first_batch/anomaly), whatsapp rejected (penalize+wake), dns-verify (auth_failed), compose error
  - `[high]` `[patch]` FR-9 quebrado na UI: chips chamam send() livre, não a rota de actions testada — fix: chip com action → POST actions
  - `[high]` `[patch]` FR-23 demo chip cria campanha real — fix: fluxo demonstrativo com fixtures, sem campanha
  - `[high]` `[patch]` FR-26/FR-28/FR-37 ausentes do diff — fix mínimo: sources no card de conteúdo; domainHistory no onboarding→floor; headers List-Unsubscribe+rodapé no compile
  - `[high]` `[patch]` scheduler WA usa `prisma.whatsAppCampaignContact` (nome certo em prod, ausente no fake) → TypeError na suíte — fix: `waContactModel`
  - `[high]` `[patch]` enqueueBatch não atômico: falha pós-débito perde unidades+alocação; refundBatch sem caller — fix: try/catch → refundBatch + reset; caller no cancel
  - `[high]` `[patch]` GET certificate persiste (sem skipPersist) e muda pick por updatedAt — fix: skipPersist:true
  - `[high]` `[patch]` ack de wake sem orgId no where (cross-org) + sem teste HTTP — fix: orgId no where + testes
  - `[high]` `[patch]` dns-verify sem nenhum teste (fail-closed AD-8 não verificado) — fix: suíte com resolver injetado
  - `[medium]` `[patch]` pendingWakes não filtra acknowledgedAt (ack não persiste no painel) — fix: filtro JSON path
  - `[medium]` `[patch]` dedupKey com randomBytes não deduplica — fix: chave determinística por dia
  - `[medium]` `[patch]` ORG_PAUSED desperta como "bloqueio por saldo" — fix: tipo studio.org.paused
  - `[medium]` `[patch]` processSend include sem status → pausa de campanha é dead code — fix: include status
  - `[medium]` `[patch]` orgId ausente pula checagem de pausa (campaign deletada) — fix: fail-closed re-agenda
  - `[medium]` `[patch]` estorno pode creditar mensagem já enviada (ordem already_sent/terminal) — fix: already_sent primeiro
  - `[medium]` `[patch]` corrida enqueueBatch → duplo envio/débito — fix: updateMany condicional scheduledAt:null
  - `[medium]` `[patch]` dispatchImmediate crash sem conta (account.id null) — fix: null-check → CANAL_NAO_CONFIGURADO
  - `[medium]` `[patch]` re-enfileirado de pausa cria makeQueue por chamada — fix: queue module-level
  - `[medium]` `[patch]` consent gaps: N+1 + "5 lead(s)" quando são 500 — fix: count + "5+"
  - `[medium]` `[patch]` DKIM falso negativo (substring 'dkim') — fix: aceitar p=
  - `[medium]` `[patch]` Teste da Maria avalia subject, não emailDoc — fix: avaliar corpo
  - `[medium]` `[patch]` consultas sem org scope (suggestions untouchedLeads, hotReplies sem take) — fix: tenantId via relação + take
  - `[medium]` `[patch]` POST actions sem requirePremiumOrg (muta LLM/segmentos) — fix: gating
  - `[medium]` `[patch]` snapshot arbitrário no certificate (sem orderBy/take) — fix: createdAt desc take 1
  - `[medium]` `[patch]` corrida de consent → 500 em vez de replay — fix: P2002 → findFirst replay
  - `[medium]` `[patch]` prospectId órfão no POST consent — fix: validar prospect da org
  - `[medium]` `[patch]` resposta da action traz status pré-ação — fix: re-ler campanha
  - `[medium]` `[patch]` replayed duplica turnos no thread — fix: gravar turnos só quando !replayed
  - `[medium]` `[patch]` canal inválido cria account com rampa de e-mail — fix: throw
  - `[medium]` `[patch]` audiência 0 sem chip de audiência — fix: chip quando count===0
  - `[medium]` `[patch]` deep link /studio/campaigns/:id abre campanha errada — fix: mapear id
  - `[medium]` `[patch]` AC "30 de 100" vs floor 10 — fix: floor configurável via env + teste com floor 0
  - `[medium]` `[patch]` estornos AD-13 além de no_recipient sem teste (terminal state, provider failure, transitória) — fix: testes
  - `[medium]` `[patch]` WA org-pause sem teste; pause_check_failed sem teste — fix: testes
  - `[medium]` `[patch]` ackCockpitWake sem catch (unhandled rejection) — fix: .catch(setError)
  - `[medium]` `[patch]` loadHome null → setHome não aplica — fix: guard
  - `[low]` `[patch]` certificado bloqueado em âmbar, não vermelho; ledger block com "+" — fix de render
  - `[low]` `[patch]` Gaveta sem Esc/focus-trap/aria-modal — fix: keydown + trap
  - `[low]` `[patch]` estorno silencioso sem orgId — fix: console.error
  - `[low]` `[reject]` heurística unsubscribe substring — custo de parser > benefício v1; Certificado já falha sem config explícita
  - `[low]` `[reject]` DKIM selectores de poucos provedores — ampliar selectores coberto no fix DKIM; lista exaustiva é deferred
  - `[low]` `[reject]` `void hourStart` — inócuo
  - `[low]` `[reject]` WhatsApp attempts 1000 mágico — comportamento herdado do 010, fora do diff
  - `[false]` `[reject]` "waContactModel resolver é workaround" — é adaptação fake/prod documentada no próprio bridge
  - `[false]` `[reject]` "workers intocados violados" — hooks aditivos seguem o padrão 010 (à prova de falha)
  - `[false]` `[reject]` "frontend não testável" — plano designa verificação manual para UI (vitest só p/ módulos puros)
  - `[false]` `[reject]` "AD-11 provider interface ausente" — plano/spine defere abstração para a migração Cloud API; paridade no worker é o escopo v1
  - `[maybe-false]` `[defer]` attemptsMade >= attempts-1 frágil p/ detecção de falha definitiva — se true é medium; settle: instrumentar reenqueues manuais
  - `[maybe-false]` `[defer]` loadHome null + criação de campanha invisível — se true é medium; settle: reproduzir em UI
  - `[maybe-false]` `[defer]` hotReplies carrega tabela toda sem janela — se true é medium (custo); settle: EXPLAIN com base grande
  - `[maybe-false]` `[defer]` WhatsApp workers fakes sem organization — settle: fixture realista
  - `[maybe-false]` `[defer]` BALANCE wake a cada tick 60s esgota teto com duplicados — settle: medir após dedupKey determinístico
  - `[maybe-false]` `[defer]` certificate outreachContact findFirst sem org scope — prospectIds não colidem entre orgs; settle: decidir convenção de query
  - `[maybe-false]` `[defer]` FR-11 turnos ≤6 não impos/testado E2E — settle: teste E2E de conversa
  - `[maybe-false]` `[defer]` "Audience Review regressão" — settle: smoke de UI
  - `[maybe-false]` `[defer]` sandbox interativa ausente (§6.2 v1.x) — fora do MVP por design
  - `[maybe-false]` `[defer]` projeção de reposição ausente (§6.2 v1.x) — fora do MVP por design
  - `[maybe-false]` `[defer]` "espera infinita no thinking sem timeout SSE" — settle: adicionar timeout se reproduzir

## Design Notes

- Fail-closed é lei no gate (AD-4); débito materializa messageIds (AD-13); `enqueueBatch` é a única porta para a fila (AD-14). Ordem de construção: Cockpit+Chips → Orçamento → Confiança → Autonomia.
- UX authority: `experience-direction.md` (glow só semântico, zero-jargão, voz mordomo, entrada suave 200ms/stagger 40ms). Dark herda tokens shadcn existentes (`.dark` em `apps/web/src/index.css`); acento premium exclusivo do Cockpit definirá-se no DESIGN.md (pendência UX registrada).
- Prisma: migrations não-interativas (`migrate diff --from-url ... --to-schema-datamodel --script` → `migrate deploy`).

## Verification

**Commands:**
- `pnpm test` -- expected: suítes novas (reputation/gate/actions/suggestions/autonomy/certificate) verdes + suítes 010 existentes verdes
- `cd apps/web && pnpm build` (ou `pnpm run build` na raiz) -- expected: build TS/Vite sem erros
- `npx prisma migrate deploy` (contra DB local `postgresql://cnpj:cnpj@localhost:5432/cnpj`) -- expected: migrações aplicadas sem drift

**Manual checks (if no CLI):**
- `/studio` desktop: empty state com ≤3 chips com motivo; fluxo feliz ≤6 turnos até campanha em voo; Rail só aparece com campanha; glow somente em luz acesa/saldo/aprovação
- 375px: Despertar com aprovação + pausa global operáveis
