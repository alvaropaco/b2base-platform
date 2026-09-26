# Reconciliação — experience-direction.md → PRD Cockpit (011)

Input: `_bmad-output/specs/spec-campaign-studio-cockpit/experience-direction.md`
Destino: `prd.md` + `addendum.md` (mesma pasta). Foco: FRs 1–13, 21–25, 26–30
e seções de estética/tom (§1, §2.1, §2.3, §3, §4.1/4.2/4.4/4.5, §5, §11).

## Capturado (resumo)

- **Estrutura da rota única:** FR-1 (`/studio`, thread + input no rodapé, sem
  abas/painéis), FR-2 (estado vazio: marca + pergunta-título + ≤3 chips +
  placeholder instrutivo), FR-3 (Rail com progressive disclosure, luz = etapa
  corrente, só a próxima ação válida clicável), FR-4 (cards como mensagens do
  thread), FR-5 (Gaveta sob demanda, sem menu permanente). "Zero chrome" está
  coberto em substância por FR-1/FR-4.
- **Chat guiado por máquina de estados:** FR-8 (próxima pergunta válida,
  determinística em tema), FR-9 (chips = ações semânticas do orquestrador, com
  os nomes exatos `set_objective`, `set_audience`, `generate_content`,
  `set_schedule`), FR-10 (texto livre roteado; laya como non-goal §5), FR-13
  (bolha "pensando" com progresso ao vivo via SSE do 010, eco no addendum).
- **Momento-assinatura:** FR-6 captura a luz percorrendo o Rail + assentar,
  com fallback `prefers-reduced-motion`; UJ-1 usa como climax.
- **Sugestões contextuais / mordomo:** FR-21 (motor + chip cita o dado),
  FR-22 (degradação elegante — "nunca chips fracos"), FR-23 (Dia Zero como
  primeiros passos), FR-24 (sinais fortes), FR-25 (chip inicia diálogo).
  Postura proativa do mordomo capturada em §2.1 (JTBD contextual) e §4.4.
- **Confiança visível:** FR-26 (origem dos dados, com exemplo de formato),
  FR-27 (Certificado bloqueante), FR-30 (Teste da Maria + aprovação do 1º
  lote).
- **Dark premium por referência:** §4.1 delega a direção visual a
  `experience-direction.md`; non-goal "toggle de tema claro" trava dark como
  decisão de produto; §11 captura 60fps, `prefers-reduced-motion`, contraste
  AA e teclado — a substância de "acessibilidade também é luxo" está lá
  (só o enquadramento retórico caiu).
- **Copy do dia 30:** UJ-2 reproduz 3 dos 4 exemplos quase verbatim
  (respostas quentes, saldo 82% + janela terça 9h, rascunho desde sexta).

## GAPS

1. **Zero-jargão com vocabulário exato (voz do produto) — o maior furo.** A
   regra "nunca 'segmento', 'execução', 'guard-rail' para o usuário" e as 4
   perguntas canônicas ("Quem vai receber? · O que vai ser dito? · Quando? ·
   Quanto de reputação vai custar?") não aparecem em nenhum FR, NFR ou nota de
   glossário. FR-30 cobre a copy das *campanhas* (Teste da Maria), não a voz do
   Piloto/UI. Precisa de diretriz de voice & tone vinculada a FR-8/FR-9/FR-15
   (é testável: copy user-facing sem os termos proibidos).
2. **Proibição de glow decorativo ("cassino") e estados semânticos de glow.** O
   PRD só diz "glow com significado" por referência (§4.1). Os constraints —
   **uma** cor de acento; glow permitido somente em: luz acesa do Rail, saldo
   saudável, botão de aprovação pulsando devagar; glow de enfeite proibido —
   não viram exigência testável (candidato a NFR/design-constraint ou
   consequência do FR-6). O addendum também não ecoa.
3. **Tonicidade da copy das sugestões (exemplos do dia 30).** O mecanismo está
   em FR-21 ("chip cita o dado"), mas a diretriz de tom — dado concreto +
   estado + pergunta curta de ação ("Você tem 1.240 leads enriquecidos e
   nenhum contato ainda — começamos por eles?") — não é requisito nem diretriz
   em lugar nenhum; UJ-2 ilustra 3 casos sem generalizar a regra. O 4º exemplo
   (campanha "Indústrias SP" em rascunho desde sexta — "finalizo?") não aparece
   em nenhum artefato de destino.
4. **Movimento e assinaturas visuais fora do momento-assinatura.** Entrada das
   mensagens (fade + subida curta, escalonada), Rail "surge suavemente" na
   primeira campanha, dia zero com "todas as luzes apagadas + um único glow
   suave no convite", conversa que cresce do centro, input grande — FR-2/FR-3/
   FR-23 capturam só o conteúdo/estrutura, e o addendum não recebe nada de
   direção visual; tudo depende da leitura direta do input.

## Conteúdo qualitativo perdido (quotes que caem silenciosamente)

- "Glow de enfeite é proibido ('cassino')." — ausente do PRD e do addendum.
- "Zero jargão… nunca 'segmento', 'execução', 'guard-rail'." + as 4 perguntas
  canônicas — ausentes (inclui o exemplar de pergunta-título "O que você quer
  conquistar hoje?" e o placeholder "Conte o que você quer alcançar…", que
  FR-2 exige só genericamente).
- "Acessibilidade também é luxo." — substância em §11, enquadramento perdido
  (informativo; sem ação).
- "60fps ou nada" — 60fps está em §11; a formulação de padrão binário caiu.
- Copy dia 30 não reproduzida: "A campanha 'Indústrias SP' ficou em rascunho
  desde sexta — finalizo?"; e o padrão das demais existe só como ilustração de
  UJ-2, não como diretriz.
- "Superfícies quase-preto em camadas; uma cor de acento respirando via glow"
  e "mensagens entram com fade + subida curta, escalonadas" — só no input.
- Dia zero visual: "todas as luzes apagadas, um único glow suave no convite de
  primeiros passos" — FR-23 cobre o conteúdo, não a composição visual.
