---
name: Campaign Cockpit
description: Identidade visual do Cockpit — violeta elétrico sobre quase-preto, glass sutil e glow estritamente semântico.
status: final
created: 2026-09-26
updated: 2026-09-27
companions:
  - EXPERIENCE.md
sources:
  - ../../specs/spec-campaign-studio-cockpit/experience-direction.md
---

# Campaign Cockpit — Design

## Brand & Style

Referência de linguagem: **framer.com** (aprovada pelo dono do produto) —
quase-preto em camadas, superfícies de vidro discretas, uma cor respirando via
glow, movimento suave tipo mola. Postura: **premium contido** — "cassino" é a
anti-referência máxima. O Cockpit usa o design system shadcn/Tailwind da
plataforma com uma camada de marca: os tokens abaixo valem **apenas dentro de
`.cockpit-scope`** (a subárvore `/studio`); o resto da plataforma mantém o
indigo herdado. Direção escolhida: **D1 · Violeta Elétrico**.

## Colors

- `{colors.surface-0}` `#06070A` — fundo base. Nunca em texto.
- `{colors.surface-1}` `#0B0D12` — cartões e thread (camada 1).
- `{colors.surface-2}` `#12151C` — elevação, vidro (camada 2).
- `{colors.accent}` `#8B5CF6` — A ÚNICA cor de acento. Botão primário, luz acesa do Rail, chip em hover, foco de input. Glow derivado: `{colors.glow}`.
- `{colors.accent-2}` `#A78BFA` — texto sobre acento escuro, detalhes.
- `{colors.success}` `#34D399` — saldo saudável, certificado verde. Com glow próprio suave.
- `{colors.warning}` `#FBBF24` — atenção (Teste da Maria como warning).
- `{colors.danger}` `#F87171` — bloqueio, pausa ativa, certificado reprovado.
- `{colors.text}` `#F2F4F8` · `{colors.text-2}` `#9AA3B2` · `{colors.text-3}` `#5B6472` — hierarquia de texto em três níveis, nada mais claro que `{colors.text}`.

## Typography

Inter (herdada da plataforma). Pesos 400/500/600/700. Números do saldo e
métricas em `tabular-nums`. Sem fontes novas — identidade vem de cor, espaço
e movimento, não de tipografia exótica.

## Layout & Spacing

Base 4px; coluna central do thread com largura máxima 760px centrada; respiro
generoso (mín. 24px entre blocos). `prefers-reduced-motion` desliga entrada e
sweep (substituir por indicador estático).

## Elevation & Depth

Profundidade por **tom em camadas** (`surface-0` → `surface-2`) + vidro
(`bg-white/[0.04]`, borda `rgba(255,255,255,.08)`, `backdrop-blur`). Glow
(`{colors.glow}`) permitido SOMENTE onde há significado: luz acesa do Rail,
saldo saudável, CTA primário, chip em hover, momento de envio autorizado.
**Glow decorativo é proibido.**

## Shapes

Cards 16px · inputs 14px · chips pill (`9999px`) · avatar/luzes círculos.

## Components

- **Rail (5 luzes)** — Objetivo→Audiência→Mensagem→Agenda→Saldo; luz acesa com `box-shadow: 0 0 10px {colors.glow}`; etapa inativa `#2A3140` sem glow; sweep de 900ms no envio autorizado (`cockpit-rail-sweep`).
- **Chip** — pill com borda `accent/40`, fundo `accent/10`; hover intensifica glow; **motivo citável visível** abaixo do label em `text-muted-foreground`.
- **Certificado** — card rico no thread; verde (glow success) libera, vermelho bloqueia.
- **Botão primário** — gradiente 135° `{colors.accent}`→`{colors.accent-2}` com sombra `{colors.glow}`.
- **Pausa global** — sempre acessível no header; ativa: selo vermelho + banner explicativo.

## Do's and Don'ts

- **Do:** glow só em elemento com significado de estado; movimento em 200ms ease-out com stagger 40ms; UMA cor de acento.
- **Don't:** glow de enfeite ("cassino"); segunda cor de acento; animações >400ms; claro dentro do Cockpit; jargão ("segmento", "execução", "guard-rail") em qualquer superfície.
