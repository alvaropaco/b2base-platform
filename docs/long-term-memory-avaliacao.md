# Avaliação — Memória de longo prazo para o chat do Cockpit (mem0 e alternativas)

**Data**: 2026-09-28 · **Contexto**: QA do chat (`qa-artifacts/2026-09-28-studio-chat/`) +
solicitação do dono: considerar long-term memory (ex.: [mem0](https://github.com/mem0ai/mem0))
para respostas ambíguas e perda de contexto.

## 1. O problema real (evidências do QA)

O chat hoje tem memória **apenas da campanha corrente**:

- histórico das últimas **12 mensagens** (`buildHistoryBlock`, `studio/ai/chat-agent.js`);
- estado da campanha (objetivo/oferta/audiência/agenda/materiais) via `buildStateBlock`;
- contexto do workspace (canais, respostas quentes, marca) via `buildOrgBlock`.

O que se perde entre sessões/campanhas:

| Evidência do QA | Memória teria ajudado? |
|---|---|
| **F1** — "Não entendi" em confirmações curtas | Parcialmente: é falha de parse do output (corrigida no commit `4dce2851`), mas interpretação de "demonstração"/"sim" depende da pergunta anterior — histórico curto e sem memória de padrões do usuário agrava |
| Preferências recorrentes do usuário ("sempre quero tom direto", "meu ICP é indústria de SP") | **Sim** — hoje o usuário repete isso em toda campanha |
| Correções de segmento que viraram regra ("quando falo alimentos, inclua bebidas") | **Sim** — cada nova campanha recomeça do zero |
| Resultados de campanhas passadas ("assunto com pergunta abriu mais") | **Sim** — hoje só existe por campanha (`StudioReplyClassification` é org-wide mas não é injetado como aprendizado) |
| Contradição modelo × dados (F3) | Não — é determinístico, corrigido com aviso no servidor; memória não resolve |

## 2. Opções avaliadas

### A. mem0 (plataforma ou OSS self-hosted)
- **Pró**: pipeline pronto de extração/atualização/recuperação de fatos
  (add/search/history), memória de entidade, SDK TS, opção hospedada.
- **Contra**:
  - **Nova dependência/infraestrutura** — serviço Python (OSS) + vector store, ou
    dependência de SaaS terceiro. A constituição/AGENTS.md exige justificativa em spec
    para nova dependência — justa, mas pesada para o ganho imediato;
  - **LGPD/dados de cliente**: fatos extraídos de conversas contêm dados comerciais;
    enviá-los a um serviço externo (hospedado) exige avaliação de dados pessoais e DPA;
  - Custo duplo de LLM (extração + busca) por turno em cima da latência já observada
    (p95 ≈ 8–12 s).

### B. Memória nativa Prisma/Postgres (recomendada como fase 1)
- Tabela `StudioMemory` escopada por **orgId** (`kind`, `content`, `source`,
  `confidence`, `createdAt/expiresAt`), alimentada por:
  1. **determinístico**: ações confirmadas viram fatos (ex.: 3ª campanha seguida
     com tom "direto" → preferência);
  2. **explícito**: frases do usuário do tipo "de agora em diante…" / "sempre…" →
     extração por LLM com confirmação no chat (mesmo padrão de confirmação humana
     já usado em materiais);
- Injeção barata: novo bloco `buildMemoryBlock(extras)` no prompt do agente
  (mesmo molde de `buildOrgBlock`), 200–500 tokens, **sem** busca vetorial no
  primeiro momento (org tem poucas dezenas de fatos; `WHERE orgId ORDER BY confidence`).
- **Pró**: zero dependência nova, dados na própria base (LGPD), cabe na arquitetura
  `extras` existente, mensurável com o evaluator (`eval/`).
- **Contra**: recuperação semântica limitada (resolvida depois com pgvector se
  volume crescer — Postgres já é a stack).

### C. mem0 OSS como *engine* por trás da tabela (fase 2, condicional)
Se a qualidade da extração/seleção da fase 1 estagnar (muitos fatos, ruído),
adotar mem0 **self-hosted** apenas como serviço de extração/recuperação, mantendo
`StudioMemory` como fonte da verdade e os dados na infraestrutura própria. Entrar
nessa decisão via spec BMad (`$bmad-spec`) com critérios medidos no evaluator.

## 3. Recomendação

1. **Fase 1 (recomendada agora)**: `StudioMemory` nativa + injeção no prompt +
   extração explícita com confirmação humana. Casos de uso: preferências de tom,
   ICP recorrente, regras de segmento do usuário.
2. **Fase 2 (condicional)**: mem0 self-hosted como engine de extração/recuperação,
   decidida por spec própria após baseline com o evaluator.
3. **Nunca** mem0 hospedado com dados de cliente sem avaliação LGPD/DPA.

**Critério de sucesso** (medido com `pnpm run eval:chat`): casos novos
"preferência persistente entre campanhas" e "regra de segmento lembrada" passando
sem o usuário repetir o contexto — e judge ≥ 7 em `contextRetention`.
