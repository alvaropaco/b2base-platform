---
stepsCompleted: [step-01, step-02, step-03, step-04]
inputDocuments:
  - _bmad-output/specs/spec-studio-campaign-reliability/SPEC.md
  - _bmad-output/specs/spec-studio-campaign-reliability/diagnosis.md
  - _bmad-output/specs/spec-studio-campaign-reliability/eval-matrix.md
  - _bmad-output/specs/spec-studio-campaign-reliability/transcript-teste-2026-09-29.md
  - _bmad-output/planning-artifacts/prds/prd-b2base-platform-2026-09-26/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-b2base-platform-2026-09-26/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-b2base-platform-2026-09-26/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-b2base-platform-2026-09-26/EXPERIENCE.md
  - _bmad-output/specs/spec-campaign-studio-cockpit/experience-direction.md
---

# b2base-platform — Epic Breakdown — Studio Campaign Reliability

## Overview

Fatiamento da spec `spec-studio-campaign-reliability` (onda de correção do agente de campanhas do `/studio`, sobre o Cockpit 011 já built) em epics e stories implementáveis. Fonte dos requisitos: SPEC (CAP-1…CAP-6) + decisões D1–D5 do dono (2026-09-29). Nota de processo: os portões de aprovação interativos deste workflow foram executados contra as decisões registradas D1–D5 no `.memlog.md` da spec e na conversa com o dono (que respondeu todas as open questions e delega execução) — revisão final antes do build cabe ao dono.

## Requirements Inventory

### Functional Requirements

- **FR1 (CAP-1):** Todo turno do chat termina em resposta útil; falha de LLM/JSON é recuperada por retry por estágio e, no pior caso, degrada com mensagem que explica o que NÃO foi alterado — nunca fallback de erro sem recuperação.
- **FR2 (CAP-1):** Decisões fechadas do vendedor são persistidas no estado da campanha; o agente não re-pergunta fase concluída.
- **FR3 (CAP-1):** Toda falha interna registra `errorCode` + stack no `StudioChatTrace`, consultável via `GET /campaigns/:id/traces`.
- **FR4 (CAP-2):** Matching de segmento tolerante a acento e variação de grafia, com termos atômicos (não frase composta) e `companyName`/`tradeName` no catálogo de filtros.
- **FR5 (CAP-2):** Tradução NL→critérios (`segment-nl`) ancorada nos valores reais de `industry` da org (amostra few-shot).
- **FR6 (CAP-2):** Recuperação determinística de audiência 0-match: explica por que não casou e propõe filtro materialmente diferente, sem repetir critério.
- **FR7 (CAP-3, D1):** Nova action aditiva `capture_leads` no manifest v1 com busca híbrida (lexical + embeddings/pgvector) sobre a base própria.
- **FR8 (CAP-3):** Quando a base própria não atende, captura via MCP CNPJ (`search_companies`/`filter_companies`/`get_company_by_cnpj`) com dedupe por CNPJ.
- **FR9 (CAP-3):** Lead capturado grava proveniência (base própria vs `mcp-cnpj`) e entra no fluxo de consentimento/opt-out; sem capacidade disponível, recusa explicável sem inventar leads.
- **FR10 (CAP-4):** Jornada objetivo→audiência>0→conteúdo (2 canais)→agenda→certificado verde conclui sem dead-end, com fases persistidas e validadas no orchestrate.
- **FR11 (CAP-6, D4):** Encolher a seleção após a matrícula sincroniza a fila de execução (sem reenvio nem duplo débito) e o Monitor sinaliza divergência durante a janela.
- **FR12 (CAP-5):** Suíte L1 com `journey-e2e` **bloqueante** no CI pós-deploy + cenários `segmento-industrial`, `recuperacao-zero-match`, `nao-re-pergunta`, `captura-com-mcp`, `captura-sem-mcp`.
- **FR13 (CAP-5, D3):** Judge de evals migra para modelo independente (dedicado no Laya, fora do gateway LiteLLM do SUT).
- **FR14 (CAP-5):** Suítes L0 determinísticas (`segment-matching`, `segment-recovery`, `turn-reliability`, `decision-memory`, `capture-leads`, `journey-state`, `queue-enrollment`) no gate de PR.
- **FR15 (CAP-5):** F2 corrigido (`confirm_material` resolve nome→id por org); F4–F8 cobertos como cenários/asserções adversariais.

### NonFunctional Requirements

- **NFR1:** `actions.v1` sem breaking change; captura entra como capacidade aditiva.
- **NFR2:** Multi-tenancy `orgId` em toda query/endpoint; `requirePremiumOrg` em endpoint novo — exceção deliberada D2: captura disponível para trial e premium, com limite conservador de volume por org/dia.
- **NFR3:** LGPD — proveniência, consentimento e zero invenção de contato.
- **NFR4:** Erro visível (nenhum catch descarta a causa); migrações só via `prisma migrate` (pgvector incluído).
- **NFR5:** Asserções comportamentais (nunca texto exato); anti-flake N× com classificação infra×agente.
- **NFR6:** Motores 010/011, bridge e NATS `*.v1` intocados; guard-rails (saldo/consentimento) não contornáveis na recuperação de 0-match.
- **NFR7:** Reuso de `mcp-cnpj.js` e do padrão de embeddings do `cnpj-data-publisher`; dependência nova só com justificativa (constituição VI).

### Additional Requirements

- AD-1…AD-14 da spine de arquitetura (gate fail-closed; débito via ledger com writer único; `enqueueBatch` única porta da fila; idempotência `StudioActionRun`; scheduled→running gated).
- Brownfield — sem starter template (arquitetura de plataforma existente; nenhuma story é setup de projeto).
- Migração vetorial (pgvector) no DB da plataforma entra via `prisma migrate`, criada apenas quando a captura precisar (Story 2.1).

### UX Design Requirements

- **UX-DR1:** Chips/cards novos (captura, recuperação 0-match) seguem `experience-direction.md` do 011: voz mordomo, zero jargão, chip executa ação real.
- **UX-DR2:** Monitor: sinalização de divergência fila×audiência visível e explicável, sem novo jargão, nos tokens do 011.
- **UX-DR3:** Card de captura lista proveniência por lote ("da sua base" / "encontrado via CNPJ") — confiança visível (espírito CAP-8 do 011).
- **UX-DR4:** Mensagens de degradação (CAP-1) no tom do produto, indicando próximo passo; stack só em trace, nunca ao usuário.

### FR Coverage Map

| FR | Epic | Resumo |
|---|---|---|
| FR1, FR2, FR3 | Epic 1 | turno resiliente, memória de decisão, erro visível |
| FR4, FR5, FR6 | Epic 1 | segmentação robusta + recuperação 0-match |
| FR15 | Epic 1 (F2) / Epic 4 (F4–F8) | fix confirm_material; cenários adversariais |
| FR7, FR8, FR9 | Epic 2 | captura híbrida + MCP + proveniência/gating |
| FR10, FR11 | Epic 3 | jornada conclui; fila sincroniza + Monitor |
| FR12, FR13, FR14 | Epic 4 | suítes L0/L1, journey bloqueante, judge independente |

## Epic List

### Epic 1: Conversa que não trava — turno confiável e audiência que casa
O vendedor conversa no `/studio` e a audiência descrita aparece: sem "problema técnico" não recuperado, sem re-pergunta de decisão tomada, com segmentação que encontra os leads que existem e recupera sozinha do 0-match.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR15 (F2)

### Epic 2: Capturar leads do sistema e via CNPJ
"Capture mais leads" materializa prospects novos por busca híbrida na base própria e, quando a base não atende, via MCP de CNPJ — com proveniência, consentimento e disponível para trial e premium (D1, D2).
**FRs covered:** FR7, FR8, FR9

### Epic 3: Jornada que conclui e fila consistente
A campanha conclui do objetivo ao agendamento sem dead-end, e a execução respeita a seleção atual: fila sincroniza quando a audiência encolhe e o Monitor sinaliza a divergência (D4).
**FRs covered:** FR10, FR11

### Epic 4: Malha de qualidade e judge independente
A qualidade do agente fica medida continuamente: suítes L0 no PR, jornada E2E bloqueante no CI pós-deploy, cenários adversariais F4–F8 e judge em modelo independente no Laya (D3).
**FRs covered:** FR12, FR13, FR14, FR15 (F4–F8)

## Epic 1: Conversa que não trava — turno confiável e audiência que casa

O vendedor conversa no `/studio` e a audiência descrita aparece — sem erro técnico não recuperado, sem re-pergunta, com matching que casa com a base real e recuperação de 0-match.

### Story 1.1: Erro interno visível e recuperável

As a vendedor no /studio,
I want que uma falha interna vire uma resposta honesta sobre o que não foi alterado,
So that eu nunca fico sem saber o estado da minha campanha.

**Acceptance Criteria:**

**Given** falha de LLM simulada (timeout ou JSON inválido 3×)
**When** o turno executa
**Then** a resposta explica o que NÃO foi alterado e sugere o próximo passo (UX-DR4), sem parecer confirmação falsa
**And** o `StudioChatTrace` registra `errorCode` + stack, visível em `GET /campaigns/:id/traces`
**And** a causa é logada no servidor (nunca descartada)
**Given** retry por estágio configurado
**When** a primeira tentativa falha
**Then** o turno tenta recuperação antes de degradar (zero fallbacks diretos no caso F da suíte)

### Story 1.2: Memória de decisão do vendedor

As a vendedor,
I want que o agente lembre o que eu já decidi,
So that eu não responda a mesma pergunta duas vezes.

**Acceptance Criteria:**

**Given** decisão fechada pelo vendedor (ex.: "só industrial")
**When** qualquer turno seguinte executa
**Then** o agente não re-pergunta a decisão e a referencia quando relevante
**Given** replay idempotente do turno
**When** o estado é re-lido
**Then** a decisão persiste sem duplicar registros

### Story 1.3: Segmentação que casa com a base real

As a vendedor,
I want descrever a audiência em linguagem natural e ver os leads certos entrarem,
So that minha campanha nasce com audiência real.

**Acceptance Criteria:**

**Given** base com "Metalúrgica Taunus" em companyName e industry CNAE "Fabricação de estruturas metálicas"
**When** o vendedor pede "indústrias metalmecânicas"
**Then** a audiência materializa com leads (sem falso "nenhum casou")
**And** o matching é insensível a acento ("metalurgica" casa "metalúrgica")
**And** `companyName`/`tradeName` são aceitos no catálogo de filtros
**And** o `segment-nl` recebe amostra real de `industry` da org como few-shot, dentro do budget de prompt
**Given** o caso industrial da base fixada de QA
**When** o pedido industrial roda
**Then** a audiência inclui ≥ 50 leads (D5)

### Story 1.4: Recuperação de audiência 0-match

As a vendedor,
I want que o agente saia sozinho do "0 leads",
So that eu não precise ajustar o filtro na tentativa e erro.

**Acceptance Criteria:**

**Given** filtro materializado que casa 0 leads
**When** o vendedor pede ajuste (ou o turno seguinte roda)
**Then** o agente explica por que não casou e propõe critério materialmente diferente (comparação computável: nunca repete o mesmo `where`)
**Given** segunda proposta também casa 0
**When** nova proposta é gerada
**Then** ela difere das anteriores (sem loop) e guard-rails (saldo/consentimento) permanecem intocados

### Story 1.5: F2 — confirm_material resolve por nome

As a vendedor,
I want confirmar um material citando o nome,
So that a confirmação não falhe por detalhe técnico do id.

**Acceptance Criteria:**

**Given** o modelo passa nome do material em vez de id
**When** `confirm_material` executa
**Then** resolve por nome dentro da org; nome ambíguo pede desambiguação em vez de falhar
**And** teste L0 cobre id, nome e ambiguidade

## Epic 2: Capturar leads do sistema e via CNPJ

"Capture mais leads" materializa prospects novos por busca híbrida na base própria e via MCP de CNPJ — com proveniência, consentimento, trial e premium.

### Story 2.1: Infraestrutura de busca híbrida

As a vendedor,
I want que a busca por leads entenda o que eu quero dizer,
So that encontre empresas mesmo sem a grafia exata.

**Acceptance Criteria:**

**Given** migração pgvector + índice lexical aplicada via `prisma migrate` (NFR4)
**When** busca de teste roda em fixture
**Then** resultados híbridos (lexical + vetorial) para query semântica (ex.: "empresas de equipamentos agrícolas") retornam matches relevantes
**And** embeddings seguem o padrão do `cnpj-data-publisher` (endpoint OpenAI-compatible) e o backfill é idempotente
**And** nenhuma dependência nova além da justificada na spec (NFR7)

### Story 2.2: Action capture_leads na base própria

As a vendedor,
I want pedir "capture mais leads" e ver prospects da minha própria base entrarem na campanha,
So that aproveite leads que já tenho e estavam esquecidos.

**Acceptance Criteria:**

**Given** campanha com audiência insuficiente
**When** o vendedor pede captura
**Then** a action aditiva `capture_leads` (NFR1) executa a busca híbrida e materializa prospects no tenant correto com proveniência "base própria"
**And** a action é idempotente por `actionId` (replay não duplica)
**And** o card do chat mostra contagem e proveniência (UX-DR1, UX-DR3)

### Story 2.3: Captura via MCP CNPJ

As a vendedor,
I want encontrar leads que não estão na minha base,
So that minha audiência atinja o tamanho certo sem sair do chat.

**Acceptance Criteria:**

**Given** base própria insuficiente para o pedido
**When** a captura executa
**Then** o MCP CNPJ é consultado (reuso `mcp-cnpj.js`, NFR7), com dedupe por CNPJ, e prospects novos são criados com proveniência "mcp-cnpj" e fluxo de consentimento/opt-out (NFR3)
**Given** CNPJ já presente na base
**When** a captura retorna o mesmo CNPJ
**Then** não duplica (replay P2002→findFirst)
**Given** token/quota indisponível
**When** a captura é pedida
**Then** recusa explicável e nenhum prospect é criado
**And** nenhum contato é inventado — só dados retornados pelo MCP (NFR3)

### Story 2.4: Gating e limites de captura

As a operação da B2Base,
I want a captura disponível em trial e premium com limites claros,
So that o recurso cresce sem custo descontrolado.

**Acceptance Criteria:**

**Given** org trial
**When** captura é pedida
**Then** é permitida (D2), com multi-tenancy preservado
**Given** limite diário de volume por org atingido (default conservador, assumption da spec)
**When** nova captura é pedida
**Then** bloqueio explicável com quando-libera
**And** o volume consumido fica registrado para monitoria

## Epic 3: Jornada que conclui e fila consistente

A campanha conclui do objetivo ao agendamento sem dead-end, e a execução respeita a seleção atual do vendedor.

### Story 3.1: Estado explícito da jornada

As a vendedor,
I want um fluxo que avança em ordem sem travar nem atalhar,
So that minha campanha chega ao agendamento completa.

**Acceptance Criteria:**

**Given** campanha nova
**When** os turnos avançam
**Then** a fase corrente (objetivo→audiência→conteúdo→agenda→certificado) fica persistida e o orchestrate valida a próxima ação válida
**Given** tentativa de atalho inválido (ex.: agendar sem conteúdo)
**When** a action chega
**Then** é rejeitada com explicação do que falta
**And** a decisão fechada (Story 1.2) marca a fase como concluída

### Story 3.2: Fila sincroniza com a seleção

As a vendedor,
I want que tirar alguém da seleção pare seus envios,
So that ninguém que eu removi receba mensagem.

**Acceptance Criteria:**

**Given** lote matriculado com 3 contatos
**When** a seleção encolhe para 2
**Then** a fila sincroniza sem reenvio nem duplo débito (ledger íntegro, messageId estável)
**And** zero contatos removidos recebem envio após a sincronização
**And** a idempotência existente (`StudioActionRun`) permanece

### Story 3.3: Monitor sinaliza divergência audiência×fila

As a vendedor,
I want ver no Monitor quando a fila difere da audiência,
So that sei exatamente o que está em voo.

**Acceptance Criteria:**

**Given** divergência entre audiência e fila na janela de sincronização
**When** o Monitor abre
**Then** a divergência aparece explicável (quantos e por quê), sem jargão (UX-DR2)
**And** some após a sincronização, nos tokens do 011

### Story 3.4: Jornada E2E executando ponta a ponta

As a dono do produto,
I want a jornada completa rodando verde na conta QA,
So that "primeira campanha E2E" deixa de ser falso.

**Acceptance Criteria:**

**Given** conta QA (leads Repro*, envios pausados)
**When** a jornada completa roda (objetivo→audiência>0→conteúdo 2 canais→agenda→certificado verde)
**Then** conclui sem dead-end, verde em 3 execuções seguidas
**And** o cenário `journey-e2e` entra na suíte L1 com asserções comportamentais (base para o gate do Epic 4)

## Epic 4: Malha de qualidade e judge independente

Qualidade medida continuamente: suítes L0 no PR, jornada bloqueante no CI, cenários adversariais F4–F8 e judge independente no Laya.

### Story 4.1: Suítes L0 determinísticas no gate de PR

As a desenvolvedor da plataforma,
I want testes determinísticos de comportamento do agente no PR,
So that regressão de conversa não chega à produção.

**Acceptance Criteria:**

**Given** as 7 suítes da `eval-matrix.md` (segment-matching, segment-recovery, turn-reliability, decision-memory, capture-leads, journey-state, queue-enrollment)
**When** o PR roda
**Then** todas verdes dentro do `conversational-evals-checks.yml`
**And** asserções são comportamentais, nunca texto exato (NFR5)

### Story 4.2: Anti-flake e diagnóstico de falha

As a desenvolvedor da plataforma,
I want separar falha de agente de falha de ambiente,
So that o gate não fica vermelho por flake.

**Acceptance Criteria:**

**Given** execução da suíte L1
**When** um cenário roda
**Then** roda N× e só falha se reproduzir na maioria
**And** falha de ambiente (timeout LiteLLM, 5xx do deploy) é classificada `infra` e não contamina o score do agente
**And** o relatório inclui `traceId`s por turno para diagnóstico sem reprodução manual

### Story 4.3: Cenários L1 novos contra base fixada

As a dono do produto,
I want os comportamentos do seu teste virarem casos de regressão permanentes,
So that o que quebrou uma vez não quebra de novo sem alarme.

**Acceptance Criteria:**

**Given** conta QA com base fixada
**When** a suíte L1 roda
**Then** `segmento-industrial`, `recuperacao-zero-match`, `nao-re-pergunta`, `captura-com-mcp` e `captura-sem-mcp` executam com as asserções da matriz
**And** `captura-sem-mcp` valida a recusa com o token isolado (sem depender de indisponibilidade real)

### Story 4.4: journey-e2e bloqueante no CI

As a dono do produto,
I want a jornada E2E como portão de release,
So that nada deploya quebrando a criação de campanha.

**Acceptance Criteria:**

**Given** dataset `journey-v1`
**When** o workflow pós-deploy roda
**Then** `journey-e2e` é bloqueante (vermelho impede considerar a release saudável), com asserções de ordem canônica, `audienceCount ≥ 50` (D5) e `certificateGreen`
**And** a consistência temporal entre turnos (F7) entra como asserção da jornada

### Story 4.5: Judge independente no Laya

As a dono do produto,
I want o judge avaliando num modelo que não é o avaliado,
So that a nota não é chutar o próprio jogo.

**Acceptance Criteria:**

**Given** judge v2 configurado com modelo dedicado no Laya (D3)
**When** a suíte L1 roda com judge
**Then** judge e SUT usam gateways distintos e o relatório registra `judgeVersion v2`
**And** baseline judge v1×v2 comparado no primeiro run, sem truncamento de JSON

### Story 4.6: Cenários adversariais F4–F8

As a dono do produto,
I want os modos de falha conhecidos cobertos por testes,
So que F4–F8 nunca reapareçam sem alarme.

**Acceptance Criteria:**

**Given** os cenários da tabela de pendências da `eval-matrix.md`
**When** a suíte L1 roda
**Then** F4 (rascunho não inventa intenção), F5 (cards sem duplicidade), F6 (URL sem conteúdo → recusa explicável) e F8 (sem oferta inventada) executam com asserções comportamentais
**And** falhas são classificadas pela camada anti-flake (Story 4.2)
