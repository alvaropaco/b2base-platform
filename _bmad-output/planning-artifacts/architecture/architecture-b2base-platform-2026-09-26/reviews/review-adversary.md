---
title: "Review adversária — Architecture Spine Campaign Studio Cockpit (011)"
type: adversary-review
created: '2026-09-26'
target: ARCHITECTURE-SPINE.md
method: construção de unidades concretas um nível abaixo (stories do mesmo épico / módulos novos) que obedecem todos os ADs ao pé da letra e ainda assim constroem incompatível; cross-check com código real (studio/, outreach-workers.js, whatsapp-workers.js, prisma/schema.prisma)
---

# Review Adversária — Spine 011 (Campaign Studio Cockpit)

**Veredito:** a spine é forte no single-writer do `balance` (AD-3) e na centralidade do
gate (AD-4), mas **não é implementável por dois times independentes sem colisão**.
Construí pares de stories/módulos que cumprem cada AD literalmente e ainda assim
produzem saldos incompatíveis, dois donos da mesma entidade, caminhos de mutação
conflitantes e corridas reais. São 13 buracos: **3 críticos, 5 altos, 4 médios, 1 baixo**.
Recomendo endurecer os ADs abaixo **antes** de `$speckit-tasks` — cada buraco, se
chegar ao plan, vira duas stories "verdes" que não se encaixam.

Evidência de código citada por caminho absoluto. Nenhuma finding depende de
implementação hipotética sem ancoragem no que já existe.

---

## Índice de findings

| # | Severidade | Resumo | AD que fecha |
| --- | --- | --- | --- |
| F-01 | crítica | Débito no release × estorno de falha assíncrona: sem política de crédito | AD-13 (novo) |
| F-02 | crítica | `hold` órfão no vocabulário do ledger: dois gates conformes, semânticas de reserva incompatíveis | AD-3 endurecido |
| F-03 | crítica | `consume` transacional ≠ árbitro do tamanho do lote: corrida dispatchImmediate × tick | AD-4 endurecido |
| F-04 | alta | Dois donos da "mensagem que vai pro ar": StudioContent editável × execução congelada no 1º compile | AD-2 endurecido + AD-7 |
| F-05 | alta | Pausa global da org sem entidade e sem checagem in-flight nos workers | AD-14 (novo) + AD-5 |
| F-06 | alta | `floor`/`rampStage`/`domainAuthStatus`: três writers, duas leituras de "floor efetivo" | AD-3 + AD-8 endurecidos |
| F-07 | alta | Unique constraint do AD-6 pode lacrar efeito perdido (registro idempotente, efeito não) | AD-6 endurecido |
| F-08 | alta | Fatiamento do AD-4 × motor "first-touch only": 2º lote morre ou nasce motor paralelo | AD-2 endurecido (primitiva de release) |
| F-09 | média | Certificado persistido vs. re-avaliação: sem dono de verdade para UI/Despertar | AD-7 endurecido |
| F-10 | média | Consentimento WhatsApp: default-deny no certificado, default-allow no caminho do motor | AD-15 (novo) |
| F-11 | média | Deferred de rampa esconde divergência: unidade de débito por canal sem modelo | AD-3+AD-9 endurecidos |
| F-12 | média | scheduled→running do AD-5 sem update condicional: corrida com edição/re-aprovação | AD-5 endurecido |
| F-13 | baixa | "Saldo exibido" (account) vs. "saldo efetivo" (gate): painel pode mentir | AD-3 endurecido |

---

## CRÍTICAS

### F-01 — Ledger transacional × envio assíncrono que falha depois do débito (sem política de estorno)

**Construção adversária.** Épico CAP-4, duas stories:

- **Story A — "Release de lote com fatiamento"**: o tick do scheduler chama
  `gate.consume(orgId, 'email', 50, {refType:'release'})` → débito de 50 +
  evento `debit` na mesma transação (AD-3 ✓), marca `scheduledAt` e enfileira
  (AD-4 ✓).
- **Story B — "Falha permanente de envio"**: ao observar `OutreachMessage`
  em `FAILED` (bounce duro, `no_recipient_email` — ver
  `/Volumes/OxAI/github/b2base-platform/outreach-workers.js:558-604`), emite
  `credit` para devolver o débito, porque AD-3 já prevê o tipo `credit`
  (AD-3 ✓ — o tipo existe exatamente para isso).

Ambas obedecem todos os ADs. **Incompatibilidade:** nenhum AD responde
(a) SE há estorno; (b) em quais estados terminais (`FAILED`? `BOUNCED`?
`UNSUBSCRIBED`?); (c) idempotência do estorno — o requeue de órfãs roda com
`dedupe: false` (`outreach-workers.js:453-487`) e o `processSend` re-tenta com
backoff: cada retry re-observando `FAILED` re-credita; (d) quem emite — o
worker é intocado (AD-1) e não conhece o ledger, então não existe observador
definido do estado terminal; (e) granularidade: o débito foi por **LOTE**
(`refId` = release) e o estorno nasce por **MENSAGEM** — `refType/refId` sem
modelo de alocação lote→mensagem não fecha a equação. Duas builds conformes
produzem saldos diferentes para a mesma org — e a trilha append-only não
reconcilia.

**AD que fecha — AD-13 (novo, "Estorno e captura final"):**
`debit` no release é definitivo salvo falha permanente do envio; estorno é
`credit` idempotente chaveado por `messageId` (unique por
`refType='refund', refId=messageId`), emitido por um único observador do ledger
(módulo `reputation.js`), acionado pelos estados terminais declarados em lista
fechada (`FAILED` permanente e `BOUNCED` duro — `UNSUBSCRIBED` não estorna:
o custo de reputação já ocorreu). Proibido estorno fora do observador único.

### F-02 — `hold` órfã: dois gates conformes com semânticas de reserva incompatíveis

**Construção adversária.** Mesmo épico, dois implementadores do gate:

- **Implementador A (prudente)** lê "append-only: `debit|credit|hold|block`"
  e implementa 2 fases: `hold` no tick, captura (`debit`) no `SENT`,
  expiração de holds por job. AD-3 ✓ literalmente — o tipo está no AD.
- **Implementador B (simples)** usa `debit` direto no release. AD-3 ✓ — o AD
  diz só que balance muta na transação do evento, nada sobre quando cada tipo
  se aplica.

**Incompatibilidade:** orgs da build A exibem saldo menor (holds em aberto
sem TTL obrigatório = débito fantasma); histórico do ledger não é comparável
entre builds; sugestões (AD-9) e certificado (AD-7, "Saldo ≥ necessário") leem
o account e divergem do que o gate concederia. É o caso clássico de um
vocabulário de enum citado num AD sem regra de uso — cada reader inventa a
máquina de estados.

**AD que fecha — AD-3 endurecido:** v1 fecha o vocabulário: **somente
`debit` no release e `credit` de estorno (AD-13)**. `hold`/`block` ficam
proibidos até existirem com regra completa (TTL obrigatório, captura definida,
evento de expiração) — ou saem do enum. Nenhum módulo interpreta `hold`;
a interpretação é do dono do ledger.

### F-03 — `consume` transacional não é árbitro do tamanho do lote (corrida dispatchImmediate × tick)

**Construção adversária.** O AD-4 manda: "dispatchImmediate com **fatiamento**
do lote ao saldo disponível" e "scheduler tick antes do release de cada lote".
Duas stories:

- **Story A** (dispatch imediato): lê `account.balance` (100), calcula
  `fatia = min(pendentes, 100)`, chama `consume(100)`. AD-4 ✓.
- **Story B** (tick de 60s, mesma campanha multicanal recém-aprovada):
  mesma leitura, mesmo cálculo, `consume`. AD-4 ✓.

**Corrida:** ambos leem saldo 100 no mesmo instante. Se `consume` for
"transacional" apenas no sentido AD-3 (débito+evento atômicos, saldo pode
ficar negativo), o segundo consume passa e o saldo vai a −100 — envio sem
fundo, exatamente o que o gate existe para impedir. Se `consume` rejeitar o
segundo, a Story B **já marcou `scheduledAt` nos contatos e enfileirou antes
de descobrir** (padrão check-then-act; o código real hoje faz a marcação
ANTES de qualquer gate — `/Volumes/OxAI/github/b2base-platform/studio/scheduler-worker.js:79-101`)
→ envio sem débito. O gate é "único ponto de decisão", mas o AD não diz que
o **consume é o único alocador de tamanho de lote** — cada story fatiou fora
do gate.

**AD que fecha — AD-4 endurecido:** `consume` faz `UPDATE` condicional
(`balance >= units` dentro da transação, `SELECT … FOR UPDATE` ou
`UPDATE … WHERE balance >= n`) e **retorna a fatia concedida**, que é a
autoridade final de alocação. É proibido: (i) calcular fatia fora do gate;
(ii) marcar contatos (`scheduledAt`/`nextSendAt`) ou enfileirar qualquer
unidade que o consume não concedeu; (iii) aceitar saldo negativo em nenhuma
condição. O release só executa com `granted = requested`; caso contrário o
excedente fica para o próximo tick.

---

## ALTAS

### F-04 — Dois donos da "mensagem que vai pro ar": StudioContent editável × execução congelada no 1º compile

**Cross-check de código (não é hipótese):**
`/Volumes/OxAI/github/b2base-platform/studio/channel-bridge.js:42-69` —
`ensureEmailExecution` retorna a execução **existente** sem atualizar
`subject`/`body`; `ensureWhatsAppExecution` idem, e os
`whatsappSequenceStep` só nascem no `create` (`:109-127`). `approveCampaign`
e `runImmediateDispatch` re-compilam
(`/Volumes/OxAI/github/b2base-platform/studio/campaign-service.js:230-235,288-293`),
mas o re-compile é no-op sobre conteúdo. O fluxo FR-006 (pausa → in_review →
editar → re-aprovar) edita `StudioContent` — **e o motor continua enviando o
conteúdo do primeiro compile**.

**Construção adversária.** Story "Certificado/Teste da Maria" (AD-7) avalia
heurísticas **sobre StudioContent**; story "ciclo de vida" (AD-5) re-aprova
após edição confiando que o compile propaga. Ambas obedecem os ADs; o
certificado verde valida um artefato que **não é** o que o motor envia. Dois
donos da verdade do conteúdo sem regra de sincronização.

**AD que fecha — AD-2 endurecido + AD-7:** o compile deve detectar drift
(hash do conteúdo compilado persistido na campanha/execução) e, havendo
mudança, atualizar a execução (subject/body/steps) **antes** da aprovação
concluir — ou proibir aprovação com drift. AD-7 complementa: o certificado
declara **sobre qual artefato avalia** (versão/hash do conteúdo) e esse hash
faz parte da re-avaliação do release.

### F-05 — Pausa global da org: estado sem dono e sem checagem in-flight

**Construção adversária.** AD-4: "a pausa global da org é checada no mesmo
gate". Mas **onde mora o flag?** AD-3 não o inclui em
`StudioReputationAccount`; não há modelo; não há rota.

- **Story "Cockpit: botão pausar tudo"**: persiste a pausa em `Organization`
  (campo novo). Obedece todos os ADs — o flag não é `balance`, AD-3 não
  restringe.
- **Story "gate"**: lê `paused` na account por canal (`orgId+channel`) —
  exige escrever N linhas para pausar 1 org. Também obedece.

**Incompatibilidade:** o gate de B nunca vê a pausa de A → a org "pausada"
continua disparando. E mesmo com flag unificado, **jobs in-flight** ignoram:
o `processSend` real não checa pausa de campanha nem de org
(`outreach-workers.js:489-545` checa só estados terminais do contato,
`SENT` e rate limit); o `requeueStuckScheduledMessages` reintroduz mensagens
`SCHEDULED` vencidas com `dedupe: false`. O AD-5 manda `processSend` checar
"status/pausa **da campanha**" — a pausa da **org** em voo não é coberta por
AD nenhum.

**AD que fecha — AD-14 (novo, "Pausa da organização") + AD-5 complementado:**
entidade única `StudioOrgPause` (org-scoped: motivo, janela/tipo, autor),
única fonte da pausa global; lida pelo gate (AD-4) **e** por
`processSend`/worker de WhatsApp antes de cada envio individual via módulo
injetável (workers continuam sem conhecer o ledger). Semântica: pausa global
vence estado de campanha e vale para mensagens in-flight e reenfileiradas.

### F-06 — `floor`/`rampStage`/`domainAuthStatus`: três writers, duas leituras de "floor efetivo"

**Construção adversária.** AD-3 tranca só o `balance`; os demais campos da
account (`floor, rampStage, domainAuthStatus`) ficam sem single-writer.

- **Story "dns-verify" (AD-8)**: "falha → `floor` do Saldo efetivo zero" —
  implementação natural: `UPDATE account SET floor = 0` quando o DNS falha.
- **Story "avanço de rampa/warm-up" (mesmo épico)**: rotina diária recalcula
  `floor = rampFloor(rampStage)` e grava — no dia seguinte sobrescreve o zero
  da primeira.

Ambas mutam campos que nenhum AD protege. Incompatível: ou o bloqueio DNS
evapora em 24h (A sobrescrito por B), ou o floor fica 0 para sempre após uma
falha transitória de DNS (sem regra de recuperação definida). E "floor do
Saldo **efetivo**" é ambíguo por construção: coluna vs. computação — o painel
(AD-3: "consulta do painel lê account") e o gate passam a exibir/decidir
números diferentes.

**AD que fecha — AD-3 + AD-8 endurecidos:** single-writer por campo:
`domain-verify` é o único writer de `domainAuthStatus`/`verifiedAt`; o
avanço de rampa é o único writer de `floor`/`rampStage`; o **gate é o único
intérprete** de "floor efetivo" = `f(floor, domainAuthStatus)` (computado,
nunca escrito por cima). Recuperação definida: revalidação verde restaura o
floor efetivo no próximo evaluate, sem mutação de coluna.

### F-07 — Unique constraint do AD-6 pode lacrar um efeito perdido

**Construção adversária.** AD-6: execução registra `StudioActionRun` com
unique em `campaignId+action+hash(params)` (ou `actionId` do cliente).

- **Story A** (`action` "lançar" → `runImmediateDispatch` → enfileira
  centenas de jobs): grava o run **depois** do efeito. Timeout de HTTP/crash
  entre efeito e insert → cliente re-tenta com mesmo `actionId` → unique
  retorna "already exists"... que não existe ainda → ou o insert falha por
  efeito duplicado em outra ordem, ou o run é gravado sem resultado e o
  efeito ficou parcial (dispatch de e-mail ok, WhatsApp abortado no meio —
  `dispatchImmediate` não é transacional,
  `/Volumes/OxAI/github/b2base-platform/studio/dispatch.js:44-97`). Retry é
  bloqueado pela constraint → **lançamento pela metade, silencioso, para
  sempre**.
- **Story B** grava o run **antes** do efeito ("idempotência correta"):
  crash entre insert e efeito → retry bloqueado pela mesma constraint →
  efeito nunca executado.

Ambas obedecem o AD-6 ao pé da letra. O AD garante idempotência do
**registro**, não a equivalência registro↔efeito — e o efeito é assíncrono
(fila): "sucesso da action" ≠ enviado.

**AD que fecha — AD-6 endurecido:** run com máquina de estados
(`started → completed | failed`), insert do `started` ANTES do efeito;
retry permitido **somente** de run `started` com lease expirado (mesma
`actionId` retoma o run em vez de colidir); resultado da action referencia os
`refIds` criados; actions com efeito externo de envio passam pelo gate como
qualquer release (hoje `runImmediateDispatch` não passa por gate nenhum —
ver F-03/F-08).

### F-08 — Fatiamento do gate × motor "first-touch only": o 2º lote morre ou nasce motor paralelo

**Cross-check de código:** `enrollAudience` inscreve **toda** a audiência no
compile com status `QUEUED` (`channel-bridge.js:134-164`). Já
`startOutreachCampaign` **filtra** prospects já inscritos
(`outreach-workers.js:986-995`: `alreadyEnrolled` → `jobsQueued: 0`) —
idempotência de "primeiro toque". Ou seja: o release do scheduler via
`startOutreachCampaign` para contatos já inscritos enfileira **zero**.

**Construção adversária.** Story "release de lotes agendados" (AD-4/AD-5) —
o implementador descobre o acima e escolhe:

- **Build A:** mantém `startOutreachCampaign` → campanhas nunca enviam o
  2º lote (no-op silencioso por trilha "correta").
- **Build B:** contorna chamando `_enqueueSend`/duplicando a lógica de
  criação de mensagens → **novo caminho de envio fora do bridge** — viola
  AD-1/AD-2, mas é o único jeito de fazer o AD-4 funcionar com os ADs
  atuais. Os ADs, juntos, tornam uma das duas builds "errada" sem dizer qual.

**AD que fecha — AD-2 endurecido:** o bridge expõe a **única primitiva de
release de lote** (`enqueueBatch(executionId, prospectIds)` reutilizando as
filas existentes — motores intocados); `enrollAudience` e o release usam o
mesmo marcador de progresso (`scheduledAt`/`nextSendAt`), que passa a ser
contrato declarado do bridge. Nenhuma story cria caminho de enfileiramento
próprio.

---

## MÉDIAS

### F-09 — Certificado persistido vs. re-avaliação: sem dono da verdade para UI e Despertares

AD-7 manda persistir o resultado e re-avaliar no release — mas os inputs do
checklist mudam por fora o tempo todo (`domainAuthStatus` cai no job diário,
saldo cai a cada release, opt-outs chegam via tracking). **Par:** a UI do
CAP-8 exibe o selo do certificado **persistido** (barato, AD-7 ✓ "resultado
persiste"); o gate re-avalia (AD-7 ✓). Janela entre persistir e re-avaliar:
selo verde na UI + gate bloqueando (e o inverso após correção, sem
re-persistência definida). Pior: um bloqueio por certificado expirado não
está na tabela fechada do AD-10 (`bloqueio por saldo` está; `bloqueio por
certificado` não) → campanha parada **sem Despertar**, silenciosamente.
**Fecha:** AD-7 endurecido — certificado persistido é **cache** com
`expiresAt` + `inputFingerprint` (hash de `verifiedAt`, saldo na hora,
config de descadastro, consentimentos); toda leitura para UI/autonomia
recomputa ou invalida pelo fingerprint; gate é a única autoridade de
bloqueio; "bloqueio por certificado" entra na tabela do AD-10 com
prioridade explícita.

### F-10 — Consentimento WhatsApp: default-deny no certificado, default-allow no caminho do motor

AD-7 diz que o certificado checa "consentimento WhatsApp por lead"; nenhum
AD fixa o **default** e nenhum AD põe a checagem no caminho do envio. O
`compliance-service` hoje só quantifica leads sem contato como `attention`
(`/Volumes/OxAI/github/b2base-platform/studio/compliance-service.js:262-290`,
não bloqueia); o worker de WhatsApp não checa consentimento. **Par:** story
"certificado LGPD" implementa default-deny (ausência de registro =
bloqueio, código `SEM_CONSENTIMENTO` ✓ convenção); story "enrollment/release"
inscreve e envia sem checar — e `requeueStuckScheduledMessages` (dedupe off)
reintroduz mensagens vencidas por fora do gate. Certificado vermelho correto,
envio de todo modo. **Fecha:** AD-15 (novo, "Default-deny de consentimento"):
ausência de consentimento registrado bloqueia em **todos** os pontos —
certificado, gate, enrollment do bridge e checagem barata no worker — com a
mesma fonte (`StudioLeadConsent` ou equivalente, auditável por lead, FR-23).

### F-11 — O Deferred de rampa esconde uma divergência real: unidade de débito por canal sem modelo

O item Deferred ("números de rampa/warm-up e calibração de débito por
complaint — plan; a spine trava só o mecanismo") difere **números**, mas o
mecanismo travado não define **unidade de débito**: 1 contato = 1 crédito?
E-mail pesa como WhatsApp? **Par:** story "sugestão de plano de envio"
(AD-9 precisa responder "há saldo para esta campanha?") inventa pesos por
canal (email 1, whatsapp 2); story "gate" debita 1 por unidade em ambos.
Ambas conformes — a sugestão promete capacidade que o gate não concede, e o
"Saldo ≥ necessário" do certificado (AD-7) usa uma terceira fórmula. É o
exato cenário "números mudando por canal sem modelo para isso". **Fecha:**
AD-3+AD-9 endurecidos — a função `custo(canal, tipo) → créditos` é declarada
num único módulo (`reputation.js`), consumida por gate, certificado e
sugestões; transição de `rampStage` grava evento próprio no ledger
(`reason` explícito) — os números podem mudar no plan sem nascer uma segunda
fonte de verdade.

### F-12 — scheduled→running do AD-5 sem update condicional: corrida com edição/re-aprovação

AD-5 manda o `tickAll` transicionar `scheduled`→`running` **via gate**, mas
não diz **como**. **Par:** story do tick faz `assertTransition` +
`update(status:'running')` (leitura fora de transação); story de edição usa
o fluxo FR-006 (`scheduled → in_review` é transição legal,
`campaign-service.js:32`). No instante entre a leitura do tick e o update, o
usuário devolve a campanha para `in_review` e edita conteúdo → o update do
tick sobrescreve para `running` **com conteúdo novo não aprovado** (nenhum
guard de versão na mensagem enfileirada). Idem dois ticks concorrentes
(repeat job + boot) re-disparando a transição. **Fecha:** AD-5 endurecido —
transição via `UPDATE … WHERE status = 'scheduled'` (guard de estado na
própria escrita, contagem de linhas = 1 ou abort), acoplada ao consume
(F-03); tick idempotente por `(campaignId, janela)`.

---

## BAIXA

### F-13 — "Saldo exibido" vs. "saldo efetivo": o painel pode mentir

AD-3: "consulta do painel lê account". Mas o que bloqueia é o gate
(floor efetivo, pausa global, certificado, DNS). **Par:** story do painel
exibe `balance` cru; story do gate decide sobre saldo efetivo — org com
saldo 500 e DNS quebrado vê "saldo 500, pronto para disparar" enquanto todo
release bloqueia. Nenhum AD obriga os dois números a coincidirem ou define
qual a UI mostra. **Fecha:** AD-3 endurecido — endpoint único de "saldo
efetivo" exposto pelo módulo do gate (`reputation-gate.js`), e é **ele** que
o Cockpit exibe; `balance` cru fica para auditoria do ledger apenas.

---

## Cross-check com o Deferred (pedido explícito)

- **"Números de rampa/warm-up"** — divergência escondida confirmada: não é
  só o número, é o **owner** de `floor`/`rampStage` e a **unidade de
  débito** (F-06, F-11). Diferir os números é legítimo; diferir o modelo que
  os recebe, não.
- **"Migração WhatsApp Cloud API"** — AD-11 cobre; sem buraco encontrado
  além de F-10 (consentimento, que é ortogonal ao provider).
- **"Multiusuário/gestor"** — sem FKs, ok. Nenhuma story construída colidiu.
- **"Piloto onipresente"** — AD-6 como base é coerente, **contanto que** o
  AD-6 endurecido (F-07) entre: piloto multiplica retries/automatismos e
  transforma o lacre de efeito perdido de caso raro em rotina.
- **"Instrumentação SM-1" / "artefatos humanos"** — sem impacto
  arquitetural.

## Síntese para o autor da spine

Os 13 buracos reduzem a 5 movimentos: **(1)** fechar o vocabulário e a
economia do ledger (débito no release, estorno idempotente por observador
único, `hold` banido ou especificado; unidade de custo por canal num módulo
só) — F-01, F-02, F-11, F-13; **(2)** fazer do `consume` o árbitro atômico
da alocação e acoplar transição de estado a escrita condicional — F-03,
F-12; **(3)** dar dono e ponto de checagem a pausa global e consentimento
(default-deny em todos os pontos, inclusive in-flight) — F-05, F-10;
**(4)** declarar contrato de versão entre StudioContent → compile →
certificado (hash, drift, re-compile que propaga) — F-04, F-09; **(5)**
transformar idempotência de actions em protocolo de efeito (run com estado +
lease + primitiva única de release de lote no bridge) — F-06 (single-writer
por campo), F-07, F-08.
