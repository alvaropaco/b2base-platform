---
title: "Campaign Cockpit — Experience"
status: final
created: 2026-09-26
updated: 2026-09-27
companions:
  - DESIGN.md
---

# Campaign Cockpit — Experience Spine

> A direção comportamental canônica é
> `../../specs/spec-campaign-studio-cockpit/experience-direction.md`
> (compromisso adotado). Este spine registra o delta de implementação
> validado em produção (E2E 2026-09-27, Playwright + Chrome real) e
> complementa o PRD (FR-1…FR-37) e a spine de arquitetura (AD-1…AD-14).

## Foundation

Web SPA desktop-first (`/studio`, rota única, shadcn/Tailwind com escopo de
marca `.cockpit-scope` — ver `DESIGN.md`). Casca clara "AI Chatbot UI" (2026-09-27): sidebar
permanente ≥1024px e overlay com hambúrguer abaixo disso (Esc + scrim).
Mobile 375px: leitura de Despertares, aprovações e pausa global (sem edição
rica de conteúdo).

## Information Architecture

| Superfície | Alcance | Propósito |
|---|---|---|
| Home (briefing do mordomo) | `/studio` | Orbe + composer em cartão, ≤3 chips contextuais e feature cards; Rail quando existe campanha |
| Thread de conversa | mesma rota | Diálogo de briefing; piloto em texto plano com avatar, usuário em bolha gradiente; cards = mensagens ricas |
| Sidebar / overlay | casca esquerda | Cockpit, Campanhas, Agente IA, Marca (painéis "Avançado" agora são navegação, não gaveta de rodapé); card do Orçamento de Reputação no rodapé |
| Painel de Saldo | sidebar (Canais/card) | Saldo por canal com luz de saúde (verde acima do piso, rosa bloqueado), movimentos do ledger |
| Despertares | sino (topbar) | lista fechada FR-31, ack por item, teto diário; pausa global junto no mobile (FR-7) |

## Voice and Tone

Mordomo atento: PT-BR, segunda pessoa, dado concreto + pergunta de ação
("Saldo de e-mail em 82% — autoriza o disparo?"). Zero-jargão (nunca
"segmento", "execução", "guard-rail"). Limites declarados com honestidade
("não tenho acesso à sua caixa de mensagens — aqui eu monto campanhas").

## State Patterns

- **Dia Zero** (org sem dados): convites de primeiros passos, nunca chips de operação.
- **Zero-match**: audiência que casa 0 leads → *avisar* (backlog registrado no PRD §10); nunca seguir silenciosamente.
- **Bloqueio**: sempre com explicação + caminho (quanto falta, quando libera, o que configurar).

## Accessibility Floor

`prefers-reduced-motion` honrado (sweep, flutuação do orbe e typing dots →
estático); contraste AA no dark; navegação por teclado; `aria-current` no Rail
com o passo corrente centralizado na faixa scrollável; overlay de navegação
mobile com Esc, scrim e foco inicial no primeiro botão.

## Key Flows

UJ-1..UJ-3 do PRD (Rafael). Validados em produção em 2026-09-27 (E2E
Playwright; ver plano `_bmad-output/implementation-artifacts/plan-011-campaign-studio-cockpit.md`).
