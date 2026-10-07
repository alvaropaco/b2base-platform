
## 2026-10-07 — onda de QA: disparos, consentimento, Stripe e enriquecimento

- Disparo WhatsApp/e-mail destravado (fila morta por hasMessage quebrado, cura de órfãos nos 2 canais, ressurreição de cancelados sem mensagem, disparo delta e parcial "primeiros N leads").
- Consentimento WhatsApp AUTOMÁTICO na captura/cadastro + ação em LOTE (fim do CHAT_FAILED e dos lotes de 3 com "continua").
- Compra de envios pelo /studio via Stripe Checkout (packs +50/+100/+250, fulfillment idempotente por webhook).
- Escolha de VARIANTE arquiva as outras (uma mensagem só por lead); canal declarado sem conteúdo sai da campanha na aprovação.
- Enriquecimento: WhatsApp do SITE vira o telefone prioritário do lead (capability company.digital_presence no motor v2).
- Correções: canais sem conteúdo não bloqueiam aprovação, diagnóstico no_phone no card do disparo, normalização de variáveis snake_case no render, monitor com "—" em vez de zero falso.
