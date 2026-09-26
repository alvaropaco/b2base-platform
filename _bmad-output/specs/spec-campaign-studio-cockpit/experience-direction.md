# Direção de experiência — Cockpit

Referência aprovada pelo dono do produto (2 screenshots, 2026-09-26): chat minimalista e calmo — estado vazio com ícone + título central + 3 chips de sugestão + input grande no rodapé; bolha de "pensando" da IA; a conversa cresce do centro; zero chrome.

## Estrutura (1 rota)

- `/studio` é uma única coluna de conversa; sem nav de abas, sem painéis laterais, sem cards órfãos.
- **Estado vazio:** marca/ícone, pergunta-título ("O que você quer conquistar hoje?"), 3 chips contextuais, input grande; o placeholder instrui ("Conte o que você quer alcançar…").
- **Rail das 5 luzes** (Objetivo → Audiência → Mensagem → Agenda → Saldo): surge suavemente quando a primeira campanha existe (progressive disclosure); a luz acesa é a etapa corrente; só a próxima ação válida é clicável.
- **Cards de resultado** (audiência encontrada, conteúdo gerado, agenda proposta, certificado de segurança) nascem como bolhas ricas *dentro* do thread.
- A gaveta **"Avançado"** (journeys, experimentos, templates) é aberta pelo piloto quando o contexto pede — nunca um menu permanente esperando o usuário entender.

## Chat guiado pela máquina de estados

- Cada turno consulta o estado da campanha e faz apenas a **próxima pergunta válida**; opções finitas viram chips que carregam as ações semânticas já existentes no orquestrador do 010 (`set_objective`, `set_audience`, `generate_content`, `set_schedule`, …) — **chips são ações, não sugestões de texto**.
- Texto livre segue o fluxo normal do orquestrador (classificação de intenção por LLM hoje; laya é evolução futura — ver `backlog.md`).
- **Pensando:** bolha viva com as etapas de progresso ao vivo — a infraestrutura SSE do 010 já entrega ("Criando audiência…", "Gerando conteúdo…").

## Vocabulário visual (dark premium)

- Superfícies quase-preto em camadas; **uma** cor de acento respirando via glow.
- Glow **apenas onde há significado**: luz acesa do estado, saldo saudável, botão de aprovação pulsando devagar. Glow de enfeite é proibido ("cassino").
- Movimento: mensagens entram com fade + subida curta, escalonadas; 60fps ou nada; `prefers-reduced-motion` respeitado (acessibilidade também é luxo).
- **Momento-assinatura:** envio autorizado — a luz corre pelo rail e o glow assenta.
- Zero jargão para o usuário: "Quem vai receber? · O que vai ser dito? · Quando? · Quanto de reputação vai custar?" — nunca "segmento", "execução", "guard-rail".
- **Dia zero:** todas as luzes apagadas, um único glow suave no convite de primeiros passos.

## Dia 30 — exemplos de sugestão contextual (tonicidade de copy)

- "Você tem 1.240 leads enriquecidos e nenhum contato ainda — começamos por eles?"
- "12 respostas quentes há 2 dias sem tratamento. Preparo os rascunhos de resposta?"
- "Saldo de e-mail em 82% — a melhor janela desta semana é terça 9h. Autoriza o disparo?"
- "A campanha 'Indústrias SP' ficou em rascunho desde sexta — finalizo?"

Postura do piloto: ele não espera ser perguntado — a home é o **briefing do mordomo**: as três coisas mais importantes da operação hoje, na mesa, com pergunta de abertura.
