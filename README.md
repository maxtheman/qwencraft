# Agent Harness Debug Runtime

First-pass local LLM simulation harness:

- Effect-driven physics tick and per-entity brain loops
- Debug room UI in React/Vite
- LM Studio via OpenAI-compatible API
- Stub brain fallback when LM Studio is unavailable

Docs:

- Scope and original POC target: [docs/poc-scope.md](/Users/max/Documents/agent_game/docs/poc-scope.md)
- Current architecture and direction: [docs/current-direction.md](/Users/max/Documents/agent_game/docs/current-direction.md)

## Run

1. Start LM Studio local server if you want real model turns.
2. Optional: copy `.env.example` values into your shell.
3. Install dependencies:

```bash
npm install
```

4. Start the app:

```bash
npm run dev
```

- Debug UI: `http://127.0.0.1:5173` or the next free Vite port
- API: `http://127.0.0.1:3001/api/state`

## Profile LM Studio

Run the direct profiler against the loaded LM Studio model:

```bash
npm run profile:lmstudio
```

Optional overrides:

- `LMSTUDIO_MODEL`
- `LMSTUDIO_BASE_URL`
- `PROFILE_RUNS`

## Environment

- `LMSTUDIO_BASE_URL`
  - default: `http://127.0.0.1:1234/v1`
- `LMSTUDIO_MODEL`
  - optional; if omitted the server tries to use the first loaded model
- `LMSTUDIO_API_KEY`
  - default: `lm-studio`
- `PORT`
  - default: `3001`

## Current Tool Surface

- `inspect_view()`
- `move(direction, distance)`
- `jump(direction, distance, strength)`
- `approach_entity(entityId, stopWithin)`

The LM Studio path now asks for one structured JSON decision per turn:

- public `thought`
- one `action`

The runtime then executes that action locally and records a trace.

## What This First Pass Proves

- the Effect runtime can drive concurrent entities
- prompt edits are hot-swappable
- per-entity pause/resume works
- obstacle hints and visible entity ids are fed into the agent loop
- movement is distance-based rather than anchor-based
- viewport images can be attached to LM Studio turns
- per-turn traces capture the prompt, raw model output, executed action, and latency

## Notes

- If LM Studio is not reachable, the system falls back to a deterministic stub policy and keeps the sim running.
- The current UI is a debug surface, not the final PixiJS renderer.
- The repo is compiled with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noImplicitReturns`.
