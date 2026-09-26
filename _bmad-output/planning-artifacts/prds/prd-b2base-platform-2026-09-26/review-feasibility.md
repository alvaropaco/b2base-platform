# Review de Viabilidade de Engenharia — PRD Campaign Studio Cockpit (011)

- **Data:** 2026-09-26
- **Entrada:** `prd.md` + `addendum.md` (mesma pasta)
- **Base de código verificada:** `studio/` (router, chat-routes, campaign-service, scheduler-worker, guardrails, channel-bridge, compliance-service, dispatch, ai/), `outreach-workers.js`, `whatsapp-workers.js`, `apps/web/src/studio/` (StudioApp.tsx, CampaignChat.tsx, api.ts), `prisma/schema.prisma`.

## Veredito

**VIÁVEL COM RESSALVAS.** A tese central do addendum — "o Cockpit se apoia no 010 sem reescrever" — confere para o **backend**: bridge de canais, transporte SSE, ações semânticas, pipeline LiteLLM, classificação de respostas com confiança e guard-rail do 1º lote existem exatamente onde o addendum diz. Porém, três premissas do PRD **não** conferem contra o código e viram trabalho explícito no plan: (1) as ações do orquestrador não são idempotentes como FR-9 assume; (2) o gate do Saldo "a montante da fila" não cobre envio imediato nem o que já está na fila (FR-15/FR-19); (3) campanhas `scheduled` nunca são processadas pelo scheduler atual — o clímax do UJ-1 ("campanha em voo" agendada) hoje não despacharia. A camada web (`apps/web/src/studio`) é reconstrução quase total, não encaixe.

---

## Achados — Alta

### A1. FR-9: ações semânticas existem, mas 3 de 6 NÃO são idempotentes
**FR-9** exige "tocar um Chip dispara a ação de backend correspondente (idempotente)".

As ações com os nomes do PRD existem em `runAction` (`studio/chat-routes.js:63-188`): `set_objective` (:63), `set_audience` (:75), `attach_url` (:100), `confirm_material` (:113), `generate_content` (:120), `set_schedule` (:144). Idempotência por ação:

| Ação | Comportamento | Idempotente? |
|---|---|---|
| `set_objective` | `update` por id, last-write-wins (:64-70) | Sim |
| `set_schedule` | `update` por id (:167) | Sim |
| `confirm_material` | seta `confirmedAt` via `confirmExtraction` | Sim (no-op se já confirmado) |
| `set_audience` | cria **nova** `StudioSegment` a cada chamada (:84-92) + LLM `segment-nl` + snapshot (o snapshot antigo é superseded em `campaign-service.js:126-129`, então o *estado* converge, mas as linhas de segmento se acumulam e cada toque repaga LLM + full scan de prospects) | **Não** |
| `attach_url` | cria **novo** material + re-extração LLM a cada chamada (:100-111) | **Não** |
| `generate_content` | `generateAndStorePackage` cria **novo pacote de variações** a cada chamada (:130-136) | **Não** |

Dois toques no chip "Gerar conteúdo" = duas séries de variações duplicadas em revisão. O FR-9 assume idempotência que o código não tem; o plan precisa definir (chave de idempotência por campanha+ação, ou dedupe no cliente) — não é "apoiar-se no existente", é endurecer contrato. O addendum já pede versionamento do contrato das actions; somar a isso a semântica de idempotência explícita por action.

### A2. FR-15/FR-19: o gate "a montante da fila" não cobre dispatch imediato nem a fila em voo
O addendum afirma: "Novos FRs de envio (Saldo, Certificado) operam **antes** da fila existente, como gate". Contra o código:

- **O ponto de encaixe no scheduler é real e bom**: `tickCampaign` (`studio/scheduler-worker.js:24-136`) já encadeia gates (startAt :28, 1º lote :33, janela :38, cota :44-55) antes de liberar lotes de `QUEUED` — o Saldo entra como mais um gate e o bloqueio explicável do FR-15 é naturalmente implementável ali.
- **Porém o dispatch imediato ignora esse caminho**: `runImmediateDispatch` (`studio/campaign-service.js:279-321`) → `dispatchImmediate` (`studio/dispatch.js:44-97`) enfileira a **audiência inteira de uma vez** em `outreach:prepare` (stagger de 500 ms, `outreach-workers.js:1000-1012`). Não há lote. "Nenhum lote excede o saldo vigente" (FR-15) e "o saldo de warm-up libera um primeiro lote pequeno" (UJ-1) exigem **fatiamento por saldo** no modo imediato — lógica que não existe; ou o modo imediato bloqueia sempre que audiência > saldo, ou o Saldo precisa de release incremental também fora do scheduler.
- **E o que já está na fila não para**: `processSend` (`outreach-workers.js:489-658`) consulta apenas estados terminais do contato (:513) e rate limit (:528) — **nunca** o status da campanha Studio ou um flag de pausa da org. Mensagens já em `outreach:message-send` (delayed pelo rate limiter) e follow-ups agendados para dias depois (`_scheduleFollowup` :853-916) disparam normalmente após uma "pausa global" (FR-19). O motor de WhatsApp, em contraste, **checa** `PAUSED/CANCELLED` por contato (`whatsapp-workers.js:193-209`) — a pausa funciona lá. FR-19 ("pausa surte efeito antes do próximo envio em fila") exige novo check por mensagem em `processPrepare`/`processSend` (custo: 1 query por envio) — trabalho no hot path dos workers, não um gate a montante.

### A3. Campanhas `scheduled` nunca são despachadas — o fluxo "Campanha em Voo" agendada está morto no código atual
`tickAll` declara no comentário "varre campanhas `scheduled|running`" mas filtra **apenas** `status: 'running'` (`studio/scheduler-worker.js:162-165`). Nenhum código transita `scheduled → running` (única origem de `running`: dispatch imediato `campaign-service.js:316-319` e `control resume` em `campaign-routes.js:177-200`). O chat transita `approved → scheduled` no `set_schedule` (`chat-routes.js:163-166`), e a rota `POST /campaigns/:id/schedule` faz o mesmo (`campaign-routes.js:158-162`). Resultado: campanha agendada fica em `scheduled` para sempre, sem tick, sem Saldo, sem envio. O Cockpit elege exatamente esse caminho como clímax (UJ-1, Rail "Agenda→Saldo"); o plan precisa corrigir o `tickAll` (varrer `scheduled` + startAt) **junto** com o gate do Saldo, senão o FR-15 é testado contra um fluxo que nunca roda.

---

## Achados — Média

### M1. FR-9: não existe endpoint de ação standalone para os Chips
`runAction` só executa **dentro** do turno de chat, após orquestração LLM (`chat-routes.js:60-189, 256-271`). O front não tem chips — só texto livre (`apps/web/src/studio/components/CampaignChat.tsx:294-314`). FR-9 ("nenhum Chip envia apenas texto") exige um endpoint novo (ex.: `POST /campaigns/:id/actions`) + contrato versionado. Viável (a lógica já está fatorada em `runAction`), mas é API nova, não reaproveitamento.

### M2. FR-16: zero infraestrutura de SPF/DKIM/DMARC
Única menção no repo é uma mensagem de erro do Resend (`email-provider.js:329`). `EmailAccount` (`prisma/schema.prisma:310`) não tem campos de domínio/verificação; não há DNS lookup nem estado de verificação. "Saldo efetivo zero até verificação" (FR-16) é um subsistema novo (checks DNS, modelo de estado, fluxo de verificação, Despertar de orientação FR-28). O PRD não sinaliza isso como novo — no plan, dimensionar como feature, não como gate.

### M3. FR-21: classificação tem confiança utilizável, mas o insumo é fraco e o coverage é parcial
A fundação confere: `StudioReplyClassification` persiste `label`, `confidence`, `needsHumanReview` com threshold 0.7 configurável (`studio/ai/classify-reply.js:19, 50-78`; `prisma/schema.prisma:1247`) — "exibir só com confiança alta" é query direta. Porém:
- O classificador recebe **só o assunto** da resposta: `text: subject` (`outreach-workers.js:814`) — o corpo do e-mail do lead nunca é classificado; "quente" com confiança alta sobre o assunto é base fraca para a killer suggestion.
- O reply-sync só cobre contas **gmail** (`outreach-workers.js:667-668` — "SMTP/Resend são send-only"); orgs nesses providers jamais geram o candidato "respostas quentes".
- A classificação é fire-and-forget (`.catch` ignorado, :807-816) — latência entre resposta e sugestão é variável.
FR-21 continua viável, mas o plan deve incluir passar o corpo ao classificador e aceitar o gap de coverage não-gmail.

### M4. FR-8: não há máquina de estados do briefing — o "próximo turno determinístico" é camada nova
O orquestrador é um prompt LLM livre com fallback "não entendi" (`studio/ai/chat-agent.js:23-40, 86-98`); o estado da campanha entra como contexto (`buildStateBlock` :42-57), mas nada restringe a pergunta seguinte. A máquina de estados que existe (`studio/campaign-service.js:16-64`) governa **status da campanha**, não o diálogo. FR-8 ("o próximo turno é determinístico em tema... perguntas repetidas/órfãs = falha de teste") exige um driver de estado de briefing acima do `chatAgent.orchestrate` — viável, mas é o componente mais novo do fluxo e o FR-11 (≤6 turnos) depende dele.

### M5. "Sem reescrever" não se aplica à camada web — o shell atual contradiz FR-1/FR-4
`StudioApp.tsx` renderiza menu permanente de abas no header — Campanhas / Agente IA / Marca (`apps/web/src/studio/StudioApp.tsx:86-108`) — exatamente o que FR-1 proíbe ("Nenhum menu de abas renderiza no Cockpit"). `CampaignChat.tsx` renderiza **painel lateral de estado** (`aside`, :319-377) — FR-4 proíbe ("nunca em painel lateral"). São 5 views e 12 componentes (journeys, experimentos, templates, editores) que o Cockpit migra para a Gaveta/ thread. O backend se aproveita; o frontend do Cockpit é reconstrução de shell + thread única + Rail + chips. O addendum não afirma o contrário, mas o PRD §1 ("o 010 acabou de entregar motor, SSE e guard-rails") pode induzir o dimensionamento errado no plan.

### M6. FR-18: cota diária do scheduler só se aplica a e-mail — WhatsApp roda com lote fixo
O cálculo de cota condiciona em `campaign.emailExecutionId` (`studio/scheduler-worker.js:47`): campanha **WhatsApp-only** tem `quota == null` e libera lote fixo de **50/tick** (:105-109), ignorando `dailyLimit` configurado. O pacing conservador do Saldo (FR-18) precisa fechar esse buraco como primeiro passo — hoje o canal de maior risco é o único sem cota declarativa.

---

## Achados — Baixa

### B1. FR-13: transporte SSE confere; granularidade de progresso é por ação, não por etapa
SSE completo em `POST /campaigns/:id/chat/stream` (`chat-routes.js:296-346`): eventos `status/reply/card/card_error/done/error`, heartbeat 15 s, `X-Accel-Buffering: no`; o front consome (`CampaignChat.tsx:120-164`). O addendum ("status/reply/card/done já implantado") **confere**. Ressalva: o progresso é 1 label por ação (`ACTION_LABELS`, :199-206); `generate_content` (compose multicanal, dezenas de segundos) emite um único "Gerando conteúdo…" sem progresso interno. FR-13 ("cada etapa de backend emite evento") é atendível instrumentando `compose-service`, mas não é grátis.

### B2. FR-33: OpsNotification existe, mas sem dedupe real nem teto diário
`notify()` grava in-app com `dedupKey` que embute **bytes aleatórios** (`studio/notify.js:16`) — dedupe inefetivo; não há quota por org/dia nem agrupamento. Fundação ok para FR-31; FR-33 é lógica nova em cima.

### B3. Gating premium parcial nas ações do chat
Só `generate_content` exige premium (`chat-routes.js:121`); `set_objective`, `set_audience`, `attach_url` não passam por `requirePremiumOrg`. O NFR cross-cutting ("gating por plano em toda ação nova") deve cobrir os novos endpoints de chip desde o dia 1 — hoje o padrão do módulo é inconsistente.

### B4. FR-1 (redirect de rotas antigas) é trivial
Roteamento interno por pathname sem react-router (`StudioApp.tsx:18-26, 52-67`); adicionar redirects é mudança local. Sem risco.

---

## Confirmações (o addendum acerta)

| Claim do addendum | Evidência |
|---|---|
| Bridge D1: Cockpit compila para `OutreachCampaign`/`WhatsAppCampaign`; tracking/replies permanecem nos workers | `studio/channel-bridge.js:42-69, 103-128` (idempotente por `studioCampaignId`); `scheduler-worker.js:142-159` delega a `outreach-workers`/`whatsapp-workers` |
| SSE do 010 reutilizável p/ FR-13 | `chat-routes.js:296-346` + consumo em `CampaignChat.tsx:120-164` |
| Ações semânticas `set_objective`/`set_audience`/`generate_content`/`set_schedule`/`confirm_material` existem | `chat-routes.js:63-188`; documentadas em `studio/ai/chat-agent.js:11-18` |
| Pipeline extract/compose/personalize LiteLLM continua | `studio/ai/extract.js`, `compose.js`, `personalize.js`; `compose-service.generateAndStorePackage` |
| Classificação de respostas alimenta sugestão "quentes" com confiança | `classify-reply.js:50-78` (persistido, threshold 0.7) — ver ressalva M3 |
| Guard-rail do 1º lote permanece e é embrião do Contrato de Autonomia | `guardrails.hasPendingFirstBatch` no tick (`scheduler-worker.js:33-35`), `approveFirstBatch` (`guardrails.js:51-74`), rota `approve-first-batch` (`campaign-routes.js:236`) |
| Saldo como modelo de 1ª classe (não JSON em `guardrails`) | coerente com o código: `guardrails` é campo Json nas execuções (`guardrails.js:59-62`) — a decisão de não estendê-lo é correta |
| Certificado bloqueante tem ponto de encaixe real | `compliance-service.runPreApprovalChecks` (nível `block` impede aprovar — `campaign-service.js:209-225`); novos itens (Saldo, autenticação, janela) entram como items `block` |

## Recomendações para o plan

1. **Entrar como trabalho explícito (não "apoiar-se")**: idempotência das actions (A1), endpoint de actions p/ chips (M1), fatiamento por saldo no dispatch imediato + check de pausa por mensagem no worker de e-mail (A2), correção do `tickAll` para `scheduled` (A3), verificação SPF/DKIM (M2), driver de estado do briefing (M4).
2. **Dimensionar o frontend como rebuild do shell** (M5) — thread única, Rail, chips, Gaveta — reaproveando no máximo `api.ts` e partes de `CampaignChat`.
3. **Corrigir a cota WhatsApp-only do scheduler antes do Saldo** (M6) — é pré-condição factual do FR-18.
4. A3 e A2 se resolvem juntos: o gate do Saldo no `tickCampaign` só faz sentido quando o fluxo `scheduled` realmente roda.
