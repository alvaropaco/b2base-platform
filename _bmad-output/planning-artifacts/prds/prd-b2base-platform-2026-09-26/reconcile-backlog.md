# Reconciliação: backlog da spec 011 → PRD Campaign Studio Cockpit

- **Input:** `_bmad-output/specs/spec-campaign-studio-cockpit/backlog.md` (MoSCoW confirmado, sessão 2026-09-26)
- **Destino:** `prd.md` + `addendum.md` (pasta `prd-b2base-platform-2026-09-26`)
- **Data:** 2026-09-26
- **Veredito geral:** captura alta. Todos os itens Must e os Won't estão presentes em FRs, §5, §6.1/6.2 ou addendum. Os Shoulds "Confiança visível" e os Coulds foram promovidos/reescopados explicitamente. Há 5 gaps — 1 semântico (killer suggestion #2), 1 estrutural (ordem de construção) e 3 de detalhe qualitativo.

## Itens capturados (resumo, item a item)

### Must

| Item do backlog | Onde foi capturado |
|---|---|
| **Cockpit UX completo** (CAP-1/2/3/7): `/studio` em 1 rota, thread central, rail das 5 luzes com progressive disclosure, cards como bolhas no thread, abas/painéis removidos, chat guiado por máquina de estados com chips-ação, dark premium | FR-1 (rota única), FR-2 (estado vazio), FR-3 (Rail + progressive disclosure), FR-4 (cards no thread), FR-5 (Gaveta), FR-8 (máquina de estados), FR-9 (chips-ação); §6.1; direção visual delegada a `experience-direction.md`; complemento "tema claro" virou Non-goal §5 |
| **Chips contextuais + dia zero** (CAP-5/6): endpoint de sugestões sobre o estado da org | FR-21 (motor de sugestões sobre estado da org), FR-22 (graceful degradation), FR-23 (Dia Zero), FR-25 (chip inicia diálogo); §6.1; esboço do motor no addendum |
| — Killer suggestion 1: respostas quentes sem tratamento (reusa classificação do 010) | FR-21 + addendum ("Classificação de respostas (010) alimenta a killer suggestion 'respostas quentes' — só confiança alta"); UJ-2 ilustra |
| — Killer suggestion 3: autorizar disparo na melhor janela com saldo saudável | FR-21 ("Saldo+janela favoráveis") + addendum (ranking); UJ-2 |
| **Orçamento de reputação mínimo** (CAP-4): saldo por canal + débito por envio + bloqueio preventivo com explicação + painel de saldo | FR-14 (saldo/débito), FR-15 (bloqueio explicável), FR-20 (painel); §6.1; addendum "Moeda do Saldo" |

### Should

| Item do backlog | Onde foi capturado |
|---|---|
| **Confiança visível** (CAP-8): citação da origem dos dados; certificado pré-disparo | FR-26 (origem citada) e FR-27 (certificado bloqueante) — promovidos ao §6.1 junto com FR-28…FR-30 |
| Killer suggestions refinadas (copy e priorização) | **Parcial** — priorização capturada no addendum (ranking: respostas quentes > riscos > retomadas > crescimento); refinamento de copy sem dono (gap 5) |
| Painel de saldo completo (histórico, projeção de reposição) | **Parcial** — FR-20 cobre corrente/tendência/explicação; histórico via eventos auditáveis no addendum; projeção de reposição ausente (gap 3) |

### Could

| Item do backlog | Onde foi capturado |
|---|---|
| Sandbox "ver o Studio voar" com leads de demonstração | Capturada e reescopada: FR-23 entrega demonstração (fixtures, LGPD); §6.2 exclui sandbox **interativa** com voo completo (v1.x) |
| Efeito especial do envio autorizado (luz correndo pelo rail) | FR-6 (momento-assinatura, promovido ao MVP, com `prefers-reduced-motion`); §6.2 exclui animação além do momento-assinatura |
| Piloto automático end-to-end (guard-rail do 1º lote como embrião) | §6.2 exclui piloto automático sem 1º lote aprovado; FR-30 e addendum mantêm o guard-rail obrigatório e o batizam de embrião do Contrato de Autonomia (FR-31…) |

### Won't (desta vez)

| Item do backlog | Onde foi capturado |
|---|---|
| **laya** como engine System-1 | §5 Non-Goals ("laya / fine-tune de classificadores — reavaliar com dataset pós-Must"); justificativa comprimida (gap 4) |
| Campanhas gatilho de momento (moment marketing) | §5 Non-Goals, quase verbatim ("spec futura") |
| Novo canal de envio; toggle de tema claro | §5 Non-Goals ("Novo canal de envio / reescrita dos motores"; "Toggle de tema claro — dark é decisão de produto") |

### Ordem de construção

Acordo "Cockpit+Chips juntos → Orçamento por baixo (scheduler) → Confiança progressiva → Piloto/laya por último" — **não registrada** no PRD nem no addendum (gap 2).

## GAPS

1. **Killer suggestion #2 alterada sem flag de divergência (semântico).** O backlog confirma "reengajamento em 1 clique de leads que abriram 2+ e-mails" (critério por aberturas, execução em 1 clique). O PRD mudou ambos os pontos: FR-24 exige sinal forte (clique ou resposta), com aberturas só como reforço ("nenhum Chip motivado só por opens"), e FR-25 faz o chip **iniciar diálogo**, não executar nada ("não executa nada sem o passo do usuário"). A mudança é defensável (anti-spull/anti-chip-fraco), mas é uma decisão nova que contraria o MoSCoW confirmado e não está marcada como divergência a validar com o dono do produto.
2. **Ordem de construção acordada não capturada (estrutural).** "Cockpit+Chips juntos → Orçamento por baixo (scheduler) → Confiança progressiva → Piloto/laya por último" não aparece em nenhuma seção do PRD (§6 só tem In/Out of Scope) nem no addendum. `bmad-create-epics-and-stories` perde o sequenciamento que o dono validou — em especial "Orçamento por baixo (scheduler)", que implica o Saldo como gate a montante da fila existente (hoje implícito apenas no addendum).
3. **"Projeção de reposição" do painel de saldo sumiu (Should).** O backlog pede painel completo com "histórico, projeção de reposição". FR-20 é retroativo (valor corrente, tendência recente, explicação de variações); a projeção só aparece indiretamente na mensagem de bloqueio (FR-15: "quando/como libera"). Decidir: incluir projeção no FR-20 ou documentar a exclusão no §6.2.
4. **Won't laya: justificativa e papéis comprimidos.** §5 mantém o essencial (reavaliar pós-Must), mas perde: (a) os 3 papéis que laya exerceria — roteador de intenção do chat, guardrail de conteúdo pré-envio, escalation por confiança; (b) o dado decisivo "checkpoints rendem perto do acerto aleatório em zero-shot → exige fine-tune com dataset próprio"; (c) o link do repo (`github.com/NandhaKishorM/laya`). Sem isso, a reavaliação pós-Must fica sem critério objetivo.
5. **Should "killer suggestions refinadas (copy e priorização)": copy sem dono.** A priorização foi parar no ranking do addendum, mas o refinamento de copy/microcopy dos chips não tem FR, métrica nem nota no addendum — FR-21 só exige que o chip cite o dado motivador. Risco de a "copy refinada" (deliverable Should explícito) não virar tarefa em epics/stories.

## Detalhes qualitativos perdidos (para referência, não bloqueiam)

- **Copy das killer suggestions:** o backlog não traz copy literal, mas a formulação é mais viva que os FRs — "12 respostas quentes há 2 dias sem tratamento" (UJ-2 preserva o espírito); "reengajamento em 1 clique" perdeu a promessa de imediaticidade ao virar FR-25 (ver gap 1).
- **Justificativa do Won't laya:** "encaixe real, mas checkpoints rendem perto do acerto aleatório em zero-shot" — a nuance "encaixe real" (não é rejeição técnica, é bloqueio de qualidade do modelo base) se perdeu no §5; importa para não reler o non-goal como rejeição da abordagem.
- **"Movimento premium dark":** o PRD delega a `experience-direction.md` e registra "dark é decisão de produto" — aceitável, mas a expressão de intenção ("movimento") sobrevive só como FR-6/glow.
- **Guard-rail do 1º lote como "embrião":** capturado no addendum quase verbatim — sem perda.
- **Referência canônica:** o backlog aponta o memlog do brainstorming como registro canônico; o PRD §0 referencia a pasta da spec, o que cobre indiretamente.
