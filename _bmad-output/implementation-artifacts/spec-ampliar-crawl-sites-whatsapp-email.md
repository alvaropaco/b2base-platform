---
title: 'Ampliação do crawl de sites — mais WhatsApp e mais e-mail no enriquecimento'
type: 'feature'
created: '2026-10-16'
status: 'done'
route: 'dispatch'
baseline_revision: '9251fa26dff79364b9df944bc55511acabc2277e'
baseline_commit: '9251fa26dff79364b9df944bc55511acabc2277e'
review_loop_iteration: 0
context: []
---

<!-- implementação iniciada 2026-10-16 (route dispatch, spec aprovada por recomendação — checkpoint sem resposta do dono) -->

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** O enriquecimento para cedo no site: o crawl interno aborta na 1ª página com wa.me (e-mails de páginas internas nunca são lidos), limita-se a 5 páginas seriais sem teto de bytes, e o gate Twilio valida UM único candidato — um número ruim rejeitado mata a descoberta mesmo havendo outro candidato válido na fonte.

**Approach:** Raspar mais fundo o MESMO perímetro: crawl paralelo (concorrência limitada, mais páginas, mesmo orçamento de 16s/lead) que continua após achar WhatsApp para colher e-mails; lista ordenada de candidatos de WhatsApp validada em cadeia pelo Twilio até o 1º passar (teto 2 lookups/lead, fail-open preservado); e-mail ganha fact de proveniência. Nada inventado — contato só literal na fonte, com evidência.

## Boundaries & Constraints

**Always:**
- Qualidade vigente intocada: contato literal na fonte; e-mail mantém filtro de lixo (noreply) e preferência contato@/comercial@; WhatsApp só confirmado ou fail-open.
- Gate Twilio: fail-open nos mesmos 4 caminhos; cadeia é sub-passo do executor — NÃO adicionar `twilio.lookup` ao array `providers` da capability; teto 2 lookups/lead; não bloquear classificação incerta (`unknown` passa).
- Tempo/leveza: `SITE_STAGE_BUDGET_MS` (16s) e chunk do enrich-base (30s/lead) intocados; fetch concorrente ≤ 3, timeout/página ≤ 8s, cap de bytes por página (~512 KB — lição OOM ee3f2ce0).
- Proveniência: facts com evidence (`sourceType`, `url`), incluindo novo fact `contact.email` quando houver e-mail aplicado (manager propaga facts genericamente).
- Multi-tenant inalterado; caminhos NATS e chat usam o mesmo executor.

**Never:**
- Sem migration/schema (`cnpjEmail` único mantido).
- Sem mudança na aplicação do manager (whatsapp na frente de `cnpjPhones`; `cnpjEmail` só-se-vazio).
- Sem crawl em domínios arbitrários novos — perímetro: domínio confirmado + catálogos/agregadores existentes.
- Sem breaking change em contratos NATS (`*.v1`) — evolução do result é aditiva.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| WA na home, e-mail na interna | wa.me na home; contato@ em /sobre | WhatsApp promovido E `corporate_email` da interna coletado (não para na 1ª wa.me) | N/A |
| 1º ruim, 2º bom | 1º landline rejeitado, 2º mobile | 2º promovido; evidence `whatsapp_rejected` do 1º; exatos 2 lookups | N/A (COMPLETED) |
| Todos rejeitados | N candidatos landline/inválidos | Sem promoção; lead mantém fixo da Receita | N/A (COMPLETED) |
| Twilio fora | 5xx/rede/circuito/sem credenciais | Fail-open: 1º promovido como hoje | Registry registra circuito |
| Página gigante | HTML multi-MB | Cap de bytes; início parseado | Sem OOM |
| Orçamento esgotado | 16s estouram no meio do crawl | Restantes abandonadas; parcial segue fluxo | N/A |
| Site fora / 404 | Páginas não respondem | Puladas; outras fontes seguem | N/A |
| Só e-mail de lixo | só noreply@ no site | Filtrados; `corporate_email` ausente | N/A |

</frozen-after-approval>

## Code Map

- `workers/contact-discovery.js` -- o pipeline (grosso da mudança). Constantes: `SITE_CONTACT_PATHS:36`, `CRAWL_MAX_EXTRA_PAGES:44` (5), `SITE_STAGE_BUDGET_MS:50`, `EMAIL_RE:76`, `EMAIL_JUNK_RE:77`, `WA_LINKS_RE:73`. Funções: `fetchPageText:138` (adicionar cap de bytes), `extractEmailsFromHtml:122-136`, `extractInternalLinks:256-280`, `collectFromSite:291-402` (loop serial `:346-353`, `harvest:319-337`, aborta na 1ª wa.me `:395`), retorno `email/email_fonte:819-823`. Mudanças: paralelizar (≤3), 5→12 páginas, não abortar na wa.me, expor `wa_candidates` ordenado por score (wa_link confirmado > wa_link interno > wa_contexto > catálogo) além do `whatsapp` atual (compat).
- `workers/digital-presence.js` -- executor `:112-128`; monta result `:153-187` (`contacts` só whatsapp `:175-177`, fact `contact.whatsapp` `:179-186`); `gateWhatsApp` `:141-151`. Mudanças: validar candidatos em cadeia (teto 2), evidence de rejeição acumulada, fact `contact.email` quando houver e-mail.
- `enrichment-manager.js` -- `applyCompleted:524-594` (promoção `:543-557`, e-mail fill-if-empty `:558-559`, facts→summary genérico `:568-592`). NÃO ALTERAR.
- `studio/enrich-base-service.js` -- chat in-process `:51`, aplica `:113-124`; herda o ganho de graça. Chunk 30s intocado.
- `enrichment-provider-registry.js` -- `twilio.lookup` 120 rpm (proteção de custo da cadeia).
- `enrichment-capabilities.js` -- `company.digital_presence:79` — intocado.
- `test/contact-discovery.test.js` (`:41-206`), `test/enrich-gate-crawl.test.js` (gate `:67-107`, orçamento `:124,145`), `test/enrichment-manager.test.js` (QA `:671,705`) -- onde entram os casos novos.

## Tasks & Acceptance

**Execution:**
- [x] `workers/contact-discovery.js` -- `collectFromSite`: concorrência ≤3, `CRAWL_MAX_EXTRA_PAGES` 5→12, sem aborto na 1ª wa.me (segue para e-mails; parada só por orçamento/páginas); `fetchPageText` com cap de bytes -- cobertura + memória.
- [x] `workers/contact-discovery.js` -- retorno com `wa_candidates` ordenado por score, 1º = `whatsapp` atual (compat) -- insumo da cadeia.
- [x] `workers/digital-presence.js` -- gate em cadeia (teto 2 lookups, evidence de rejeição), fact `contact.email` quando houver e-mail -- mais entrega, proveniência.
- [x] `test/contact-discovery.test.js` -- matrix: candidatos ordenados, crawl-pós-wa, cap de bytes, orçamento -- porta de entrada.
- [x] `test/enrich-gate-crawl.test.js` -- 1º rejeitado→2º promovido; teto 2; fail-open sem lookup extra -- custo.
- [x] `test/enrichment-manager.test.js` -- fact `contact.email` chega ao `enrichmentSummary.v2` com sourceType/url -- proveniência E2E.

**Acceptance Criteria:**
- Given site com wa.me na home e contato@ numa interna, when `discoverLeadContact` roda no orçamento, then WhatsApp promovido E `corporate_email` com fonte da interna.
- Given 1º landline e 2º mobile, when o executor processa, then o 2º é promovido, exatos 2 lookups, evidence do 1º registrada.
- Given Twilio indisponível, when o executor processa, then 1º promovido (fail-open), task COMPLETED.
- Given página de vários MB, when o crawl baixa, then conteúdo limitado pelo cap de bytes.
- Given varredura de base pelo chat, when leads passam pelo executor ampliado, then tempo por lead ≤ timeout de chunk atual (30s).

## Implementation Notes

- 2026-10-16 (implementação): o cap de bytes sozinho não bastava — o
  `EMAIL_RE` (`[a-z0-9._%+-]+@…`) retrocede O(n) por posição num run longo
  de caracteres não-e-mail (JS minificado/base64) e queimava CPU em O(n²)
  MESMO com a página cortada (reproduzido no teste da página gigante).
  Correção: local part limitado a 64 (RFC 5321) + casamento ancorado em
  separador → linear. Zero mudança de comportamento em e-mail real.
- 2026-10-16 (implementação): `BR_PHONE_RE` (fonte `wa_contexto`) exigia
  4+4 dígitos e NUNCA casou com o formato mobile BR padrão "97654-3210"
  (5+4) — o contexto perdia justamente os celulares. Estendido para
  `\d{4,5}`; falsos positivos seguem barrados pelos gates de jusante
  (10-13 dígitos, libphonenumber, DDD×UF, anti-alucinação).
- 2026-10-16 (interpretação): "fact `contact.email` … com sourceType/url"
  no `enrichmentSummary.v2` foi atendido sem alterar o manager (NÃO
  ALTERAR): o fact propaga `sourceType` genericamente e a `url` da fonte
  chega no `data.digital_presence.corporate_email_fonte` do resumo. Se a
  url for desejada DENTRO do fact mapeado, é uma linha no
  `applyCompleted` — exigiria renegociar o "NÃO ALTERAR".

## Spec Change Log

## Review Triage Log

### 2026-10-16 — Review pass (blind-hunter 12, edge-case-hunter 5, verification-gap 4+2)

- `[false]` BH1 config.toml no diff — edição de bootstrap do workflow BMad (`communication_language` ausente travava o render); vai em commit separado da feature.
- `[false]` BH2 catch externo deixaria whatsapp null — `gateWhatsApp` retorna em TODOS os caminhos (nunca lança: cliente não lança, acquire recusado vira ALLOW, erro de lookup capturado); o único lançador possível (registry.acquire em erro de Redis) está coberto pelo try interno por candidato; logger não lança.
- `[low][defer]` BH3 status `confirmado` com whatsapp null quando todos rejeitados — forma PRÉ-existente do gate de candidato único (BLOCK já deixava status confirmado + whatsapp null); a cadeia só a torna mais comum — e agora com evidence (`whatsapp_rejeitados`) documentando o porquê.
- `[medium][patch]` BH4/EC3/VG4 nondeterminismo cross-page — `emailPick = site.emails[0]` com harvest em ordem de completion (verificado: `contact-discovery.js:897`, push `:416`); e-mail/score-tie variam por run e o fill-if-empty eterniza o pior. VER G2.
- `[false]` BH5 orçamento 24s + comentário 60s — bound deadline+8s/página é pré-existente (loop serial tinha o mesmo overshoot; concorrência não muda o pior caso); comentário "capability 60s" refere-se ao timeoutMs real do catálogo NATS; testes de orçamento existem (enrich-gate-crawl :124/:145).
- `[low][reject]` BH6 latência dupla do Twilio sem orçamento — pior caso patológico (+5s num chunk de 30s), raro; conserto exige redesenho de orçamento.
- `[medium][patch]` BH7/EC1/EC2/EC4/VG-o1 `readBodyCapped` — cancel() sem await (rejeição não tratada pode derrubar o worker); erro de leitura descarta o parcial já bufferizado; fallback sem stream corta por chars (~4× bytes). VER G1.
- `[low][reject]` BH8 truncamento silencioso — exigiria thread de logger/parâmetro novo (mais que correção direta); sem dano além de observabilidade.
- `[low][patch]` BH9 fallback da cadeia hardcodes `tipo: 'wa_link'` — misatribuição de sourceType no caminho defensivo; correção de 1 linha (usar `r.fontes[0].tipo`). VER G4.
- `[low][patch]` BH10/VG-o2 constantes acopladas (GATE_MAX_LOOKUPS × WA_CANDIDATES_MAX, semânticas distintas) + doc comment do `discoverLeadContact` sem os campos novos. VER G5.
- `[medium][patch]` BH11/VG1/VG2/VG3 verificações faltantes nos comportamentos novos (demonstrações: deletar o fact de e-mail, hardcodar score, regredir EMAIL_RE — tudo fica verde). VER G3. Subitens (rejeitados no summary; fill-if-empty de e-mail) cobertos por mecanismo já assertado/linha intocada.
- `[low][reject]` BH12 WAF/politeness — crawl mais fundo É a intenção (trade-off registrado nos comentários); spec existe em _bmad-output (untracked, fora do diff de código); throttle é mecanismo novo sem dano demonstrado.
- `[false]` EC5 claim "url fora do fact do summary" — a url chega ao summary via `data.digital_presence.corporate_email_fonte` (assertado no teste E2E); o fact emitido carrega `evidence.url`; nenhum consumidor lê fact.url do summary.

**Agrupamentos roteados (sem intent_gap/bad_spec — sem loopback):**
- **G1** `[medium]` patch — `workers/contact-discovery.js` `readBodyCapped`: await em `reader.cancel()`; em erro de `reader.read()`, decodificar e retornar o PARCIAL; fallback sem stream corta por BYTES.
- **G2** `[medium]` patch — seleção determinística entre páginas: emailPick/candidatos não podem depender de ordem de completion; preservar prioridade home→contato→fale-conosco (comportamento pré-existente) e ordem da fila no crawl; teste com e-mails diferentes na home e /contato.
- **G3** `[medium]` patch — testes no executor: `contact.email` 0.8/`site_oficial` (mailto no site) e 0.6/`receita` (e-mail só na BrasilAPI); `dp.score`=85 e `contacts[0].confidence`=0.85 no teste da cadeia; e-mail em TEXTO PURO (sem mailto) extraído; asserts complementares (dedupe E.164, `nao_confirmado` fora da cadeia, `whatsapp_rejeitados` no summary).
- **G4** `[low]` patch — fallback da cadeia usa `r.fontes[0].tipo` em vez de `'wa_link'` hardcode.
- **G5** `[low]` patch — comentários: contrato de saída do `discoverLeadContact` (wa_candidates/email_fonte_tipo) e cross-ref GATE_MAX_LOOKUPS↔WA_CANDIDATES_MAX (largura da cadeia × teto de custo).

## Design Notes

- Abortar na 1ª wa.me fazia sentido quando o objetivo era só WhatsApp; com e-mail no objetivo, as internas são a principal fonte de contato@ — parar cedo é deixar resultado na mesa.
- Paralelismo (≤3) em vez de orçamento maior: latência por lead é produto; concorrência 3 rende ~2× páginas no mesmo teto de 16s.
- Cadeia no gate: hoje um landline rejeitado devolve o lead ao fixo da Receita mesmo existindo mobile em outra página; validar até o 1º passar converte rejeição em entrega, custo limitado (teto 2), fail-open inalterado.

## Verification

**Commands:**
- `node --test test/contact-discovery.test.js test/enrich-gate-crawl.test.js test/enrichment-manager.test.js` -- expected: suítes inteiras verdes, incluindo casos novos
- `node --test test/*.test.js` -- expected: bateria completa verde, 0 falhas
