# Trabalho adiado (deferred)

- source_spec: `_bmad-output/implementation-artifacts/spec-ampliar-crawl-sites-whatsapp-email.md`
  summary: Registro do resultado pode ficar com `status: 'confirmado'` e `whatsapp: null` quando o gate Twilio rejeita todos os candidatos — shape herdado do gate de candidato único.
  evidence: Forma pré-existente (o BLOCK de candidato único já deixava status confirmado + whatsapp null antes desta spec); a cadeia a torna mais comum, mas agora com evidence estruturada (`dp.whatsapp_rejeitados` com motivo/url) documentando o porquê. Conserto limpo exigiria redefinir a semântica de `dp.status` (ex.: novo status `rejeitado_pelo_gate`) — contrato observado pelo chat/cards e pelo manager, fora do escopo desta onda.
- source_spec: `_bmad-output/implementation-artifacts/spec-fix-whatsapp-auto-cura-estorno-cap.md`
  summary: Wiring do sweep de auto-cura no boot (server-prod.js) é inviável de testar sem extrair o agendador do monólito de boot.
  evidence: Boot de server-prod.js é uniformemente não testado no repo (consumer NATS :5793 e resumeSessions :5802 idem); quebra futura do bloco setInterval deixaria a auto-cura morta com suíte verde. Fechar exige extrair `startSessionSweep(prisma, provider)` testável — fora do escopo deste bugfix.
- source_spec: `_bmad-output/implementation-artifacts/spec-fix-whatsapp-auto-cura-estorno-cap.md`
  summary: Latente `campaign is not defined` no fallback de conta de processSend (whatsapp-workers.js:388) se message.orgId for falsy.
  evidence: Pré-existente e inalcançável hoje (orgId sempre gravado na criação da mensagem, :342); se um dia faltar, ReferenceError em vez do fallback de relink. Correção de 1 linha (`message.orgId` apenas), mas exige teste do fallback órfão — pré-existente, não causado por esta spec.
- source_spec: `_bmad-output/implementation-artifacts/spec-fix-whatsapp-auto-cura-estorno-cap.md`
  summary: Sweep de auto-cura não considera gating por plano/suspensão de org ao religar sessões.
  evidence: O canal WhatsApp não tem gating por plano em lugar nenhum do código (isChannelConfigured só checa existência+CONNECTED); pré-existente. Se um dia houver suspensão de org com sessão viva, o sweep a manterá religada — revisar quando gating de WhatsApp existir.
