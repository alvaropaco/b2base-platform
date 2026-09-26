# Addendum — Campaign Studio Cockpit (011)

Decisões técnicas e material de profundidade que não cabem no PRD. O PRD e este
addendum são lidos juntos pelos fluxos downstream (arquitetura, epics).

## Como o Cockpit se apoia no 010 (sem reescrever)

- **Bridge de canais (D1 do 010):** o Cockpit não envia nada — compila para
  `OutreachCampaign`/`WhatsAppCampaign` existentes; tracking, replies e inbox
  continuam os mesmos. Novos FRs de envio (Saldo, Certificado) operam **antes**
  da fila existente, como gate.
- **SSE do 010:** o progresso ao vivo do Diálogo (FR-13) reusa o transporte de
  eventos `status/reply/card/done` já implantado.
- **Ações semânticas do orquestrador:** `set_objective`, `set_audience`,
  `generate_content`, `set_schedule`, `confirm_material` etc. viram os Chips
  (FR-9). **Versionar o contrato das actions desde já** — automações externas
  vão consumi-las como API.
- **Pipeline de conteúdo:** extract/compose/personalize via LiteLLM continuam;
  Teste da Maria (FR-30) entra como heurística de validação + diretriz de prompt,
  não como modelo novo.
- **Classificação de respostas (010):** alimenta a killer suggestion "respostas
  quentes" (FR-21) — exibir só com confiança alta.
- **Guard-rail do 1º lote (010):** permanece obrigatório; é o embrião do
  Contrato de Autonomia.
- **Sequência Studio > legado, fatiga, janelas por fuso:** regras do scheduler
  do 010 preservadas; o Saldo é um gate adicional a montante.

## Moeda do Saldo (esboço para arquitetura)

- Saldo = orçamento diário seguro de envios por Canal, ajustado por:
  autenticação de domínio (FR-16), histórico (FR-28), sinais de
  rejeição/bloqueio (FR-18) e engajamento positivo (reposição).
- Débito por envio agendado (não por tentativa); bloqueio em zero; teto de
  burst por dia. Números de rampa ficam no plan — PRD trava só o mecanismo.
- Estado do Saldo persistido e idempotente; cada variação vira evento
  auditável (alimenta FR-20 e FR-29).

## Motor de sugestões (esboço)

- Candidatos = queries sobre estado da org (tabelas existentes do 010):
  leads enriquecidos sem contato; respostas classificadas quentes sem
  tratamento; campanhas em rascunho paradas há >N dias; aprovações pendentes;
  janela favorável com Saldo saudável.
- Ranking prioriza: dinheiro parado no funil (respostas quentes) > riscos
  (saldo caindo) > retomadas (rascunhos) > crescimento (leads novos).
- Cada candidato carrega o dado que o motivou (exigido por FR-21).

## Alternativas consideradas (rejeitadas)

- **Chatbot generalista estilo ChatGPT** — rejeitado: produto é diálogo de
  briefing com ações; abertura total confunde e aumenta fricção.
- **Formulário inteligente como fallback principal** — rejeitado: reintroduz
  a burocracia que motivou o projeto; a Gaveta Avançada cobre o perfil
  "odeio chat".
- **Saldo apenas reativo (guard-rails do 010)** — rejeitado: reação pós-estrago
  viola o bedrock do dono do produto (ativo é pré-condição).
- **WhatsApp cold-first com cap agressivo** — rejeitado: risco de ToS/LGPD;
  consentimento é pré-condição.

## Notas de arquitetura antecipadas (para `bmad-architecture`)

- Actions semânticas versionadas (`*.v1`) — contrato estável p/ Chips.
- Estado do Saldo como modelo de 1ª classe (não JSON solto em `guardrails`).
- Multiusuário/gestor: não bloquear (papéis virão); não construir.
- Telemetria: SM-1/SM-3/SM-C4 exigem instrumentação de funil do Cockpit
  antes do release (inclui baseline do Studio atual — Open Question 3).

## Risco C-1: transporte WhatsApp (WAHA)

O transporte atual de WhatsApp é o WAHA (sessão QR não-oficial), que viola os
ToS do Meta independentemente do consentimento. O v1 mantém o canal com o
risco declarado (PRD §4.7/§10), mitigado por consentimento (FR-35), pacing
conservador (FR-18) e Despertares. Caminho de migração: WhatsApp Cloud API
oficial (Meta) como requisito pós-Must no roadmap — Saldo (FR-14…FR-18),
Certificado (FR-27) e contrato do Cockpit são agnósticos ao transporte, de
modo que a migração troca apenas o adaptador de envio (WAHA → Cloud API), sem
alterar requisitos.

## Pré-requisitos de engenharia descobertos no gate

- **(a) Gate do Saldo cobre fila E dispatch imediato:** hoje `processSend`
  não checa pausa/status do Saldo, e o dispatch imediato enfileira a audiência
  inteira — o fatiamento de lote é pré-requisito dos FR-15 e FR-19.
- **(b) Campanhas `scheduled` nunca despacham no scheduler atual:** `tickAll`
  filtra só `running` — corrigir a transição `scheduled→running` JUNTO com o
  gate do Saldo, ou o clímax do UJ-1 morre.
- **(c) Actions com chave de idempotência:** ver FR-9 — 3 actions são
  create-style hoje; o contrato versionado exige chave estável.
- **(d) Ordem de construção validada:** Cockpit+Chips juntos → Orçamento por
  baixo (scheduler) → Confiança progressiva → Piloto/laya por último.
- **(e) Migração WhatsApp Cloud API:** caminho de saída do risco C-1 (seção
  anterior) — requisito pós-Must no roadmap.
