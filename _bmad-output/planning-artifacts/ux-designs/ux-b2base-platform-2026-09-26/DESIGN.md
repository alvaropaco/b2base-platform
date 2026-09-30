---
name: Campaign Cockpit
description: Identidade visual do Cockpit — noite arroxeada com bloom radial, sidebar, orbe e composer em vidro; violeta elétrico e glow estritamente semântico.
status: final
created: 2026-09-26
updated: 2026-09-29
companions:
  - EXPERIENCE.md
sources:
  - ../../specs/spec-campaign-studio-cockpit/experience-direction.md
  - https://dribbble.com/shots/26578109-Zyricon-AI-Chatbot-Web-App
---

# Campaign Cockpit — Design

## Brand & Style

Referência de linguagem: **AI Chatbot UI (Community)**
(figma.com/design/J0Y29T0mXxmbqXNjl0HQzx, nó 0:6 — pivô aprovado pelo dono do
produto em 2026-09-27; substitui Zyricon/framer). Postura mantida:
**premium contido** — "cassino" continua a anti-referência. O Cockpit usa o
design system shadcn/Tailwind da plataforma com uma camada de marca: os tokens
abaixo valem **apenas dentro de `.cockpit-scope`** (a subárvore `/studio`); o
resto da plataforma mantém o indigo herdado. Direção: **D1 · tema claro
pastel**.

Assinaturas da linguagem (tokens medidos do Figma): fundo branco com **blobs
pastel** rosa `#FF86E1` (blur ~500) e azul `#89BCFF` (blur ~300); texto
`#160211` e muted `#56637E`; **Manrope** como fonte do escopo; cards brancos a
50% com borda hairline branca e radius 8; composer branco com stroke
`#160211`/30; sparkles de 4 pontas `#160211` como marca do AI; botão primário
sólido `#160211`. Sidebar permanente (desktop) mantida, agora clara.

## Colors

- `{colors.surface-0}` `#FFFFFF` — fundo base, com blobs pastel atrás (rosa/azul borrados). Nunca em texto.
- `{colors.surface-1}` `rgba(255,255,255,0.5)` — cartões de vidro (`.cockpit-glass`).
- `{colors.surface-2}` `#FFFFFF` — cartões sólidos e composer.
- `{colors.ink}` `#160211` — A cor de acento (quase-preto arroxeado): botão primário, rail aceso, texto forte, sparkles.
- `{colors.text-2}` `#56637E` — texto secundário (o "muted" da referência).
- `{colors.success}` emerald-600/50 — saldo saudável (acima do piso), certificado verde.
- `{colors.warning}` amber-600/100 — atenção (despertar warning, Teste da Maria).
- `{colors.danger}` rose-700/rose-50 — bloqueio, pausa ativa, certificado reprovado, saldo abaixo do piso.
- `{colors.text}` `#160211` · `{colors.text-2}` `#56637E` — hierarquia de texto; Manrope 400/700 (headline 24px, corpo 14px).

## Typography

Inter (herdada da plataforma). Pesos 400/500/600/700. Headline da abertura em
2xl/3xl semibold; texto do piloto 15px com leading relaxado. Números do saldo e
métricas em `tabular-nums`. Sem fontes novas — identidade vem de cor, espaço
e movimento, não de tipografia exótica.

## Layout & Spacing

Base 4px. Casca: **sidebar 264px** (desktop ≥1024px; abaixo disso overlay com
hambúrguer, scrim e Esc) + área central flexível com topbar mínima. Thread da
conversa com largura máxima 672px (`max-w-2xl`) centrada; hero da abertura
centralizado com orbe, composer, chips e feature cards (3 colunas ≥640px).
Respiro generoso (mín. 24px entre blocos do hero). `prefers-reduced-motion`
desliga entrada, flutuação do orbe, typing dots e sweep (substituir por
indicador estático).

## Elevation & Depth

Profundidade por **translucidez sobre o gradiente pastel**: vidro
(`rgba(255,255,255,.5)`, borda branca hairline, `backdrop-blur` —
`.cockpit-glass`) e cartões sólidos brancos. Glow permitido SOMENTE onde há
significado: saldo saudável e envio autorizado (suave). **Glow decorativo é
proibido.** Profundidade NÃO vem mais de sombra escura — vem do blur dos blobs
e do contraste com o branco.

## Shapes

Frame raiz 32px · cards/composer 8–12px · chips e pills (`9999px`) · sparkles e luzes círculos.

## Components

- **Sidebar** — logo tile em gradiente + wordmark "b2base/Cockpit"; botão "Nova campanha" em gradiente com glow; seções OPERAÇÃO (Cockpit/Campanhas/Agente IA/Marca) e CANAIS (E-mail/WhatsApp com luz de saúde: verde acima do piso, rosa abaixo); card "Orçamento de Reputação" pinado no rodapé. Item ativo: `bg-violet-500/15` + ring inset violeta.
- **Orbe (abertura)** — esfera 6rem com gradiente radial (`#E9D5FF`→`#C084FC`→`#7C3AED`→`#3B1D5E`), brilho interno e halo `::after`; flutuação 5.6s (desligada em reduced-motion).
- **Composer (cartão)** — `.cockpit-glass .cockpit-composer` rounded-2xl: linha de entrada (sparkle + input/textarea 15px) + toolbar (Anexar à esquerda, hint "Piloto B2", envio circular 36px em gradiente à direita). Foco: borda violeta + halo sutil. Na abertura, o texto digitado vira a descrição da campanha.
- **Rail (5 luzes)** — Objetivo→Audiência→Mensagem→Agenda→Saldo; passo corrente em pill com gradiente violeta + glow; etapas futuras `text-2/90`; sweep de 900ms no envio autorizado (`cockpit-rail-sweep`). Faixa scrollável com máscara de fade à direita; **o passo corrente rola para o centro** no mobile.
- **Chip** — pill de UMA linha, borda `accent/25`, fundo `accent/10`; motivo citável no `title` (tooltip). Feature card correspondente (ícone + label + motivo) na abertura.
- **Mensagens** — piloto: texto plano com avatar circular em gradiente; usuário: bolha em gradiente `rounded-2xl rounded-br-md`. Cards de resultado em glass com "Fontes dos dados". Turno em curso: typing dots (3 pontos pulsantes) + status.
- **Certificado** — card rico no thread; em 2026-09-29 virou **checklist de prontidão** (nunca portão): item ok em verde (glow success sutil), pendência em âmbar com caminho, rosa reservado ao que impede somente o disparo. Não desabilita botão de avanço.
- **Pré-voo (preview de disparo)** — tela de destino da criação: dois cartões de vidro lado a lado — e-mail com o render real (preview ≡ envio) e WhatsApp como bolha de conversa; cada cartão com heading próprio e modo edição inline. Banner de pendências em âmbar (não bloqueante) com ação embutida ("conectar canal"). CTA primário sólido `{colors.ink}`: "Colocar em voo" (ou "Conectar canal para disparar" no cenário pendente).
- **Chip de anexo** — pill com ícone do tipo (imagem/documento), nome truncado em UMA linha e "×" de remoção; borda `accent/25`, fundo `accent/10`; badge discreto com o canal destino (e-mail/WhatsApp). Segue a gramática do Chip.
- **Pausa global** — sempre acessível na topbar (pill) e junto dos Despertares no mobile; ativa: pill rosada + banner explicativo em `danger`.

## Do's and Don'ts

- **Do:** glow só em elemento com significado de estado; movimento em 200ms ease-out com stagger 40ms (orbe 5.6s como exceção de ambient); UMA cor de acento; passo corrente do Rail sempre visível.
- **Don't:** glow de enfeite ("cassino"); segunda cor de acento; animações >400ms (exceto ambient); claro dentro do Cockpit; jargão ("segmento", "execução", "guard-rail") em qualquer superfície.
