# PRD Quality Review — Campaign Studio Cockpit (011)

*Review em 2026-09-26 contra o rubric `prd-validation-checklist.md`. PRD + addendum lidos juntos; referências brownfield verificadas contra o código (`studio/ai/chat-agent.js`, `studio/chat-routes.js`, `prisma/schema.prisma`).*

## Overall verdict

PRD maduro e pronto para alimentar os fluxos downstream (UX → arquitetura → epics): decisões aparecem como decisões (com alternativas rejeitadas documentadas no addendum), os 36 FRs carregam consequências testáveis, e as referências ao motor do 010 batem com o código real. O que está em risco é a mensurabilidade da tese: a métrica primária de negócio (SM-2) não tem alvo numérico e a barra de qualidade de conteúdo (FR-30) não tem limites operáveis — o resto são mecânicas de glossário e índice de assumptions.

## Decision-readiness — strong

O PRD decide e assume o custo de decidir. "Toggle de tema claro — dark é decisão de produto" (§5) é decisão declarada, não consideração; "Cold-first via WhatsApp — eliminado do produto (ver 4.7)" idem, com o risco de ToS/LGPD nomeado. O addendum traz "Alternativas consideradas (rejeitadas)" com quatro rejeições reais e o motivo de cada uma ("reação pós-estrago viola o bedrock do dono do produto") — o padrão raro de um PRD que registra o que foi descartado. As Open Questions são genuinamente abertas: a Q2 admite "política do provedor não é pública; monitorar sinais... e calibrar em produção" — incerteza confessada, não escondida. O único `[NOTE FOR PM]` (§6.2, multiusuário "emocionalmente caro para contas maiores; revisitar cedo") está numa tensão real, não num checkpoint seguro. O trade-off central está dito com honestidade: "nunca promete imunidade: WhatsApp é tratado com conservadorismo explícito" (§4.3).

### Findings

- **low** Sequenciamento de construção acordado não registrado (§6, addendum) — a ordem validada pelo dono ("Cockpit+Chips → Orçamento por baixo → Confiança progressiva → Piloto/laya por último", registrada em `reconcile-backlog.md` como gap) aparece no addendum só de forma parcial ("Novos FRs de envio... operam **antes** da fila existente, como gate"); o sequenciamento completo some antes de `bmad-create-epics-and-stories`. *Fix:* uma linha de ordem de construção no addendum (não no PRD — é decisão de epics).

## Substance over theater — strong

Nada aqui é mobiliário. Uma persona só (Rafael), e marcada: "[ASSUMPTION: persona ilustrativa — validar com clientes reais]" (§2.3) — o oposto de persona theater. Os quatro JTBD (§2.1) puxam decisões concretas: o emocional vira o Orçamento de Reputação (§4.3), o contextual vira UJ-2/§4.4, o social vira o Teste da Maria com FR (§4.5). Os NFRs (§11) têm números e âncoras no código/constituição ("1º feedback ≤2s (p95)", "contratos NATS `*.v1` intocados"), não boilerplate de escalabilidade. A Visão é intransferível: "o maior medo dele — perder o domínio de e-mail ou ter o WhatsApp bloqueado — é tratado só reativamente" não troca com nenhum outro PRD da categoria. O "Teste da Maria" poderia ser folclore, mas ganha implementação em FR-30 com heurística e guard-rail humano.

### Findings

(nenhum — dimensão sem achados que agreguem informação)

## Strategic coherence — strong

O PRD tem tese declarada e dupla: "a reputação do ativo de envio do cliente é pré-condição, não feature" e "confiança se calibra com transparência" (§1). Os grupos de features são derivações da tese (4.3/4.5/4.6 da primeira e segunda; 4.2/4.4 da fricção), não lista de capacidades — e o §10 amarra risco→FR→mitigação sem órfãos. As métricas validam a tese, não atividade: SM-C1 "volume é vanity; nunca meta por si" é counter-metric de produto rara; SM-C4 ("fuga para a Gaveta" como sintoma de falha do Diálogo) e SM-C3 ("meta é zero atribuível ao Studio; nunca trocada por crescimento de envio") fecham o circuito. O escopo do MVP é kind problema+experiência coerente: entra o cockpit inteiro e o orçamento, sai multiusuário e sandbox de voo — sem fatiamento por facilidade.

### Findings

- **medium** SM-2 sem alvo nem comparador (§7) — a métrica primária que "valida" o motor inteiro é "respostas positivas → reuniões por org ativa/mês; baseline a medir no release": sem número-alvo e com baseline que só passa a existir depois do release, ninguém consegue julgar no green-light se a aposta valeu (a Open Question 3 cobre o baseline de ativação do SM-1, não o de SM-2). O mapeamento "Valida 4.3–4.7" por seção (em vez de FR-IDs como SM-1 faz) agrava a frouxidão. *Fix:* definir alvo relativo ao baseline instrumentado pré-release, ou declarar checkpoint explícito de calibração (ex.: revisão 60 dias pós-release) e mapear por FRs.

## Done-ness clarity — strong

Esta é a parte mais forte do documento. Quase todos os FRs têm seção **Consequences** com consequência verificável e frequentemente o próprio teste: FR-11 ("contagem de turnos ≤6 no fluxo feliz (teste E2E); p95 de primeiro feedback ≤2s"), FR-15 ("teste de integração: lote > saldo → bloqueio + explicação"), FR-27 ("disparo com item reprovado = impossível (teste de integração)"), FR-8 ("perguntas repetidas/órfãs = falha de teste"). Adjetivos perigosos são raros e, quando aparecem, a consequência os cerca (FR-2 diz "Estado vazio convidativo" mas trava "contagem de Chips ≤3; placeholder contém instrução"). Os NFRs são bounds, não adjetivos. Onde o PRD adia números, diz que adia e trava o mecanismo (FR-17: "PRD trava só o mecanismo").

### Findings

- **medium** FR-30 sem limites operáveis (§4.5) — a barra de qualidade central de conteúdo pede que o pipeline "valida heuristicamente os critérios (curto, um ask, tom de par)": "curto" não tem teto, "tom de par" não é verificável como escrito. É o único FR cuja consequência de teste não fecha. *Fix:* boundar o que é boundável (ex.: ≤N palavras, ≤1 ask) e declarar que os thresholds heurísticos ficam no plan — hoje nem isso está dito.
- **low** Quantificadores indefinidos em FR-13 e FR-34 — "nenhuma operação longa sem progresso" (§4.2) e "disparidade alta entre orgs dispara revisão" (§4.6) não têm limiar. *Fix:* limiares explícitos (ex.: progresso para operações >2s; revisão acima de N desvios da mediana).

## Scope honesty — strong

Omissões explícitas em duas camadas: §5 (Non-Goals de produto, 8 itens com justificativa — inclusive "arquitetura não deve bloquear, mas não constrói" para multiusuário) e §6.2 (Out of Scope do MVP, com o adiamento do sandbox qualificado: "v1 entrega demonstração passiva... voo em sandbox para v1.x"). Assumptions inline onde a inferência não veio do usuário (persona ilustrativa, números de rampa, fixtures LGPD, teto de 5 Despertares). Densidade de open-items adequada ao stake de launch: 3 Open Questions + 4 tags inline + 1 NOTE FOR PM, todos com dono e momento ("decidir no plan", "instrumentar antes do release"). O não-goal "laya / fine-tune de classificadores — reavaliar com dataset pós-Must" aponta para `backlog.md` em vez de reabrir a discussão.

### Findings

(nenhum — as ressalvas de "laya" e do roundtrip do índice estão em Mechanical notes)

## Downstream usability — strong

Glossário presente e com dentes: 13 termos, usados com caixa consistente nos FRs/SMs, e com sinônimo banido ("Sinônimo proibido: 'dashboard'"). IDs contíguos e sem duplicatas (FR-1…36, UJ-1…3, SM-1…4, SM-C1…4); todas as cross-refs resolvem (FR-28 → "habilita FR-17 override"; FR-36 → "Saldo FR-18"; os ranges do §6.1 batem exatamente com a numeração). Os 3 UJs têm protagonista nomeado e carregam contexto inline. Seções funcionam extraídas isoladamente: os FRs que dependem do 010 ("intenções do 010", FR-10; "infraestrutura SSE do 010", FR-13) são cobertos pelo addendum, que §0 declara leitura conjunta. Brownfield verificado: `set_objective`/`set_audience`/`generate_content`/`set_schedule`/`confirm_material` existem em `studio/ai/chat-agent.js`; eventos `status/reply/card` em `studio/chat-routes.js`; `OutreachCampaign`/`WhatsAppCampaign` e `guardrails Json` em `prisma/schema.prisma` — a nota do addendum "não JSON solto em `guardrails`" é precisa.

### Findings

- **low** "briefing do mordomo" não glossado (§2.1, UJ-2, título de §4.4) — apelido usado 3× sem entrada no §3; um leitor que extrai §4.4 isolado não resolve "mordomo". *Fix:* entrada no Glossário apontando para §4.4.

## Shape fit — strong

É um PRD chain-top declarado (§0: "para os fluxos downstream do BMad") e se comporta como tal: UJs com protagonista são load-bearing (a aposta do produto é de experiência, não de capability), o rigor de testabilidade serve a criação de stories, e a traceabilidade de riscos (§10) serve a arquitetura. Não há superformalização: nenhum UJ descreve fluxo de operador único que seria overhead, e o mobile (FR-7) é limitado a "ler estado... e aprovar/rejeitar" sem fingir paridade. O side brownfield é tratado com a disciplina que o rubric pede: refs de código exatas, UJs novos não confundidos com o Studio legado (FR-1: "Rotas antigas do Studio redirecionam para `/studio`").

### Findings

(nenhum)

## Mechanical notes

- **Roundtrip do Índice de Assumptions parcial** — §0 promete "suposições marcadas `[ASSUMPTION]` e indexadas no §9", mas 3 das 7 entradas do índice ("v1 assume 1+1 por org", "pipeline LiteLLM existente", "Stakes: ... inferido") não têm tag inline correspondente; §2.2 aponta na direção inversa ("v1 assume 1+1 (§9)"). Conteúdo rastreável, contrato próprio descumprido. *Fix:* taggear inline ou separar como "premissas de contexto" no índice.
- **Drift de glossário leve** — UJ-1 usa "saldo de warm-up" (híbrido que mistura Saldo com warm-up, ambos definidos); "orçamento de fricção" (§4.2/FR-11) e "mordomo" fora do §3. Nada que quebre resolução de termos principais (Saldo, Canal, Despertar, Certificado usados de forma uniforme).
- **ID continuity** — sem gaps nem duplicatas; SM-2 referencia seções ("4.3–4.7") onde os demais SMs referenciam FR-IDs — padronizar.
- **Termo "laya"** (§5) — só resolúvel via `backlog.md`/SPEC (é a "engine System-1" da SPEC 011); uma vírgula de contexto no PRD pouparia ida à fonte.
- **Seções obrigatórias** — todas presentes para o stake declarado (Visão, Usuário, Glossário, Features, Non-Goals, Escopo MVP, SMs, Open Questions, Índice de Assumptions, Riscos, NFRs).
