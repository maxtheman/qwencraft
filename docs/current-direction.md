# Current Direction

## What This Repo Is Now

This repo is no longer just a scope document. It is a working local simulation harness with:

- an authoritative Node server
- Effect-driven physics and per-entity brain loops
- a React/Vite debug client
- LM Studio integration through the OpenAI-compatible API
- per-entity prompt editing, pause/resume, thread reset, traces, and viewport previews

The current renderer is still a debug surface. It is proving the agent loop, not the final art direction.

## The Direction We Have Been Heading Toward

The target is a small "agentic metroidvania harness":

- side-view 2D rooms
- multiple autonomous entities
- short public thought bubbles over each entity
- local model-driven behavior
- hot-swappable prompts and short-term memory
- runtime-owned movement, collision, and visibility

The important architectural choice is that the runtime remains authoritative.

The model should decide intent:

- what it is trying to do
- which visible entity matters
- whether to move, jump, inspect, or approach
- what short public thought to surface

The runtime should decide execution:

- movement clamping
- collision and obstacle resolution
- visible entity detection
- line-of-sight
- trace capture
- world state updates

## Current Architecture

### Server

- [src/server/main.ts](/Users/max/Documents/agent_game/src/server/main.ts)
  - Express API
  - Effect loops for physics and entity brains
- [src/server/runtime.ts](/Users/max/Documents/agent_game/src/server/runtime.ts)
  - world state
  - movement / jump / obstacle handling
  - observation building
  - trace application
- [src/server/lmstudio.ts](/Users/max/Documents/agent_game/src/server/lmstudio.ts)
  - OpenAI-compatible LM Studio calls
  - multimodal turn requests
  - stub fallback path
- [src/server/viewport.ts](/Users/max/Documents/agent_game/src/server/viewport.ts)
  - server-side viewport image generation for vision turns

### Client

- [src/client/App.tsx](/Users/max/Documents/agent_game/src/client/App.tsx)
  - debug room renderer
  - prompt editing
  - entity inspection
  - trace review

### Shared

- [src/shared/contracts.ts](/Users/max/Documents/agent_game/src/shared/contracts.ts)
  - strict schemas and snapshot contracts

## What Works

- two concurrent entities
- local LM Studio model turns
- per-turn observation + viewport image input
- prompt edits while the sim is running
- per-entity pause/resume
- thread reset
- trace capture:
  - prompt sent
  - raw model output
  - executed action
  - action result
  - latency
- fallback stub mode when LM Studio is unavailable

## Current Rough Edges

- the room is still a debug SVG, not PixiJS
- agent prompting is controllable but not yet strongly steerable in plain natural language
- obstacle behavior can still lead to repetitive jump/move loops
- long-running memory is still a compressed text summary, not a better background summarizer fiber
- the debug UI is functional, not final

## What The Next Build Should Probably Be

1. Split `persona` from `operator directive` in the UI so control input is explicit.
2. Add a runtime "stuck" policy that forces `inspect_view` or alternate movement after repeated blocked turns.
3. Replace the SVG room with a PixiJS scene while keeping the same server/runtime contract.
4. Add more room geometry and one or two clearer interaction surfaces.
5. Move older thread compression into a lower-priority Effect worker instead of doing it inline.

## What Not To Lose

The valuable part of this repo is the loop shape:

- server-owned world
- entity fibers
- model chooses intent
- runtime executes safely
- short public thoughts remain visible

That is the core of the proof. The renderer and content can change later without throwing away the architecture.
