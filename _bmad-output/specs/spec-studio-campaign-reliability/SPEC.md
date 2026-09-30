---
id: SPEC-studio-campaign-reliability
companions:
  - diagnosis.md
  - eval-matrix.md
  - transcript-teste-2026-09-29.md
sources: []
---

> **Contrato canônico.** Este SPEC e os arquivos em `companions:` são o contrato completo, validado por preservação, do que construir, testar e validar.

# Studio Campaign Reliability

## Why

Dor a resolver. O teste do dono em 2026-09-29 no `/studio` (transcript em `.memlog.md`) mostrou o agente de campanhas incapaz de concluir a jornada que o Cockpit (011) promete: turnos morrem em "Tive um problema técnico", a audiência descrita em linguagem natural casa com 0 de 505 leads e o agente re-insiste no mesmo filtro, "capture mais leads" não tem capacidade nenhuma por trás, e nenhuma campanha foi concluída do começo ao fim até hoje. Cada sintoma tem causa-raiz identificada em código (`diagnosis.md`) — é uma onda de correção sobre o 011, não uma reabertura dele. Quem é afetado: o vendedor (e o dono, que não consegue validar o produto), agora.

## Capabilities

- **CAP-1 — Turno resiliente e conclusivo**
  - **intent:** Toda mensagem do vendedor recebe uma resposta útil e conclusiva — o turno nunca termina em erro não recuperado, não re-pergunta decisão já tomada e avança o fluxo da campanha.
  - **success:** Em eval contra conta QA, 0 turnos terminam em fallback de "problema técnico" sem recuperação; cenário com decisão já declarada não re-pergunta; todo turno com falha interna registra `errorCode` e stack consultáveis no trace (`StudioChatTrace`).
- **CAP-2 — Segmentação que casa com a base real**
  - **intent:** O vendedor descreve a audiência em linguagem natural e o agente materializa um segmento que encontra os leads relevantes que existem na base; quando casa 0, ele recupera sozinho em vez de insistir.
  - **success:** Em base fixada de QA, pedido "indústria metalmecânica" materializa audiência com ≥ 50 leads relevantes (decisão D5 do dono); após um 0-match, o turno seguinte propõe filtro materialmente diferente do anterior e explica por que não casou; matching tolera acento e variação de grafia.
- **CAP-3 — Captura de leads**
  - **intent:** Ao pedir "capture mais leads", o vendedor recebe prospects novos encontrados por busca semântica na base própria e, quando a base não atende, via MCP de CNPJ — materializados com proveniência e consentimento registrados.
  - **success:** Cenário de eval de captura grava prospects novos no tenant correto com origem registrada (base própria vs MCP CNPJ) e fluxo de consentimento aplicado; sem capacidade disponível (token/quota), o agente recusa de forma explicável e não inventa leads.
- **CAP-4 — Jornada E2E concluída**
  - **intent:** A criação de campanha no `/studio` conclui do objetivo ao agendamento com certificado/aprovação, sem dead-end — a jornada que hoje nunca completa passa a completar.
  - **success:** Suíte E2E multi-turno (objetivo→audiência>0→conteúdo 2 canais→agenda→certificado verde) executa verde em N execuções seguidas contra conta QA; demonstração real: o dono conclui uma campanha no `/studio` de produção sem sair do chat.
- **CAP-5 — Malha de qualidade da conversa**
  - **intent:** A qualidade do agente é medida continuamente por uma suíte que cobre a jornada completa, a precisão de segmentação e a regressão do comportamento atual, com gate determinístico, judge em modelo independente do agente avaliado e relatório que separa falha de agente de flake de ambiente.
  - **success:** A suíte (matriz em `eval-matrix.md`) inclui jornada E2E bloqueante no CI, casos de precisão de segmento contra base fixada e os 8 casos atuais preservados; o judge roda em modelo dedicado fora do gateway LiteLLM do SUT (via Laya, decisão D3); relatório de falha identifica a camada (agente × ambiente) sem reexecução manual.
- **CAP-6 — Audiência em voo consistente** *(decisão D4 — pendência do quality stack promovida a escopo)*
  - **intent:** A audiência que a campanha em voo usa reflete a seleção atual do vendedor — encolher a seleção sincroniza a fila de execução e o Monitor sinaliza qualquer divergência residual; ninguém que saiu da seleção recebe mensagem.
  - **success:** Teste determinístico: encolher a seleção após a matrícula reduz a fila sem reenvio nem duplo débito de saldo; o Monitor exibe a divergência durante a janela de sincronização; zero contatos removidos recebem envio após a sincronização.

## Constraints

- Reusar o cliente MCP existente (`mcp-cnpj.js`) e a infraestrutura de embeddings do `cnpj-data-publisher` quando aplicável; serviço ou dependência nova só com justificativa na spec/plan (constituição VI).
- Contrato `actions.v1` sem breaking change; a captura de leads entra como capacidade aditiva no manifest ou como `v2`.
- Multi-tenancy (`orgId`) + `requirePremiumOrg` em toda action/endpoint novo; exceção deliberada (D2): a captura de leads (CAP-3) fica disponível também para trial — limites de volume/quota por org ficam no plan.
- LGPD: lead capturado registra origem/proveniência e segue o fluxo de consentimento/opt-out existente; proibido inventar dado de contato.
- Erro visível: nenhum catch descarta a causa (`_err` logado com stack); falha de LLM/JSON persiste `errorCode` no trace.
- Busca da captura é híbrida (D1): lexical (Postgres) + embeddings com pgvector — seguindo o padrão de embeddings do `cnpj-data-publisher`; índice vetorial no DB da plataforma entra via `prisma migrate`.
- Testes são porta de entrada: cada CAP entra com teste (`node --test` + eval de conversa comportamental, nunca texto exato); migrações só via `prisma migrate`.
- Motores de envio 010/011, bridge e contratos NATS `*.v1` intocados; a recuperação de audiência 0 não contorna guard-rails (saldo, consentimento) nem infla a audiência com leads irrelevantes só para "casar".

## Non-goals

- Fine-tune de classificadores e laya como engine System-1 (mantido deferred do 011).
- Novo canal de envio ou reescrita dos motores.
- Reforma da UX do Cockpit (escopo do 011); ajustes pontuais de chips/cards apenas quando exigidos por estes CAPs.
- Enriquecimento em massa ou re-processamento da base CNPJ inteira — captura é sob demanda, via chat.
- Import de listas externas arbitrárias (scraping) fora do MCP de CNPJ.

## Success signal

O dono conclui, no `/studio` de produção, uma campanha do objetivo ao agendamento sem sair do chat — a "primeira campanha E2E" deixa de ser falso — e a suíte de jornada fica verde no CI em execuções seguidas, provando que não foi sorte.

## Assumptions

- Conta QA (qa-regression-0927@b2base.net, leads Repro*, envios pausados) serve de base fixada para evals de precisão; evals rodam contra ambiente deployado no workflow `conversational-evals` existente.
- Os 505 leads da conta de teste têm `industry` majoritariamente null ou CNAE descritivo — verificação obrigatória na implementação do CAP-2.
- As pendências F2/F4–F8 do quality stack conversacional pertencem ao escopo do CAP-5 — definições recuperadas da memória de projeto e tabeladas em `eval-matrix.md` (F2 vira fix; F4–F8 viram cenários/asserções).
- Quota/custo por busca no MCP CNPJ é desconhecido — o plan adota limite conservador de volume por org/dia com monitoria, ajustável depois.
- O modelo exato do judge independente é escolhido no plan entre os disponíveis no Laya; requisito: fora do gateway LiteLLM usado pelo agente avaliado.

## Open Questions

*(nenhuma — as 5 perguntas da v1 foram respondidas pelo dono em 2026-09-29 e viraram decisões D1–D5 no `.memlog.md`)*
