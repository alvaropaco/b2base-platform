---
title: "Reconciliação PRD+Addendum ↔ Architecture Spine (011)"
type: reconcile-review
created: '2026-09-26'
inputs:
  - _bmad-output/planning-artifacts/prds/prd-b2base-platform-2026-09-26/prd.md
  - _bmad-output/planning-artifacts/prds/prd-b2base-platform-2026-09-26/addendum.md
spine: ARCHITECTURE-SPINE.md
---

# Reconciliação — PRD + Addendum vs. Architecture Spine (011)

Veredito: **a spine cobre o núcleo carregante** (Orçamento de Reputação, gate,
scheduled→running, actions versionadas, Certificado, sugestões, Contrato de
Autonomia, transporte WhatsApp, todos os pré-requisitos (a)–(e) do addendum).
Os vazamentos estão concentrados na **camada de apresentação/NFR** (mobile,
acessibilidade, performance) e num **requisito de envio** (FR-37) que a regra
"workers intocados" deixa órfão.

## Cobertos (resumo)

**FRs 4.1–4.7 (35 de 37 plenamente cobertos):**
- Cockpit/Diálogo: FR-1…FR-6, FR-8…FR-13 → map CAP-1/2/3 (`apps/web/src/studio/`, `chat-routes.js`) + AD-6 (máquina de estados + actions) + SSE no Stack; FR-6 via CAP-7 (CSS nativo, constituição VI).
- Orçamento de Reputação: FR-14…FR-20 → AD-3 (ledger, `rampStage`, `domainAuthStatus`), AD-4 (gate único + **pausa global antes do saldo**), AD-5 (scheduled→running + `processSend` checa pausa), AD-8 (DNS verificado); números de rampa legitamente em Deferred.
- Sugestões/Dia Zero: FR-21…FR-25 → AD-9 (queries puras, ranking determinístico, `motivo`, graceful degradation como ausência).
- Confiança: FR-26, FR-27, FR-29, FR-30, FR-37(*) → AD-7 (checklist determinístico, re-avaliação no release, heurísticas do **Teste da Maria**, opt-outs, consentimento por lead); FR-29/FR-32 via convenção "toda decisão autônoma grava registro explicável" + AD-10; FR-28 → AD-8.
- Contrato de Autonomia: FR-31…FR-34 → AD-10 (tabela fechada, **orçamento diário de despertares com agregador**), AD-12 (prom-client).
- WhatsApp: FR-35, FR-36 → AD-7 + AD-11 (provider interface) + código `SEM_CONSENTIMENTO`.

**Seção 10 (riscos) — 8/8:** banimento→AD-3/AD-11; C-1 WAHA→AD-11 + Deferred (Cloud API); domínio queimado→AD-7/AD-8; adoção/fricção→AD-9 + Deferred (telemetria de funil); fadiga→AD-10; sugestões surdas→AD-9; voz da marca→AD-7 (Teste da Maria) + AD-10 (1º lote na lista de wake); chips-como-API→AD-6 (manifest v1/v2, unique constraint).

**Addendum — 5/5 pré-requisitos:** (a) gate cobre `processSend`/`dispatchImmediate` + fatiamento→AD-4 (cita os dois textualmente); (b) `scheduled` nunca despacha→AD-5; (c) idempotência de actions→AD-6; (d) ordem de construção→legitamente épics (não é arquitetura); (e) migração Cloud API→AD-11 + Deferred. Moeda do Saldo (débito por envio agendado, ledger idempotente, evento auditável)→AD-3/AD-4.

**§11 NFRs cobertos:** multi-tenancy/gating (Inherited IV + AD-12); observabilidade (AD-12 + convenções); idempotência/NATS `*.v1` (Inherited II + AD-6); testes `node --test` fake-prisma (convenções); estética/CSS nativo/sem lib nova (CAP-7 + Inherited VI); LGPD de consentimento (AD-7/AD-11).

## GAPS (5)

### GAP-1 — Mobile mínimo (FR-7) sem portador [alto]
Nenhuma menção a viewport/mobile/375px na spine. FR-7 exige que leitura de
estado (Rail, Saldo), Despertares e **aprovação/pausa global** operem em ≤375px
— e a pausa global é exatamente o controle de emergência que precisa funcionar
no celular (UJ-3). Sem isso, a SPA nasce desktop-only por omissão.
**Deveria viver em:** linha CAP-1/2/3 do Capability Map ou nova convention em
"Estado & cross-cutting" (`Cockpit operável em ≤375px para leitura/aprovação/pausa`).

### GAP-2 — Acessibilidade §11 sem portador [alto]
`prefers-reduced-motion` (também consequência do FR-6), contraste AA no dark e
navegação por teclado não aparecem em AD, convenção nem Deferred. A linha CAP-7
cita só "CSS nativo"; o requisito silencioso (preferências do usuário honradas)
cai entre constituição VI e o PRD.
**Deveria viver em:** AD-7 não — na **linha CAP-7 do map + convention de UI**
(`prefers-reduced-motion` obrigatório em toda animação; AA no tema dark; Cockpit
navegável por teclado).

### GAP-3 — FR-37 descadastro: headers RFC 8058 e SLA ≤48h órfãos [alto]
AD-7 carrega "opt-outs" como item do Certificado, mas os requisitos de envio —
`List-Unsubscribe`/one-click em 100% dos e-mails e honrar descadastro ≤48h em
**todos os canais** — não têm dono. A spine declara workers/providers
"intocados como motores" (AD-1/AD-2), então nada no substrato aponta onde
FR-37 é implementado/verificado; é o clássico requisito silencioso que a
estrutura derruba. FR-37 é Must (§6.1).
**Deveria viver em:** regra no **AD-2** (bridge preserva/acrescenta headers no
caminho de saída do email-provider) + item do checklist AD-7 (opt-out pendente
>48h reprova o Certificado); teste listado no map CAP-8.

### GAP-4 — Orçamento de performance §11 sem portador [médio]
p95 do 1º feedback ≤2s (FR-11) e 60fps nas animações não estão em convenção,
AD ou Deferred. O ≤2s constrange desenho (primeiro evento SSE, ack síncrono da
action) e merece uma linha; 60fps é decorrência de CAP-7, mas não está dito.
**Deveria viver em:** convention "Estado & cross-cutting" (budget p95 ≤2s para
1º feedback; medir via prom-client/AD-12) + CAP-7 (60fps, CSS nativo).

### GAP-5 — Sandbox/Dia Zero "só fixtures" (FR-23 + §11 LGPD) implícito [baixo]
O map cobre CAP-5/6 (Dia Zero), mas a invariante de compliance — demonstração
roda **sem tocar ativos reais de envio e nunca com dados reais** — não está em
convenção nem em AD-9. Risco baixo (épics provavelmente pegam), mas é invariante
LGPD e custa uma linha.
**Deveria viver em:** AD-9 (regra: candidatos do Dia Zero/sandbox leem apenas
fixtures; nenhum caminho toca provider real) ou linha LGPD nas convenções.

## Não-gaps verificados

- FR-11 turnos ≤6, FR-12 valor cedo, FR-24 critérios de ranking, Open Questions
  1–2 (números de rampa, limite WhatsApp): mecanismo na spine, números em
  Deferred/plan — correto.
- SM-C4 "fuga para a Gaveta" e baseline SM-1 (OQ-3): Deferred de telemetria cobre.
- Non-goals (multiusuário, Piloto onipresente, cold-first WhatsApp): respeitados
  — Deferred registra "não bloquear o modelo" para papéis.
- Voz do Piloto (zero-jargão) e Teste da Maria como diretriz de copy: produto/épics,
  não arquitetura — correto que a spine só carregue a parte verificável (AD-7).
