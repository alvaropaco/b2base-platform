# Reconcile: SPEC-campaign-studio-cockpit → PRD 011

- **Input:** `_bmad-output/specs/spec-campaign-studio-cockpit/SPEC.md`
- **Destino:** `_bmad-output/planning-artifacts/prds/prd-b2base-platform-2026-09-26/` (`prd.md` + `addendum.md`)
- **Data:** 2026-09-26
- **Método:** extração claim a claim (não ingestão). Cada claim load-bearing do SPEC foi verificado contra FRs, Non-Goals, Metrics, Assumptions e addendum.

---

## Claims capturados (resumo com âncoras)

### Why

| Claim do SPEC | Capturado em |
|---|---|
| 010 entregou o motor (audiência, conteúdo, agenda, guard-rails, analytics) | PRD §1 ("motor excelente"); addendum "Como o Cockpit se apoia no 010" |
| UI trava adoção: difícil de entender, chat desconexo, usuário sem saber o que fazer | PRD §1 (quase verbatim) |
| Maior medo do vendedor (domínio banido / WhatsApp bloqueado) tratado só reativamente | PRD §1 + §2.1 (JTBD emocional) + FR-14…20 (reativo → preventivo) |
| Vendedores não-marketer precisam confiar e escalar sem atrito | PRD §1 (segunda convicção), §2.1, FR-11 (orçamento de fricção) |
| Cockpit chat-first dark premium | FR-1…FR-7, §5 (dark como decisão), §11 (60fps, reduced-motion) |
| Piloto automático que orçamenta reputação como pré-condição | FR-14…20; addendum "Saldo = gate a montante da fila" |
| Uma pergunta por vez; acorda só em pontos de risco | FR-8; FR-31 (lista fechada de Despertares) |

### Capabilities (8 CAPs)

- **CAP-1 Cockpit chat-first** — intent em FR-1/FR-2; success "sem formulário/aba" nas consequences de FR-1. **Parcial:** o "teste dos 5 segundos" do estado vazio não virou critério (ver GAP-2).
- **CAP-2 Chat guiado por estado** — intent em FR-8/FR-9/FR-10. **Parcial:** success "concluível somente com chips" e "texto livre só em campos genuinamente abertos" sem consequence testável explícita (ver GAP-5).
- **CAP-3 Rail de progresso** — FR-3 (surge só com campanha, reflete estado real, próxima ação clicável), Glossário Rail com as 5 luzes. **Parcial:** "≤5s para identificar etapa/próxima ação" não virou critério (GAP-2); "sem decodificar jargão" só implícito.
- **CAP-4 Orçamento de reputação** — completo: FR-14 (saldo finito debitado por envio), FR-15 (bloqueio preventivo + teste de integração + "nenhum lote excede o saldo vigente" verbatim nas consequences), addendum "Moeda do Saldo".
- **CAP-5 Sugestões contextuais** — FR-21 lista exatamente os 5 sinais do SPEC. **Alterado:** success "sempre ≥3 sugestões" virou "≥1 e ≤3" (ver GAP-1). "Nenhuma inaplicável" em FR-22 + FR-24.
- **CAP-6 Dia zero** — FR-23 com os 3 convites (importar leads, descrever o que vende, demonstração). **Parcial:** "primeiro passo em ≤60s" não virou critério (GAP-2).
- **CAP-7 Movimento premium dark** — FR-6 (momento-assinatura), §11 (60fps, `prefers-reduced-motion`), §4.1 delega direção visual a `experience-direction.md` (companhion — capturado por referência).
- **CAP-8 Confiança visível** — FR-26 (fontes citadas antes da aprovação), FR-27 (certificado bloqueante: Saldo, autenticação, opt-outs, janela — os 3 itens do SPEC presentes).

### Constraints

- Dark sem exceção → §5 ("dark é decisão de produto"). ✅
- Conversa+chips como mecanismo primário; sem formulários/abas → FR-1, FR-9, FR-10, §5 (último item). ✅
- Motores existentes + bridge D1, nenhum novo motor → §5 + addendum (seção inteira sobre o 010). ✅
- Multi-tenancy, gating, LGPD, sandbox com fixtures (const. IV/V) → §11 + FR-23 `[ASSUMPTION]`. ✅
- Idempotência, NATS `*.v1` intocados (const. II) → §11 + addendum ("actions semânticas versionadas"). ✅
- Testes como porta de entrada (const. III) → §11 + consequences de FR-15/FR-27. ✅
- "Segurança do ativo é pré-condição, não feature" → §1 (primeira convicção, quase verbatim), FR-16, addendum alternativas rejeitadas. ✅
- **Stack atual / animações via CSS nativo / dependência nova só com justificativa (const. VI)** → ❌ **ausente do PRD e do addendum** (ver GAP-3).

### Non-goals

Os 5 do SPEC presentes em §5: laya/fine-tune (com `backlog.md`), moment marketing, novo canal/reescrita de motores, toggle de tema claro, editores fora do fluxo (Avançado → Gaveta, FR-5). O PRD adicionou 3 non-goals próprios (multiusuário, piloto onipresente, cold-first WhatsApp) — adição legítima, não contradição.

### Success signal

"≥40% das contas novas com 1ª campanha em voo via chat na 1ª sessão, 30 dias, zero incidentes" → SM-1 + SM-C3 (inclui a cláusula "nunca trocada por crescimento de envio"). Medição instrumentada no addendum ("telemetria antes do release"). ✅

### Assumptions

- 1 domínio + 1 WhatsApp por org, saldo agregado por canal → §9. ✅
- Pipeline LiteLLM existente → §9 + addendum. ✅
- **Saldo do Rail só aparece com canal configurado** → ❌ ausente (ver GAP-4).

### Open Questions

- Inicialização do saldo de org nova → respondida pelo design (FR-17 rampa + flag manual); números deferidos ao plan como OQ-1 do PRD. Resolução legítima. ✅
- Fonte de verdade do limite WhatsApp → PRD OQ-2 (monitorar e calibrar em produção). ✅
- Demonstração: fictícios vs. real mascarado → resolvida como `[ASSUMPTION]` fixtures (FR-23, §9), coerente com LGPD. ✅

---

## GAPS

### GAP-1 — CAP-5: critério de sucesso enfraquecido silenciosamente (≥3 → ≥1)

O SPEC valida CAP-5 com "conta com dados **sempre recebe ≥3** sugestões aplicáveis". O PRD FR-21 vira "≥1 e ≤3". Pode ser intencional (coerente com FR-22 e o ranqueamento do addendum — melhor 1 chip forte que 3 medianos), mas **inverteu um critério do contrato validado sem registrar a decisão**. Ou o PRD registra o porquê da mudança (com risco associado: home com 1 chip parece vazia?), ou FR-21 volta a ≥3 para contas com dados operacionais.

### GAP-2 — Critérios de tempo-para-compreensão dos CAPs 1, 3 e 6 caíram juntos

Três success criteria do SPEC desapareceram sem rastro: (a) **teste dos 5 segundos do estado vazio** (CAP-1: "o que esta tela faz por mim é respondível à primeira vista"); (b) **usuário identifica etapa corrente e próxima ação no Rail em ≤5s** (CAP-3); (c) **primeiro passo do Dia Zero concluído em ≤60s a partir da home** (CAP-6). O PRD só manteve o 5s do Teste da Maria — que é barra de *conteúdo*, não de *interface*. Nada nos FRs de UI (FR-2, FR-3, FR-23) ou nas SMs valida compreensibilidade. Sugestão: virar teste de usabilidade criterial ou SM secundária (ex.: SM-5 de compreensão à primeira vista em testes moderados).

### GAP-3 — Constraint da constituição VI ausente: CSS nativo / sem dependência nova de UI

O SPEC trava "animações via CSS nativo — dependência nova de UI só com justificativa na spec/plan (constituição VI)". O PRD §11 cita as constituições II, III, IV, V e VII — **a VI não aparece em lugar nenhum** (PRD nem addendum). É load-bearing justamente aqui: CAP-7 pede glow, 60fps e mensagens suaves, o convite natural a puxar Framer Motion/GSAP. Deve entrar como NFR em §11 ou como constraint no addendum para `bmad-architecture`.

### GAP-4 — Assumption do Saldo-no-Rail por canal configurado não foi transportada

"O 'Saldo' do rail só aparece quando o canal está configurado na organização" não está em §9, nem em FR-3, nem no Glossário. Afeta o desenho do Rail (a 5ª luz é condicional) e a ordenação do onboarding (configurar canal antes de mostrar saldo). Fácil de resolver: cláusula no FR-3 + linha em §9.

### GAP-5 — CAP-2: "concluível somente com chips" não virou teste explícito

O success do SPEC ("fluxo padrão concluível usando somente chips; texto livre necessário apenas em campos genuinamente abertos, ex.: descrição do objetivo") não tem consequence direta. FR-11 testa ≤6 turnos no fluxo feliz, mas não exige que os turnos sejam chips — um fluxo que dependa de digitar livre passa no FR-11 e violaria o CAP-2. FR-10 trata do roteamento do texto livre, mas não da condição inversa (texto livre **só** onde o campo é genuinamente aberto). Falta uma consequence no FR-9/FR-11: "fluxo feliz executável 100% via Chips (teste E2E)".

---

## Ideias qualitativas que a estrutura de FRs deixou cair silenciosamente

1. **A voz do Piloto.** O PRD define *o que* o Piloto decide e *quando* desperta (FR-31/32), mas não *como ele fala*: registro, pessoa, tom de companheiro de voo vs. assistente. O "tom de par" do FR-30 vale só para o copy da campanha — não para o Piloto consigo mesmo. A metáfora de aviação (piloto, despertar, voo, luzes) é a espinha dorsal da voz e sobreviveu só como vocabulário de glossário, sem diretriz de conversa.

2. **"Estado vazio elegante" e "luzes apagadas".** O feel de quiet-luxury do primeiro momento (UJ-1: "um convite no centro") foi reduzido pelo FR-2 a um inventário (marca + pergunta + ≤3 chips + placeholder). O que faz a tela parecer um convite e não uma tela vazia é direção de conteúdo e timing — não é capturável como contagem de chips, e o PRD delega isso só implicitamente a `experience-direction.md`.

3. **Glow com significado e movimento ambiente.** O SPEC separa glow "somente onde há significado" e "mensagens que entram de forma suave" (movimento de entrada, contínuo) do momento-assinatura (único). O PRD testabilizou o momento (FR-6) e **o movimento de entrada das mensagens — o feel diário do cockpit — ficou só na referência a `experience-direction.md`**, sem âncora em FR ou NFR.

4. **Honestidade sem promessa de imunidade.** "Nunca promete imunidade", "conservadorismo explícito" (CAP-4/FR-18) é uma postura de voz — como o produto *explica* um bloqueio — e não só uma regra de engine. FR-15 exige mensagem explicável, mas o tom de humildade calibrada ("quanto falta, quando libera, sem garantia absoluta") não é diretriz em lugar nenhum.

5. **"Seguro para apertar o botão" como sentimento-alvo.** O JTBD emocional e o UJ-1 (Certificado trava → configura → libera → autoriza) carregam o arco de confiança, mas nenhuma métrica valida o *sentimento*; os proxies (Certificado, pausa global, SM-C3) validam o mecânico. Se o sentimento for o produto real, merece ao menos uma verificação qualitativa declarada (entrevistas/clips pós-release).

---

## Veredito

Reconciliação forte: ~90% dos claims load-bearing do SPEC estão capturados com âncoras FR/SM rastreáveis, e o PRD legítimamente **resolveu** 1 open question (demonstração → fixtures) e **respondeu** outro (inicialização do saldo → FR-17). Os 5 gaps são de critérios de sucesso (GAP-1, GAP-2, GAP-5) e constraints/assumptions perdidas na tradução (GAP-3, GAP-4) — nenhum exige refazer o PRD; todos são patches pontuais.
