---
title: 'Gate Twilio Lookup no WhatsApp do site (worker digital-presence)'
type: 'feature'
created: '2026-10-08'
status: 'done'
baseline_revision: '31fa539bcf5990341b6d572780eb47cfe20c4dec'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
deferred:
  - summary: >-
      Consumo duplo de company.digital_presence (dois durables no mesmo subject) executa o gate Twilio até duas vezes por task (custo pago dobrado) e cria corrida "primeiro-resultado-vence" quando um dos workers fail-opena.
    evidence: |-
      Verificado: o durable digital-presence filtra enrichment.task.company.digital_presence.> e o durable company filtra enrichment.task.company.> — cada task é entregue aos dois (topologia redundante pré-existente, deliberate). Com o gate no segundo consumidor, cada task gera até 2 lookups pagos; se um acquire for recusado (rate limit compartilhado), um worker fail-opena e o primeiro result a chegar no manager decide a promoção. Contenção atual: rate limit/circuit breaker compartilhados no Redis (120 rpm).
    location: >-
      workers/company-deep.js:150; workers/digital-presence.js:219-221
    severity: medium
---

<intent-contract>

## Intent

**Problem:** O WhatsApp extraído do site virou telefone prioritário do disparo (entra na frente de `cnpjPhones`, e o motor WA usa `[0]`), mas um `wa.me` raspado pode ser fixo, 0800, voicemail ou inválido — cada número ruim é mensagem que não entrega e sessão de disparo queimada.

**Approach:** Validar o número no Twilio Lookup v2 (pacote Line Type Intelligence) dentro do worker `company.digital_presence`, antes de publicar o resultado: número confirmadamente ruim não é promovido (o lead mantém o fixo da Receita); qualquer indisponibilidade do Twilio é fail-open (promove como antes). Cliente REST puro via `fetch`, sem SDK novo.

## Boundaries & Constraints

**Always:**
- Gate DENTRO do executor: rejeição é resultado válido (`COMPLETED`), nunca falha de task.
- Fail-open em todos os caminhos de indisponibilidade: sem credenciais, sem registry, `acquire` recusado (rate limit/circuito), exceção/timeout de rede.
- Todo lookup passa pelo provider `twilio.lookup` no `enrichment-provider-registry` (acquire/recordOutcome/release).
- Evidência por atributo com `sourceType: 'twilio'` (`contact.whatsapp_line_type` na promoção; `contact.whatsapp.rejected` na rejeição).
- Credenciais só via env: `TWILIO_API_KEY_SID`/`TWILIO_API_KEY_SECRET` (preferido) ou `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`.

**Never:**
- Não adicionar `twilio.lookup` ao array `providers` da capability no catálogo (é sub-passo do executor, não failover de task — o runtime usaria como provider alternativo e rotularia o result errado).
- Não bloquear por classificação incerta: `unknown`/ausente/`fixedVoip`/`nonFixedVoip` passam (bloquear incerto regrediria a feature do WhatsApp do site).
- Não introduzir dependência npm da Twilio; não alterar contratos NATS versionados (`*.v1`).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Linha móvel | site com wa.me; Twilio `type: mobile` | `digital_presence.whatsapp` promovido + fact `contact.whatsapp_line_type: mobile` | Nenhum |
| Linha não-WhatsApp | Twilio `type: landline/tollFree/voicemail` | `whatsapp: null` + `whatsapp_rejected` + `rejected_reason: LINE_TYPE:*`; `contacts: []` | Nenhum (COMPLETED) |
| Número inválido | Twilio `valid: false` (+`validation_errors`) | idem linha não-WhatsApp, `rejected_reason: INVALID_NUMBER:*` | Nenhum (COMPLETED) |
| Twilio fora | HTTP 5xx / erro de rede / timeout | Fail-open: promove; `recordOutcome ok:false` no registry; sem fact de line type | Registrada no circuit breaker |
| Sem credenciais | `TWILIO_*` ausentes | Fail-open sem tocar registry nem Twilio | Nenhum |
| Circuito aberto | `acquire('twilio.lookup')` recusa | Fail-open sem chamar lookup; ticket não existe, nada a liberar | `retryAfterMs` respeitado pelo registry |

</intent-contract>

## Code Map

- `twilio-lookup.js` — cliente Lookup v2 + política: `isConfigured()`, `lookupPhoneNumber()` (nunca lança; URL com `%2B` + `Fields=line_type_intelligence`, Basic auth, timeout 5s herdando signal), `evaluateWhatsAppNumber()` e `BLOCKED_LINE_TYPES`.
- `workers/digital-presence.js` — executor `company.digital_presence`; `gateWhatsApp()` (provider `twilio.lookup`, fail-open nos 4 caminhos); factory com `execDeps: { registry, twilioLookup }` e `runtime.registerExecutors(executors)` ANTES do `return` (regressão de c89e8d4e — código morto deixou o worker de produção sem consumir).
- `workers/sdk/runtime.js` — ctx do executor = `{ signal, logger, deps: execDeps+prisma, rawStore }`; acquire de provider usa `def.providers` com failover (não alterar); timeout da task via AbortController.
- `enrichment-manager.js` (linhas ~519–549) — superfície observável: `dp.whatsapp` → frente de `cnpjPhones`; `dp.whatsapp` null → não promove; `contacts[type=whatsapp]` também promoveria (por isso rejeição publica `contacts: []`).
- `enrichment-provider-registry.js` — `acquire`/`recordOutcome`/release; defaults 120 rpm / 20 concorrentes por provider (proteção de custo, ~US$ 0,005/lookup).
- `enrichment-capabilities.js` (linha ~79) — capability `company.digital_presence`: tier basic, `providers: ['site.crawl']`, timeoutMs 30000 (mantêm-se).
- `enrichment-contracts.js` — `VERSION = '1'`; `validateTaskPayload` exige 8 campos + input objeto + attempt ≥ 1.
- `workers/company-deep.js` — segundo consumidor de `company.digital_presence` (subject `enrichment.task.company.>`, durable próprio): recebe o mesmo `execDeps: { registry, twilioLookup }` — sem isso o gate fail-openaria silenciosamente neste caminho.
- `test/twilio-lookup.test.js` — 13 testes: política, cliente (URL/auth/parse), gate no executor (6 cenários da matrix), wiring `processMessage` ponta a ponta (regressão do registro) e wiring do `company-deep` (segundo consumidor do subject).
- `test/workers-executors.test.js` — padrão de mock de `global.fetch` a seguir.
- `.env.example` — seção "Gate Twilio Lookup" com as 4 variáveis.

## Tasks & Acceptance

**Execution:**
- `workers/digital-presence.js` — conferir que o gate publicado casa 1:1 com a I/O Matrix (BLOCK → `whatsapp_rejected` + `contacts: []`; ALLOW com lineType → fact `contact.whatsapp_line_type`; fail-open sem fact) e que `registerExecutors` precede o `return` — ajustar qualquer desvio.
- `twilio-lookup.js` — conferir cliente e política contra as Boundaries (sem throw, fail-open, `BLOCKED_LINE_TYPES` exato).
- `test/twilio-lookup.test.js` — garantir cobertura dos 6 cenários da I/O Matrix + wiring; adicionar caso faltante, se houver.
- Suíte — rodar a bateria completa da plataforma.

**Acceptance Criteria:**
- Given um lead cujo site publica wa.me de linha móvel, when a task `company.digital_presence` é processada, then o resultado promove o número e o manager o aplica na frente de `cnpjPhones`.
- Given um wa.me que o Twilio classifica como `landline` (ou `tollFree`/`voicemail`/inválido), when a task é processada, then o resultado traz `whatsapp: null` + `whatsapp_rejected` e o Prospect mantém o fixo da Receita em `cnpjPhones[0]`.
- Given o Twilio sem credenciais, fora ou com circuito aberto, when a task é processada, then o número é promovido (fail-open) e a task sai `COMPLETED`.
- Given o worker de produção, when sobe e consome uma task real via `processMessage`, then a task sai `COMPLETED` com executor registrado (regressão c89e8d4e).

## Spec Change Log

## Review Triage Log

### 2026-10-08 — Review pass
- verdicts: 17 findings — high 0, medium 3, low 8, false 6, maybe-false 0 (blind-hunter 15, verification-gap 2, edge-case-hunter 0, intent-alignment 0 — descritivo, leitura R1 "continuar-e-completar" implementada sem divergência)
- findings:
  - `[medium]` `[patch]` wiring company-deep: teste só cobre o formato de teste (execDeps injetado); branch de produção (deps:{registry} + require default + env TWILIO_*) sem cobertura — regressão silenciosa passaria pela suíte (mesma classe de c89e8d4e) — AÇÃO: teste de wiring no formato de produção adicionado (env TWILIO_* + fetch mockado landline → acquire twilio.lookup + whatsapp_rejected).
  - `[medium]` `[patch]` (verification-gap, mesmo root cause do anterior, agrupado) boot de produção do gate em company-deep não verificado por teste — AÇÃO: mesmo patch do row anterior.
  - `[medium]` `[defer]` consumo duplo do subject (dois durables) → até 2 lookups pagos por task + corrida primeiro-resultado-vence em fail-open — topologia redundante pré-existente (deliberate, resilience); conserto exige redesenho de consumers, fora do escopo — registrado em `deferred`.
  - `[low]` `[patch]` company-deep registerExecutors repassa deps.execDeps cru em vez do execDeps mesclado (hoje inerte — makeExecutors não consome as chaves do gate; armadilha p/ executores futuros) — AÇÃO: `makeExecutors({ prisma, ...execDeps })`.
  - `[low]` `[patch]` semântica de override do execDeps diverge entre factories (digital-presence substitui tudo; company-deep faz merge por chave) — AÇÃO: digital-presence harmonizado ao merge por chave.
  - `[low]` `[reject]` matrix I/O não enumera as 7 valores de BLOCKED_LINE_TYPES — conserto editaria o spec (intent-contract é read-only); o código é o contrato canônico e o spec manda conferir `BLOCKED_LINE_TYPES` exato nele.
  - `[low]` `[reject]` sem AC cobrindo company-deep — conserto editaria o spec; cobertura existe via teste dedicado de wiring.
  - `[low]` `[reject]` comandos de verificação fora do padrão `pnpm test` / lower-bound apodrecendo — conserto editaria o spec; suíte de plataforma é a relevante (apps/web intocado) e roda o mesmo node --test.
  - `[low]` `[reject]` formato de rejected_reason só em testes — formato é definido por `evaluateWhatsAppNumber` (implementação canônica); spec usa wildcard de propósito.
  - `[low]` `[reject]` sem consideração de proteção de dados p/ envio de telefones BR ao Twilio — conserto editaria o spec; a transferência ao processador externo é inerente à intenção escolhida pelo dono ("pode integrar que vou pagar"); diligência LGPD/Twilio será relatada no resumo da run.
  - `[low]` `[reject]` Design Notes "normalizariam" código-antes-de-spec — a nota documenta estado real para orientar o step-03 desta run; sem dano concreto.
  - `[false]` caminho "sem registry" deixaria gasto sem medidor — refutado: `gateWhatsApp` retorna ALLOW ANTES do acquire/lookup quando registry ausente; Twilio nunca é chamado sem medidor.
  - `[false]` logs de change/triage vazios contrariam review-loop — refutado: os logs são populados por este passo (step-04), que está rodando agora; timing definido pelo workflow.
  - `[false]` `followup_review_recommended: false` sem suporte — refutado: o campo é computado no Finalize por fórmula (patched high ou ≥2 medium), que ainda não rodou nesta passada.
  - `[false]` justificativa de `contacts: []` protegeria estado que o produtor nunca emite — refutado: o caminho de sucesso publica `contacts[type=whatsapp]`; o array vazio no BLOCK é exatamente o que impede a promoção pelo filtro do manager.
  - `[false]` warning `oversized` inexplicado — refutado: é convenção machine-readable do build-auto (>1600 tokens), definida no workflow, não no documento.
  - `[false]` `context: []` descarta proveniência — refutado: c89e8d4e e QA 2026-10-07 estão citados no Intent/Code Map do próprio spec; `context:` é para arquivos a carregar, não histórico.

## Design Notes

Estado atual: implementação base já commitada em `31fa539b` (nesta run, antes do planejamento) — step-03 deve CONFERIR cada task contra a árvore e completar apenas o que faltar.

Racional fail-open: o gate protege contra dado ruim CONFIRMADO, não contra falta de dado; bloquear por indisponência do provider pago regrediria a feature de QA 2026-10-07. Custo é contido pelo registry (120 rpm ≈ teto de ~US$ 0,60/min em saturação, irreal na prática — o worker crawla páginas antes do lookup).

## Verification

**Commands:**
- `node --test test/twilio-lookup.test.js` -- expected: 14 testes passando
- `node --test test/*.test.js` -- expected: ≥897 testes, 0 falhas

**Manual checks (if no CLI):**
- Sem `TWILIO_*` no env, logs do worker mostram promoção normal (comportamento idêntico ao anterior ao gate).

## Auto Run Result

Status: done

### Resumo da mudança
Gate Twilio Lookup (Line Type Intelligence) no WhatsApp extraído do site: o worker `company.digital_presence` valida o wa.me antes de publicá-lo com prioridade — linha fixa/0800/voicemail/número inválido é rejeitado (`whatsapp_rejected`) e o lead mantém o fixo da Receita em `cnpjPhones[0]`; qualquer indisponibilidade do Twilio é fail-open. Wiring do gate também no segundo consumidor do subject (`company-deep`), que antes fail-openaria em silêncio. Bônus da run: correção do `registerExecutors` morto de c89e8d4e (worker de produção sem consumir).

### Arquivos alterados
- `twilio-lookup.js` — cliente REST Lookup v2 + política de promoção (commit 31fa539b).
- `workers/digital-presence.js` — gate `gateWhatsApp` no executor; `execDeps` com merge por chave (harmonizado ao padrão company-deep); `registerExecutors` antes do `return` (commit 31fa539b + patch de review).
- `workers/company-deep.js` — `execDeps` mesclado (registry + twilioLookup default) injetado no runtime e no `makeExecutors` — gate ativo no segundo consumidor (patch de review).
- `test/twilio-lookup.test.js` — 14 testes: política, cliente, 6 cenários da I/O Matrix, wiring `processMessage` (digital-presence e company-deep, incluindo formato de produção com env TWILIO_* e fetch mockado).
- `.env.example` — seção Gate Twilio Lookup com as 4 variáveis (commit 31fa539b).
- `_bmad-output/implementation-artifacts/spec-gate-twilio-lookup-whatsapp-site.md` — esta spec (artefato da run).

### Review — breakdown
- **Patches aplicados: 3 entradas** (veredito na entrada: 1 medium, 2 low) — teste de wiring no formato de produção do company-deep; `makeExecutors({ prisma, ...execDeps })` com o objeto mesclado; harmonização do merge por chave no digital-presence.
- **Deferred: 1** (medium) — consumo duplo do subject (dois durables): até 2 lookups pagos por task + corrida primeiro-resultado-vence em fail-open; topologia pré-existente, ver frontmatter `deferred`.
- **Rejeitados: 12** (6 `false` com refutação registrada, 6 `low` rejeitados — em geral conserto editaria o spec ou dano negligenciável), todos com evidência no `Review Triage Log`.
- edge-case-hunter: 0 findings; intent-alignment: 0 findings (descritivo — leitura R1 "continuar-e-completar" implementada).

### Follow-up review recommendation
`false` — patches por veredito: high 0, medium 1, low 2 (1ª passada: exige high patchado ou ≥2 medium; não atingido).

### Verificação
- `node --test test/twilio-lookup.test.js` → 14/14 pass.
- `node --test test/*.test.js` → 897/897 pass, 0 falhas.
- Matrix Test Audit: 6/6 linhas da I/O Matrix com teste cobrindo, rodou e passou.
- `pnpm -C apps/web test` não aplicável (apps/web intocado pelo diff).

### Riscos residuais
- `deferred`: consumo duplo do subject (custo pago dobrado por task + corrida em fail-open), contido pelo rate limit compartilhado (120 rpm).
- O gate está inerte (fail-open) até `TWILIO_API_KEY_SID`/`SECRET` (ou Account SID/Token) irem para o Infisical `/b2base` e os workers reiniciarem.
- LGPD: a validação transfere telefones (dados de contato) ao Twilio — diligência do processador externo com o DPO pendente (fora do escopo deste diff).
