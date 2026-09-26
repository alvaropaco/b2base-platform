# Review Rubric — ARCHITECTURE-SPINE.md (Campaign Studio Cockpit, 011)

- **Artefato revisado:** `_bmad-output/planning-artifacts/architecture/architecture-b2base-platform-2026-09-26/ARCHITECTURE-SPINE.md`
- **Spec dirigente:** `_bmad-output/specs/spec-campaign-studio-cockpit/SPEC.md` (CAP-1…CAP-8) + PRD/addendum 2026-09-26
- **Cross-check brownfield:** `outreach-workers.js`, `whatsapp-workers.js`, `studio/dispatch.js`, `studio/scheduler-worker.js`, `studio/chat-routes.js`, `studio/guardrails.js`, `studio/channel-bridge.js`, `studio/org-gating.js`, `prisma/schema.prisma`, `docs/constitution.md`, `package.json`, `Dockerfile`, `.github/workflows/`
- **Data:** 2026-09-26

## Veredito geral

A spine é **aprovável com revisões** — substantivamente correta e derivada com
fidelidade rara do PRD/addendum (os três "pré-requisitos de engenharia
descobertos no gate" do addendum — (a) `processSend` sem pausa + lote inteiro
no dispatch imediato, (b) `tickAll` filtrando só `running`, (c) actions
create-style — viraram AD-4, AD-5 e AD-6, e **todas** as alegações empíricas
sobre o código existente conferem caractere a caractere nos arquivos). O
paradigma "gate transacional a montante + ledger append-only" é o divisor de
águas certo para o nível abaixo e está blindado por regras testáveis. Os dois
problemas que impedem aprovação seca: **AD-4 não declara semântica de falha
(fail-closed)** num codebase cuja cultura documentada é "catch-and-ignore" —
o buraco exato por onde a invariante-bedrock vaza — e a **pausa global
(FR-19), checada "antes do saldo" no gate, não tem casa decidida** no modelo
de dados. Somam-se erros de verificação de tech nomeada (o repo usa **Bull
v4, não BullMQ**; fila real é `studio:scheduler`) e duas FRs Must (FR-26,
FR-29) com vínculo fraco ou inexistente. Nada crítico; 2 high, 5 medium, 4 low.

## Julgamentos por dimensão

### 1. Pontos de divergência reais fixados, sem omissões — **adequate**

Os pontos que realmente divergiriam no nível abaixo estão fixados e verificados
no código: AD-4 ("`dispatchImmediate` com **fatiamento** do lote ao saldo
disponível") responde ao fato real de `dispatch.js:44-97` passar
`prospectIds` completo a `startOutreachCampaign`, que enfileira tudo
(`outreach-workers.js:1000-1012`); AD-5 ("`tickAll` filtra só `running` hoje")
confere com `scheduler-worker.js:163` (`where: { status: 'running' }`); AD-6
("`set_audience`/`attach_url`/`generate_content` são create-style hoje")
confere com `chat-routes.js:75-142` (criações sem chave de idempotência); AD-3
acerta o alvo ao citar o "padrão `guardrails`" de JSON solto
(`guardrails.js:59-62,108-115`). Transição `scheduled→running` é legal no
motor de estados existente (`campaign-service.js:32`).

Omissões que forçarão decisão não mediada: **onde vive a pausa global** (AD-4
a checa "no mesmo gate, antes do saldo", mas AD-3 só define account por
`orgId+channel` — pausa global é cross-channel por definição); **onde vive o
consentimento WhatsApp por lead** (AD-7 lista "consentimento WhatsApp por lead"
no checklist, a convenção LGPD pede "auditável por lead", nenhum modelo/AD
decide a persistência); **semântica de falha do gate** (ver H1). Semântica
`hold` do ledger enumerada mas sem regra de uso.

### 2. Toda Rule é enforceable e realmente previne a divergência declarada — **adequate**

Maioria forte: AD-3 ("`balance` só muta **na mesma transação** que insere o
evento") é verificável em review/teste e mata o drift declarado; AD-4 enumera
os três pontos de chamada — testável um a um; AD-6 com **unique constraint**
na chave é mecânico; AD-7 ("o gate **re-avalia** no momento do release") fecha
a race aprovação×envio declarada; AD-10 "tabela fechada `evento →
wake|silent`" é decidível por inspeção. Dois enunciados ambíguos: AD-2 diz
"pedido honrado ≤48h… que não pode nascer nos workers", mas honrar um POST
one-click RFC 8058 necessariamente toca o processamento de contato do motor —
o que exatamente fica no compile do bridge vs. no engine fica por decidir;
AD-8 "falha → `floor` do Saldo efetivo zero" não distingue "verificação DNS
reprovada" de "o job diário falhou em rodar" (a segunda leitura bloquearia
todas as orgs por um incidente de infra).

### 3. Nada sob Deferred permite divergência entre unidades — **strong**

Todos os itens diferidos são parâmetros ou roadmap, não estrutura: "Números de
rampa/warm-up… a spine trava só o mecanismo (AD-3/AD-8)" — correto e alinhado
ao PRD ("PRD trava só o mecanismo", §9.1); Cloud API deferida com "a interface
de provider (AD-11) é o único compromisso"; multiusuário com guarda explícita
("sem FKs que impeçam papéis"); piloto com base declarada (AD-6). Nenhum item
deferido deixa duas unidades livres para divergir estruturalmente.

### 4. Tech nomeada verificada como atual — **thin**

Correto: Node 22 (`Dockerfile:33,77` `node:22-alpine`; CI `node-version: 22`),
Express 5 (`5.2.1`), Prisma 5.x (`5.22.0`), Postgres "15+" (16-alpine no
docker-compose), React/Vite/TS/Tailwind (18.3/5.4/5.7–5.9/3.4), "SSE nativo
(transporte do 010)" (`chat-routes.js:304` `text/event-stream`). Errado:
**"BullMQ + Redis… (queue `studio-scheduler`, repeat 60s)"** — o repo usa
**Bull v4** (`bull@^4.16.5`, `outreach-queues.js:1-30`), cuja API
(`queue.process`) difere da de BullMQ (`Worker`); o nome real da fila é
`studio:scheduler` (`scheduler-worker.js:189`), e o diagrama repete "BullMQ
workers 010" assim como AD-8 ("job BullMQ diário"). Seguir o texto ao pé da
letra levaria a **adicionar a dependência `bullmq`** — violação direta da
constituição VI. Também: "`assertPremiumOrg`" não existe — a função real é
`requirePremiumOrg` (`studio/org-gating.js:20`).

### 5. Ratifica (não contradiz) o codebase brownfield — **strong**

Ponto mais forte da spine. Cada alegação sobre o código existente foi
verificada e é verdadeira (ver dimensão 1); D1 do 010 é ratificada com o
bridge real (`channel-bridge.js` compila para `OutreachCampaign`/
`WhatsAppCampaign`, idempotente por `studioCampaignId`); SSE, métricas
prom-client, gating premium, testes com fake-prisma ("padrão 010" —
`_setPrismaForTests` existe) e migração via Prisma estão todos herdados, não
re-decididos. Nenhuma contradição com a constituição 2.0.0 nem com o 010
encontrada.

### 6. Cobre as capacidades da spec dirigente (CAP-1…8) — **adequate**

Front-matter faz `binds: [CAP-1…CAP-8]` e o Capability → Architecture Map
cobre as oito, com casas concretas (CAP-4 → `reputation.js`/`reputation-gate.js`,
CAP-8 → `certificate.js`, Autonomia → `autonomy.js`). Falhas de vínculo: o
mapa liga CAP-8 inteiro a AD-7, mas **FR-29 (Explicabilidade do Piloto) não é
bound por nenhum AD** (o addendum diz que o ledger "alimenta FR-20 e FR-29" —
a spine não transportou isso); **FR-26 (Origem dos dados citada) está no
Binds de AD-7 mas ausente do seu Rule** — a origem de dados é do pipeline
compose (`reasoningFacts`/`compositionOrigin` já existem no motor), não do
certificado. CAP-2 (máquina de estados → próxima pergunta) fica implícito em
`chat-routes.js`/orquestrador — risco baixo, mas não nomeado.

### 7. Nenhum AD novo enfraquece invariante herdada — **strong**

AD-12 re-afirma II/IV/VII com métricas nomeadas (`studio_gate_*`,
`studio_ledger_*`, `studio_suggestions_*`); AD-6 replica o padrão da
constituição II ("Breaking change → `manifest.v2.js` side-by-side; v1 nunca
muda de forma"); AD-1 ("nenhum serviço/processo novo") encarna a constituição
VI; AD-4 **fortalece** a constraint da spec ("nenhum caminho de envio novo
pode ignorar o saldo"). LGPD/sandbox/fixtures presente nas convenções. Nada a
corrigir.

### 8. Toda dimensão de altitude de feature decidida, deferida ou em aberto — **adequate**

Deployment: decidido por herança (linha de constituição VII: "Deploy pela
pipeline existente"); jobs: AD-8 (job DNS diário) + scheduler 60s herdado +
bootstrap existente (`registerStudioScheduler`); observabilidade: métricas e
logs `[studio:*]` nas convenções; config: `STUDIO_*`. **Ambientes é
completamente silencioso** (dev/homolog/prod; topologia onde o job diário
roda — mesmo processo dos workers? singleton?) e falta a pergunta de
rollout: o que acontece com campanhas 010 já `scheduled`/`running` no momento
em que o gate entra (conta de saldo inexistente — bypass ou crash?). São
dimensões que o plan precisará decidir sem substrato.

## Achados por severidade

### Critical

Nenhum.

### High

- **H1 — AD-4 não declara fail-closed.** A Rule enumera quem chama o gate,
  mas não o que fazer quando o gate/ledger **erro**. O codebase tem cultura
  documentada de engolir erro em caminho aditivo ("à prova de falha
  (ignorado)" — `outreach-workers.js:346-349` e `:806-819`); um implementador
  que aplique o mesmo idioma ao gate produz envio sem débito — exatamente a
  divergência que a spine existe para impedir. *Fix:* acrescentar à Rule do
  AD-4 (e às Consistency Conventions): "erro/timeout do gate ou do ledger ⇒
  `block` (fail-closed); proibido catch-and-continue entre o gate e qualquer
  ponto de efeito".
- **H2 — Pausa global (FR-19) sem casa no modelo.** AD-4: "A pausa global da
  org é checada no mesmo gate, antes do saldo" — mas AD-3 define
  `StudioReputationAccount` como `orgId+channel` unique; uma pausa global
  cross-channel não tem persistência decidida (campo nas accounts? novo
  modelo? settings da org?). Dois implementadores resolverão diferente, e é o
  controle de emergência do produto. *Fix:* estender AD-3 com a home e a
  semântica (por org, aplica a todos os canais; quem cria/limpa; evento no
  ledger?).

### Medium

- **M1 — "BullMQ" ≠ Bull v4 e nome de fila errado.** Stack, diagrama
  ("BullMQ workers 010") e AD-8 ("job BullMQ diário") citam BullMQ; o repo usa
  `bull@^4.16.5` e a fila real é `studio:scheduler` (não `studio-scheduler`).
  Risco concreto: seguir o texto adicionaria dependência nova (constituição
  VI). *Fix:* trocar por "Bull v4 (fila `studio:scheduler`, repeat 60s)" nos
  três pontos.
- **M2 — "Todo caminho de envio chama o gate" (AD-4) superafirma a cobertura.**
  A enumeração (scheduler tick, `dispatchImmediate`, transição
  scheduled→running) cobre só os caminhos do Cockpit; campanhas criadas fora
  do Studio seguem direto pelos motores "intocados" (AD-1) sem gate. *Fix:*
  escopar a frase ("todo caminho de envio **do Cockpit**") ou registrar
  decisão explícita de que caminhos legados ficam fora do escopo v1 — hoje a
  universal do enunciado e a enumeração se contradizem.
- **M3 — Consentimento WhatsApp por lead sem persistência decidida.** AD-7
  checklist e convenção LGPD ("consentimento de WhatsApp auditável por lead")
  pressupõem um registro por lead; o schema só tem opt-out
  (`CONTACT_STATUS.OPTED_OUT`). *Fix:* uma linha em AD-7 ou AD-3 nomeando o
  modelo/campo e o vínculo de auditoria.
- **M4 — FR-29 sem bound; FR-26 com bind vazio.** FR-29 (Explicabilidade do
  Piloto) não aparece em nenhum AD; FR-26 está no Binds de AD-7 mas não no
  Rule (a citação de origem é do pipeline compose, não do certificado).
  CAP-8/Must com metade da arquitetura implícita. *Fix:* apontar FR-26 ao
  pipeline compose/convenções e FR-29 ao registro de decisões (AD-10/ledger),
  ou criar regra própria.
- **M5 — Envelope ambiental silencioso.** Ambientes (dev/homolog/prod), onde o
  job diário de AD-8 roda/bootstrap (singleton? mesmo processo?), e migração
  de campanhas 010 já em voo quando o gate entra (backfill de
  `StudioReputationAccount`? bypass controlado?) não aparecem nem como
  Deferred. *Fix:* uma subseção "Operação" com três linhas, ou itens
  explícitos em Deferred com destinatário (plan/epics).

### Low

- **L1 — Nome de função inexistente.** "`assertPremiumOrg`" → real é
  `requirePremiumOrg` (`studio/org-gating.js:20`; usada como
  `context.requirePremiumOrg` em `chat-routes.js:121`).
- **L2 — Caminho `companions` quebrado.** `../../specs/spec-campaign-studio-cockpit/experience-direction.md`
  resolve para `planning-artifacts/specs/` (inexistente); do diretório da
  spine seriam três níveis (`../../../specs/…`), ou root-relative como as
  `sources`.
- **L3 — Bind errado em AD-10.** "Binds: CAP-4 (FR-31…FR-34)" — FR-31…34 são
  o Contrato de Autonomia (o Capability Map acerta: "Contrato de Autonomia —
  `studio/autonomy.js`"); CAP-4 é Orçamento de Reputação.
- **L4 — Ambiguidades pontuais de regra.** `hold` enumerado em AD-3 sem regra
  de uso (saldo disponível vs. reservado indefinido); AD-8 "falha → floor
  zero" não distingue reprovação de verificação DNS de falha de execução do
  job. Definir em uma frase cada.

## Notas mecânicas

- Mermaid do diagrama é sintaticamente válido (subgraph + cylinder `LED[(…)]`
  + dotted edges); labels com em-dash renderizam.
- Estrutura interna consistente: os 12 ADs têm Binds/Prevents/Rule; o
  Structural Seed dá arquivo para cada AD novo (`reputation-gate.js`,
  `reputation.js`, `certificate.js`, `suggestions.js`, `autonomy.js`,
  `actions/manifest.v1.js`, `jobs/domain-verify.js`) — exceto a **interface de
  provider de WhatsApp (AD-11)**, sem arquivo/diretório semeado
  (`email-provider.js` vive na raiz; onde nasce o provider de WhatsApp?).
- Convenções de erro citadas (`SALDO_INSUFICIENTE`, `CANAL_NAO_CONFIGURADO`,
  `SEM_CONSENTIMENTO`) casam com o padrão real de `errors.js`
  (`httpError(code, status, msg)`).
- Front-matter coerente (altitude `feature`, `binds` com os 8 CAPs, sources
  existem); `status: draft` apropriado.
- Contagem de achados: **0 critical / 2 high / 5 medium / 4 low.**
