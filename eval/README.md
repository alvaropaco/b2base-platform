# B2Base Conversational Evaluation

This suite tests the Campaign Studio chat as a black-box conversation API.

## Run against a local server

```bash
B2BASE_EVAL_URL=http://127.0.0.1:3001 pnpm run eval:chat
```

The runner executes the same multi-turn conversations repeatedly and checks:

- non-empty responses;
- expected semantic cards;
- clarification behavior for incomplete requests;
- multi-turn continuity.

The suite is intentionally dependency-free and does not require a model-specific SDK.

## Adding a regression

Add a case to `conversations/core.json` and capture the user messages and observable expectations. Prefer behavior assertions over exact wording so prompt improvements do not create brittle tests.

## CI gate

Set `B2BASE_EVAL_URL` to an already-running test environment and optionally `B2BASE_EVAL_THRESHOLD` to change the quality gate.
