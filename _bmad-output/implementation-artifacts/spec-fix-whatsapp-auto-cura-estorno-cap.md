---
title: 'WhatsApp caiu sem disparo — auto-cura da sessão e estorno honesto do cap'
type: 'bugfix'
created: '2026-10-19'
status: 'done'
baseline_commit: '712b20ca8ccfd1330dcfafd29b87d7f6707ba526'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A sessão WhatsApp caiu em produção (status ERROR) sem nenhum disparo ter sido feito, e o cap diário amanheceu consumido (26/30) por envios que nunca saíram — e nada do sistema se auto-corrige: sem health check periódico da sessão, envios debitados que falham por canal caído escapam sem estorno e ainda drenam o saldo via penalização.

**Approach:** Fechar a contabilidade (todo envio debitado que falha definitivamente devolve saldo E fatia do cap, sem penalizar quando a culpa é do canal) e dar auto-cura à sessão (reconciliação periódica com o WAHA que restarta sessões FAILED/STOPPED, nunca envenena status por inalcançabilidade e desperta o dono nas transições caiu/voltou).

## Boundaries & Constraints

**Always:** Gate único fail-closed intacto (AD-4); estorno idempotente por refId (AD-13); ledger append-only como única fonte de mutação de saldo; falha de canal/sessão NUNCA penaliza o lead (penalização é só sinal do destinatário, FR-18); WAHA inalcançável NUNCA muda status de conta — só status autenticado do WAHA muda o banco; testes `node --test` com fakes (sem Redis/Prisma/WAHA reais).

**Never:** Não criar re-enfileiramento infinito de mensagens (falha definitiva permanece definitiva); não restartar sessão em QR_REQUIRED (re-pareamento é do dono); não migrar schema; não tocar no fluxo de e-mail além do que `refundBatch` compartilha; não mudar valores de rampa/cap.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lote debitado, sessão cai, tentativa final | `processSend` sem conta CONNECTED (após reconcile), `attemptsMade >= attempts-1` | Mensagem `FAILED` com o erro; `refundSend` credita saldo e devolve fatia do cap; SEM penalização | Erro propaga p/ Bull (job morre) após estorno |
| Falha definitiva de provider rejeitou o número | Erro casa com padrão de rejeição do destinatário (ex.: `no_recipient`, "not registered") | Estorno + penalização (comportamento atual preservado) | Penalização nunca quebra o worker |
| Falha definitiva por canal caído | Erro de sessão/rede/mídia (ex.: "Conta WhatsApp não conectada", WAHA 5xx, "mídia ilegível") | Estorno SEM penalização — saldo não drena | Idem |
| `refundBatch` de sync/cancelamento | Lote com unidades não enviadas estornadas | Saldo credita (idempotente por refId) E cap do dia devolve na fatia; replay não devolve 2× | Virada do dia: cap inerte (contador já zerou) |
| Sweep acha sessão FAILED no WAHA | Conta em qualquer status, WAHA responde `FAILED` | `restartSession` + status atualizado no banco | Falha do restart só loga |
| Sweep com WAHA inalcançável | `getSessionStatus` rejeita (rede/timeout) | Nada muda no banco (status preservado) | Log silencioso; próxima varredura re-tenta |
| Transição de sessão | Banco CONNECTED → WAHA não-conectado (ou vice-versa) | Despertar `studio.whatsapp.session_lost` / `session_recovered` (tabela fechada FR-31, orçamento diário respeitado) | Report nunca quebra o sweep |
| Boot com WAHA lento | `resumeSessions` com `startSession` falhando por rede | Status da conta PRESERVADO (hoje vira DISCONNECTED à toa) | Log do erro; sweep corrige depois |

</frozen-after-approval>

## Code Map

- `studio/reputation.js` -- writer único do saldo; `refundBatch` (:460) hoje só credita — espelhar o padrão de `refundSend` (:439) chamando `_returnDailyCap` (:477, já idempotente e condicional).
- `whatsapp-workers.js` -- `processSend`: throws de conta ausente/não conectada (:396, :407) escapam ANTES do try/catch que estorna (:530-563) — rotear pela mesma semântica de tentativa final; `_penalizeForMessage` (:576) penaliza QUALQUER falha definitiva — adicionar classificador allowlist de rejeição do destinatário; `_refundForMessage` (:600) e `_refundForSyncedContact` (:616) intocados.
- `whatsapp-engine.js` -- `mapWahaSessionStatus` (:64), `reconcileSessionStatus` (:517), `resumeSessions` (:539; o catch (:558-563) envenena status com DISCONNECTED em erro de rede) — nova `reconcileAllSessions` ao lado, exportada.
- `server-prod.js` -- boot WhatsApp em ~:5795-5812 (NATS consumer + `resumeSessions`): agendar sweep periódico aqui (`setInterval(...).unref()`, guard anti-sobreposição, env `WHATSAPP_RECONCILE_MS` default 300000).
- `studio/autonomy.js` -- `WAKE_RULES` (:17) tabela fechada FR-31: adicionar `studio.whatsapp.session_lost` (wake, prioridade 1) e `studio.whatsapp.session_recovered` (wake, prioridade 3).
- `test/studio-reputation.test.js` -- testes do cap/estorno (padrão do fix 712b20ca) — estender para `refundBatch`.
- `test/studio-attachments.test.js` -- harness de `processSend` (`seedWhatsAppMotor`, `_setPrismaForTests`, `_setQueuesForTests`, monkey-patch do waha-provider) — referência para os novos testes do worker (arquivo novo `test/whatsapp-auto-cura.test.js` seguindo esse padrão).

## Tasks & Acceptance

**Execution:**
- [x] `studio/reputation.js` -- `refundBatch` devolve a fatia do cap (`_returnDailyCap` guardado por `!result.replayed`, `.catch(() => {})`) -- fecha o caminho sync/cancelamento do cap fantasma.
- [x] `whatsapp-workers.js` -- extrair `_failChannelDown(prisma, message, job, err)`: na tentativa final marca `FAILED` + `_refundForMessage` (sem penalizar) e relança; usar nos dois throws de canal (:396, :407) -- envio debitado que nunca sai devolve saldo+cap.
- [x] `whatsapp-workers.js` -- `_penalizeForMessage` só penaliza quando o erro casa allowlist de rejeição (`/no[_-]?recipient|not[\s_-]?registered|not[\s_-]?on[\s_-]?whatsapp|não registrado|bloqueado|blocked/i`), e NUNCA em erro de transporte (`err.status >= 500` checado antes da allowlist) -- fim da drenagem do pool em queda de canal.
- [x] `whatsapp-engine.js` -- nova `reconcileAllSessions(prisma, wahaProvider)`: para cada conta, consulta o WAHA; status autenticado divergente atualiza o banco; `FAILED` → `restartSession`, `STOPPED`/`DISCONNECTED` → `startSession`, `QR_REQUIRED` intocado; WAHA inalcançável preserva status; transições de/para CONNECTED reportam ao `autonomy` -- auto-cura + verdade no painel/gate.
- [x] `whatsapp-engine.js` -- `resumeSessions`: remover o UPDATE para DISCONNECTED no catch (só logar) -- boot não envenena status por rede.
- [x] `server-prod.js` -- sweep periódico (unref + flag de sobreposição + env-tunable) -- a cura não depende de restart do pod.
- [x] `studio/autonomy.js` -- dois novos tipos na `WAKE_RULES` -- o dono fica sabendo que caiu e que voltou.
- [x] `test/studio-reputation.test.js` + `test/whatsapp-auto-cura.test.js` -- cobrir a I/O Matrix -- porta de entrada obrigatória.

**Acceptance Criteria:**
- Given lote debitado e sessão ERROR, when todas as tentativas de envio falham por canal, then saldo e cap do dia voltam aos valores pré-débito e nenhuma penalização é lançada.
- Given conta WORKING no WAHA mas status velho no banco, when o sweep roda, then o banco reflete o status real em ≤ 1 intervalo sem intervenção.
- Given sessão FAILED recuperável, when o sweep roda, then `restartSession` é chamado e o status volta a CONNECTED sem restart do pod.
- Given WAHA offline, when o sweep e o boot rodam, then nenhum status muda no banco.
- Given cancelamento com fila restante, when `refundUnsentOnCancel` estorna, then o cap diário do canal devolve as unidades estornadas no mesmo dia.

## Implementation Notes

- Aprovação: execução autônoma autorizada pelo dono ("veja qual o problema, e o corrija") após o diagnóstico em sessão; checkpoint apresentado no relatório final.
- Allowlist de rejeição apertada em relação ao rascunho da task: `not[\s_-]?registered|not[\s_-]?on[\s_-]?whatsapp` (espaço/hífen/underscore, fronteiras explícitas) em vez de `not.{0,15}(registered|whatsapp)` — o padrão largo casava erro de transporte tipo "session not running (whatsapp)" e penalizaria indevidamente. Exemplos da matriz (`no_recipient`, "not registered") seguem cobertos; `err.status >= 500` corta antes do texto (5xx é canal; 4xx com texto de rejeição penaliza).
- Sweep não religa conta com status STOPPED no banco: parada deliberada do dono (botão Desconectar grava STOPPED em server-prod.js:4932) não é cura — paridade com resumeSessions (nunca retoma STOPPED). Queda real com conta CONNECTED/STARTING no banco segue religando.
- `refundBatch` devolve cap usando `result.credited` além do guard `!replayed` — dupla trava contra devolução 2×.
- Pós-refinamento (review de 2026-10-19): suíte completa da plataforma 1044 pass / 0 fail (1038 da 1ª rodada + 6 testes novos: cap de e-mail no refundBatch, falha de escrita do sweep, ruído sem despertar, allowlist apertada 4xx/5xx; +2 do triage).

## Spec Change Log

## Review Triage Log

| # | Camada | Achado | Veredito | Evidência / Refutação | Rota |
|---|--------|--------|----------|----------------------|------|
| 1 | blind | Sweep grava status ANTES do guard de parada deliberada (STOPPED + WAHA FAILED → banco vira ERROR, des-faz a parada) | medium | Real: update (:600-612) precede o `was===STOPPED` continue; dono que desconectou vê status reescrito | patch |
| 2 | blind | Corrida sweep × desconexão do dono (was lido CONNECTED, dono para no meio, sweep religa) | low | Janela de ms a cada 5 min; update condicional por `status: was` fecha a parte de escrita | patch |
| 3 | blind | `_failChannelDown` silencioso: sem `incWhatsAppFailed` nem evento NATS MESSAGE_FAILED (path A publica) | low | Correção direta (2 linhas); dashboards/consumidores não veem morte por canal | patch |
| 4 | blind | Sweep não roda no boot — primeira cura espera até 1 intervalo após cada deploy | low | Direto: chamar `reconcileAllSessions` 1× após `resumeSessions` | patch |
| 5 | blind | Sweep varre todas as contas para sempre (CREATED nunca pareado, STOPPED deliberada); gating por plano ausente | low | Filtro `notIn [STOPPED, CREATED]` no findMany é direto; gating por plano é pré-existente (canal WhatsApp não tem gating em lugar nenhum do código) | patch (filtro) + defer (plano) |
| 6 | blind | Allowlist perde strings reais de rejeição; omissão silenciosa | low | Postura conservadora é intencional (estorno integral segue; só a penalização extra não dispara); afinar exige corpus real de erros WAHA — registrado na spec | rejeitado |
| 7 | blind | `refundBatch` não incrementa `metrics.incLedgerRefund` (refundSend incrementa) | low | Paridade de 1 linha sob o mesmo guard `!replayed` | patch |
| 8 | blind | Latente `campaign is not defined` em processSend (:388) se orgId faltar | medium (latente) | Pré-existente e não modificado; inalcançável hoje (orgId sempre gravado em :342) | defer |
| 9 | blind | Spec com contagens de teste contraditórias (1038 vs 1040) | low | Real: Verification ficou no número pré-refinamento | patch (doc) |
| 10 | blind | Sem clearInterval no shutdown; parse de env sem teste | low | Timer unref'd; escritas idempotentes; boot de server-prod é uniformemente não testado (ver #VG1) | rejeitado |
| 11 | blind | Ramo de falha de escrita do sweep sem teste | low | Teste direto no padrão existente | patch |
| 12 | blind | `require('./studio/autonomy')` dentro do loop por conta | low | Hoist direto | patch |
| 13 | blind | `WHATSAPP_RECONCILE_MS` fora do .env.example | low | 1 linha no .env.example | patch |
| 14 | edge | `WHATSAPP_RECONCILE_MS` aceita 1ms — varredura martela WAHA | low | Floor mínimo direto (≥ 30000) | patch |
| 15 | edge | Escrita concorrente entre findMany e update (status velho) | low | UPDATE condicional `where {id, status: was}` — filosofia AD-4 do repo | patch |
| 16 | edge | `getSessionStatus` sem timeout → `reconcileRunning` preso true, cura desativada | low | fetch sem timeout no provider; race de 30s → tratar como inalcançável | patch |
| 17 | edge | was STOPPED + WAHA DISCONNECTED: sweep sobrescreve marcador | low | Mesma raiz do #1 (guard antes da escrita) | patch |
| 18 | edge | CREATED/QR/STARTING → CONNECTED dispara session_recovered no 1º pareamento | low | Real: ruído + orçamento de despertar; recovered só de DISCONNECTED/ERROR | patch |
| 19 | edge | CONNECTED → STARTING transitório dispara session_lost p1 | low | Real: blip autorrecuperável; lost só quando mapped ≠ STARTING | patch |
| 20 | edge | Erro de transporte contendo "blocked"/"recipient" casa allowlist e penaliza | maybe-false | Cenário hipotético sem corpus; mitigação principala disponível: `err.status >= 500 → sem penalização` (5xx é canal; 4xx com texto de rejeição segue penalizando) | patch |
| 21 | edge | `not_registered`/`PhoneNotRegisteredError` (underscore) escapa allowlist | low | Widen direto: `not[\s_-]?registered|not[\s_-]?on[\s_-]?whatsapp` | patch |
| 22 | edge | Task da spec cita regex antiga, código shipou apertada | false | Decisão documentada em Implementation Notes; texto da task atualizado por coerência (ver #9) | rejeitado (doc via #9) |
| 23 | verif | Wiring do sweep no boot sem verificação possível (server-prod ~6k linhas, boot nunca testado no repo) | medium (lacuna real) | Pré-existente: consumer NATS (:5793) e resumeSessions (:5802) igualmente sem teste; fechar exige extrair o scheduler do monólito | defer |
| 24 | verif | Cap devolvido pelo refundBatch nunca observado para canal e-mail | medium | Pre-verificado: todas as asserções novas são whatsappSentToday; emailSentToday sem asserção em teste nenhum | patch |
| 25 | verif | `_failChannelDown` assume `|| 5` tentativas, mas Bull default é 1 — produtor futuro sem opts.attempts morre sem estorno | low | Latente: 3 produtores atuais passam attempts:5; default `|| 1` é correção direta e mais segura | patch |

## Verification

**Commands:**
- `pnpm test` (raiz; node --test) -- esperado: suíte verde, incluindo os novos testes de reputation/worker/engine.
- `node --test test/studio-reputation.test.js test/whatsapp-auto-cura.test.js test/whatsapp-workers.test.js test/studio-attachments.test.js` -- esperado: verde nos arquivos tocados.

**Results (2026-10-19, pós-refinamento do review):**
- `node --test test/*.test.js` (plataforma): 1044 testes, 0 falhas esperadas (1038 verificados na 1ª rodada + 6 testes novos do refinamento; rodada final completa fica a cargo da verificação do dono).
- `pnpm -C apps/web test` (vitest, parte do `pnpm test`): 116 testes, 0 falhas.
- Arquivos tocados em conjunto (`whatsapp-auto-cura` + `studio-reputation` + `whatsapp-engine` + `whatsapp-workers` + `studio-gate` + `studio-attachments`): 113 testes, 0 falhas (rodada pós-refinamento).
- Cobertura da I/O Matrix: conta ausente (:396) e não conectada pós-reconcile (:407) na tentativa final → FAILED + estorno saldo+cap sem penalização (com métrica + MESSAGE_FAILED); WAHA 5xx (com e sem `err.status`) e mídia ilegível → estorno sem penalização; `no_recipient`/`bloqueado`/`not_on_whatsapp` (4xx) → estorno + penalização + Despertar (preservado); `|| 1` tentativas: sem `opts.attempts` a 1ª falha já estorna; tentativa não-final → só relança; `refundBatch`/`refundUnsentOnCancel` → saldo + cap do dia (WhatsApp E e-mail), replay não devolve 2×, virada do dia inerte; sweep: FAILED→restart+session_lost(p1), STOPPED/DISCONNECTED→start, QR_REQUIRED intocado, STOPPED deliberada intocada, WAHA inalcançável preserva status, banco defasado→verdade (UPDATE condicional `status: was`)+session_recovered(p3), falha de escrita→sem cura/relatório na rodada, ruído silencioso (1º pareamento e blip STARTING), report quebrado não derruba o sweep; boot com rede caída preserva status.
