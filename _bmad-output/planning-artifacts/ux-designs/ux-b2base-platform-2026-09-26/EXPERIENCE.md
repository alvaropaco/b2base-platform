---
title: "Campaign Cockpit — Experience"
status: final
created: 2026-09-26
updated: 2026-09-29
companions:
  - DESIGN.md
---

# Campaign Cockpit — Experience Spine

> A direção comportamental canônica é
> `../../specs/spec-campaign-studio-cockpit/experience-direction.md`
> (compromisso adotado). Este spine registra o delta de implementação
> validado em produção (E2E 2026-09-27, Playwright + Chrome real) e
> complementa o PRD (FR-1…FR-37) e a spine de arquitetura (AD-1…AD-14).
> Update 2026-09-29: onda "criação de campanha sem bloqueios" (decisão do
> dono) — prontidão em vez de portão, cenários de canal, anexos, conteúdo
> em voo e tela Pré-voo.

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
| Pré-voo (preview de disparo) | tela da campanha | Preview lado a lado do que sai por e-mail e por WhatsApp, qualquer detalhe editável ali e a ação de disparo; **destino automático do fim da criação** |
| Sidebar / overlay | casca esquerda | Cockpit, Campanhas, Agente IA, Marca (painéis "Avançado" agora são navegação, não gaveta de rodapé); card do Orçamento de Reputação no rodapé |
| Painel de Saldo | sidebar (Canais/card) | Saldo por canal com luz de saúde (verde acima do piso, rosa bloqueado), movimentos do ledger |
| Despertares | sino (topbar) | lista fechada FR-31, ack por item, teto diário; pausa global junto no mobile (FR-7) |

## Voice and Tone

Mordomo atento: PT-BR, segunda pessoa, dado concreto + pergunta de ação
("Saldo de e-mail em 82% — autoriza o disparo?"). Zero-jargão (nunca
"segmento", "execução", "guard-rail"). Limites declarados com honestidade
("não tenho acesso à sua caixa de mensagens — aqui eu monto campanhas").
Pendência nunca soa a interdição: "faltam 2 envios de saldo — a reposição
diária libera às 07:00" e não "bloqueado".

## Criação de campanha — prontidão, canais e conteúdo

Decisão do dono (2026-09-29). **A criação nunca bloqueia por mecânica de
envio.** A campanha nasce, evolui e termina no Pré-voo de ponta a ponta —
mesmo sem nenhum canal conectado. O Certificado deixa de ser portão e vira
**checklist de prontidão**: cada item informa estado + caminho ("Faltam 21
envios de saldo — a reposição diária libera mais às 07:00"), nunca desabilita
o avanço da criação. O único ponto fail-closed do produto continua sendo o
**disparo** (gate de reputação na hora de enviar — intocado).

**Cenários de canal** — moldam O QUE dispara, nunca SE a campanha existe:

| Canais conectados | Comportamento da campanha |
|---|---|
| Só e-mail | dispara só e-mail; as peças de WhatsApp ficam salvas como rascunho para quando conectar |
| E-mail + WhatsApp | dispara ambos — WhatsApp só para leads com consentimento (regra existente) |
| Nenhum | campanha criada do começo ao fim; finaliza no Pré-voo com status **"pendente de envio"** e o card de conexão de canal em destaque; conectar destrava o disparo na mesma tela |

**Consentimento WhatsApp** deixa de bloquear: leads sem consentimento ficam
fora do canal WhatsApp (recebem só e-mail); o checklist informa quantos e por
quê. **SPF/DKIM** segue aviso (2026-09-27). **Agenda vazia** não é erro: sem
janela definida o disparo usa a política padrão, editável no Pré-voo.

**Anexos** (dono, PS3): o cliente anexa imagens e arquivos que saem **juntos
na mensagem** — no e-mail como anexo do provedor; no WhatsApp como mídia (1
imagem **ou** 1 documento por mensagem, limite do canal). Anexo é da campanha,
com escolha de canal destino e limite de tamanho visível antes de enviar.

**Materiais salvos** (dono, PS1): todo material/anexo criado durante a
campanha fica salvo nela para acompanhamento (aba Materiais do detalhe) —
incluindo falhas de extração, com estado e motivo.

**Conteúdo em voo** (dono, PS2): com disparo em curso, o conteúdo das
mensagens **ainda não enviadas** permanece editável (Pré-voo, Revisão e
chat); mensagens já enviadas são imutáveis; o Monitor registra que houve
edição e a partir de quando vale, sem jargão.

**Fim da criação**: cumpridas as etapas, o cliente é **redirecionado
automaticamente ao Pré-voo** (sem pedir permissão; o chat fica um clique
atrás). Nenhum dead-end: do Pré-voo dá para voltar ao chat, ao detalhe ou
editar qualquer coisa.

## State Patterns

- **Dia Zero** (org sem dados): convites de primeiros passos, nunca chips de operação.
- **Zero-match**: audiência que casa 0 leads → *avisar* (backlog registrado no PRD §10); nunca seguir silenciosamente.
- **Pendência × Bloqueio**: pendência (canal, saldo, consentimento, agenda) é informativa e tem caminho — nunca trava a criação; bloqueio só existe na hora do disparo (gate) e sempre com explicação + caminho (quanto falta, quando libera, o que configurar).
- **Campanha em voo**: editável no que ainda não saiu; o que já saiu é registro histórico imutável.

## Accessibility Floor

`prefers-reduced-motion` honrado (sweep, flutuação do orbe e typing dots →
estático); contraste AA no dark; navegação por teclado; `aria-current` no Rail
com o passo corrente centralizado na faixa scrollável; overlay de navegação
mobile com Esc, scrim e foco inicial no primeiro botão; no Pré-voo, os dois
previews têm título e estrutura de heading própria (não dependem só da
comparação visual lado a lado).

## Key Flows

UJ-1..UJ-3 do PRD (Rafael). Validados em produção em 2026-09-27 (E2E
Playwright; ver plano `_bmad-output/implementation-artifacts/plan-011-campaign-studio-cockpit.md`).

**UJ-4 — Rafael cria a campanha sem canal conectado** (2026-09-29). Rafael
briefa o mordomo, anexa um PDF e uma imagem, vê o conteúdo nascer e — sem
WhatsApp pareado e com saldo de e-mail em reposição — é levado ao **Pré-voo**:
vê o e-mail renderizado e a bolha do WhatsApp lado a lado, ajusta o assunto,
lê no checklist o que falta ("conecte o WhatsApp" / "saldo libera às 07:00"),
conecta o canal ali mesmo e coloca em voo. Clímax: a campanha **sempre** chega
inteira ao Pré-voo — a conexão de canal é um passo dentro da jornada, não um
portão antes dela.
