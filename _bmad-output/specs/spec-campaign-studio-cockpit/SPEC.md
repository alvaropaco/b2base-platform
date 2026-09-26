---
id: SPEC-campaign-studio-cockpit
companions:
  - backlog.md
  - experience-direction.md
sources: []
---

> **Contrato canônico.** Este SPEC e os arquivos em `companions:` são o contrato completo, validado por preservação, do que construir, testar e validar.

# Campaign Studio Cockpit (011)

## Why

Dor + oportunidade. O Campaign Studio (010) entregou o motor (audiência, conteúdo, agenda, guard-rails, analytics), mas a experiência trava a adoção: a UI é difícil de entender, o chat parece desconexo e o usuário não sabe intuitivamente o que fazer — enquanto o maior medo do vendedor (domínio de e-mail banido, WhatsApp bloqueado por spam) é tratado só reativamente. Vendedores não-marketer precisam confiar para usar e escalar sem atrito. Esta spec reconstrói o Studio como um **cockpit chat-first dark premium**: um piloto automático que orçamenta a reputação do ativo do cliente como pré-condição e conduz o usuário uma pergunta por vez, acordando-o apenas nos pontos de risco.

## Capabilities

- **CAP-1 — Cockpit chat-first**
  - **intent:** O vendedor conduz objetivo→campanha-em-voo inteiramente numa única tela de conversa (`/studio`), sem formulários nem abas.
  - **success:** O fluxo completo é executado sem abrir formulário ou aba; o estado vazio passa no teste dos 5 segundos (o que esta tela faz por mim é respondível à primeira vista).
- **CAP-2 — Chat guiado por estado**
  - **intent:** O bot faz sempre a próxima pergunta válida da máquina de estados da campanha, uma por vez, e opções finitas aparecem como chips que executam ações reais.
  - **success:** O fluxo padrão é concluível usando somente chips; texto livre é necessário apenas em campos genuinamente abertos (ex.: descrição do objetivo).
- **CAP-3 — Rail de progresso**
  - **intent:** O usuário enxerga onde a campanha está (Objetivo→Audiência→Mensagem→Agenda→Saldo) sem decodificar jargão.
  - **success:** O rail surge somente quando existe campanha e reflete o estado real; usuário identifica etapa corrente e próxima ação em ≤5s.
- **CAP-4 — Orçamento de reputação**
  - **intent:** O Studio protege o ativo de envio do cliente (domínio de e-mail, número de WhatsApp) tratando reputação como saldo finito debitado a cada envio.
  - **success:** Agendamento que excederia o saldo disponível é bloqueado preventivamente com mensagem explicável (teste de integração); nenhum lote em voo excede o saldo vigente.
- **CAP-5 — Sugestões contextuais**
  - **intent:** A home do Studio sugere as 3 próximas ações derivadas do estado real da organização (leads enriquecidos sem contato, respostas sem tratamento, rascunhos, aprovações pendentes, saldo).
  - **success:** Conta com dados sempre recebe ≥3 sugestões aplicáveis ao estado corrente; nenhuma sugestão inaplicável é exibida.
- **CAP-6 — Dia zero**
  - **intent:** Conta recém-criada recebe convites de primeiros passos (importar leads, descrever o que vende, ver demonstração) no lugar de sugestões de operação.
  - **success:** Conta nova sem dados conclui um primeiro passo em ≤60s a partir da home, sem precisar entender o produto antes.
- **CAP-7 — Movimento premium dark**
  - **intent:** A interface transmite premium via tema dark com glow somente onde há significado e mensagens que entram de forma suave.
  - **success:** Animações rodam a 60fps nas interações principais; com `prefers-reduced-motion` ativo, movimento não essencial é eliminado.
- **CAP-8 — Confiança visível**
  - **intent:** Antes de autorizar um disparo, o usuário vê de onde veio cada dado usado no conteúdo e um certificado de segurança pré-envio.
  - **success:** Todo conteúdo gerado lista as fontes de dados usadas; o disparo só habilita após certificado verde (saldo, opt-outs, janelas).

## Constraints

- Dark é decisão de produto: nenhuma superfície do Studio em tema claro.
- A interface primária é conversa + chips; formulários e abas não voltam a ser mecanismo principal do fluxo.
- Motores de envio existentes (Outreach/WhatsApp) permanecem; o cockpit compila para execuções existentes via bridge (decisão D1 do 010) — nenhum novo motor de envio.
- Stack atual (React/Vite/Tailwind em `apps/web`; Express/Prisma/BullMQ na raiz); animações via CSS nativo — dependência nova de UI só com justificativa na spec/plan (constituição VI).
- Multi-tenancy, gating por plano e LGPD valem em toda tela/endpoint novo; sandbox e demonstrações usam fixtures, nunca dados reais (constituição IV/V).
- Persistência idempotente; contratos NATS `*.v1` intocados (constituição II).
- Testes são porta de entrada: cada CAP com comportamento novo entra com teste (constituição III).
- Segurança do ativo é pré-condição, não feature: nenhum caminho de envio novo pode ignorar o saldo.

## Non-goals

- Integração laya / fine-tune de classificadores (requer dataset próprio; spec futura — ver `backlog.md`).
- Campanhas gatilho de momento (moment marketing por sinais de enriquecimento).
- Novo canal de envio ou reescrita dos motores.
- Toggle de tema claro.
- Novos editores de conteúdo fora do fluxo conversacional (o "Avançado" atual vira gaveta do piloto — ver `experience-direction.md`).

## Success signal

- Ativação segura: em 30 dias pós-release, ≥40% das contas novas colocam a primeira campanha em voo via chat na primeira sessão — com zero incidentes de bloqueio de domínio ou banimento de WhatsApp atribuíveis ao Studio. Medição: analytics de ativação + guard-rails existentes.

## Assumptions

- Uma organização opera com um domínio de e-mail e um número de WhatsApp por vez (v1): o saldo é agregado por canal.
- O "Saldo" do rail só aparece quando o canal está configurado na organização.
- O conteúdo gerado continua vindo do pipeline LiteLLM existente (extract/compose/personalize), sem modelo novo.

## Open Questions

- Como inicializar o saldo de uma org nova sem histórico (heurística de warm-up? dado do provedor de envio?) — decide o design do CAP-4.
- Qual é a fonte de verdade do limite seguro por número de WhatsApp (a política do provedor não é pública) — afeta o CAP-4.
- A "demonstração" do dia zero roda com leads fictícios gerados ou com um subconjunto real mascarado? (LGPD — ver CAP-6/`backlog.md`).
