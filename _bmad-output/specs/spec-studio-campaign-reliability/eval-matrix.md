# Eval Matrix — malha de qualidade da conversa (CAP-5)

Substitui a lacuna do core-v1: jornada completa, precisão de segmentação e captura nunca foram avaliadas. Camadas cumulativas — L0 bloqueia PR, L1+ bloqueia release do agente. Preserva os 8 casos atuais de `eval/conversations/core.json` (regressão).

## L0 — Determinístico (`node --test`, fixtures, roda em PR)

| Suíte | Cobre | CAP |
|---|---|---|
| `segment-matching.test.js` | matching tolerante a acento/grafia; substrings atômicos vs frase composta; campos novos (`companyName`/`tradeName`) no catálogo; 0-match detectado corretamente | CAP-2 |
| `segment-recovery.test.js` | recuperação de 0-match propõe critério materialmente diferente (diferença computável entre critérios); nunca repete o mesmo where | CAP-2 |
| `turn-reliability.test.js` | falha de LLM/JSON → recuperação por retry/estágio; `_err` sempre logado; `errorCode` persistido no trace | CAP-1 |
| `decision-memory.test.js` | decisão fechada persistida; orchestrate não propõe re-pergunta de fase concluída | CAP-1 |
| `capture-leads.test.js` | action `capture_leads` idempotente; proveniência gravada; disponível para trial e premium (D2); recusa explicável sem MCP/token; zero lead inventado | CAP-3 |
| `journey-state.test.js` | estado da jornada objetivo→audiência→conteúdo→agenda→certificado avança e rejeita atalhos inválidos | CAP-4 |
| `queue-enrollment.test.js` | encolher a seleção após a matrícula sincroniza a fila (CAP-6/D4): sem reenvio, sem duplo débito, zero envio a contato removido | CAP-6 |

## L1 — Eval de conversa (conta QA deployada; gate determinístico)

Runner existente (`eval/run-conversations.js`, asserções comportamentais, nunca texto exato). Novos cenários além dos 8 do core-v1:

| Cenário | Passos | Asserções-chave | CAP |
|---|---|---|---|
| `journey-e2e` (bloqueante, novo dataset `journey-v1`) | objetivo → audiência industrial → conteúdo 2 canais → agenda → certificado verde | `audienceCount ≥ mínimo acordado`; todos os cards presentes em ordem canônica; `certificateGreen`; turno final conclusivo | CAP-4 |
| `segmento-industrial` | "quero indústrias metalmecânicas" contra base Repro* fixada | audiência casa leads esperados (precision/recall da base fixada); zero falso "nenhum lead casou" | CAP-2 |
| `recuperacao-zero-match` | induz 0-match, depois "ajuste os filtros" | 2º critério ≠ 1º; explicação do porquê; `audienceConsistent` | CAP-2 |
| `nao-re-pergunta` | decisão declarada (ex.: "só industrial"), turno seguinte qualquer | `noRepeatQuestion`; resposta referência a decisão tomada | CAP-1 |
| `captura-com-mcp` | "capture mais leads" com MCP disponível (conta QA) | prospects novos gravados; `provenancePresent`; busca híbrida consultada (lexical+vetorial, D1); sem inventar contatos | CAP-3 |
| `captura-sem-mcp` | mesmo pedido com `CNPJ_MCP_TOKEN` ausente/inválido | recusa explicável; nenhum prospect criado | CAP-3 |

**Gates**: score determinístico ≥ 85 (atual) **e** `journey-e2e` verde obrigatório (novo — hoje a jornada não existe na suíte). Judge roda em **modelo independente do SUT** (D3: dedicado no Laya, fora do LiteLLM do agente) e compõe o relatório; entrada dele no gate fica para o plan, após baseline com o modelo novo.

## L2 — Anti-flake e diagnóstico

- Toda execução roda N× (ex.: 3); cenário só falha se reproda na maioria — falha de ambiente (timeout LiteLLM, 5xx do deploy) é classificada como `infra` e não contamina o score do agente.
- Base fixada: evals de precisão rodam contra fixture Repro* conhecida (não contra dados mutáveis de produção); o dataset declara os matches esperados.
- Relatório por cenário inclui `traceId`s dos turnos (consulta `GET /campaigns/:id/traces`) para diagnóstico sem reprodução manual.

## Integração CI

- PR: L0 + syntax check (estende `conversational-evals-checks.yml`).
- Pós-deploy (estende `conversational-evals.yml`): L1 completo contra conta QA, incluindo `journey-e2e` como gate bloqueante; L2 aplicado na análise.

## Pendências herdadas do quality stack (definições recuperadas da memória de projeto 2026-09-28)

Incorporar como cenários/asserções desta matriz antes do build (algumas já viram fix, não só teste):

| Item | Definição | Tratamento |
|---|---|---|
| F2 | `confirm_material` falha quando o modelo passa **nome** em vez de **id** | fix: resolver por nome×org; asserção L0 + cenário L1 |
| F4 | rascunho inventa a intenção do lead | asserção anti-invenção no judge/report + prompt; cenário L1 |
| F5 | cards duplicados no thread | asserção L1 (`cardPresent` sem duplicidade) |
| F6 | extração de URL vazia | cenário L1 (material-url com página sem conteúdo útil) |
| F7 | descrição temporal inconsistente entre turnos | asserção L1 de consistência |
| F8 | oferta inventada (produto que não existe) | asserção anti-invenção; caso adversarial L1 |
| Matrícula de fila vs seleção | fila mantém contatos já matriculados quando a audiência encolhe ("2 na audiência, 3 na fila") | **resolvido (D4)**: virou CAP-6 — sincronizar a fila E sinalizar no Monitor; suíte `queue-enrollment.test.js` |
| Independência do judge | judge roda no mesmo modelo/gateway do SUT | **resolvido (D3)**: migrar nesta onda para modelo dedicado no Laya, fora do gateway do SUT |
