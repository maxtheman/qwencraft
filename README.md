# Qwencraft

`qwencraft` is a local LLM-driven block-building sandbox.

The current repo proves the loop:

- Effect-driven simulation and agent turns
- LM Studio integration over the OpenAI-compatible API
- a game-first isometric sandbox UI
- local relative tools instead of raw world mutation
- trace capture for prompts, raw model output, chosen action, and result
- beacon authoring and model-visible world markers
- a headless harness for repeatable behavior testing

## The Next Step

The next step is not more UI polish or more hidden runtime automation. It is to make the model materially better at multi-step building.

Right now the model has enough information for a legal local move, but not enough well-shaped task state to reliably build coherent structures over several turns. The system should evolve toward:

1. `objective_progress`
   A compact, task-specific progress view derived from the current objective and current world state.

2. `candidate_actions`
   A small set of legal next actions with expected effects, so the model chooses between meaningful options instead of inventing coordinates from scratch every turn.

3. better short-term plan memory
   Keep the fixed system prompt stable, but preserve the last few turns plus a compact plan summary so the agent can continue a shape instead of re-deciding from zero.

4. headless evaluation as the primary loop
   Use the headless harness to score concrete tasks like rows, pads, towers, and beacon-directed builds before judging behavior in the UI.

The design goal is a model-driven sandbox that stays honest:

- no secret objective solver
- no hidden shape completion fallback
- runtime remains authoritative about legality
- the model remains responsible for choosing the next action

## Current Tool Surface

- `inspect_patch()`
- `move(direction, steps)`
- `turn(direction)`
- `place_block(blockType, dx, dy, dz)`
- `remove_block(dx, dy, dz)`

## Run

1. Install dependencies:

```bash
npm install
```

2. Start LM Studio if you want real model turns.

3. Start the app:

```bash
npm run dev
```

- UI: `http://127.0.0.1:5173` or the next free Vite port
- API: `http://127.0.0.1:3001/api/state`

## Headless Harness

Run the LM-backed headless evaluator:

```bash
npm run harness:headless
```

Useful overrides:

- `LMSTUDIO_MODEL`
- `LMSTUDIO_BASE_URL`
- `LMSTUDIO_TOOL_MODE`
- `LMSTUDIO_IMAGE_MODE`
- `LMSTUDIO_TEMPERATURE`
- `LMSTUDIO_MAX_TOKENS`
- `LMSTUDIO_TOP_P`

## Direct Profiling

Run the direct LM Studio profiler:

```bash
npm run profile:lmstudio
```

## Environment

- `LMSTUDIO_BASE_URL`
  - default: `http://127.0.0.1:1234/v1`
- `LMSTUDIO_MODEL`
  - optional; if omitted the server tries to use the first loaded model
- `LMSTUDIO_API_KEY`
  - default: `lm-studio`
- `LMSTUDIO_TOOL_MODE`
  - `auto`, `native`, or `json`
  - default: `auto`
- `LMSTUDIO_IMAGE_MODE`
  - `auto`, `always`, or `never`
  - default: `auto`
- `LMSTUDIO_TEMPERATURE`
  - default: `0.1`
- `LMSTUDIO_MAX_TOKENS`
  - default: `80`
- `LMSTUDIO_TOP_P`
  - default: `0.9`
- `PORT`
  - default: `3001`

## Docs

- [docs/poc-scope.md](/Users/max/Documents/agent_game/docs/poc-scope.md)
- [docs/current-direction.md](/Users/max/Documents/agent_game/docs/current-direction.md)
- [docs/block-world-pivot.md](/Users/max/Documents/agent_game/docs/block-world-pivot.md)

## Notes

- If LM Studio is not reachable, the system falls back to a deterministic stub policy.
- The repo is compiled with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noImplicitReturns`.
