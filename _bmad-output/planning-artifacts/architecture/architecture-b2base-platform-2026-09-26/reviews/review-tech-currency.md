# Review — Tech Currency / Reality Check

**Artefato:** `ARCHITECTURE-SPINE.md` — Campaign Studio Cockpit (011)
**Revisor:** tech-currency
**Data:** 2026-09-26
**Veredito:** ✅ Aprovado com ressalvas — a spine é substancialmente fiel ao brownfield (todas as afirmações de código existente bateram), mas contém **1 erro factual de biblioteca (BullMQ ≠ Bull)** na tabela Stack que pode induzir o implementador a violar a Constituição VI.

---

## Metodologia

Cada decisão commitada na spine foi confrontada com o código real (`package.json` raiz e `apps/web`, `studio/*`, `outreach-queues.js`, `outreach-workers.js`, `whatsapp-workers.js`, `docker-compose.yml`, `Dockerfile`) e, para os padrões de e-mail, com pesquisa web atual (set/2026).

---

## Achados

### 🔴 ALTA

#### A-1 — A spine diz "BullMQ", mas o projeto usa **Bull v4 clássica** (`bull`), biblioteca diferente e API-incompatível

**Onde:** Stack ("BullMQ + Redis | existente (queue `studio-scheduler`, repeat 60s)"), mermaid ("Q[BullMQ workers 010 — intocados]") e AD-4.

**Evidência:**
- `package.json` (raiz): `"bull": "^4.16.5"` + `"@types/bull": "^4.10.4"` — **nenhum `bullmq` instalado**.
- `outreach-queues.js:1-11`: *"Bull v4 queue factory… Uses bull v4"* — `const Bull = require('bull')`.
- `studio/scheduler-worker.js:190`: `require('bull').Worker || null; // Bull v4: process no queue`.

**Por que importa:** Bull (v4) e BullMQ são pacotes distintos com APIs incompatíveis (Bull: `queue.process()`; BullMQ: classes `Queue`/`Worker`/`QueueEvents`). Um implementador seguindo a spine como substrato pode (a) rodar `pnpm add bullmq` — dependência nova, violando a Constituição VI que a própria spine invoca ("Nenhuma dependência nova", linha 157) — ou (b) escrever código novo do gate/scheduler com a API do BullMQ, que não roda contra a Bull instalada. A spine está internamente inconsistente.

**Nota de moeda:** Bull está oficialmente em **modo de manutenção** upstream (o sucessor recomendado é o BullMQ). Adotar Bull v4 como realidade é correto para o 011 (zero deps novas, motores intocados), mas a migração para BullMQ deveria constar explicitamente em **Deferred** para não surpreender depois.

**Correção sugerida:** trocar toda menção "BullMQ" por "Bull (v4, `bull` ^4.16.5)"; adicionar em Deferred: "Migração Bull→BullMQ — diferida; Bull está em manutenção upstream, motores existentes permanecem em Bull v4".

---

### 🟡 MÉDIA

#### M-1 — Nome da fila impreciso: `studio-scheduler` vs. real `studio:scheduler`

**Onde:** Stack ("queue `studio-scheduler`").

**Evidência:** `studio/scheduler-worker.js:188-193`: `createQueue('studio:scheduler')` (dois pontos) com `jobId: 'studio-scheduler-tick'` (hífen é só o jobId). A convenção do repo usa dois pontos (`outreach:prepare`, `outreach:message-send`, `whatsapp:send` — `outreach-queues.js:23-27`, `whatsapp-workers.js:606`).

**Por que importa:** a spine é substrato de build; quem consultar a fila, compor métricas `studio_*` ou debugar Redis com o nome errado não encontra nada.

**Correção sugerida:** Stack → "Bull + Redis (fila `studio:scheduler`, repeat job 60s)".

#### M-2 — Stack web sem versões: majors atuais (React 19, Vite 7, Tailwind 4) não são os do projeto

**Onde:** Stack ("React + Vite + TS + Tailwind | apps/web existente").

**Evidência:** `apps/web/package.json`: `react`/`react-dom` `^18.3.1`, `vite` `^5.4.14`, `tailwindcss` `^3.4.17`, `typescript` `^5.7.3` (vs `^5.9.3` na raiz — duas versões de TS no monorepo). Hoje o mercado está em React 19, Vite 6/7 e Tailwind 4 (engine nova, sintaxe de config diferente).

**Por que importa:** sem pin, um implementador pode assumir features de Tailwind 4 (`@theme`, CSS-first config), React 19 (actions, `use`) ou Vite 6+ que não existem no projeto. As convenções ("animações CSS nativas", `prefers-reduced-motion`) são agnósticas de versão — ok — mas a linha da Stack deveria ancorar a realidade.

**Correção sugerida:** Stack → "React 18.3 + Vite 5.4 + TS 5.7 + Tailwind 3.4 | apps/web existente (animações CSS nativas)".

---

### 🟢 BAIXA

#### B-1 — Postgres "15+" quando o real é 16

`docker-compose.yml:5`: `postgres:16-alpine`; `prisma/schema.prisma`: provider `postgresql`. "15+" não é falso, mas num documento substrato o valor pinado é o que evita drift. **Correção:** "Prisma 5.22 / Postgres 16".

#### B-2 — Node 22 correto no Docker, mas sem pin local e em janela de manutenção

`Dockerfile` usa `node:22-alpine` (builder e runtime) — o claim "Node.js 22 (runtime existente)" bate. Porém não há `.nvmrc` nem campo `engines` (dev local executando v26.7.0), e em set/2026 o Node 22 está na fase de manutenção do LTS (linha corrente é a 24; EOL do 22 = abril/2027). Não exige ação no 011 (runtime existente, Constituição VI), mas vale registrar o horizonte de EOL e considerar `.nvmrc` com 22 para paridade dev/prod.

---

## ✅ Verificações confirmadas (sem achado)

| Claim da spine | Realidade | Status |
| --- | --- | --- |
| Express 5 | `express` `^5.2.1` (raiz) | ✔ |
| Prisma 5.x | `prisma`/`@prisma/client` `^5.22.0` | ✔ |
| SSE nativo, transporte do 010 | `studio/chat-routes.js:304` (`text/event-stream`) | ✔ |
| `studio/reputation-gate.js` é novo (não existe) | Confirmado — inexistente, assim como `reputation.js`, `certificate.js`, `suggestions.js`, `autonomy.js`, `actions/`, `jobs/` (todos do Structural Seed) | ✔ |
| `studio/chat-routes.js`, `dispatch.js`, `scheduler-worker.js`, `channel-bridge.js` existem | Todos em `studio/` | ✔ |
| `email-provider.js`, `waha-provider.js` (providers atrás de interface, AD-11) | Ambos na raiz; `email-provider.js` é de fato a abstração (gmail/smtp/resend via `sendEmailForAccount`) | ✔ |
| Queue repeat 60s | `scheduler-worker.js:193` — `repeat: { every: 60_000 }`, registrada em `server-prod.js:5603` | ✔ |
| AD-5: "`tickAll` filtra só `running` hoje" | `scheduler-worker.js:163-164`: `where: { status: 'running' }` | ✔ |
| AD-4: "`dispatchImmediate` enfileira lote inteiro" | `studio/dispatch.js:44-96` — passa `prospectIds` completo, sem fatiamento | ✔ |
| AD-4: "`processSend` não checa pausa" | `outreach-workers.js:489` — nenhum check de pause (grep vazio); já `whatsapp-workers.js:200` checa `PAUSED` — a "paridade" do AD-5 reflete o código real | ✔ |
| AD-6: `set_audience`/`attach_url`/`generate_content` são create-style | `studio/chat-routes.js:75,100,120` | ✔ |
| `assertPremiumOrg` existe | `server-prod.js:794` | ✔ |
| `apps/web/src/studio/` (SPA) | Existe (`StudioApp.tsx`, `api.ts`, `components/`, `views/`) | ✔ |
| `docs/constitution.md` | Existe (nota: `AGENTS.md` aponta `.specify/memory/constitution.md`, que não existe — drift do repo, não da spine) | ✔ |

### Padrões de e-mail (pesquisa web, set/2026)

| Claim | Status |
| --- | --- |
| `List-Unsubscribe` one-click = RFC 8058 (AD-2) | ✔ Correto e vigente — Proposed Standard (IETF, jan/2019), não obsoletado; é a spec exigida por Google/Yahoo/Microsoft para bulk senders desde 2024 (headers `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) |
| Spam complaint ≤ 0,3% como gatilho de reputação (Deferred: "calibração de débito por complaint") | ✔ Threshold vigente — Google (Postmaster Tools) e Yahoo (Sender Hub) exigem < 0,3% (teto; orientação oficial é mirar < 0,1%), com enforcement progressivo (rejeição/throttling) desde out/2024 |
| Descadastro honrado em ≤48h (FR-37) | ✔ Bate com a exigência dos providers de processar descadastro em até 2 dias |

---

## Resumo

| Severidade | Qtd |
| --- | --- |
| Alta | 1 |
| Média | 2 |
| Baixa | 2 |
| **Total de achados** | **5** |
| Claims verificados e confirmados | 14 + 3 padrões de e-mail |

**Veredito:** a spine passou no reality-check brownfield com nota alta — cada afirmação sobre código existente (gaps do gate, `tickAll`, lote inteiro no `dispatchImmediate`, ausência de pausa no `processSend` de e-mail, actions create-style) descreve o código com precisão, o que dá boa confiança no substrate. O único erro factual relevante é cosmético mas perigoso: chamar a Bull v4 de "BullMQ". Com as correções A-1, M-1 e M-2 aplicadas (troca de nome, nome exato da fila, versões pinadas), a Stack fica 1:1 com o repositório.
