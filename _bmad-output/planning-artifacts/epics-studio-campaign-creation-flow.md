---
stepsCompleted: [step-01, step-02, step-03, step-04]
inputDocuments:
  - _bmad-output/planning-artifacts/ux-designs/ux-b2base-platform-2026-09-26/EXPERIENCE.md
  - _bmad-output/planning-artifacts/ux-designs/ux-b2base-platform-2026-09-26/DESIGN.md
  - _bmad-output/planning-artifacts/ux-designs/ux-b2base-platform-2026-09-26/.memlog.md
  - _bmad-output/planning-artifacts/prds/prd-b2base-platform-2026-09-26/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-b2base-platform-2026-09-26/ARCHITECTURE-SPINE.md
  - _bmad-output/specs/spec-studio-campaign-reliability/SPEC.md
---

# b2base-platform — Epic Breakdown — Criação de Campanha sem Bloqueios

## Overview

Fatiamento da onda "criação de campanha sem bloqueios" (decisão do dono em
2026-09-29, registrada no `.memlog.md` do spine UX
`ux-b2base-platform-2026-09-26` e materializada no update de hoje do
`EXPERIENCE.md`/`DESIGN.md`) em epics e stories implementáveis, sobre o
Cockpit 011 já built. Fonte dos requisitos: seção "Criação de campanha —
prontidão, canais e conteúdo" do EXPERIENCE.md + decisões do dono
(cenários 1.1/1.2/1.3, PS1 materiais, PS2 edição em voo, PS3 anexos,
redirect ao Pré-voo) + diagnóstico de código desta sessão (Resend conectado
não registrava autenticação de domínio → piso efetivo engolia o saldo →
"0 envios disponíveis"; botão de avanço desabilitado por `hasBlocking` em
`CampaignChat.tsx`).

Nota de processo: os portões de aprovação interativos deste workflow foram
executados contra as decisões registradas no memlog da UX e na conversa com
o dono (que delega execução; precedente da onda
`spec-studio-campaign-reliability`) — revisão final antes do build cabe ao
dono. O documento da onda anterior vive em `epics.md` (não-commitado) e
permanece intocado.

## Requirements Inventory

### Functional Requirements

- **FR1 (Criação não-bloqueante):** O avanço da criação (botão "Seguir pra
  Mensagem" e aprovação) NUNCA é desabilitado por pendência de canal, saldo,
  consentimento, autenticação de domínio ou agenda; o Certificado vira
  checklist de prontidão informativo (estado + caminho + quando libera).
- **FR2 (Canal só e-mail):** Com apenas `EmailAccount` conectada, a campanha
  dispara somente e-mail; as peças de WhatsApp geradas ficam salvas como
  rascunho para quando o canal for conectado.
- **FR3 (Canais e-mail + WhatsApp):** Com ambos conectados, o disparo usa os
  dois — WhatsApp apenas para leads com consentimento registrado (regra
  existente), que recebem o e-mail como canal primário.
- **FR4 (Sem canal → pendente de envio):** Sem nenhum canal conectado, a
  campanha é criada do começo ao fim e finaliza no Pré-voo com status
  visível **"pendente de envio"**; conectar um canal destrava o disparo na
  mesma tela, sem refazer a criação.
- **FR5 (Consentimento não bloqueia):** Leads sem consentimento WhatsApp não
  bloqueiam a criação — ficam fora do canal WhatsApp (recebem só e-mail) e o
  checklist informa quantos são e por quê.
- **FR6 (Anexos de mensagem):** O cliente anexa imagens e arquivos que saem
  JUNTOS na mensagem: no e-mail como anexo do provedor; no WhatsApp como
  mídia (1 imagem OU 1 documento por mensagem, limite do canal), com escolha
  de canal destino e limites de tamanho visíveis antes de enviar.
- **FR7 (Materiais salvos na campanha):** Todo material/anexo criado ou
  anexado durante a campanha fica persistido nela e visível para
  acompanhamento (Materiais do detalhe da campanha), incluindo falhas de
  extração com estado e motivo.
- **FR8 (Conteúdo editável em voo):** Com disparo em curso, o conteúdo das
  mensagens ainda não enviadas permanece editável (Pré-voo, Revisão e
  chat); mensagens já enviadas são imutáveis; o Monitor registra que houve
  edição e a partir de quando vale, sem jargão.
- **FR9 (Pré-voo com redirect automático):** Cumpridas as etapas da criação,
  o cliente é redirecionado automaticamente à tela Pré-voo: preview lado a
  lado do e-mail (render real ≡ envio) e do WhatsApp (bolha de conversa),
  qualquer detalhe editável ali mesmo (assunto, corpo, texto, anexos,
  audiência, agenda) e a ação de disparo/conexão de canal — sem dead-end.
- **FR10 (Resend = domínio autenticado):** A conexão bem-sucedida de um
  remetente Resend registra a autenticação de domínio (SPF/DKIM exigidos e
  verificados pelo provedor) no `EmailAccount` e na conta de reputação —
  eliminando o falso "0 envios disponíveis"; a revalidação DNS própria
  reconhece o seletor `resend._domainkey` e segue como revalidação de fundo.

### NonFunctional Requirements

- **NFR1:** Gate fail-closed intocado (AD-4): a liberdade é na CRIAÇÃO; o
  disparo continua passando pelo `reputation-gate` como único ponto de
  decisão. Nenhuma rota nova fala com workers fora de `enqueueBatch` (AD-14).
- **NFR2:** Multi-tenancy `orgId` em toda query/endpoint novo +
  `requirePremiumOrg`; LGPD — anexo/mídia de WhatsApp só para leads com
  consentimento auditável (modelo `StudioLeadConsent` existente).
- **NFR3:** `actions.v1` sem breaking change: novas capacidades (anexos de
  campanha, edição de conteúdo em voo) entram como actions aditivas no
  manifest ou como `v2` side-by-side (AD-6), idempotentes (`StudioActionRun`).
- **NFR4:** Mídia de WhatsApp atrás da interface de provider (AD-11):
  `sendMedia` implementado no provider WAHA; nenhuma regra de negócio lê
  detalhe de transporte.
- **NFR5:** Anexos reutilizam o storage do Studio (`studio/storage.js`:
  SHA-256, whitelist de extensão, limites 5MB trial / 25MB premium);
  tipo/tamanho validados no upload E no compile do disparo (fail-safe).
- **NFR6:** Erro visível — nenhum catch descarta a causa (`_err` logado com
  stack); migrações só via `prisma migrate`; testes `node --test` com
  fake-prisma (padrão 010/011) em toda story.
- **NFR7:** Preview ≡ envio: o Pré-voo renderiza com a MESMA função de
  render do disparo (MJML / `email-renderer.js`) — nada de preview paralelo.
- **NFR8:** Acessibilidade/mobile: Pré-voo utilizável em 375px (cartões
  empilhados), `prefers-reduced-motion` honrado, navegação por teclado e
  contraste AA dentro de `.cockpit-scope`.

### Additional Requirements

- AD-1…AD-14 da spine de arquitetura vigentes; brownfield — sem starter
  template, nenhuma story é setup de projeto.
- **Máquina de estados:** "pendente de envio" usa `StudioCampaign.status`
  existente (`approved`) + `statusReason` dedicado (ex. `NO_CHANNEL_CONNECTED`)
  — OU status novo via `prisma migrate`; a escolha exata fica no plan, mas o
  estado precisa ser visível por nome na UI (lista, detalhe, Pré-voo).
- **Compilação de canais no bridge (AD-2):** canais efetivos do disparo =
  canais da campanha ∩ canais conectados no momento do release; WhatsApp sem
  canal conectado nunca enfileira (vira rascunho preservado).
- **Edição em voo:** não muta mensagens já enfileiradas/enviadas; edição
  aplica-se a conteúdo de steps/touches ainda não despachados; sem reenvio e
  sem duplo débito (idempotência do ledger preservada, AD-13).
- **Anexos por mensagem:** limite por canal declarado no compile (e-mail:
  múltiplos anexos até o teto de tamanho; WhatsApp: 1 mídia por mensagem) —
  regra de negócio no `channel-bridge`/compile, não no worker.
- **Sem dependência nova** (constituição VI): upload/mídia usam multer +
  storage existentes; animações CSS nativas.

### UX Design Requirements

- **UX-DR1 (Checklist de prontidão):** Certificado no thread em tom
  informativo: item ok verde (glow success sutil), pendência âmbar com
  caminho ("quanto falta, quando libera, o que configurar"), rosa reservado
  ao que impede SOMENTE o disparo; nenhum item desabilita botão de avanço.
- **UX-DR2 (Pré-voo):** dois cartões de vidro lado a lado — e-mail com o
  render real e WhatsApp como bolha de conversa — cada um com heading
  próprio e edição inline; banner âmbar de pendências com ação embutida
  ("conectar canal"); CTA primário `{colors.ink}` "Colocar em voo" ou
  "Conectar canal para disparar" no cenário pendente; redirecionamento
  automático ao fim da criação; estrutura de heading própria (não depende
  só da comparação visual).
- **UX-DR3 (Chip de anexo):** pill com ícone do tipo (imagem/documento),
  nome truncado em UMA linha, "×" de remoção e badge discreto do canal
  destino (e-mail/WhatsApp); gramática do Chip existente (borda
  `accent/25`, fundo `accent/10`).
- **UX-DR4 (Voz mordomo):** pendência nunca soa interdição ("faltam 2 envios
  — a reposição diária libera às 07:00", nunca "bloqueado"); zero jargão;
  edição em voo comunicada sem termo técnico no Monitor.
- **UX-DR5 (Estado pendente visível):** "pendente de envio" aparece por nome
  na lista de campanhas, no detalhe e no Pré-voo, sempre acompanhado do
  caminho de destravamento (conectar canal).

### FR Coverage Map

| FR | Epic | Resumo |
|---|---|---|
| FR1, FR5 | Epic 1 | checklist de prontidão; avanço nunca desabilita; consentimento informativo |
| FR10 | Epic 1 | Resend registra domínio autenticado (implementado nesta sessão) |
| FR2, FR3, FR4 | Epic 1 | canais efetivos no bridge; pendente de envio destravável |
| FR6, FR7 | Epic 2 | anexos que saem na mensagem (e-mail + WhatsApp); materiais salvos e visíveis |
| FR9 | Epic 3 | tela Pré-voo + redirect automático |
| FR8 | Epic 3 | edição de conteúdo em voo (não enviados), enviados imutáveis |

## Epic List

### Epic 1: Criação que nunca trava — prontidão, canais e pendente de envio
Qualquer cliente cria a campanha do início ao fim sem portão: o Certificado informa o que falta (nunca interdita), o canal conectado molda O QUE dispara (nunca SE a campanha existe) e, sem canal, ela fica "pendente de envio" destravável ao conectar.
**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR10

### Epic 2: Anexos e materiais que viajam com a campanha
O cliente anexa imagens e arquivos que saem JUNTOS nas mensagens (e-mail e WhatsApp) e acompanha, na campanha, tudo que foi criado/anexado — incluindo falhas de extração.
**FRs covered:** FR6, FR7

### Epic 3: Pré-voo — ver, ajustar e lançar
O fim da criação chega ao Pré-voo por redirect automático: preview real do que sai por e-mail e WhatsApp, qualquer detalhe editável ali — inclusive com disparo em curso (o que ainda não saiu); o que já saiu é registro imutável.
**FRs covered:** FR8, FR9

## Epic 1: Criação que nunca trava — prontidão, canais e pendente de envio

Qualquer cliente cria a campanha do início ao fim sem portão: o Certificado informa o que falta (nunca interdita), o canal conectado molda O QUE dispara (nunca SE a campanha existe) e, sem canal, ela fica "pendente de envio" destravável ao conectar.

### Story 1.1: Resend conectado registra domínio autenticado

As a cliente que conecta o envio pelo Resend,
I want que a conexão já conte como domínio autenticado,
So that minha campanha não aparece com "0 envios disponíveis" com o canal conectado.

**Acceptance Criteria:**

**Given** API key Resend válida com o domínio do remetente verificado no painel do provedor
**When** `POST /api/email/connect` conclui
**Then** o `EmailAccount` persiste `sendingDomain`, `domainAuthStatus 'verified'`, `domainAuthVerifiedAt` e `domainAuthDetail` (source `resend-connect`)
**And** a `StudioReputationAccount` (orgId, 'email') recebe `domainAuthStatus 'verified'` via writer único (`recordDomainAuth`) — o piso efetivo volta a valer e o disponível = saldo − piso
**Given** domínio NÃO verificado no Resend
**When** a conexão tenta
**Then** falha cedo com instrução e nada é registrado (comportamento atual preservado)
**Given** reconexão de conta existente com `domainAuthStatus 'failed'` ou `'unverified'`
**When** a conexão conclui
**Then** o estado vira `'verified'` (reconexão conserta o estado antigo)
**And** a revalidação DNS diária reconhece o seletor `resend._domainkey` (`checkDomain`), sem derrubar o que a conexão registrou
**And** testes `node --test` cobrem os casos acima (fake-prisma + fetch stubado) — *implementação e testes já existem desta sessão (2026-09-29, não-commitados); a story os valida e preserva*

### Story 1.2: Certificado vira checklist de prontidão — avanço nunca trava

As a vendedor criando campanha,
I want ver o que falta como lista de pendências com caminho,
So that eu avance na criação e resolva o resto na hora certa.

**Acceptance Criteria:**

**Given** campanha com qualquer pendência (saldo zerado, domínio não verificado, consentimento, agenda vazia)
**When** o Certificado é avaliado para a CRIAÇÃO
**Then** nenhum item tem nível bloqueante — pendências viram aviso com: o que é, o que destrava e quando libera (ex.: reposição às 07:00)
**And** o botão "Seguir pra Mensagem" (e a aprovação) NUNCA fica desabilitado por pendência (`hasBlocking` deixa de travar o avanço em `CampaignChat.tsx`)
**Given** o MESMO estado avaliado no momento do DISPARO
**Then** o `reputation-gate` continua fail-closed (pausa → certificado vigente → saldo) — AD-4 intocado (UX-DR1)
**Given** pendência de saldo
**Then** o texto está no tom mordomo ("faltam X envios — a reposição diária libera às 07:00"), nunca "bloqueado" (UX-DR4)
**And** o card de Orçamento de Reputação do chat não exibe mais "piso" igualado ao saldo (o sintoma "piso é 103" some)
**And** testes: níveis do Certificado, avanço habilitado com pendência e gate inalterado

### Story 1.3: Consentimento WhatsApp informativo

As a vendedor,
I want saber quantos leads ficam fora do WhatsApp e por quê,
So that eu crie a campanha sem trava e entenda o alcance real de cada canal.

**Acceptance Criteria:**

**Given** audiência com leads sem consentimento WhatsApp (e sem `OutreachContact REPLIED`)
**When** a campanha avança na criação
**Then** nenhum bloqueio; esses leads ficam fora do canal WhatsApp na matrícula (regra `no_consent` existente preservada) e recebem só e-mail
**And** o checklist informa "X leads recebem só e-mail — sem consentimento WhatsApp" com o caminho (registrar consentimento)
**Given** disparo em execução
**Then** nenhuma mensagem de WhatsApp sai para lead sem consentimento (regressão do comportamento atual)
**And** `StudioLeadConsent` segue auditável por lead (NFR2)

### Story 1.4: Canais efetivos — o que dispara depende do que está conectado

As a vendedor,
I want que a campanha use exatamente os canais que tenho conectados,
So that o disparo nunca falha por canal ausente nem perde peças que já gerei.

**Acceptance Criteria:**

**Given** só `EmailAccount` conectada e campanha com canais `[email, whatsapp]`
**When** o compile/dispatch roda
**Then** só e-mail enfileira; as peças de WhatsApp permanecem salvas como rascunho (nada se perde) (FR2)
**Given** ambos os canais conectados
**Then** dispara ambos — WhatsApp só para leads com consentimento (FR3)
**Given** canal whatsapp na campanha sem `WhatsAppAccount CONNECTED`
**Then** nenhuma mensagem de WhatsApp enfileira e nenhum lote falha por isso
**And** a regra de interseção vive no compile do `channel-bridge` (AD-2/AD-14), não no worker
**And** testes com fake-prisma cobrem os três cenários de canal

### Story 1.5: Pendente de envio — campanha completa sem nenhum canal

As a vendedor sem canal conectado,
I want criar a campanha do começo ao fim e deixá-la pronta,
So that conectar o canal depois basta para disparar.

**Acceptance Criteria:**

**Given** org sem `EmailAccount` nem `WhatsAppAccount` conectadas
**When** a criação conclui (aprovação)
**Then** a campanha persiste aprovada com status visível **"pendente de envio"** (`statusReason` dedicado, ex. `NO_CHANNEL_CONNECTED`; se exigir status novo, entra via `prisma migrate` — decisão no plan) (FR4)
**And** o estado aparece por nome na lista de campanhas e no detalhe da campanha, sempre com o caminho de destravamento (UX-DR5; quando o Pré-voo existir — Story 3.1 — também lá)
**Given** o cliente conecta um canal em seguida
**When** ele tenta disparar a campanha pendente
**Then** o disparo destrava na mesma tela sem refazer a criação (gate normal se aplica)
**And** nenhuma campanha nessa situação fica presa em draft/in_review

## Epic 2: Anexos e materiais que viajam com a campanha

O cliente anexa imagens e arquivos que saem JUNTOS nas mensagens (e-mail e WhatsApp) e acompanha, na campanha, tudo que foi criado/anexado — incluindo falhas de extração.

### Story 2.1: Anexo de campanha — modelo, upload e canal destino

As a vendedor,
I want anexar imagens e arquivos à campanha escolhendo se saem no e-mail, no WhatsApp ou nos dois,
So that minha mensagem carregue o material certo.

**Acceptance Criteria:**

**Given** campanha aberta (chat, Revisão ou Pré-voo)
**When** anexo um arquivo (imagem ou documento) pelo upload existente
**Then** o anexo persiste vinculado à campanha com canal destino (`email|whatsapp|both`), reutilizando `studio/storage.js` (SHA-256, whitelist, limites 5MB trial / 25MB premium) (FR6)
**And** o chip de anexo mostra ícone do tipo, nome truncado em UMA linha, "×" de remoção e badge do canal destino (UX-DR3)
**Given** arquivo acima do limite ou extensão fora da whitelist
**When** o upload tenta
**Then** recusa explicável com o limite visível ANTES de enviar
**And** a capacidade entra como action aditiva no manifest `v1` (AD-6), idempotente por `actionId` (`StudioActionRun`)
**And** multi-tenancy: anexo só consulta/persiste na org do usuário (NFR2)

### Story 2.2: E-mail sai com anexos

As a lead que recebe a campanha,
I want receber os arquivos que o vendedor anexou,
So that o material viaja junto com a mensagem.

**Acceptance Criteria:**

**Given** campanha com anexos destino `email`/`both` aprovada
**When** o compile monta a mensagem
**Then** os anexos entram no payload do provider (`ResendEmailProvider`/`SMTPEmailProvider`) dentro do teto de tamanho total declarado no compile (FR6)
**Given** anexo que excede o teto no compile (ex.: cenário mudou depois do upload)
**Then** a mensagem sai SEM o anexo problemático e o fato fica registrado/explicável — nunca falha o lote inteiro (fail-safe, NFR5)
**Given** conta com provider sem suporte a anexo
**Then** degrada explicável pela mesma regra
**And** testes `node --test` do compile e dos providers com stub

### Story 2.3: WhatsApp envia mídia

As a lead com consentimento,
I want receber a imagem ou o documento na conversa do WhatsApp,
So that o material chega no canal que eu uso.

**Acceptance Criteria:**

**Given** `WhatsAppAccount CONNECTED` e anexo destino `whatsapp`
**When** o bridge enfileira a mensagem com mídia
**Then** o provider (interface — AD-11) envia via `sendMedia`: 1 imagem OU 1 documento por mensagem (FR6)
**Given** peça com texto + mídia
**Then** o texto da peça acompanha a mídia (legenda/corpo) sem duplicar mensagem de texto
**Given** anexo destino whatsapp para lead sem consentimento
**Then** nada envia (regra existente, NFR2)
**And** nenhuma regra de negócio lê detalhe do WAHA — só a interface de provider (NFR4)
**And** testes do provider com HTTP stubado (WAHA) e do bridge

### Story 2.4: Materiais da campanha visíveis

As a vendedor,
I want ver tudo que foi criado e anexado na campanha,
So that eu acompanho o material sem depender do histórico do chat.

**Acceptance Criteria:**

**Given** campanha com materiais (upload/URL/prompt) e anexos
**When** abro os Materiais do detalhe da campanha
**Then** a lista mostra todos com estado: confirmado, falha de extração (com motivo), anexo pronto (FR7)
**Given** material com falha de extração
**Then** ele aparece com o motivo e o caminho (trocar arquivo ou confirmar mesmo assim) — nunca desaparece (PS1)
**And** cada item registra quando entrou na campanha (acompanhamento)
**And** multi-tenancy preservada em toda query

## Epic 3: Pré-voo — ver, ajustar e lançar

O fim da criação chega ao Pré-voo por redirect automático: preview real do que sai por e-mail e WhatsApp, qualquer detalhe editável ali — inclusive com disparo em curso (o que ainda não saiu); o que já saiu é registro imutável.

### Story 3.1: Tela Pré-voo — preview real e edição de qualquer detalhe

As a vendedor,
I want ver exatamente o que vai sair por e-mail e por WhatsApp e editar qualquer detalhe ali,
So that eu lanço com confiança, sem tela de por meio.

**Acceptance Criteria:**

**Given** campanha com conteúdo por canal
**When** abro o Pré-voo
**Then** dois cartões lado a lado: e-mail com o render real (MESMA função de render do disparo — preview ≡ envio, NFR7) e WhatsApp como bolha de conversa (pluga o `WhatsAppPreview` existente) (FR9)
**And** cada cartão tem heading próprio e edição inline de assunto, corpo/texto e anexos; audiência e agenda são editáveis a partir da mesma tela (UX-DR2)
**Given** viewport 375px
**Then** os cartões empilham (utilizável) e teclado, contraste AA e `prefers-reduced-motion` são honrados (NFR8)
**Given** pendências (canal, saldo, agenda)
**Then** banner âmbar informativo com ação embutida; CTA primário "Colocar em voo" — ou "Conectar canal para disparar" no cenário pendente (UX-DR2/DR5)
**And** o preview consome o endpoint de preview existente (nenhum render paralelo)

### Story 3.2: Redirect automático ao fim da criação

As a vendedor,
I want ser levado ao Pré-voo quando a criação completa,
So that o fluxo termina no que importa, sem passo perdido.

**Acceptance Criteria:**

**Given** todas as etapas da criação cumpridas no chat
**When** o último turno/etapa conclui
**Then** o Cockpit redireciona automaticamente ao Pré-voo, sem pedir permissão, com o chat acessível a um clique (FR9)
**Given** campanha sem canal conectado
**Then** o Pré-voo abre no estado "pendente de envio" (integra com a Story 1.5)
**And** nenhum dead-end: voltar ao chat e ao detalhe é sempre possível
**And** E2E (Playwright + Chrome real) cobre objetivo → audiência → conteúdo → Pré-voo com redirect

### Story 3.3: Editar conteúdo com disparo em curso

As a vendedor com campanha em voo,
I want corrigir o conteúdo das mensagens que ainda não saíram,
So that o resto do disparo sai como eu quero, sem pausar tudo.

**Acceptance Criteria:**

**Given** campanha `running` com lotes pendentes
**When** edito o conteúdo de um step/touch ainda não despachado (Pré-voo, Revisão ou chat)
**Then** as mensagens ainda não enviadas passam a usar o conteúdo atualizado; sem reenvio e sem duplo débito (AD-13 intacto) (FR8)
**Given** mensagem já enviada
**Then** o conteúdo permanece imutável (o histórico não muda)
**And** o Monitor registra que houve edição e a partir de quando vale, sem jargão (UX-DR4)
**And** a edição entra como action aditiva/`v2` (AD-6) com idempotência `StudioActionRun` preservada
**And** testes do serviço de edição + regressão do ledger (nenhum débito extra)
