---
title: 'Criação de campanha sem bloqueios — prontidão, canais, anexos e Pré-voo'
type: 'feature'
ticket: ''
created: '2026-09-30'
status: 'built'
baseline_revision: '7bc32c1d09723fd3b3b8a217b2924e67eece2cfe'
route: 'full'
route_source: 'auto'
review: 'thorough'
review_source: 'auto'
lenses_ran: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'intent-alignment']
review_loop_iteration: 1
followup_review_recommended: true
context:
  - '_bmad-output/planning-artifacts/epics-studio-campaign-creation-flow.md'
  - 'AGENTS.md'
warnings: ['multiple-goals', 'oversized']
deferred:
  - summary: >-
      Migração 20260930090000_studio_attachments_and_media gerada sem banco (Postgres dev offline) e ainda NÃO aplicada — rodar `pnpm run db:migrate` (ou `db:deploy`) e validar contra Postgres real antes de qualquer deploy que use anexos.
    evidence: |-
      Implementation Notes do plano + SQL existem, mas nenhum `migrate` rodou contra um Postgres; fake-prisma não exercita SQL.
    location: >
      prisma/migrations/20260930090000_studio_attachments_and_media/migration.sql
    severity: medium
  - summary: >-
      Suíte web tem 1 teste vermelho PRÉ-EXISTENTE alheio a esta onda (`apps/web/src/services/onboarding.profile.test.ts:132` — falha de timing não-reproduzível já vista antes); não contamina o score desta mudança, mas mascara regressões da suíte web até ser consertado.
    evidence: |-
      Verificação Gap (pass 2): `vitest run` completo = 97 passed / 1 failed, arquivo fora do diff; falha avulsa já observada em runs anteriores.
    location: >
      apps/web/src/services/onboarding.profile.test.ts
    severity: low
  - summary: >-
      Story 3.2 (AC do epics) pedia E2E Playwright + Chrome real cobrindo objetivo→Pré-voo com redirect — o repo não tem harness de browser; a verificação ficou nos testes de decisão pura (vitest) + QA manual do dono. Construir o harness é obra própria, registrada aqui.
    evidence: |-
      Intent Alignment (pass 2): nenhuma suíte Playwright existe em package.json/CI; plano reclassificou como manual opcional (decisão do dono que delega QA).
    location: >
      apps/web/src/studio/views/PreFlightView.tsx
    severity: medium
---

<intent-contract>

## Intent

**Problem:** A criação de campanha no `/studio` bloqueia por mecânica de envio (saldo "0 disponíveis", consentimento WhatsApp, canal ausente), peças geradas não correspondem aos canais conectados, não há anexos na mensagem, e não existe preview final editável — o fluxo trava antes do fim.

**Approach:** Tornar o Certificado checklist de prontidão (só o disparo continua gated), derivar os canais efetivos do que está conectado (sem canal → campanha "pendente de envio"), acrescentar anexos de mensagem (e-mail + mídia WhatsApp), materiais visíveis na campanha, e a tela Pré-voo com redirect automático e edição de conteúdo inclusive em voo. Fonte canônica dos ACs por story: o arquivo em `context`.

## Boundaries & Constraints

**Always:**
- `reputation-gate` fail-closed intocado como ÚNICO ponto de decisão do disparo (AD-4); pausa → certificado → saldo.
- Saldo mutado só por `studio/reputation.js` (writer único, AD-3); fila só por `enqueueBatch` (AD-14); idempotência `StudioActionRun` (AD-6); estorno por `credit` (AD-13).
- Multi-tenancy `orgId` em toda query/rota nova; `requirePremiumOrg` onde os pares têm.
- Migrações só via `prisma migrate`; testes `node --test` + fake-prisma em toda story; erro visível (`_err` logado com stack).
- Tokens/voz do 011 (D1 claro pastel, `.cockpit-scope`); zero jargão; pendência nunca soa interdição.
- Actions novas aditivas no `manifest.v1` (sem breaking change).

**Never:**
- Não bloquear/desabilitar avanço de CRIAÇÃO por pendência de envio (canal, saldo, consentimento, DNS, agenda).
- Nenhum serviço/processo novo; nenhum envio fora dos motores existentes; nenhum caminho de fila fora do bridge.
- Não enviar WhatsApp a lead sem consentimento; não mutar mensagem já enviada.
- Não introduzir framework/dependência nova (constituição VI).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Só e-mail conectado | campanha `[email,whatsapp]` | dispara só e-mail; peças WhatsApp permanecem salvas | — |
| Nenhum canal | aprovação conclui | status "pendente de envio" visível; destrava ao conectar | gate normal no disparo |
| Lead sem consentimento | audiência com N sem consentimento | fora do WhatsApp, recebem e-mail; checklist informa N | — |
| Anexo e-mail > teto no compile | anexo excede teto total | mensagem sai SEM o anexo, fato registrado | nunca falha o lote |
| Anexo WhatsApp | 1 imagem OU documento por mensagem | `sendMedia` pela interface de provider | sem consentimento → não envia |
| Edição com campanha `running` | step/touch não despachado | templates da execução sincronizam; enviados imutáveis | sem duplo débito |
| Edição `emailDoc` pela UI | PATCH `contents[].emailDoc` | persiste (hoje é descartado silenciosamente — bug) | validação de placeholders |

</intent-contract>

## Code Map

- `studio/certificate.js` -- itens do certificado: `saldo` :93-110 (`block`), `domain_auth` :112-130 (`warning`), `consent_whatsapp` :153-166 (`block`, gaps em :59-81), `maria_test` :168-190; persistido em `approval.certificate` :200-206.
- `studio/reputation.js` -- `effectiveFloor/effectiveBalance` :74-85 (unverified → piso = saldo); `recordDomainAuth` :421-438; writer único do saldo.
- `studio/reputation-gate.js` -- `evaluate` :116, `consume` :156, `isChannelConfigured` :53-67, `BLOCK_CODES` :21-28 — intocado.
- `studio/channel-bridge.js` -- `ensureEmailExecution` :81-112 (congela subject/body no approve), `compileSteps` :118-140 + `ensureWhatsAppExecution` :146-171 (congela `messageTemplate`; reusa execução se `emailExecutionId/whatsappExecutionId` existe :82-85/:147-150), `enqueueBatch` :241-310 (enfileira só prospectIds).
- `studio/campaign-service.js` -- `EDITABLE_STATES` :41 (`draft|in_review|paused`) + `assertEditable` :67-77; `approveCampaign` :168-273 (bloqueios `EMPTY_AUDIENCE`/`COMPLIANCE_BLOCKED`; compile em :227-235).
- `studio/campaign-routes.js` -- `PATCH /campaigns/:id` :557-619 (atualiza `subject/preheader/whatsappText/linkedinText/ctaUrl` + `editHistory` :611-614; **ignora `emailDoc`**); approve :104-112; schedule :116-171; control :174-238 (statusReason em :200/:259); sample :629-676.
- `studio/chat-routes.js` -- `buildBalanceCard` :499-531 ("piso é X"); `start_whatsapp_pairing` :407-465; `runChatTurn` :606-738.
- `studio/material-routes.js` -- upload multer :112-182 (limites :17-18); extração/confirm/compose :51-212.
- `studio/storage.js` -- storage local SHA-256 + whitelist :16-77 — reutilizar para anexos.
- `studio/content-routes.js` -- `POST contents` :44-81; preview e-mail :84-107 (MJML `renderEmail`, lead exemplo :23-30); `rewrite/suggest` :143-177; translate :193.
- `studio/scheduler-worker.js` -- `tickCampaign` :39-167 (release por execução; gate em :54-87).
- `email-provider.js` -- `connectEmailAccount` já registra domínio Resend (Story 1.1 FEITA, commit `7bc32c1d`); `ResendEmailProvider` :179-221; `PROVIDER_DAILY_CAPS` :30-34.
- `waha-provider.js` -- `sendText` :156; **`sendMedia` placeholder :166-169** — implementar (imagem `imageMessage`/documento `documentMessage`, base64/URL).
- `prisma/schema.prisma` -- `StudioCampaign` :1084-1117 (`status` :1093, `statusReason`, `channels` Json, `approval` Json, `emailExecutionId/whatsappExecutionId`), `StudioContent` :1176-1202, `StudioMaterial` :1208-1223, `StudioLeadConsent` :1524-1536.
- `apps/web/src/studio/api.ts` -- `patchCampaign` :96, `composeCampaign` :415, `createContent` :466, `fetchPreview` :477-486, `fetchCampaignSample` :184-189, `approveCampaign` :117-121.
- `apps/web/src/studio/components/CampaignChat.tsx` -- `hasBlocking` :280-282 (desabilita avanço); botão "Seguir pra Mensagem" :571-586 (`handleApprove` :214-224; **`onApproved` prop :69 já existe, StudioApp não passa**); "Colocar em voo" :587-597; certificado :251-260/:418-440.
- `apps/web/src/studio/StudioApp.tsx` -- `pane` union :112 + switch :716-737; `navigate` :283-288; deep-link :150-166; `CampaignChat` wiring :769-781; `prevStatusRef` :179-189.
- `apps/web/src/studio/views/CampaignDetailView.tsx` -- tabs :22; importa `WhatsAppPreview` mas só monta `RepliesReview` :15/:125; `CampaignReview` :97.
- `apps/web/src/studio/components/WhatsAppPreview.tsx` -- props `{campaign}`, lê `/sample` filtra whatsapp :21-40, bolhas :48-58.
- `apps/web/src/studio/views/CampaignsListView.tsx` -- `STATUS_LABEL` :16-26, badge :159-171 (sem `statusReason`).
- `apps/web/src/studio/components/EmailEditor.tsx` -- salva `{contents:[{id,emailDoc}]}` :87-105 (backend ignora — bug de contrato); preview iframe :245-254.
- Render no motor: `outreach-workers.js:287-289`, `whatsapp-workers.js:143,298` (`renderTemplate` do template congelado no envio).
- **Loopback 1:** o working tree contém uma implementação PARCIAL do loop 1 (Epic 1 só, com semântica própria: `forRelease`, 409 no imediato, `nextReplenishLabel`) — RECONCILIE com este plano; o plano ganha. Arquivos novos do loop 1 que sobreviveram ao revert: nenhum (só modificações tracked em `studio/`, `apps/web/src/studio/`, `test/`).

## Tasks & Acceptance

**Execution:**
- [x] `email-provider.js`/`studio/dns-verify.js`/testes -- Story 1.1 JÁ IMPLEMENTADA (commits `7bc32c1d`, `4475a3cd`) -- verificar suítes verdes e não regredir.
- [x] `studio/certificate.js` + `apps/web/src/studio/components/CampaignChat.tsx` -- Story 1.2 (RE-derivar/reconciliar): itens `ok|warning|pending` na criação com `howToFix`/`whenUnblocks`; `block` só no contexto de disparo (`forDispatch: true`, consumido pelo `reputation-gate.precheck`); card do certificado **âmbar quando houver `pending`** (não verde) e chip "Ver pendências" vivo (B5/B6); horário da reposição em **pt-BR local** (America/Sao_Paulo), nunca UTC cru (B15); tom mordomo sem "bloqueado"/"piso" -- FR1/UX-DR1/DR4.
- [x] `studio/certificate.js` -- Story 1.3 (RE): `consent_whatsapp` informativo na criação (N leads só e-mail + caminho); no DISPARO (`forDispatch`) segue bloqueando campanha com canal WhatsApp (gate AD-4); copy condicionada à existência do canal e-mail (E12); regra de matrícula preservada -- FR5.
- [x] `studio/channel-bridge.js` -- Story 1.4 (RE): canais efetivos = campanha ∩ conectados; WhatsApp só consentidos na matrícula (uma query `findMany in`, não N+1 — B11) -- FR2/FR3.
- [x] `studio/campaign-service.js` + `studio/campaign-routes.js` + `CampaignsListView.tsx`/`CampaignDetailView.tsx` -- Story 1.5 (RE): `statusReason 'NO_CHANNEL_CONNECTED'` quando aprova sem canal; rótulo "Pendente de envio" por nome; **T-UNLOCK (D5):** gate passou e execuções nulas → `bridge.compile` na hora (tick scheduled→running E caminho imediato); rota de schedule só limpa `statusReason` com canal conectado; `CONTENT_EDITABLE_STATES` inclui `approved` e `scheduled` (B1) -- FR4/UX-DR5.
- [x] `prisma/schema.prisma` (migrate) + `studio/attachment-service.js` (novo) + rotas em `material-routes.js` + `AttachmentChip.tsx` (novo) + `api.ts` -- Story 2.1 (RE): `StudioAttachment` (orgId, campaignId, fileName no storage, mime/size, `channels`), upload com limites visíveis + multer `LIMIT_FILE_SIZE` → 400 (E4), action aditiva `attach_files` (404 se algum id não casar — B14; ids ordenados na chave — B18), chip UX-DR3 -- FR6/NFR5.
- [x] `studio/channel-bridge.js` + `email-provider.js` + `outreach-workers.js` -- Story 2.2 (RE) + **T-ATTACH-RELEASE (D6) + T-ATTACH-REF (D8):** anexo resolvido NA LIBERAÇÃO do lote (ordem estável por `createdAt`; excedentes/ilegíveis fora com `skipped` registrado — B10/E6/E7); execução guarda REFERÊNCIA (`{attachmentId, fileName, originalName, mimeType, sizeBytes}`), bytes lidos do storage no send com fail-safe (nunca falha o lote); providers declaram `capabilities.attachments`; Gmail degrada explicável; teste do anexo chegando ao provider (V2) -- FR6.
- [x] `waha-provider.js` + `studio/channel-bridge.js` + `whatsapp-workers.js` -- Story 2.3 (RE): `sendMedia` real (imagem→sendImage, documento→sendFile, texto da peça como legenda); mídia determinística (mais antiga por `createdAt`, excedentes em `skipped`); teste do branch de mídia no `processSend` (V3) -- FR6/NFR4.
- [x] `apps/web/src/studio/views/CampaignDetailView.tsx` + endpoint de listagem + **T-MAT-SCOPE (D7):** `StudioMaterial.campaignId` (nullable, migrate) preenchido no contexto da campanha; aba Materiais lista por campanha e rotula à parte os da org; falha de extração nunca some (motivo + caminho) -- FR7/PS1.
- [x] `apps/web/src/studio/views/PreFlightView.tsx` (novo) + `StudioApp.tsx` + `api.ts` -- Story 3.1 (RE): dois cartões (e-mail: `fetchPreview`/iframe; WhatsApp: bolha com `text` truthy — E14), edição inline (assunto/texto/anexos), banner âmbar com `howToFix` + ação, CTA por estado (draft/paused não dispara 409 genérico — B12/E15), 375px empilha, headings próprios, sem `subjectRef` morto (B19) -- FR9/UX-DR2/NFR7/NFR8.
- [x] `CampaignChat.tsx` + `StudioApp.tsx` -- Story 3.2 (RE): `onApproved` wired → redirect automático ao Pré-voo; sem canal → abre "pendente de envio" (integra 1.5/D5) -- FR9.
- [x] `studio/campaign-routes.js` (PATCH) + `studio/campaign-service.js` + `studio/channel-bridge.js` (`syncPendingTemplates`) + `manifest.v1.js` + `chat-routes.js` -- Story 3.3 (RE) + **T-EDIT-ACTION (D9):** PATCH persiste `emailDoc` (com escopo de org no conteúdo); contents-only editável em `approved|scheduled|running` (B1); sync SEM registro falso de edição, propaga `unsubscribeMailto`, sem fallback `whatsappText` para corpo (E8/E9/V7); `approval.contentEdits` com LEITOR no Monitor/detalhe (B8); action aditiva `edit_content` (idempotência `params`) reusando o mesmo serviço — edição pelo chat (AD-6) -- FR8/PS2/AD-13.
- [x] `test/*.test.js` -- testes por story + **Review fixes (sobrevivem ao loopback):** (a) edição pós-aprove (`approved`) e destrava-agendado (tick) — V1/B1; (b) anexo até o provider + strip Gmail — V2; (c) branch mídia no `processSend` — V3; (d) card de saldo — V4; (e) `STUDIO_STORAGE_DIR` de teste com `mkdtemp` — B16; (f) UI mínima testável (CampaignChat/Pré-voo) — I1. Suítes obrigatórias verdes: `studio-certificate`, `studio-gate`, `studio-reputation`, `studio-dns-verify`, `studio-actions` (11 actions), `email-provider-connect`.

**Acceptance Criteria:**
- Given os 3 cenários de canal (Story 1.4), when compile/dispatch roda, then e-mail-only, ambos-consentidos, ou nada-enfileira-sem-erro, com peças preservadas.
- Given org sem canal (1.5), when aprova e DEPOIS agenda (scheduled) ou conecta o canal, then o tick/imediato compila e dispara — nunca "Em voo" com fila vazia.
- Given qualquer pendência (1.2), when Certificado avalia para criação, then nenhum item bloqueia o avanço; no disparo o gate bloqueia como hoje.
- Given anexo criado APÓS o approve (Pré-voo), when o próximo lote libera, then o anexo sai na mensagem (D6) com fail-safe de teto/legibilidade.
- Given campanha running (3.3), when edita conteúdo não despachado, then próximos envios usam o novo texto, enviados imutáveis, saldo/ledger intactos; edição também alcançável via action `edit_content` no chat.
- Given UI salva `emailDoc` (3.3), when PATCH, then persiste e o preview ≡ envio.

## Implementation Notes

_(preenchido na implementação do loop 2 — reconciliação do loopback 1 com este plano; o plano venceu em todos os conflitos)_

**Decisões principais**
- Certificado: flag de contexto é `forDispatch` (o `forRelease` do loop 1 foi renomeado); itens com níveis `ok|warning|pending|block` e campos `howToFix`/`whenUnblocks`; novo item `canal` (sem canal conectado → `pending` na criação, `block` no gate) alimenta o banner do Pré-voo (UX-DR2). `consent_whatsapp` é informativo (`pending`) na criação e volta a `block` em `forDispatch` (task 1.3/AD-4) — o loop 1 o tinha tornado não-bloqueante também no disparo; horário de reposição via `reputation.nextReplenishLabel` (pt-BR/America/Sao_Paulo, B15).
- 409 `NO_CHANNEL_CONNECTED` no disparo imediato sem canal **permaneceu** (é o "gate normal no disparo" da matriz I/O): o que mudou do loop 1 é que o caminho imediato e o tick agora PERSISTEM as execuções compiladas (D5) — sem isso o scheduler liberaria de execuções nulas para sempre ("Em voo" com fila vazia, G1). Tick `scheduled→running` chama `bridge.compile` quando o gate passa e as execuções estão nulas; `statusReason` só é limpo com canal de fato (rota de schedule inclusa).
- Anexos (D6/D8): `StudioAttachment` (orgId, campaignId nullable, fileName no storage, mime/size, `channels`); `enqueueBatch` re-resolve ANTES de enfileirar (e-mail: teto `STUDIO_EMAIL_ATTACHMENT_MAX_BYTES` por chamada, ordem estável por `createdAt`, excedentes/ilegíveis em `skipped`; WhatsApp: mídia mais antiga, excedentes em `skipped`) e persiste REFERÊNCIAS em `OutreachCampaign.studioAttachments`/`WhatsAppCampaign.studioAttachments`; bytes lidos no send (outreach-workers com fail-safe "nunca falha o lote"; whatsapp-workers com falha segura FAILED+estorno, E11). Providers declaram `capabilities.attachments`; Gmail degrada explicável (`attachmentsSkipped`).
- Edição em voo (3.3/D9): serviço único `flow.updateContents` (usado pelo PATCH contents-only e pela action `edit_content`); `CONTENT_EDITABLE_STATES = draft|in_review|paused|approved|scheduled|running`; `bridge.syncPendingTemplates` sincroniza só steps sem envio (motor 0-based ↔ Studio 1-based), re-aplica rodapé/headers com `unsubscribeMailto` (E9) e NUNCA usa `whatsappText` como corpo (V7); `approval.contentEdits` só em `scheduled|running` e com mudança real (E8), lido no Monitor (B8). PATCH persiste `emailDoc` com validação de placeholders (bug de contrato morto).
- Actions v1 agora com 11 entries (`attach_files` com ids ordenados na chave — B18 — e 404 sem sucesso parcial — B14; `edit_content` idempotência `params`).
- E4: multer `LIMIT_FILE_SIZE` → 400 explicável (`uploadOr400`); E10: remoção de anexo apaga registro antes do arquivo; B9: DELETE de anexo escopado por `:id` da campanha; E14: bolha do WhatsApp só com `text` truthy; B19: sem `subjectRef` (assunto edita direto no estado do Pré-voo); I1: `primaryCtaFor`/`displayStatusLabel` puras cobertas por vitest (`apps/web/src/studio/views/preFlight.cta.test.ts`).

**Arquivos novos**: `studio/attachment-service.js`, `apps/web/src/studio/components/AttachmentChip.tsx`, `apps/web/src/studio/views/PreFlightView.tsx`, `apps/web/src/studio/views/CampaignMaterialsView.tsx`, `prisma/migrations/20260930090000_studio_attachments_and_media/migration.sql`, `test/studio-attachments.test.js`, `test/studio-content-editing.test.js`, `apps/web/src/studio/views/preFlight.cta.test.ts`.

**Surpresas**: `runImmediateDispatch` do baseline já compilava, mas NÃO persistia os ids das execuções (destrava criava execução órfã — corrigido no D5); `prisma format` reformataria o schema inteiro (dif de ~1000 linhas) — edições aplicadas à mão no estilo do arquivo (`prisma validate` verde); whatsapp-nats é best-effort, o que permitiu testar `processSend` com provider stubado sem Redis/NATS.

## Plan Change Log

### 2026-09-30 — Loopback 1 (review pass 1, bad_plan)
- **Gatilho:** 5 grupos bad_plan do review (detalhes no Review Triage Log): G1 destrava-agendado sem recompile (B2/E2/E3/V1/V5/I6); G2 anexos pós-aprovação nunca resolvidos — compile congela no approve e o Pré-voo é pós-aprove (B3); G3 materiais sem escopo de campanha — `StudioMaterial` não tem `campaignId` (B4/E18/V6); G4 anexos de e-mail como base64 no JSONB, carregados por envio (B13); G5 Story 3.3 entregue só via PATCH, sem action aditiva do contrato (I3/I4). Verificados no código: `compile` só roda em `approveCampaign`/`runImmediateDispatch`; `ensure*Execution` reusa execução; `syncPendingTemplates` sincroniza só templates; release do tick usa `emailExecutionId/whatsappExecutionId` nulos.
- **Emenda:** Design Notes ganham D5 (destrava-recompile no tick/imediato), D6 (anexos resolvidos NA LIBERAÇÃO do lote, nada congelado no approve; fail-safe mantido), D7 (`StudioMaterial.campaignId` + listagem por campanha), D8 (anexos por referência ao storage, não base64 no JSONB), D9 (action aditiva `edit_content` para o chat). Tasks ganham T-UNLOCK, T-ATTACH-RELEASE, T-MAT-SCOPE, T-ATTACH-REF, T-EDIT-ACTION e o bloco "Review fixes".
- **Known-bad evitado:** campanha "Em voo" com fila vazia para sempre; anexo anexado no Pré-voo que nunca sai; 409 de edição na tela de destino da criação; aba Materiais mostrando materiais de outras campanhas.
- **KEEP (deve sobreviver à re-derivação):** certificado com contexto `forDispatch` (criação `pending`/`warning` com `howToFix`/`whenUnblocks`; `block` só no gate — AD-4 intocado); interseção de canais no compile (`skippedChannels` explicável) e filtro de consentimento na matrícula (`whatsappConsentedIds`); "pendente de envio" = `approved` + `statusReason NO_CHANNEL_CONNECTED`, limpo só com canal de fato; `sendMedia` real no WAHA (imagem→sendImage, documento→sendFile, legenda = texto da peça) e mídia no 1º toque; PATCH persiste `emailDoc` + contents-only editável; `syncPendingTemplates` com stepIndex 0-based do motor vs 1-based do Studio (imutabilidade do que já saiu, zero débito); teto de anexos lido por chamada (`STUDIO_EMAIL_ATTACHMENT_MAX_BYTES`); tom mordomo sem "bloqueado"/"piso" no card de saldo; onApproved → redirect ao Pré-voo.

## Review Triage Log

### 2026-09-30 — Review pass 1 (thorough: blind-hunter, edge-case-hunter, verification-gap, intent-alignment)
- verdicts: 54 findings — high 8, medium 22, low 20, false 4, maybe-false 0
- findings (B=blind-hunter, E=edge-case-hunter, V=verification-gap, I=intent-alignment):
  - [high] [patch] B1/E1 — PATCH de conteúdo em `approved` dá 409 (Pré-voo é pós-aprove) — verificado: `CONTENT_EDITABLE_STATES` omite `approved`/`scheduled`; fix no re-derive.
  - [high] [bad_plan] B2/E2/V1/V5/I6 — agendado/imediato sem canal nunca recompila: tick libera de execuções nulas → "Em voo" sem enviar nada — verificado: compile só no approve/imediato, release preso a execuções nulas → D5.
  - [high] [bad_plan] B3 — anexos adicionados no Pré-voo nunca saem: `ensure*Execution` reusa execução e sync não toca anexos → D6.
  - [medium] [bad_plan] B4/E18/V6 — `GET /campaigns/:id/materials` lista org inteira (`StudioMaterial` sem `campaignId`) → D7.
  - [medium] [patch] B5/B6 — card do certificado fica verde com pendências; chip "Ver pendências" morto — fix no re-derive.
  - [medium] [patch] B8 — `approval.contentEdits` sem leitor no Monitor — fix no re-derive.
  - [medium] [patch] B9 — DELETE de anexo ignora o `:id` da campanha — fix no re-derive.
  - [medium] [patch] B10/E6/E7 — resolução de anexos não determinística; excedentes sem `skipped` — fix no re-derive (D6).
  - [medium] [bad_plan] B13 — base64 de anexos no JSONB lido por envio → D8.
  - [medium] [patch] B15 — horário UTC cru na copy — fix: pt-BR local.
  - [medium] [patch] B16/I1/I5 — cobertura de testes (approved-edit, cadeia provider, mídia no processSend, card saldo, UI mínima, mkdtemp) — fix no re-derive.
  - [false] [reject] B17 — "contradição do plano sobre migração" — rejeitado: consertar é editar o plano (regra); estado já registrado como risco residual/deferred.
  - [low] [patch] B7/E13 — prop `contentId` morta/quebrada no WhatsAppPreview — fix: remover.
  - [low] [patch] B11/E19 — N+1 de consentimento — fix: `findMany in`; cross-tenant refutado (prospectIds da própria org, cuid global).
  - [low] [patch] B12/E15 — Pré-voo em draft/paused: badge/CTA genéricos que dão 409; banner sem `howToFix` — fix no re-derive.
  - [low] [patch] B14/E5 — `attach_files` confirma sucesso parcial silencioso — fix: 404 parcial.
  - [low] [patch] B18 — chave de idempotência sensível à ordem — fix: ordenar ids.
  - [low] [patch] B19 — `subjectRef` morto — fix: remover.
  - [medium] [patch] E4 — multer `LIMIT_FILE_SIZE` vira 500 — fix: 400 explicável.
  - [low] [patch] E8/E9 — sync registra edição sem mudança; footer sem `unsubscribeMailto`; fallback `whatsappText` no corpo — fix no re-derive.
  - [low] [patch] E10 — remoção apaga arquivo antes do registro — fix: reordenar.
  - [low] [reject] E11 — anexo removido pós-compile → mídia FAILED — rejeitado: falha segura (FAILED + estorno idempotente), improvável, fix adicionaria ramificação.
  - [low] [patch] E12/E14 — copy "recebem só e-mail" sem canal e-mail; bolha vazia com `text=''` — fix no re-derive.
  - [low] [reject] E16 — race de `load()` concorrentes — rejeitado: improvável, fix adiciona guardas.
  - [low] [reject] E17 — falha de `fetchCertificate` esconde banner — rejeitado: improvável, fix ramificado.
  - [medium] [patch] V2/V3/V4 — testes faltantes (anexos→provider, mídia no processSend, card de saldo) — fix no re-derive.
  - [medium] [patch] V7 — fallback de corpo usa `whatsappText` no sync — fix no re-derive.
  - [medium] [defer] V8/I8 — migração não aplicada — `deferred` no frontmatter (rodar db:migrate antes de deploy).
  - [false] [reject] I2 — gatilho do redirect no approve — rejeitado: o plano define o gancho (`onApproved`); approve é o fim da criação.
  - [medium] [bad_plan] I3/I4 — 3.3 sem action aditiva (AD-6); edição não reachable pelo chat → D9.
  - [false] [reject] I7 — ausência da Story 1.1 no diff — rejeitada: 1.1 está no baseline (`7bc32c1d`).

### 2026-09-30 — Review pass 2 (thorough, pós-loopback; mesmas 4 lentes)
- verdicts: 49 findings — high 3, medium 10, low 18, false/reject 9, defer 2, carried 3 (I2, V8/I8, B16 parcial) — maybe-false 0
- findings (B=blind-hunter, E=edge-case-hunter, V=verification-gap, IN=intent-alignment; patches agrupados por raiz):
  - [high] [patch] B1 — mídia do WhatsApp sai em TODOS os toques (sem guard de 1º toque; KEEP prometia 1º toque) — verificado no `processSend` — fix: guard `stepIndex null|0`.
  - [high] [patch] E1 — `edit_content` pelo chat: `actionParams` coerente campos ausentes para `null` → `updateContents` trata null como valor e APAGA subject/emailDoc — fix: omitir campos ausentes.
  - [high] [patch] B10/E5/E12 — campanha sem canal DECLARÁVEL (vazio/linkedin) contorna o 409 e entra "Em voo" com fila vazia (G1 por outra porta; front-end ainda mostra CTA de voo) — fix: `sendable.length === 0 ||` no guard + `declared.length > 0 &&` no Pré-voo.
  - [medium] [patch] E7/VG-other2 — D5 só cobre AMBAS execuções nulas: segundo canal conectado depois do voo nunca compila — fix: compilar por canal faltante declarado.
  - [medium] [patch] BH8 — anexos `skipped` sem superfície para o usuário (só console) — fix: persistir último resumo e expor chip no Pré-voo.
  - [medium] [patch] BH3 — dedup SHA-256 + DELETE sem refcount quebra anexo irmão de conteúdo idêntico — fix: refcount antes do removeFile.
  - [medium] [patch] BH9/VG4 — suíte vitest do web não roda em nenhum caminho de verificação — fix: encadear `vitest run` no script testado.
  - [medium] [patch] E4/VG-other1 — PATCH contents+metadado em estado não-editável aplica conteúdo ANTES do 409 (mutação parcial) — fix: assertEditable antes do updateContents.
  - [medium] [patch] E3/BH4/VG1 — rota de schedule limpa QUALQUER statusReason (não só NO_CHANNEL_CONNECTED) e sem teste — fix: guard por canal declarado∩conectado + teste dos 2 cenários.
  - [medium] [patch] VG2 — `resolveWhatsAppAttachment` sem teste de seleção (espelho do de e-mail) — fix: teste.
  - [medium] [patch] VG3 — `sendMedia` real do WAHA nunca executa nos testes (stub troca a função alterada) — fix: teste com fetch stubado (padrão V2).
  - [medium] [patch] BH15 — resolução de anexos no enqueueBatch sem proteção: erro ali falha o lote (fura o "nunca falha o lote") — fix: try/catch → segue sem anexo.
  - [medium] [defer] IN1 — Story 3.2 E2E Playwright + ACs de tela/a11y (S3) sem harness no repo — registrado em deferred (harness de browser é obra própria; QA manual do dono cobre no curto prazo).
  - [medium] [defer] VG4b — `onboarding.profile.test.ts` (web) vermelho PRÉ-EXISTENTE, alheio ao diff — registrado em deferred.
  - [low] [patch] BH2 — `whatsappConsentedSet` carrega todos os consentimentos da org (1ª query sem `in`) — fix: `in` na 1ª query.
  - [low] [patch] BH5 — compile ainda tem fallback `whatsappText` no corpo (V7 incompleto no compile) — fix: alinhar compile ao sync.
  - [low] [patch] BH6 — edição só-de-assunto não sincroniza sem `emailDoc` — fix: sincronizar subject com zero envios independente de emailDoc.
  - [low] [patch] BH7 — `edit_content` com chave de idempotência sensível à ordem (irmão do B18) — fix: ordenar/normalizar.
  - [low] [patch] BH12 — limites de plano triplicados + coerção silenciosa de canal inválido → 'both' — fix: constantes compartilhadas + 400.
  - [low] [patch] BH13 — PATCH contents-only devolve `data` obsoleto — fix: retornar campanha fresca.
  - [low] [patch] BH14 — pill do Monitor mostra hora sem data — fix: data+hora.
  - [low] [patch] BH16/E8 — tick sem snapshot ativo entra em running com execuções nulas — fix: `skipped: 'no_snapshot'`.
  - [low] [patch] BH17 — fallback de `nextReplenishLabel` inventa "00:00" — fix: omitir horário se Intl falhar.
  - [low] [patch] E2 — `attach_files` re-parenta anexo de outra campanha silenciosamente — fix: 409.
  - [low] [patch] E6 — emailDoc com ordem de chaves diferente conta mudança falsa — fix: comparação estável.
  - [low] [patch] E10 — multi-file upload descarta excedentes sem aviso — fix: 400 "um arquivo por vez".
  - [low] [patch] E11 — fallback `connectedChannels` do Pré-voo hardcodando whatsapp:false — fix: fallback completo.
  - [low] [patch] E14 — troca de campanha com pane='preflight' mostra estado obsoleto — fix: `key={campaignId}`.
  - [low] [patch] E16 — `scheduled` + NO_CHANNEL_CONNECTED mostra "Agendada" (rótulo não cobre) — fix: estender `displayStatusLabel`.
  - [low] [patch] E18 — banner de pendências sem a ação embutida do UX-DR2 — fix: ação "conectar" no item `canal`.
  - [low] [patch] IN2 — Pré-voo sem links de audiência/agenda (UX-DR2 "linkados") — fix: 2 botões de link.
  - [low] [reject] BH11 — CTA "Conectar canal" é beco (vai ao chat) — rejeitado: o chat É a superfície de conexão por design (pairing/configuração vivem lá); navegação não é dead-end.
  - [low] [reject] E9 — re-resolução por lote sobrescreve refs de mensagens enfileiradas — rejeitado: é a semântica do PS2 ("o que ainda não saiu usa o atual"); remoção → envia sem anexo é defensável.
  - [low] [reject] E13 — `load()` desfaz edição não salva — rejeitado: mesmo rationale do E16 do pass 1.
  - [low] [reject] E15 — envelope sem `data` trava Materiais em loading — rejeitado: improvável, guard defensivo.
  - [low] [reject] E17 — contents-only em pausa não aplica o flip FR-006 — rejeitado: semântica deliberada da onda (edição em voo); metadados mantêm o flip; gate re-avalia certificado no resume.
  - [low] [reject] IN3 — upload só no Pré-voo (chat tem action `attach_files`; Revisão é leitura) — rejeitado: superfícies cobertas no conjunto.
  - [false] [reject] BH18/IN6 — tasks do plano `[ ]` com implementação completa — rejeitado: consertar é editar o plano; o workflow atualiza as caixas na finalização.
  - carried: IN4 = I2 (gatilho do redirect — false, mantido); IN5/migração = V8/I8 (defer, já em `deferred`); parte do IN1 já coberta pelo patch B16/I1 do pass 1 (vitest puro entregue).
  - **Patches aplicados (mesma data, pelo implementador do passo 3):** os 21 grupos `[patch]` acima foram corrigidos — guard de 1º toque na mídia; `edit_content` sem apagar campos ausentes + chave estável; 409 para canal não-declarável (backend e Pré-voo); compile por canal faltante no tick + `no_snapshot`; try/catch na resolução de anexos; sync de subject sem emailDoc; sem fallback `whatsappText` no compile; refcount no delete + 409 re-parent; `in` na 1ª query de consentimento; schedule limpa `statusReason` só com interseção declarado∩conectado; `assertEditable` antes de mutar; retorno fresco no PATCH; rótulo "Pendente de envio" em `scheduled`; `canonicalJson` no emailDoc; 400 canal inválido; limites compartilhados; 400 multi-arquivo; fallback `connectedChannels` completo; data+hora no pill; ação no banner + links de audiência/agenda no Pré-voo; `key={campaignId}`; vitest do web encadeado no `pnpm test`. Verificação pós-patch: `pnpm test` 746/746 (+ vitest web 99/99), build web ok, `prisma validate` ok.

## Auto Run Result

### Summary
Onda "criação de campanha sem bloqueios" implementada por completo (3 epics / 12 stories): Certificado virou checklist de prontidão (criação nunca bloqueia; `forDispatch` no gate, AD-4 intocado); canais efetivos = declarados ∩ conectados no compile, com "pendente de envio" (`approved` + `statusReason NO_CHANNEL_CONNECTED`) e destrava-recompile no tick/imediato (D5); anexos de mensagem com canal destino resolvidos NA LIBERAÇÃO do lote por referência ao storage (D6/D8, fail-safe de teto/legibilidade); `sendMedia` real no WAHA (1º toque, legenda = texto da peça); materiais por campanha (`StudioMaterial.campaignId`, D7); tela Pré-voo com preview real (e-mail ≡ envio + bolha WhatsApp), edição inline e CTA por estado; redirect automático via `onApproved`; edição de conteúdo em voo (PATCH persiste `emailDoc` — bug de contrato morto — + action aditiva `edit_content`, D9) com `syncPendingTemplates` para steps sem envio (enviados imutáveis, zero débito — AD-13).

### Files changed (43)
- `studio/certificate.js` — checklist de prontidão com modos criação/disparo (`forDispatch`), itens `howToFix`/`whenUnblocks`, `whatsappConsentedSet` (2 queries `in`)
- `studio/channel-bridge.js` — interseção de canais, matrícula por consentimento, D6 (anexos na liberação, `skipped`), D8 (refs), `syncPendingTemplates`, `connectedSendChannels`
- `studio/scheduler-worker.js` — canal primário efetivo; T-UNLOCK (D5) com execução persistida; `no_snapshot`/`no_channel` fail-closed
- `studio/campaign-service.js` — `NO_CHANNEL_CONNECTED`, 409 destravável, `updateContents` (serviço único PATCH/action), `CONTENT_EDITABLE_STATES`
- `studio/campaign-routes.js` — approve/schedule/control com statusReason correto; PATCH reescrito (contents-only vs metadados; assertEditable antes de mutar)
- `studio/chat-routes.js` — actions `attach_files`/`edit_content` (cards), card de saldo sem "piso"/"bloqueado", pt-BR local
- `studio/attachment-service.js` (novo), `studio/material-routes.js`, `studio/material-service.js` — anexos (upload/limites/refcount), materiais por campanha
- `studio/reputation-gate.js` — re-avalia em `forDispatch`; `studio/reputation.js` — `nextReplenishLabel` (pt-BR)
- `email-provider.js` — `capabilities.attachments` + degradação explicável; `outreach-workers.js` — anexos no send com fail-safe
- `waha-provider.js` — `sendMedia` real; `whatsapp-workers.js` — mídia no 1º toque, bytes no send, falha segura + estorno
- `prisma/schema.prisma` + migração `20260930090000_studio_attachments_and_media` — `StudioAttachment`, `StudioMaterial.campaignId`, refs nas execuções
- `apps/web/src/studio/` — `PreFlightView` (novo), `CampaignMaterialsView` (novo), `AttachmentChip` (novo), CampaignChat (checklist âmbar, avanço livre, pendente de envio), StudioApp (pane pré-voo + `onApproved`), Monitor (rótulo + contentEdits), listas/detalhe (UX-DR5), api/types
- `test/` — `studio-attachments`, `studio-content-editing`, `studio-campaign-creation-flow` (novos) + certificate/actions/approval/segments/gate atualizados; vitest `preFlight.cta.test.ts`
- `package.json` — `pnpm test` encadeia vitest do web; `.gitignore` — `.data/`

### Review findings breakdown
- **Pass 1 (54 achados):** 5 grupos bad_plan (destrava sem recompile; anexos congelados no approve; materiais sem escopo; base64 em JSONB; 3.3 sem action) → loopback com plano emendado (D5–D9) e re-derivação completa; 4 false rejeitados com refutação; 3 lows rejeitados; 1 defer (migração).
- **Pass 2 (49 achados):** 21 grupos patch aplicados (3 high: mídia em todos os toques; `edit_content` apagava campos; canal não-declarável entrava em voo vazio); 9 rejeitados com refutação; 3 defers novos (E2E harness ausente; onboarding flake pré-existente); 3 carried.
- Follow-up review: **recomendado** (`followup_review_recommended: true`) — 3 grupos high patchados no 1º passe desta mudança.

### Verification performed
- `pnpm test` — **746/746** (node --test) **+ 99/99** (vitest web, agora encadeado); build `pnpm -C apps/web build` ok; `npx prisma validate` ok; matriz de I/O (7 cenários) coberta por testes que rodaram e passaram.

### Residual risks
1. **Migração não aplicada** (`deferred`): rodar `pnpm run db:migrate` contra Postgres real antes de qualquer deploy que use anexos.
2. **E2E browser não executado** (`deferred`): QA manual no Chrome real recomendado antes do anúncio (fluxo criar → aprovar → Pré-voo → anexar → disparar).
3. Flake pré-existente em `apps/web` (onboarding), fora do escopo.

## Design Notes

- **Pendência × bloqueio:** o certificado computa itens com `level: ok|warning|pending|block`; `forDispatch=true` (só o gate) produz `block` — UI nunca vê `block` na criação. Exemplo: `{ level:'pending', whenUnblocks:'reposição diária às 07:00 (horário local)', howToFix:'conectar canal' }`.
- **Edição em voo:** `syncPendingTemplates` re-aplica `StudioContent` → templates da execução apenas para steps sem envio; já enfileirada não enviada PODE ser afetada (PS2); já enviada, nunca; sem débito novo (AD-13).
- **Anexo ≠ material:** `StudioMaterial` é insumo de IA; `StudioAttachment` é o arquivo que sai na mensagem (storage do Studio). Ambos na aba Materiais (2.4).
- **Redirect:** gancho é `onApproved` (prop existente) — nada de polling.
- **D5 (loopback 1, G1) — destrava com recompile:** aprovar/agendar sem canal deixa execuções nulas; conectar depois PRECISA compilar antes de liberar. O tick (scheduled→running) e o caminho imediato chamam `bridge.compile` quando o gate passa e `emailExecutionId/whatsappExecutionId` estão nulos; `statusReason NO_CHANNEL_CONNECTED` só é limpo com canal de fato.
- **D6 (loopback 1, G2) — anexo resolve na liberação:** nada de anexo congelado no approve. A cada lote liberado (`enqueueBatch`) os anexos são re-resolvidos de `StudioAttachment` (e-mail: teto + legibilidade com `skipped` registrado; WhatsApp: 1 mídia determinística — mais antiga por `createdAt`; excedentes em `skipped`). Anexo criado no Pré-voo sai no lote seguinte.
- **D7 (loopback 1, G3) — material ganha campanha:** `StudioMaterial.campaignId` (nullable, migrate) preenchido no contexto da campanha; aba Materiais lista por campanha e rotula à parte os da org.
- **D8 (loopback 1, G4) — anexo por referência:** execuções guardam metadados + `fileName`; bytes lidos no send (e-mail espelha o padrão `_loadMediaPayload` do WhatsApp), mesmo fail-safe. Nada de base64 em JSONB.
- **D9 (loopback 1, G5) — edição pelo chat:** action aditiva `edit_content` (AD-6) reusa o serviço do PATCH contents-only; a UI continua no PATCH.

## Verification

**Commands:**
- `pnpm test` -- expected: suítes novas + `studio-certificate`, `studio-gate`, `studio-reputation`, `studio-dns-verify`, `studio-actions`, `email-provider-connect` verdes
- `pnpm --dir apps/web build` (ou `pnpm -C apps/web build`) -- expected: TypeScript/Vite compila sem erro
- `npx prisma validate` + migração aplicável via `pnpm run db:migrate` quando houver Postgres (deferred)

**Manual checks (E2E, opcional):**
- Chrome real (channel:'chrome', nunca Chromium do cache) no `/studio`: criar campanha sem WhatsApp → avanço nunca desabilita; aprovar → Pré-voo abre; editar assunto no Pré-voo → reflete no preview; anexar no Pré-voo → sai no disparo.
