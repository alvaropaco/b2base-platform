---
title: "Campaign Studio Cockpit (011)"
status: final
created: 2026-09-26
updated: 2026-09-26
---

# PRD: Campaign Studio Cockpit (011)

## 0. Propósito do documento

Para o time do b2base (produto, UX, arquitetura, engenharia) e para os fluxos
downstream do BMad (`bmad-architecture`, `bmad-create-epics-and-stories`).
Constrói sobre a **SPEC 011** validada
(`_bmad-output/specs/spec-campaign-studio-cockpit/`: `SPEC.md`, `backlog.md`,
`experience-direction.md`) e sobre a sessão de brainstorming que a originou —
este PRD **não duplica** essas fontes; transforma o contrato em requisitos
funcionais e mensuráveis. Vocabulário ancorado no §3 Glossário; features
agrupadas com FRs numerados globalmente; suposições marcadas `[ASSUMPTION]`
e indexadas no §9.

## 1. Visão

O Campaign Studio hoje tem um motor excelente e uma experiência que trava a
adoção: o vendedor não entende o que fazer, o chat parece desconexo, e o maior
medo dele — perder o domínio de e-mail ou ter o WhatsApp bloqueado — é tratado
só reativamente. O **Cockpit** reconstrói o Studio como uma única tela de
conversa dark premium onde um **Piloto** conduz o vendedor do objetivo à
campanha em voo, uma pergunta por vez, com chips que executam ações reais.

Duas convicções carregam o produto. Primeira: **a reputação do ativo de envio
do cliente é pré-condição, não feature** — o Piloto orçamenta reputação
(saldo por canal, debitado a cada envio, com reposição) e bloqueia qualquer
disparo que o saldo não cubra, sempre explicando por quê. Segunda: **confiança
se calibra com transparência** — de onde veio cada dado usado no conteúdo,
certificado de segurança que bloqueia em vez de avisar, e decisões do Piloto
registradas de forma legível por humanos e por suporte.

*Why now:* o 010 acabou de entregar motor, SSE e guard-rails; a dor de UX é o
gargalo declarado de adoção, e cada semana sem cockpit consolida o Studio
atual como "ferramenta difícil".

## 2. Usuário-alvo

### 2.1 Jobs To Be Done

- **Funcional:** colocar uma campanha boa em voo sem pedir ajuda — do objetivo aos disparos agendados numa conversa só.
- **Emocional:** sentir-se *seguro* para apertar o botão — zero medo de queimar domínio ou banir WhatsApp.
- **Contextual:** tratar as 3 coisas mais importantes da operação hoje sem abrir cinco telas (o briefing do mordomo).
- **Social:** parecer profissional diante do lead — nenhum e-mail que envergonhe o remetente (Teste da Maria).

### 2.2 Non-users (v1)

- **Gestores de equipe com visão gerencial multiusuário** — o Cockpit v1 é single-player por organização; oversight de equipe é non-goal (§5).
- **Operações de alto volume com múltiplos domínios/números por org** — v1 assume 1+1 (§9).

### 2.3 Jornadas-chave

> **UJ-1. Rafael coloca a primeira campanha em voo no dia zero.** [ASSUMPTION: persona ilustrativa — validar com clientes reais]
> Rafael, vendedor interno de software B2B, acabou de criar a conta. Abre `/studio`: luzes apagadas, um convite no centro e três chips de primeiros passos. Toca em "Contar o que eu vendo"; a conversa pede o objetivo, ele importa um CSV de leads; o Cockpit mostra a audiência encontrada (valor cedo), propõe tom, gera conteúdo citando a origem dos dados, e o Certificado de Segurança trava por falta de SPF — ele configura, o saldo de warm-up libera um primeiro lote pequeno, ele autoriza. **Climax:** a luz corre pelo Rail e assenta — campanha em voo em 5 turnos. **Edge case:** sem saldo nem autenticação, o Piloto não deixa agendar e explica exatamente o que falta.

> **UJ-2. Rafael, no dia 30, lê o briefing do mordomo.** Entra no Cockpit: três chips contextuais — "12 respostas quentes há 2 dias sem tratamento", "saldo 82%, melhor janela terça 9h", "campanha de rascunho desde sexta". Toca no primeiro; o Piloto prepara rascunhos de resposta classificados como quentes; ele revisa e envia. **Edge case:** sem candidatos fortes, a home volta ao estado vazio elegante — nunca chips fracos.

> **UJ-3. Rafael resolve o dia pelo celular.** À noite, recebe 1 notificação priorizada do dia: respostas quentes aguardando. Abre o resumo mobile, lê o estado da campanha no Rail, aprova os rascunhos e fecha. Tudo em menos de 2 minutos.

## 3. Glossário

- **Cockpit** — a tela única `/studio`: thread de conversa + Rail + Gaveta Avançada. Sinônimo proibido: "dashboard".
- **Piloto** — o agente que conduz o Diálogo de Briefing e executa decisões autônomas dentro do Contrato de Autonomia.
- **Diálogo de Briefing** — conversa guiada pela máquina de estados da campanha; uma pergunta por vez; não é chatbot aberto.
- **Briefing do Mordomo** — a home do Cockpit apresenta as 3 coisas mais importantes da operação hoje, cada uma com dado concreto e pergunta de ação; postura do Piloto.
- **Chip** — botão de sugestão que executa uma **ação semântica** real do orquestrador; nunca texto decorativo.
- **Rail** — a linha das 5 luzes: Objetivo → Audiência → Mensagem → Agenda → Saldo. Aparece só quando existe campanha.
- **Saldo** — a moeda do **Orçamento de Reputação**: valor finito por **Canal**, debitado por envio e reposto por engajamento positivo/tempo.
- **Canal** — e-mail ou WhatsApp. Cada Canal tem saldo, regras e Certificado próprios.
- **Certificado de Segurança** — checklist pré-disparo que **bloqueia** o envio enquanto houver item reprovado.
- **Despertar** — notificação que interrompe o usuário; só ocorre por item do Contrato de Autonomia.
- **Contrato de Autonomia** — a lista fechada do que o Piloto decide sozinho vs. o que sempre desperta.
- **Gaveta Avançada** — superfície secundária (journeys, experimentos, templates), aberta por contexto ou demanda.
- **Dia Zero** — estado de organização sem dados: a home mostra primeiros passos, não operação.
- **Teste da Maria** — barra de qualidade de conteúdo: uma pessoa ocupada entende em 5s por que recebeu e responde com uma linha.
- **Campanha em Voo** — campanha aprovada e agendada/disparando dentro do Saldo.

## 4. Features

### 4.1 O Cockpit (tela única)

**Description:** `/studio` é uma única coluna de conversa — sem abas, sem painéis laterais. Estado vazio convidativo (Dia Zero ou operação); Rail surge com a primeira campanha; cards de resultado nascem dentro do thread; a Gaveta Avançada existe sob demanda. Realiza UJ-1, UJ-2, UJ-3. Direção visual completa em `experience-direction.md` (dark premium, glow com significado).

**Functional Requirements:**

#### FR-1: Rota única de conversa
O vendedor conduz todo o fluxo em `/studio` (thread central + input no rodapé), sem abas ou painéis no fluxo primário. Realiza UJ-1.
**Consequences (testable):**
- Fluxo objetivo→Campanha em Voo concluível sem navegar para outra rota.
- Rotas antigas do Studio redirecionam para `/studio`.
- Nenhum menu de abas renderiza no Cockpit.

#### FR-2: Estado vazio convidativo
Sem campanha em construção, o Cockpit exibe marca + pergunta-título + ≤3 Chips + input com placeholder instrutivo.
**Consequences:** contagem de Chips ≤3; placeholder contém instrução de ação; sem cards de operação visíveis nesse estado; passa no "teste dos 5s" — o que a tela faz pelo usuário é respondível à primeira vista.

#### FR-3: Rail com progressive disclosure
O Rail renderiza somente quando a organização tem campanha em construção ou em Voo; a luz acesa indica a etapa corrente da máquina de estados; apenas a próxima ação válida é clicável.
**Consequences:** Rail ausente em org sem campanha; luz corresponde ao estado real (teste de integração com cada transição); items futuros inativos; etapa corrente e próxima ação identificáveis em ≤5s; o Saldo só aparece no Rail quando o Canal está configurado na organização (ver §9).

#### FR-4: Cards como mensagens do thread
Audiência encontrada, conteúdo gerado, agenda proposta e Certificado de Segurança renderizam como mensagens ricas dentro do thread — nunca em painel lateral.
**Consequences:** cada card é um item do thread com ordem cronológica; zero render fora do thread.

#### FR-5: Gaveta Avançada sob demanda
Journeys, experimentos e templates acessíveis apenas via Gaveta (aberta pelo Piloto quando o contexto pede ou por demanda explícita do usuário).
**Consequences:** nenhum caminho de menu permanente; Gaveta abre como superfície secundária contextual.

#### FR-6: Momento-assinatura do envio
Autorização de disparo dispara a animação do Rail (luz percorre as etapas e assenta), respeitando `prefers-reduced-motion`.
**Consequences:** animação única por autorização; com reduced-motion ativo, substituída por indicador estático.

#### FR-7: Mobile mínimo
Em viewport ≤375px, o Cockpit permite ler estado (Rail, Saldo), ver Despertares e aprovar/rejeitar pendências; criação completa de campanha continua desktop-first.
**Consequences:** aprovação de rascunhos e pausa global operáveis no celular; nenhuma exigência de edição rica de conteúdo no mobile.

### 4.2 Diálogo de Briefing guiado por estado

**Description:** o Piloto faz sempre a próxima pergunta válida da máquina de estados da campanha, uma por vez; opções finitas viram Chips que executam ações reais; texto livre é exceção roteada pelo orquestrador. Orçamento de fricção rígido: valor cedo e poucos turnos. Realiza UJ-1, UJ-2.

**Functional Requirements:**

#### FR-8: Próxima pergunta válida
Cada turno do Piloto deriva do estado corrente da campanha; nenhuma pergunta fora da sequência válida.
**Consequences:** dada uma transição de estado, o próximo turno é determinístico em tema (conteúdo pode variar); perguntas repetidas/órfãs = falha de teste.

#### FR-9: Chips são ações
Opções finitas renderizam como Chips vinculados às ações semânticas do orquestrador do 010 (`set_objective`, `set_audience`, `generate_content`, `set_schedule`, …).
**Consequences:** tocar um Chip dispara a ação de backend correspondente (idempotente); nenhum Chip envia apenas texto; toda action é idempotente por chave estável — re-executar não duplica segmentos/conteúdos (3 actions são create-style hoje; o contrato versionado exige chave de idempotência).

#### FR-10: Texto livre roteado
Mensagens livres seguem o orquestrador existente (intenções do 010), sem exigir formulário.
**Consequences:** todo texto livre produz ou uma ação ou uma resposta de clarificação — nunca erro mudo.

#### FR-11: Orçamento de fricção
No fluxo padrão (sem anexos), a primeira Campanha em Voo ocorre em ≤6 turnos de usuário; o primeiro feedback do sistema após cada envio do usuário ocorre em ≤2s.
**Consequences:** contagem de turnos ≤6 no fluxo feliz (teste E2E); p95 de primeiro feedback ≤2s; o fluxo feliz é executável 100% via Chips (texto livre é opcional em todo o percurso).

#### FR-12: Valor cedo
A audiência encontrada é apresentada na primeira metade da conversa, antes de qualquer pergunta de agenda.
**Consequences:** no fluxo feliz, card de audiência antecede o tema agenda.

#### FR-13: Progresso ao vivo
Durante operações do Piloto, a bolha "pensando" exibe as etapas em tempo real (infraestrutura SSE do 010).
**Consequences:** cada etapa de backend emite evento de status visível; nenhuma operação longa sem progresso.

### 4.3 Orçamento de Reputação

**Description:** a reputação do ativo de envio é um recurso finito modelado como Saldo por Canal. O Piloto debita por envio, recompõe por sinal positivo, bloqueia preventivamente o que o Saldo não cobre — e nunca promete imunidade: WhatsApp é tratado com conservadorismo explícito. Realiza UJ-1 (Certificado), UJ-2 (janela).

**Functional Requirements:**

#### FR-14: Saldo por Canal
Cada Canal tem Saldo finito: débito por envio, reposição por engajamento positivo e/ou tempo (warm-up contínuo).
**Consequences:** todo envio agendado debita; reposições rastreáveis no painel; saldo nunca negativo (bloqueia em zero); taxa de reclamação de spam ≥0,3% (limiar Google/Yahoo) reduz o Saldo automaticamente e desperta (consistente com FR-18/FR-31).

#### FR-15: Bloqueio preventivo explicável
Agendamento/lote que excederia o Saldo é bloqueado antes da fila, com mensagem que informa quanto falta e quando/como libera.
**Consequences:** teste de integração: lote > saldo → bloqueio + explicação; nenhum lote excede o saldo vigente.

#### FR-16: Autenticação de domínio como pré-condição
Domínio de e-mail sem SPF+DKIM verificados (DMARC quando aplicável) tem Saldo efetivo zero até verificação.
**Consequences:** agendamento bloqueado com instrução de configuração; verificação verde libera o Saldo da regra.

#### FR-17: Cold start com rampa
Org nova começa com Saldo conservador e rampa por engajamento positivo; flag manual "domínio pré-aquecido" eleva o piso, sob responsabilidade do cliente. `[ASSUMPTION: números de rampa definidos no plan a partir de benchmarks de warm-up]`
**Consequences:** primeira semana opera abaixo do teto; rampa documentada e visível no painel.

#### FR-18: WhatsApp conservador
Canal WhatsApp tem Saldo, rampa e pacing próprios, mais conservadores; sinais de rejeição/bloqueio reduzem o Saldo automaticamente.
**Consequences:** evento de rejeição/bloqueio → débito/bloqueio imediato + Despertar; nenhuma configuração permite ritmo acima do teto conservador.

#### FR-19: Pausa global de emergência
Um clique pausa todos os envios da organização, com estado visível e retomada explícita. Realiza UJ-3.
**Consequences:** pausa surte efeito antes do próximo envio em fila; retomada exige ação consciente.

#### FR-20: Painel de Saldo
O painel mostra valor corrente por Canal, tendência recente e explicação das variações (o que debitou, o que repôs).
**Consequences:** cada variação de saldo é atribuível a um evento listado.

### 4.4 Sugestões contextuais (o briefing do mordomo)

**Description:** a home sugere até 3 próximas ações derivadas do estado real da organização. Dia Zero mostra primeiros passos. Sem sinal forte, a home volta ao estado vazio elegante — o Piloto não exibe sugestão fraca. Realiza UJ-2, UJ-3.

**Functional Requirements:**

#### FR-21: Motor de sugestões
O Cockpit computa candidatos a partir do estado da org: leads enriquecidos sem contato, respostas sem tratamento (classificação com confiança alta), campanhas em rascunho paradas, aprovações pendentes, Saldo+janela favoráveis.
**Consequences:** conta com dados recebe ≥1 e ≤3 Chips aplicáveis; cada Chip cita o dado que o motivou.

*Divergência intencional registrada:* a SPEC (CAP-5) pedia "≥3 sempre"; este PRD adota ≥1 com graceful degradation (FR-22) — divergência validada pelo dono do produto na elicitação.

#### FR-22: Graceful degradation
Sem candidatos fortes, nenhuma sugestão é exibida (volta ao estado vazio convidativo).
**Consequences:** zero Chips genéricos/decorativos em qualquer sessão.

#### FR-23: Dia Zero
Org sem dados recebe convites de primeiros passos: importar leads, descrever o que vende, demonstração com dados fictícios (sandbox). `[ASSUMPTION: demonstração usa fixtures gerados, nunca dados reais — LGPD]`
**Consequences:** org sem leads/campanhas nunca recebe sugestão de operação; sandbox roda sem tocar ativos reais de envio; o primeiro passo do Dia Zero é concluível em ≤60s.

#### FR-24: Sinais fortes para reengajamento
Candidatos de reengajamento exigem sinal forte (clique ou resposta) como critério primário; aberturas contam apenas como reforço.
**Consequences:** nenhum Chip de reengajamento motivado só por opens.

*Divergência intencional registrada:* a killer #2 do backlog pedia "1 clique"; este PRD faz o Chip iniciar o diálogo (FR-25) e exige sinal forte (cliques/respostas, não opens) — validado na elicitação.

#### FR-25: Chip inicia diálogo
Tocar uma sugestão inicia o fluxo conversacional correspondente (não executa nada sem o passo do usuário).
**Consequences:** todo Chip de sugestão abre turno do Piloto com o contexto pronto.

### 4.5 Confiança visível

**Description:** o vendedor autoriza porque vê: de onde veio cada dado, o que o Certificado exige, e o que o Piloto fez e por quê. Conteúdo é julgado pelo Teste da Maria.

**Functional Requirements:**

#### FR-26: Origem dos dados citada
Todo conteúdo gerado exibe, antes da aprovação, os campos de dados que fundamentam a personalização (ex.: "Founders: José e Maria · CNAE 6201").
**Consequences:** nenhum conteúdo aprovável sem lista de fontes; fontes correspondem a dados reais da org.

#### FR-27: Certificado bloqueante
O Certificado de Segurança impede o disparo enquanto qualquer item estiver reprovado (Saldo, autenticação, opt-outs, janela), item a item explicável.
**Consequences:** disparo com item reprovado = impossível (teste de integração); cada item tem estado e explicação.

#### FR-28: Histórico do domínio no onboarding
O onboarding captura o histórico do domínio de envio (novo / pré-aquecido / penalizado) e o piso do Saldo responde a isso.
**Consequences:** resposta "penalizado" → piso mínimo + Despertar de orientação; "pré-aquecido" habilita FR-17 override.

#### FR-29: Explicabilidade do Piloto
Analytics do Cockpit mostram as decisões do Piloto (o que fez e por quê) além dos resultados.
**Consequences:** cada decisão autônoma rastreável a um registro legível (fuso, janela, sequência, salto de variante).

#### FR-30: Teste da Maria como barra de copy
Diretriz de geração e avaliação: a mensagem deve permitir que uma pessoa ocupada entenda em 5s por que recebeu e responda com uma linha; o 1º lote de toda campanha passa por aprovação humana (guard-rail do 010).
**Consequences:** critérios operáveis como heurísticas com limites objetivos (≤150 palavras, 1 CTA único, sem jargão de fornecedor), validadas pelo pipeline de conteúdo + humano no 1º lote.

#### FR-37: Descadastro acessível e honrado
Todo e-mail inclui link de descadastro e os headers `List-Unsubscribe`/one-click (RFC 8058); pedidos de descadastro são honrados em ≤48h em todos os canais e alimentam o item de opt-out do Certificado (FR-27).
**Consequences:** header presente em 100% dos envios de e-mail (teste); pedido de descadastro honrado em ≤48h (teste).

### 4.6 Contrato de Autonomia

**Description:** a lista fechada do que desperta o usuário vs. o que o Piloto decide sozinho, com orçamento de notificações e métrica de saúde.

**Functional Requirements:**

#### FR-31: Despertares obrigatórios (lista fechada)
Desperta SEMPRE: 1º lote de campanha nova; anomalia de Saldo/entrega; erro em conteúdo agendado; bloqueio de agendamento por Saldo; rejeição/bloqueio de WhatsApp.
**Consequences:** cada item da lista gera Despertar; nada fora da lista desperta.

#### FR-32: Decisão autônoma registrada
Toda decisão tomada sozinha pelo Piloto gera registro legível (o quê, por quê, com quais dados).
**Consequences:** auditoria lista decisões cronologicamente; suporte diagnostica sem acesso a dados do cliente.

#### FR-33: Orçamento de notificações
Despertares limitados por organização/dia, priorizados e agrupáveis. `[ASSUMPTION: teto inicial 5/dia; ajuste no plan]`
**Consequences:** excedente é agrupado em resumo único; nenhuma fila infinita de notificações.

#### FR-34: Saúde do contrato
Taxa de Despertares por org/dia é métrica interna monitorada (proxy de calibração da autonomia).
**Consequences:** série disponível para o time; disparidade alta entre orgs dispara revisão.

### 4.7 WhatsApp como follow-up consentido

**Description:** no Cockpit, WhatsApp é canal de continuidade — para leads que responderam e-mail ou têm consentimento registrado. Cold-first via WhatsApp não existe no produto (risco de ToS do WhatsApp Business e de LGPD).

Risco C-1 declarado: o transporte atual de WhatsApp é o WAHA (sessão QR não-oficial), que viola os ToS do Meta independentemente do consentimento do lead. O v1 mantém o canal com esse risco DECLARADO, mitigado por consentimento (FR-35), pacing conservador (FR-18) e Despertares; a migração para a WhatsApp Cloud API oficial é requisito pós-Must no roadmap.

**Functional Requirements:**

#### FR-35: Porta de entrada consentida
Fluxos de WhatsApp só podem ser iniciados para leads com consentimento (resposta prévia a e-mail ou opt-in registrado).
**Consequences:** tentativa de início sem consentimento = bloqueada com explicação; critério de consentimento auditável por lead.

#### FR-36: Mesmo Certificado, regras do Canal
Conteúdo de WhatsApp passa pelo Certificado com regras do Canal (Saldo FR-18, janela, opt-out).
**Consequences:** disparo sem Certificado verde impossível; regras específicas documentadas por Canal.

## 5. Non-Goals (explícitos)

- **Multiusuário/gestão de equipe** — visão gerencial, papéis e aprovação por gestor fora do v1 (arquitetura não deve bloquear, mas não constrói).
- **laya / fine-tune de classificadores** ([laya](https://github.com/NandhaKishorM/laya)) — reavaliar com dataset pós-Must (ver `backlog.md`); quando retomada, laya assume 3 papéis futuros: roteador de intenção do chat, guard-rail de conteúdo pré-envio e escalation por confiança.
- **Campanhas gatilho de momento** (moment marketing por sinais de enriquecimento) — spec futura.
- **Piloto onipresente** (piloto fora do Cockpit, nas outras superfícies da plataforma) — diferido; o Cockpit consolidado é o passo certo agora.
- **Novo canal de envio / reescrita dos motores** — o Cockpit compila para execuções existentes (bridge D1 do 010).
- **Cold-first via WhatsApp** — eliminado do produto (ver 4.7).
- **Toggle de tema claro** — dark é decisão de produto.
- **Novos editores de conteúdo fora do fluxo conversacional.**

## 6. Escopo do MVP

### 6.1 In Scope

- Cockpit completo (FR-1…FR-13): rota única, Rail, cards no thread, Gaveta, mobile mínimo, orçamento de fricção.
- Orçamento de Reputação (FR-14…FR-20): Saldo por Canal, bloqueio preventivo, autenticação como pré-condição, rampa, WhatsApp conservador, pausa global, painel.
- Sugestões contextuais + Dia Zero (FR-21…FR-25).
- Confiança visível (FR-26…FR-30, FR-37): fontes citadas, Certificado bloqueante, histórico do domínio, explicabilidade, Teste da Maria, descadastro acessível e honrado.
- Contrato de Autonomia (FR-31…FR-34).
- WhatsApp consentido (FR-35, FR-36).

### 6.2 Out of Scope (MVP)

- Visão gerencial multiusuário (non-goal §5) — `[NOTE FOR PM]` emocionalmente caro para contas maiores; revisitar cedo.
- Sandbox interativa de demonstração com voo completo — v1 entrega demonstração passiva com dados fictícios (FR-23); voo em sandbox para v1.x.
- Efeito especial expandido de animação além do momento-assinatura (FR-6).
- Piloto automático end-to-end sem 1º lote aprovado — o guard-rail humano do 1º lote permanece.
- Projeção de reposição no painel de Saldo (Should do backlog) — v1 entrega histórico retroativo (FR-20); projeção para v1.x.

## 7. Success Metrics

*Validam os FRs indicados. Counter-metrics impedem otimizar o alvo errado.*

**Primary**
- **SM-1: Ativação via chat** — ≥40% das contas novas colocam a 1ª Campanha em Voo via Cockpit na 1ª sessão (30 dias pós-release). Valida FR-1…FR-13.
- **SM-2: Conversas geradas** — respostas positivas → reuniões por org ativa/mês; baseline a medir no release — `[ASSUMPTION: alvo inicial calibrado com baseline do release — ex.: ≥5 conversas/org ativa/mês]`. Valida 4.3–4.7 (o motor inteiro existe para isso).

**Secondary**
- **SM-3: Fricção real** — mediana de turnos até a 1ª campanha ≤6; p95 do 1º feedback ≤2s. Valida FR-11, FR-13.
- **SM-4: Saldo saudável** — % do tempo com Saldo ≥80% nas orgs ativas; tendência de rejeições por Canal. Valida FR-14…FR-20.

**Counter-metrics (não otimizar)**
- **SM-C1: Envios totais** — volume é vanity; nunca meta por si (contra-balanceia SM-2).
- **SM-C2: Taxa de Despertares** — acima do teto do FR-33 é ruído; alta taxa não significa produto atento (contra-balanceia FR-31–34).
- **SM-C3: Incidentes de domínio/WhatsApp** — meta é zero atribuível ao Studio; nunca trocada por crescimento de envio (contra-balanceia tudo).
- **SM-C4: Fuga para a Gaveta** — uso da Gaveta como fluxo primário indica falha do Diálogo; monitorar, não eliminar a Gaveta (contra-balanceia SM-1).

## 8. Open Questions

1. Números exatos de rampa/warm-up do Saldo (e-mail e WhatsApp) — decidir no plan com benchmarks; PRD trava só o mecanismo (FR-17, FR-18).
2. Fonte de verdade do limite seguro por número de WhatsApp — política do provedor não é pública; monitorar sinais (FR-18) e calibrar em produção.
3. Baseline atual de ativação do Studio (para medir o Δ do SM-1) — instrumentar antes do release.

## 9. Índice de Assumptions

- §2.3 Persona Rafael é ilustrativa — validar com clientes reais.
- §4.1 FR-3 O Saldo do Rail só aparece quando o Canal está configurado na organização (relaciona-se a FR-14).
- §4.3 FR-17 Números de rampa/warm-up definidos no plan.
- §4.4 FR-23 Demonstração do Dia Zero usa fixtures fictícios, nunca dados reais (LGPD).
- §4.6 FR-33 Teto inicial de 5 Despertares/dia/org.
- §7 SM-2 Alvo inicial calibrado com baseline do release (ex.: ≥5 conversas/org ativa/mês).
- §1/§9 v1 assume 1 domínio de e-mail + 1 número de WhatsApp por org; Saldo agregado por Canal.
- §1 Conteúdo continua gerado pelo pipeline LiteLLM existente (extract/compose/personalize).
- Stakes: produto em produção para clientes (rigor launch) — inferido, confirmado implicitamente pela direção do usuário.

## 10. Riscos e Mitigações

| Risco | Sev. | Mitigação |
|---|---|---|
| Banimento de WhatsApp em massa (limite chutado) | Crítico | FR-18/FR-35: consentimento, pacing conservador, sinais reduzem Saldo, zero promessa de imunidade |
| Risco C-1: transporte WAHA (sessão QR não-oficial) viola os ToS do Meta | Crítico | Risco declarado no v1 (§4.7): FR-35/FR-18 + Despertares; migração para WhatsApp Cloud API oficial como mitigação estrutural (roadmap pós-Must — addendum) |
| Domínio queimado na semana 2 (histórico sujo) | Crítico | FR-16/FR-27/FR-28: autenticação pré-condição, Certificado bloqueante, histórico no onboarding |
| Ninguém conversar com o Piloto | Alto | FR-11/FR-12 orçamento de fricção + SM-C4 fuga p/ Gaveta monitorada |
| Piloto desperta demais (fadiga) | Médio | FR-33 orçamento de notificações + FR-34 taxa monitorada |
| Sugestões surdas queimam confiança | Médio | FR-22 graceful degradation + FR-24 sinais fortes |
| Dependência de IA degrada a voz da marca | Médio | FR-30 humano no 1º lote + edições do vendedor capturadas como sinal (herdado do 010) |
| Chips-ação viram API de fato e quebram | Médio | actions semânticas versionadas desde o início (nota p/ arquitetura — addendum) |

## 11. Cross-Cutting NFRs

- **Performance:** 1º feedback ≤2s (p95); animações 60fps; mobile utilizável em 375px.
- **Acessibilidade:** `prefers-reduced-motion` honrado; contraste AA no tema dark; navegação por teclado no Cockpit.
- **Multi-tenancy e gating:** isolamento por organização; gating por plano (trial/premium) em toda ação nova (constituição IV).
- **LGPD/compliance:** opt-out sempre disponível e honrado; consentimento de WhatsApp auditável; sandbox/demo só com fixtures (constituição V).
- **Observabilidade:** toda ação do Piloto gera registro legível (FR-32); métricas prom-client para os fluxos novos (constituição VII).
- **Idempotência/persistência:** consumidores e ações idempotentes; contratos NATS `*.v1` intocados (constituição II).
- **Testes:** cada FR com comportamento novo entra com teste (constituição III).

**Estética e Voz:**
- Dark com UMA cor de acento; glow apenas onde há significado (luz acesa, saldo saudável, aprovação) — glow decorativo proibido.
- Animações via CSS nativo; dependência nova de UI só com justificativa na spec/plan (constituição VI).
- Voz do Piloto: zero-jargão — nunca "segmento", "execução" ou "guard-rail" para o usuário; metaforicamente um mordomo atento, que fala com dado concreto + pergunta de ação (ver Glossário, "Briefing do Mordomo").
