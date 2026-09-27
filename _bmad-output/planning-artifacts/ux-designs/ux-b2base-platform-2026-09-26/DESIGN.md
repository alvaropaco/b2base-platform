---
name: Campaign Cockpit
description: Identidade visual do Cockpit — noite arroxeada com bloom radial, sidebar, orbe e composer em vidro; violeta elétrico e glow estritamente semântico.
status: final
created: 2026-09-26
updated: 2026-09-27
companions:
  - EXPERIENCE.md
sources:
  - ../../specs/spec-campaign-studio-cockpit/experience-direction.md
  - https://dribbble.com/shots/26578109-Zyricon-AI-Chatbot-Web-App
---

# Campaign Cockpit — Design

## Brand & Style

Referência de linguagem: **Zyricon — AI Chatbot Web App**
(dribbble.com/shots/26578109, pivô aprovado pelo dono do produto em
2026-09-27; substitui a referência anterior framer.com). Postura mantida:
**premium contido** — "cassino" continua a anti-referência. O Cockpit usa o
design system shadcn/Tailwind da plataforma com uma camada de marca: os tokens
abaixo valem **apenas dentro de `.cockpit-scope`** (a subárvore `/studio`); o
resto da plataforma mantém o indigo herdado. Direção: **D1 · Violeta Elétrico
sobre noite arroxeada**.

Assinaturas da linguagem: sidebar esquerda permanente (desktop) com botão
primário em gradiente e card de rodapé; bloom radial violeta no topo do fundo;
orbe 3D na abertura; composer em cartão de vidro com envio circular em
gradiente; superfícies glass com hairline `rgba(255,255,255,.09)`.

## Colors

- `{colors.surface-0}` `#0D0715` — fundo base (noite arroxeada), com bloom radial `rgba(139,92,246,.28)` no topo. Nunca em texto.
- `{colors.surface-1}` `#120D1B` — cartões elevados, sidebar `#0A0610`.
- `{colors.surface-2}` `#1C1927` — elevação, vidro (`bg-white/[0.04]`).
- `{colors.accent}` `#8B5CF6` — A ÚNICA cor de acento. Luz acesa do Rail, chip em hover, foco de input. Gradiente do envio/primário: 135° `#A855F7`→`#7C3AED` com sombra `{colors.glow}`.
- `{colors.accent-2}` `#A78BFA` — texto sobre acento escuro, detalhes (`violet-300`).
- `{colors.success}` `#34D399` — saldo saudável (acima do piso), certificado verde. Com glow próprio suave.
- `{colors.warning}` `#FBBF24` — atenção (despertar warning, Teste da Maria).
- `{colors.danger}` `#FDA4AF` (texto) / `#F43F5E` (sólido) — bloqueio, pausa ativa, certificado reprovado, saldo abaixo do piso.
- `{colors.text}` `#F5F4F9` · `{colors.text-2}` `#A79FAD` · `{colors.text-3}` `#6B6377` — hierarquia em três níveis, nada mais claro que `{colors.text}`.

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

Profundidade por **tom em camadas** (`surface-0` → `surface-2`) + vidro
(`bg-white/[0.04]`, borda `rgba(255,255,255,.09)`, `backdrop-blur` 18px —
`.cockpit-glass`). Glow (`{colors.glow}`) permitido SOMENTE onde há
significado: luz acesa do Rail, saldo saudável, CTA primário/envio, chip em
hover, momento de envio autorizado, halo do orbe. **Glow decorativo é
proibido.**

## Shapes

Cards/composer 16px · feature cards 12px · inputs 12–16px · chips e pills
(`9999px`) · orbe, avatar e envio círculos.

## Components

- **Sidebar** — logo tile em gradiente + wordmark "b2base/Cockpit"; botão "Nova campanha" em gradiente com glow; seções OPERAÇÃO (Cockpit/Campanhas/Agente IA/Marca) e CANAIS (E-mail/WhatsApp com luz de saúde: verde acima do piso, rosa abaixo); card "Orçamento de Reputação" pinado no rodapé. Item ativo: `bg-violet-500/15` + ring inset violeta.
- **Orbe (abertura)** — esfera 6rem com gradiente radial (`#E9D5FF`→`#C084FC`→`#7C3AED`→`#3B1D5E`), brilho interno e halo `::after`; flutuação 5.6s (desligada em reduced-motion).
- **Composer (cartão)** — `.cockpit-glass .cockpit-composer` rounded-2xl: linha de entrada (sparkle + input/textarea 15px) + toolbar (Anexar à esquerda, hint "Piloto B2", envio circular 36px em gradiente à direita). Foco: borda violeta + halo sutil. Na abertura, o texto digitado vira a descrição da campanha.
- **Rail (5 luzes)** — Objetivo→Audiência→Mensagem→Agenda→Saldo; passo corrente em pill com gradiente violeta + glow; etapas futuras `text-2/90`; sweep de 900ms no envio autorizado (`cockpit-rail-sweep`). Faixa scrollável com máscara de fade à direita; **o passo corrente rola para o centro** no mobile.
- **Chip** — pill de UMA linha, borda `accent/25`, fundo `accent/10`; motivo citável no `title` (tooltip). Feature card correspondente (ícone + label + motivo) na abertura.
- **Mensagens** — piloto: texto plano com avatar circular em gradiente; usuário: bolha em gradiente `rounded-2xl rounded-br-md`. Cards de resultado em glass com "Fontes dos dados". Turno em curso: typing dots (3 pontos pulsantes) + status.
- **Certificado** — card rico no thread; verde (glow success) libera, rosa bloqueia.
- **Pausa global** — sempre acessível na topbar (pill) e junto dos Despertares no mobile; ativa: pill rosada + banner explicativo em `danger`.

## Do's and Don'ts

- **Do:** glow só em elemento com significado de estado; movimento em 200ms ease-out com stagger 40ms (orbe 5.6s como exceção de ambient); UMA cor de acento; passo corrente do Rail sempre visível.
- **Don't:** glow de enfeite ("cassino"); segunda cor de acento; animações >400ms (exceto ambient); claro dentro do Cockpit; jargão ("segmento", "execução", "guard-rail") em qualquer superfície.
