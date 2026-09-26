# Review de Compliance — PRD: Campaign Studio Cockpit (011)

**Revisor:** ad-hoc (lente de compliance) · **Data:** 2026-09-26
**Artefatos revisados:** `prd.md` + `addendum.md` (mesma pasta) · Referências: LGPD (Lei 13.709/2018), ToS WhatsApp/Meta Business Messaging Policy, requisitos Google/Yahoo bulk sender (2024), `docs/constitution.md` v2.0.0.
**Veredito:** **Aprovado com ressalvas** — 1 bloqueador (C-1) que deve ser resolvido antes de `bmad-architecture`; os demais entram como emendas no PRD/plan.

O PRD é notavelmente consciente de compliance para o gênero: elimina cold-first via WhatsApp (§4.7, §5), faz do Certificado um gate bloqueante (FR-27), trata opt-out como item de bloqueio (FR-27), proíbe promessa de imunidade (§4.3, §10), e usa fixtures no sandbox (FR-23, coerente com constituição V). Os findings abaixo não revertem a direção — fecham lacunas entre a intenção declarada (§11 "LGPD/compliance") e requisitos exigíveis.

---

## Critical

### C-1 — Transporte WhatsApp não-oficial (WAHA): risco estrutural de ToS não declarado no PRD
**Cita:** §4.7 (FR-35, FR-36), §4.3 (FR-18), §1, §2.1 ("zero medo de queimar… banir WhatsApp"), §10 (linha 1 da tabela de riscos), Open Question 2; addendum inteiro (não menciona o transporte).

O PRD trata o risco WhatsApp como problema de **consentimento + pacing** (FR-35, FR-18) e o §10 declara o risco crítico "resolvido" por esses FRs. Porém o transporte real do produto é o WAHA (`/Volumes/OxAI/github/b2base-platform/waha-provider.js`: sessão persistente pareada por QR, modelo WhatsApp Web multi-device) — automação **fora dos canais oficiais do Meta**, o que viola os Termos de Serviço do WhatsApp *independentemente* de consentimento, opt-in e ritmo conservador. Contas em clients não-oficiais são banidas em ondas periódicas de enforcement; o "limite seguro" da Open Question 2 é desconhecido justamente porque não há política pública para automação não-oficial — não é um limite, é proibição. Consequências:

1. A mitigação do risco crítico nº 1 do §10 está **incompleta**: FR-18/FR-35 reduzem probabilidade, não eliminam a causa.
2. O emocional de venda (§2.1 "zero medo de… banir WhatsApp") e a narrativa do Saldo ("confiança se calibra") prometem implícitamente um controle que o transporte não garante — risco de promessa de produto que cria exposição legal/contratual com o próprio cliente.
3. Nem PRD nem addendum registram o risco ou uma aceitação formal — constituição (Governança) exige que exceções/riscos relevantes fiquem documentados na spec/plan.

**Fix sugerido:**
- PRD §10: nova linha de risco "Transporte WhatsApp não-oficial (WAHA) — Sev. Crítico — mitigação: registro de aceitação de risco do dono do produto + caminho de migração/contingência para WhatsApp Business Cloud API (template messages, janela 24h oficial) avaliado em `bmad-architecture`".
- Addendum: seção "Transporte WhatsApp" explicitando WAHA hoje, limites empíricos monitorados (FR-18) e critério de gatilho para migração (ex.: N bans atribuíveis — já coberto por SM-C3).
- Open Question 2: reformular — não existe "limite seguro público" para clientes não-oficiais; o que existe é tolerância empírica do Meta sujeita a banimento unilateral.
- O produto NÃO deve usar o canal WhatsApp como argumento de garantia em onboarding/copy enquanto o transporte for não-oficial (ver L-1).

---

## High

### H-1 — Nenhum FR exige mecanismo de descadastro por mensagem (one-click unsubscribe / List-Unsubscribe)
**Cita:** §11 ("opt-out sempre disponível e honrado"), FR-27 (opt-out como item do Certificado), §4.3; ausente em §4 inteiro.

O §11 declara opt-out "sempre disponível", mas **nenhum FR** especifica o mecanismo: toda mensagem de e-mail precisa ter link de descadastro funcional e, para envio em volume, os cabeçalhos `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058) — requisito **obrigatório** do Google/Yahoo para bulk senders (≥5 mil msgs/dia para um mesmo provedor) e honrado em ≤2 dias (que também é a expectativa de resposta à oposição do titular, LGPD art. 18, §2). Verificação no código: `dispatch-utils.js` e `outreach-workers.js` não injetam `List-Unsubscribe` — a lacuna existe hoje e o PRD não a fecha. Sem isso, o Certificado (FR-27) pode "passar" com campanhas tecnicamente não conformes, e o domínio do cliente (remetente) fica exposto a bulking/defexão.

**Fix sugerido:** novo FR (§4.3 ou §4.5): "Toda mensagem de e-mail inclui link de descadastro e cabeçalhos List-Unsubscribe/one-click; descadastro processado em ≤48h, propagando para a lista de supressão global da org e para o Certificado (FR-27)". Consequences testáveis: header presente em 100% dos disparos; teste de integração do fluxo one-click → suppression. Nota p/ arquitetura no addendum.

### H-2 — Taxa de reclamação de spam (complaint rate) ausente do Saldo, do Certificado e das métricas
**Cita:** FR-14 (débito por envio/reposição por engajamento), FR-18 (sinais de rejeição/bloqueio reduzem Saldo — só WhatsApp), FR-27 (itens do Certificado), SM-4 ("tendência de rejeições por Canal"), SM-C3.

O Google/Yahoo exigem spam rate **< 0,3%** (feedback loops) como condição de entregabilidade — é o sinal mais destrutivo para um domínio, e o PRD não o modela: o Saldo debita por envio e reage a "rejeição/bloqueio" apenas no WhatsApp (FR-18); SM-4 monitora "rejeições". Um domínio pode manter Saldo alto, autenticação verde (FR-16) e ainda assim queimar por complaints. Há também uma incoerência de produto: a infraestrutura já detecta opt-out em lote (`studio/guardrails.js` — anomalia de bounce/opt-out), mas o FR-18 só formaliza débito por sinais de WhatsApp.

**Fix sugerido:** (a) estender FR-14/FR-18: "sinais negativos por Canal incluem bounce, opt-out e reclamação de spam (FBL); complaint rate acima de limiar conservador (ex.: 0,1%) debita o Saldo e acima do limite do provedor (0,3%) trava o Canal com Despertar" — incluído na lista fechada de Despertares do FR-31 ("anomalia de Saldo/entrega" já cobre, explicitar); (b) SM-4: trocar/aumentar "tendência de rejeições" para incluir complaint rate por Canal; (c) item do Certificado FR-27: "complaint rate do Canal dentro do limite".

### H-3 — Base legal do cold outreach, papel LGPD da plataforma e direitos do titular não declarados
**Cita:** §0 (propósito), §4.5 (FR-26 — transparência de origem ≠ base legal), §11 ("LGPD/compliance" genérico), FR-23 `[ASSUMPTION: …LGPD]`.

O PRD manipula dados pessoais de sócios/contatos (pessoas naturais — LGPD se aplica a B2B; não há exceção B2B na lei) e não declara: (a) **base legal** do tratamento para o cold outreach por e-mail — consenso do mercado/ANPD: consentimento ou legítimo interesse *documentado em RAIPD* com expectativa razoável do titular; o PRD não exige nem referência a RAIPD nem registro de LIA por organização; (b) **papel da b2base como operadora** (art. 39–40) — a plataforma processa leads em nome do cliente controlador; não há requisito de termos/cláusula de operador nem instrução de tratamento; (c) **direitos do titular** (art. 18: acesso, correção, eliminação, oposição) — nenhum FR/fluxo para receber e propagar um pedido de eliminação de lead para supressão, sugestões (FR-21), audiências e campanhas em voo. FR-23 já demonstra o padrão correto (assumption LGPD explícita) — falta a mesma disciplina para o tratamento real de leads.

**Fix sugerido:** nova subseção de requisitos de compliance (ou addendum com FRs correspondentes): (1) PRD declara base legal por canal (e-mail: legítimo interesse com RAIPD do cliente ou consentimento; WhatsApp: consentimento — já garantido pelo FR-35); (2) requisito de termo de operador/instrução de tratamento aceito pelo cliente no onboarding; (3) novo FR: "Pedido de titular (eliminação/oposição) recebido pela plataforma é propagado à supressão global da org e impede reimportação/recontato; auditável". Nota: FR-35 e o compliance-service existente (supressão, FR-011/012 do 010) já dão a base técnica — o que falta é o FR do fluxo do titular.

---

## Medium

### M-1 — DMARC "quando aplicável" (FR-16) é frouxo demais para bulk sender
**Cita:** FR-16 ("SPF+DKIM verificados (DMARC quando aplicável)"), FR-27.

Para o Google/Yahoo, DMARC é **obrigatório** para bulk senders (≥5 mil/dia), não opcional; SPF/DKIM sozinhos não bastam nesse patamar. Como o PRD não define quando DMARC "aplica", a regra fica não-testável exatamente onde o risco é maior (rampa alta = orgs maiores).

**Fix:** FR-16 → "SPF+DKIM verificados; DMARC exigido (política mínima `p=none`) quando o volume projetado da org atingir patamar de bulk sender (definir no plan; ex.: ≥5 mil msgs/dia)" + item correspondente no Certificado (FR-27).

### M-2 — FR-35 aceita "resposta prévia a e-mail" como consentimento para WhatsApp
**Cita:** §4.7 ("leads que responderam e-mail ou têm consentimento registrado"), FR-35.

A política do Meta exige opt-in **para receber mensagens no WhatsApp**; uma resposta a um e-mail frio demonstra interesse na conversa por e-mail, não consentimento para o canal WhatsApp — interpretação expansiva é exatamente o padrão que gera banimento (e fragiliza a defesa LGPD do consentimento). O próprio §10 lista banimento como risco crítico; o FR-35 não deveria criar a via mais fraca.

**Fix:** FR-35 → consentimento apenas via "opt-in registrado e específico de WhatsApp, auditável por lead (origem, data, evidência)". Responder e-mail pode no máximo qualificar o lead para o *pedido* de opt-in pelo WhatsApp (primeira mensagem do tipo pedido de permissão, também auditada). Ajustar §4.7 e o UJ-2 se aplicável.

### M-3 — Transferência internacional: dados de leads enviados a provedores LLM sem menção a mecanismo
**Cita:** §9 ("Conteúdo continua gerado pelo pipeline LiteLLM existente"), addendum ("Pipeline de conteúdo… via LiteLLM"), FR-26/FR-30.

O pipeline de personalização envia dados de pessoas naturais (nome do founder, empresa, CNAE — cf. exemplo do FR-26) a provedores de IA tipicamente estrangeiros. Transferência internacional (art. 33) exige salvaguarda (SCCs da Resolução CD/ANPD 19/2024, adequação, ou contrato com cláusulas-padrão do provedor). Nem PRD nem addendum mencionam o tema, e o FR-26 dobra a exposição ao *exibir* os campos transferidos.

**Fix:** addendum: nota de compliance — inventário de dados enviados ao LLM (minimização: enviar só os campos usados na personalização), DPA/SCCs dos provedores verificados, e proibição de treino/retenção do provedor (quando disponível, ex.: endpoints enterprise). Opcionalmente um FR de minimização: "prompt enviado ao modelo contém apenas os campos listados como fontes (FR-26)".

### M-4 — Gating por plano citado, mas não mapeado nos FRs (constituição IV)
**Cita:** §11 ("gating por plano (trial/premium) em toda ação nova (constituição IV)"); FR-21 (sugestões sobre leads enriquecidos), FR-33 (orçamento de Despertares), §4.7 (canal WhatsApp), FR-23 (sandbox).

A constituição exige que nenhuma resposta exponha capacidade além do plano; o §11 cobre o princípio, mas nenhum FR indica quais capacidades são premium — e várias dependem de dados de enriquecimento profundo (premium segundo a constituição IV: trial = básico, premium = profundo). Risco concreto: sugestões do FR-21 sobre "leads enriquecidos" vazarão capacidade premium para trial se o FR não herdar o masking (`plan.js`/`plan-masking.js`).

**Fix:** nota no addendum (tabela FR → plano a fixar no plan): no mínimo FR-21 (usa enriquecimento → gating herdado), WhatsApp (canal premium?), sandbox FR-23, e teto de Despertares FR-33 por plano. Consequence testável: trial org não recebe Chip motivado por dado de enriquecimento profundo.

### M-5 — Retenção e eliminação de dados de campanha indefinidos
**Cita:** §9 (assumption de fixtures), FR-29/FR-32 (registros de decisão "com quais dados"), tracking/replies herdados do 010 (addendum).

Logs de decisão do Piloto (FR-32), analytics (FR-29) e o inbox/tracking herdam dados pessoais de leads sem política de retenção/eliminação no PRD (LGPD arts. 15–16: eliminação após fim do tratamento). Como o FR-32 institucionaliza registros com dados de leads, o PRD deve ao menos travar o mecanismo.

**Fix:** §11 ou addendum: "registros do Piloto, analytics e respostas retêm dados de leads por prazo definido no plan; eliminação do lead propaga para logs legíveis (anonymização dos identificadores, preservando a trilha de auditoria)". Mechanism-first, como o PRD já faz com rampa (FR-17).

---

## Low

### L-1 — Copy/UI pode converter "zero medo" (§2.1) em promessa de imunidade
**Cita:** §2.1 (emocional: "zero medo de queimar domínio ou banir WhatsApp"), §4.3 ("nunca promete imunidade" — bom).

Internamente o PRD é disciplinado (§4.3, §10: "zero promessa de imunidade"), mas nada impede que onboarding/UI/marketing traduzam o emocional em garantias ("seus envios nunca serão bloqueados", "entregabilidade garantida") — promessa que cria risco contratual/defensório, sobretudo com transporte WAHA (C-1).

**Fix:** diretriz de copy (uma linha no §4.5 ou addendum): nenhuma superfície do produto promete entregabilidade, imunidade a banimento ou resultados; copy de risco usa linguagem de redução de risco ("reduz o risco", "protege seu domínio"). Validar com o Teste da Maria aplicado a claims.

### L-2 — FR-28 depende de auto-declaração do cliente ("domínio pré-aquecido") sem validação técnica
**Cita:** FR-17 (flag manual eleva o piso "sob responsabilidade do cliente"), FR-28 ("pré-aquecido" habilita override).

Se o envio é do domínio próprio do cliente, o risco reputacional é dele — mas o PRD não deixa claro se há infraestrutura de envio compartilhada da plataforma (IP/reputação remetente). Auto-declaração sem checagem permite que um cliente declare "pré-aquecido" e dispare agressivamente imediatamente (e, se houver envio compartilhado, contamina terceiros).

**Fix:** FR-28 Consequence: "override 'pré-aquecido' sujeito a validação técnica leve (idade do domínio/criação do registro, presença em blocklists públicas) no plan; se houver IP compartilhado na arquitetura, o Saldo de outros clientes não pode ser afetado — arquitetura a confirmar em `bmad-architecture`".

### L-3 — Opt-out de entrada no WhatsApp (palavras-chave) não especificado
**Cita:** FR-36 ("regras do Canal… opt-out"), FR-31 (Despertar por rejeição/bloqueio), FR-35.

O FR-36 trata opt-out como item de Certificado (gate de saída), mas não especifica o processamento de **mensagens de entrada** de opt-out no WhatsApp ("sair", "stop", "não quero receber", bloqueio do contato) — que deve suprimir o lead imediatamente e alimentar o Certificado/suppressão. O transporte WAHA entrega inbound (webhook de mensagem), então é viável e testável.

**Fix:** FR-36 Consequence: "mensagem de entrada com intenção de opt-out marca o lead como suprimido no Canal em ≤24h, bloqueia lotes futuros (FR-27) e é auditável; bloqueio do contato pelo lead equivale a opt-out".

---

## Coerência com a Constituição (verificação pedida)

- **Segredos (constituição V): coerente.** Nenhum FR introduz segredo; FR-16 exige verificação DNS do cliente; FR-23 (sandbox com fixtures) espelha "materiais sensíveis de teste usam fixtures". Sem finding.
- **Gating por plano (constituição IV): parcialmente coerente.** §11 cobre o princípio, mas falta mapeamento FR → plano (ver M-4).
- **II (NATS `*.v1`), III (testes), VII (observabilidade): coerentes** — §11 cita princípios corretamente (versão 2.0.0 do `docs/constitution.md`); addendum versiona actions como `*.v1`.
- **I (spec antes de código): coerente** — PRD deriva de spec 011 declarada no §0.
- Nota menor: o §11 referencia a numeração antiga da constituição ("constituição IV/V/VII") — a numeração coincide na v2.0.0, mas a emenda 2.0.0 reescreveu o princípio I; vale citar a versão ("constituição v2.0.0, princípios IV/V/VII") para evitar drift futuro.

## Resumo para o PM

| Sev. | # | Tema |
|---|---|---|
| Critical | 1 | C-1 transporte WAHA vs ToS WhatsApp |
| High | 3 | H-1 unsubscribe/one-click; H-2 complaint rate no Saldo; H-3 base legal/operador/titular |
| Medium | 5 | M-1 DMARC bulk; M-2 consentimento WhatsApp via resposta de e-mail; M-3 transferência internacional LLM; M-4 gating por plano nos FRs; M-5 retenção/eliminação |
| Low | 3 | L-1 copy anti-promessa; L-2 validação do histórico do domínio; L-3 opt-out de entrada WhatsApp |

Ação recomendada: resolver C-1 (registro de risco + caminho de migração) antes de `bmad-architecture`; incorporar H-1…H-3 como emendas diretas no PRD (FRs novos/ajustados) nesta iteração; M/L podem ir para o plan como notas vinculadas.
