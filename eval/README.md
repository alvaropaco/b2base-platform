# Evaluador Conversacional do Cockpit (`eval/`)

Mede a qualidade REAL do chat do Studio contra o ambiente **deployado**
(padrão: `https://www.b2base.net`) — autenticando como usuário dedicado,
criando campanhas frescas `[AI-EVAL]` e avaliando comportamento, nunca
texto exato.

```
SISTEMA EM TESTE: https://www.b2base.net → Studio real → agente → ações → DB
EVALUADOR (aqui): login programático → suíte → asserções → relatório → judge opcional
```

## Configuração

| Variável | Padrão | Descrição |
|---|---|---|
| `B2BASE_EVAL_URL` | `https://www.b2base.net` | Alvo da avaliação (nunca localhost por padrão) |
| `B2BASE_EVAL_EMAIL` / `B2BASE_EVAL_PASSWORD` | — | Conta **dedicada** de avaliação (obrigatória; nunca commitar) |
| `B2BASE_FIREBASE_API_KEY` | `apps/web/.env.local` | API key **web pública** do Firebase (login REST) |
| `B2BASE_EVAL_THRESHOLD` | `85` | Gate do score determinístico (0–100) |
| `B2BASE_EVAL_CASES` | `eval/conversations/core.json` | Suíte a rodar |
| `B2BASE_EVAL_ONLY` | — | Roda um único caso por id (smoke) |
| `B2BASE_EVAL_JUDGE` | `false` | Habilita LLM-as-a-Judge (consome tokens) |
| `B2BASE_EVAL_JUDGE_THRESHOLD` | `7` | Referência do judge (report, não gate) |

## Uso

```bash
# suíte determinística completa (baseline de produção)
B2BASE_EVAL_EMAIL=... B2BASE_EVAL_PASSWORD=... pnpm run eval:chat

# smoke de um caso
B2BASE_EVAL_ONLY=pedido-ambiguo B2BASE_EVAL_EMAIL=... B2BASE_EVAL_PASSWORD=... pnpm run eval:chat

# com LLM-as-a-Judge (requer LITELLM_URL/_API_KEY/_MODEL do repo)
B2BASE_EVAL_JUDGE=true B2BASE_EVAL_EMAIL=... B2BASE_EVAL_PASSWORD=... pnpm run eval:chat
```

Saída: resumo no console + JSON completo em `eval/reports/`
(score determinístico, falhas por asserção, latência média/p50/p95/p99,
erros HTTP, disponibilidade de traces, judge por caso).

## Autenticação (mesma da aplicação)

Firebase Auth REST (`accounts:signInWithPassword`) → ID token →
`POST /api/auth/session` → cookie httpOnly `b2base_session`. A organização é
resolvida **no servidor** a partir do usuário — nenhum header de teste
(`x-test-org-id`) é usado. 401 re-loga uma vez automaticamente.

## Segurança de produção

- Só cria campanhas `[AI-EVAL] <data> <caso>` dentro da org de avaliação;
- Nunca aprova, dispara ou toca campanha de cliente;
- Nunca contata leads reais (o fluxo avaliado é planejamento no chat);
- Credenciais somente por env/CI secrets.

## Suítes

- `conversations/core.json` (`core-v1`): 8 casos canônicos + regressões do
  QA manual de 2026-09-28 —
  **F1** (`confirmacao-curta` + invariante global: "Não entendi
  completamente" é proibido em qualquer resposta) e
  **F3** (`audienceConsistent`: audiência 0 leads em base populada exige
  aviso explícito 0 × total da base).

## Níveis de teste

1. **Unit** (local/CI): `node --test` — inclui `test/eval-stack.test.js`.
2. **Determinístico** (produção): `pnpm run eval:chat` — gate de regressão.
3. **LLM-as-a-Judge** (produção, opt-in): avalia correção, retenção de
   contexto, fluxo, esclarecimento, uso de ferramentas e concisão com
   validação estrita de schema (`JUDGE_INVALID_JSON/SCORE/SCHEMA`),
   temperatura 0 e `judgeVersion`.

## Roadmap

- Telemetria `StudioChatTrace` + `GET /campaigns/:id/traces` (o evaluator
  já degrada graciosamente quando ausente);
- `eval/replay-conversation.js` (replay anonimizado de conversas reais);
- Histórico de releases: comparar relatórios main × branch.
