# B2Base Conversational Evaluation

The suite treats the Campaign Studio `/api/studio` chat as a black-box conversation API and turns regressions into repeatable tests.

## What is covered

- multi-turn conversations;
- observable response quality instead of brittle exact-text matching;
- expected semantic cards (`objective`, `audience`, `material`, `schedule`);
- clarification behavior for incomplete prompts;
- a numeric quality score and CI threshold.

## Running against a local/staging server

```bash
B2BASE_EVAL_URL=http://127.0.0.1:3001 \
B2BASE_EVAL_THRESHOLD=85 \
pnpm run eval:chat
```

The target environment must expose a test organization that can create Campaign Studio campaigns. The evaluator does not store model/API credentials.

## Adding regressions

Add a case to `eval/conversations/core.json`. Prefer assertions about behavior, cards and state over exact wording so prompt/model improvements do not make tests unnecessarily brittle.

## Next integration step

The current evaluator is intentionally black-box. It is a stable foundation for adding LLM-as-a-judge, traces, latency/token assertions and replayable production conversations later without changing the test-case format.
