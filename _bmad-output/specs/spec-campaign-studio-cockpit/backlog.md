# Backlog — MoSCoW confirmado (sessão 2026-09-26)

Priorização validada pelo dono do produto na sessão de brainstorming
(`../../brainstorming/brainstorm-campaign-studio-2026-09-26/.memlog.md` — registro canônico).
Ordem de construção acordada: Cockpit+Chips juntos → Orçamento por baixo (scheduler) → Confiança progressiva → Piloto/laya por último.

## Must (escopo desta spec)

- **Cockpit UX completo** (CAP-1, CAP-2, CAP-3, CAP-7): `/studio` em 1 rota, thread central, rail das 5 luzes com progressive disclosure, cards como bolhas no thread, abas/painéis removidos, chat guiado pela máquina de estados com chips-ação, movimento premium dark.
- **Chips contextuais + dia zero** (CAP-5, CAP-6): endpoint de sugestões sobre o estado da org; killer suggestions prioritárias — (1) respostas quentes sem tratamento (usa a classificação de resposta existente do 010), (2) reengajamento em 1 clique de leads que abriram 2+ e-mails, (3) autorizar disparo na melhor janela com saldo saudável.
- **Orçamento de reputação mínimo** (CAP-4): saldo por canal + débito por envio + bloqueio preventivo com explicação + painel de saldo.

## Should

- Confiança visível (CAP-8): citação da origem dos dados em cada frase gerada; certificado de segurança pré-disparo.
- Killer suggestions refinadas (copy e priorização).
- Painel de saldo completo (histórico, projeção de reposição).

## Could

- Sandbox "ver o Studio voar" com leads de demonstração (dia zero).
- Efeito especial do envio autorizado (luz correndo pelo rail).
- Piloto automático end-to-end (plano de voo declarado; execução com aprovação só nos pontos de risco — o guard-rail de 1º lote do 010 é o embrião).

## Won't (desta vez)

- **laya** ([github.com/NandhaKishorM/laya](https://github.com/NandhaKishorM/laya)) como engine System-1 — roteador de intenção do chat, guardrail de conteúdo pré-envio, escalation por confiança. Encaixe real, mas os checkpoints base rendem perto do acerto aleatório em zero-shot: exige fine-tune com dataset próprio antes. Reavaliar após o Must em produção.
- Campanhas gatilho de momento (moment marketing a partir de sinais de enriquecimento).
- Novo canal de envio; toggle de tema claro.
