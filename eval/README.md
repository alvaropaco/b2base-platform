# B2Base Conversational Evaluation

A black-box evaluation and observability layer for Campaign Studio chat.

## What it covers

- multi-turn regression conversations;
- observable behavior assertions instead of brittle exact wording;
- persistent per-turn telemetry: total latency, LLM latency, model, prompt/completion/total tokens, fallback, truncation and executed actions;
- optional LLM-as-a-Judge with qualitative scores;
- replay of real conversations into a selected test/staging environment.

## Run behavioral evaluation

```bash
B2BASE_EVAL_URL=http://127.0.0.1:3001 \
B2BASE_EVAL_THRESHOLD=85 \
pnpm run eval:chat
```

The evaluator expects a test organization that can create Campaign Studio campaigns.

## Run with LLM-as-a-Judge

```bash
B2BASE_EVAL_URL=http://127.0.0.1:3001 \
B2BASE_EVAL_JUDGE=true \
pnpm run eval:chat
```

The judge uses the same LiteLLM gateway as the platform and reports correctness, relevance, context retention, conversation flow, clarification, tool use, concision and an overall score.

## Replay a production conversation safely

Replay should target a staging/test environment, not production.

```bash
B2BASE_REPLAY_URL=https://staging.example.com \
B2BASE_REPLAY_ORG_ID=eval-org \
B2BASE_REPLAY_CAMPAIGN_ID=<campaign-id> \
pnpm run eval:replay
```

The runner reads only the user turns from the source conversation, creates a fresh campaign in the target environment and replays those turns sequentially. It never writes back to the source campaign.

## Inspect traces

The chat API exposes:

```
GET /api/studio/campaigns/:id/traces
```

Traces intentionally contain operational metadata only. Prompts, responses and message contents are not duplicated into the trace table.

## Adding a regression

Add a case to eval/conversations/core.json. Prefer behavior, state and semantic-card assertions over exact response text.

## CI

The existing manual GitHub Actions workflow can run the regression suite against a deployed test/staging URL. Keep the judge opt-in because it consumes LLM tokens.