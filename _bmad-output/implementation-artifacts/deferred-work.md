# Trabalho adiado (deferred)

- source_spec: `_bmad-output/implementation-artifacts/spec-ampliar-crawl-sites-whatsapp-email.md`
  summary: Registro do resultado pode ficar com `status: 'confirmado'` e `whatsapp: null` quando o gate Twilio rejeita todos os candidatos — shape herdado do gate de candidato único.
  evidence: Forma pré-existente (o BLOCK de candidato único já deixava status confirmado + whatsapp null antes desta spec); a cadeia a torna mais comum, mas agora com evidence estruturada (`dp.whatsapp_rejeitados` com motivo/url) documentando o porquê. Conserto limpo exigiria redefinir a semântica de `dp.status` (ex.: novo status `rejeitado_pelo_gate`) — contrato observado pelo chat/cards e pelo manager, fora do escopo desta onda.
