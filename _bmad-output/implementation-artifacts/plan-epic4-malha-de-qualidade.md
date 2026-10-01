---
title: 'Epic 4 confiabilidade — malha de qualidade e judge independente'
type: 'feature'
ticket: ''
created: '2026-10-01'
status: 'built'
baseline_revision: '806770e3'
route: 'full'
route_source: 'auto'
review: 'quick'
review_source: 'auto'
lenses_ran: []
review_loop_iteration: 0
warnings: []
context:
  - '_bmad-output/planning-artifacts/epics.md'
  - '_bmad-output/specs/spec-studio-campaign-reliability/eval-matrix.md'
  - 'AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A qualidade do agente nunca foi medida continuamente — o gate de PR roda 1 suíte, a jornada E2E não existe no CI, falha de ambiente confunde com regressão de comportamento, e o judge v1 chuta o próprio jogo (mesmo gateway LiteLLM do agente avaliado).

**Approach:** L0 (7 suítes determinísticas da eval-matrix) no gate de PR; runner L1 com anti-flake N× (falha só na maioria), classificação `infra`×`agent` no relatório e traceIds por turno; cenários L1 novos contra a base fixada QA (segmento-industrial, recuperacao-zero-match, nao-re-pergunta, captura-com-mcp, captura-sem-mcp) + adversariais F4/F6/F8 (F5 via cardPresentUnique, F7 via scheduleWindowsMatch na jornada); `journey-e2e` BLOQUEANTE no workflow pós-deploy; judge v2 com modelo dedicado no Laya (gateway independente do SUT) + baseline v1×v2 no primeiro run.

## Boundaries & Constraints

**Always:**
- Asserções comportamentais, nunca texto exato (NFR5) — proxies determinísticos de estado/cards/traces.
- `conversational-evals-checks.yml` continua o gate de PR (estendido, não substituído).
- Judge NÃO é gate (threshold report-only); gate = score determinístico ≥ 85 SEM falha de agente E `journey-e2e` (blocking) verde na maioria dos N runs.
- Falha de ambiente classificada `infra` NÃO contamina score nem gate (L2).
- Env/secrets: judge v2 lê `B2BASE_JUDGE_URL/_API_KEY/_MODEL` (Laya); sem Laya configurado, judge cai para v1 (LiteLLM) e o relatório registra a versão que rodou.
- captura-sem-mcp exige `B2BASE_EVAL_MCP_ISOLATED=true` (token isolado); em produção o cenário é PULADO — recusa coberta no L0 (`studio-capture-leads.test.js`).

**Never:**
- Não bloquear PR por flake de ambiente (classificação antes do gate).
- Não rodar judge v2 no mesmo gateway do SUT (D3 — a nota não é chutar o próprio jogo).
- Não tornar o gate dependente de cenário pulado por requisito de ambiente.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error Handling |
|----------|--------------|----------|----------------|
| PR com regressão de conversa | qualquer suíte L0 vermelha | gate vermelho | — |
| Flake de ambiente | caso falha 1× em 3 (N=3) | veredito PASS (maioria) | — |
| Gateway sem saldo | todos os turnos falham com LiteLLM 429 | caso classificado `infra`, fora do score/gate; relatório marca bloqueador operacional | — |
| Regressão de agente | caso falha na maioria sem erro de transporte | `agent` — gate vermelho | — |
| Pós-deploy | build-and-deploy success em main | workflow roda dataset journey; blocking reprovado → release não saudável | workflow_run só em success |
| Judge v2 configurado | B2BASE_JUDGE_URL+MODEL | relatório registra `judgeVersion v2`, gateway distinto do SUT; baseline v1×v2 quando pedido | sem Laya → v1 com nota |
| captura-sem-mcp sem ambiente isolado | requires: mcp_isolated | cenário pulado (listado no relatório), nunca falho | — |

</frozen-after-approval>

## Code Map

- `eval/run-conversations.js` -- cfg (+repeat/judgeBaseline/mcpIsolated), `classifyCase`/`requirementMet`/`INFRA_ERROR_RE` (L2), runCase (+channels/calls/traces/certificate/traceIds/baselineJudge), main (loop N×, maioria, scored = results − infra, gate com blocking), aggregate (+infraCases/agentFailures/repeat/judge.baseline).
- `eval/lib.js` -- asserções novas: `cardOrder` (subsequência), `cardPresentUnique` (F5), `audienceCountAtLeast` (D5), `certificateGreen` (strict:false = pronto-para-voo), `actionNotRepeated` (traces), `scheduleWindowsMatch` (F7), `provenancePresent` (CAP-3), `captureRefused` (FR9), `stateOfferNull` (F8).
- `eval/judge-gateway.js` (novo) -- cliente OpenAI-compatível do Laya (`B2BASE_JUDGE_*`), erros `JUDGE_TIMEOUT`/`JUDGE_HTTP_ERROR` (classificam infra).
- `eval/llm-judge.js` -- `judgeConversation` ganha `version` (v1 LiteLLM | v2 Laya) no relatório.
- `eval/auth.js` -- client: `getCertificate`, `callJson` (calls da zona de decisão).
- Datasets -- `eval/conversations/journey-v1.json` (blocking:true, F7); `eval/conversations/reliability-v1.json` (5 cenários L1 + F4/F6/F8).
- CI -- `conversational-evals-checks.yml` (7 suítes L0 + mapping comment); `conversational-evals.yml` (workflow_run pós build-and-deploy em main = journey bloqueante; dispatch manual = all/core/journey/reliability com N=3 e baseline).
- Testes -- `test/eval-stack.test.js` (+6: classificação, cardOrder subsequência, requires, judge v2 client+label, asserções novas).
- Suítes L0 canônicas (mapa no workflow): segment-matching/segment-recovery/turn-reliability/decision-memory → `studio-epic1-reliability.test.js` + `studio-segments.test.js`; capture-leads → `studio-capture-leads.test.js`; journey-state → `journey-state.test.js`; queue-enrollment → `queue-enrollment.test.js`.

## Tasks & Acceptance

- [x] L0 no gate de PR (7 suítes) -- 4.1.
- [x] Anti-flake N× + classificação infra×agente + traceIds por turno -- 4.2.
- [x] Cenários L1 contra base fixada + captura-sem-mcp com token isolado (pulável) -- 4.3.
- [x] journey-e2e bloqueante no CI pós-deploy + F7 como asserção da jornada -- 4.4.
- [x] Judge v2 no Laya (gateway independente) + baseline v1×v2 sem truncamento -- 4.5.
- [x] F4–F8 cobertos (F4/F6/F8 cenários; F5/F7 asserções na jornada) -- 4.6.

**Acceptance Criteria (verificação):**
- PR roda as 7 suítes L0 verdes dentro do `conversational-evals-checks.yml` ✔ (workflow estendido).
- Caso roda N× e só falha na maioria; erro de ambiente vira `infra` fora do score; relatório traz traceIds por turno ✔ (`eval-stack.test.js`).
- 5 cenários L1 + adversariais definidos com asserções da matriz; captura-sem-mcp por token isolado (sem indisponibilidade real) ✔ (reliability-v1).
- `journey-e2e` bloqueante pós-deploy com ordem canônica, `audienceCount ≥ 50` (D5) e `certificateGreen` ✔ (workflow_run + journey-v1 blocking).
- Judge v2 com gateway distinto, `judgeVersion v2` no relatório, baseline v1×v2 ✔ (judge-gateway + runner).

## Implementation Notes

_(2026-10-01)_

- **Proxies determinísticos para os Fs**: F4 = regex de invenção de intenção no reply; F5 = `cardPresentUnique` na jornada; F6 = `cardAbsent 'content'` + reply de confirmação/recusa; F7 = `scheduleWindowsMatch` (o declarado é o materializado); F8 = `stateOfferNull` (oferta não materializa sem declaração). O judge (quando ligado) complementa qualitativamente.
- **Gate novo**: `score ≥ threshold && agentFailures == 0 && blockingFailures == 0` — infra não bloqueia, blocking reprovado impede release saudável.
- **captura-sem-mcp**: token é constante de módulo (`mcp-cnpj.js:19`) — sem superfície por-org; a recusa com token ISOLADO fica no L0 (override `mcpCnpj` injetável) e o cenário L1 fica atrás de `B2BASE_EVAL_MCP_ISOLATED` para um ambiente dedicado futuro.
- **Matrix pós-dispatch**: workflow_run roda SÓ o journey (custo/latência do gate); dispatch manual cobre all/core/reliability. N=3 fixo no CI.
- **Verificação**: 827 testes root (826 + flake de horário pré-existente `studio-scheduler.test.js:240`), 17/17 eval-stack, build web ok. Execução real contra QA (journey ×3) é o passo pós-deploy da story 3.4.

## Plan Change Log

_(vazio)_

## Review Triage Log

_(review quick embutido: gates/classificação revisados durante o build; findings do Epic 3 não se aplicam)_

## Design Notes

- **Anti-flake por MAIORIA, não por retry silencioso**: cada run é honesto no relatório (`runResults[]`); o veredito agrega — flake real (ambiente) e regressão intermitente (agente) ficam distinguíveis.
- **Infra fora do score sem apagar o fato**: `results` mantém TUDO; só o `summary`/gate filtram infra — o relatório continua provando o bloqueador operacional.
- **Judge v2 é substituto, não paralelo**: quando Laya existe, v2 é o juiz primário; v1 só volta na baseline explícita (comparação v1×v2 no primeiro run).
