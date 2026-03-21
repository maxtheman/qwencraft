# Local LLM Metroidvania Harness: Minimal POC Scope

## Goal

Prove three things with the smallest credible surface:

1. A 2D side-view harness can show autonomous entities moving around a room and thinking in public.
2. A local model running through LM Studio can drive those entities via a tiny tool surface.
3. Multiple entities can run concurrently, each with its own prompt, memory, and hot-swappable thread.

This is not a game yet. It is a simulation harness with game-like presentation.

## Recommended Stack

- Renderer: `pixi.js`
- Runtime and orchestration: `effect`
- Server: Node + Effect HTTP/WebSocket layer
- LLM transport: OpenAI-compatible client pointed at LM Studio local server
- Shared contracts: `effect/Schema`

Why this shape:

- PixiJS is enough for a polished 2D room without dragging in a full gameplay engine.
- Effect gives you a clean loop model for ticks, retries, queues, supervision, and per-entity fibers.
- LM Studio already exposes an OpenAI-compatible local API, which keeps the LLM side replaceable.

## Minimal Visual Surface

Build exactly one side-view room first.

- Room width: roughly 1200px, height: roughly 700px
- Background: one habitat pod room with 4 anchor points
- Anchors:
  - `pod`
  - `console`
  - `garden`
  - `door`
- Entities: start with 2
- Sprite quality: placeholder pixel sprites or colored capsules are fine
- Thoughts: one short visible bubble above the entity head
- Debug overlay: entity id, current state, last tool call

Important constraint:

- Do not let the model choose raw x/y coordinates.
- Let the model choose semantic anchors, and let the runtime handle movement/pathing.

That single decision removes most of the brittleness.

## World Model

Use a nav graph, not full platformer physics, for the first proof.

- Each room has named anchors with fixed positions.
- Anchors are connected by valid paths.
- Movement is tweened between anchors.
- Interaction radius is resolved by the runtime.
- Door transitions can exist, but only one room needs to be fully implemented for the first proof.

This still reads as a metroidvania harness because the camera, room framing, doors, and side-view presentation are there, while implementation stays small.

## Entity Model

Each entity needs exactly this runtime state:

```ts
type EntityRuntime = {
  id: string
  name: string
  prompt: string
  visibleThought: string
  currentRoomId: string
  currentAnchorId: string
  status: "idle" | "thinking" | "moving" | "interacting" | "paused"
  memorySummary: string
  thread: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>
  lastToolCall?: { name: string; args: unknown }
}
```

Hot-swappable prompt/thread means:

- `prompt` can be edited while the sim is running.
- `thread` can be cleared or replaced without recreating the entity.
- the entity fiber reads the latest prompt/thread snapshot on the next tick.

## Minimal Tool Surface

Start with only 2 model-callable tools:

1. `go_to(anchorId)`
2. `interact(anchorId)`

Everything else is injected as context by the runtime:

- current room
- current anchor
- nearby anchors
- nearby entities
- last observed event

Why only 2 tools:

- Fewer tools makes the model easier to steer.
- `go_to` covers exploration and positioning.
- `interact` covers using the console, door, garden, or talking to another entity.

If you need one more tool later, add:

3. `wait(reason)`

But I would not start there.

## LLM Loop

Run one supervised loop per entity at a slow simulation rate, not every frame.

- Render: 60 FPS
- Brain tick: every 1.5 to 3 seconds per entity
- Max tool calls per tick: 1

Per tick:

1. Build a compact state summary for that entity.
2. Ask the model to either:
   - call a tool, or
   - return a one-sentence public thought if no action is needed
3. If the model calls a tool:
   - execute it
   - append tool result to thread
   - ask for one short public thought
4. Update `visibleThought`
5. Sleep until next tick

Keep the visible thought public-facing. Do not treat it as hidden chain-of-thought. It is an explicit status line the model produces for the player to see.

## Prompt Shape

Each entity gets:

- a base system prompt
- a world/rules preamble
- a short rolling memory summary
- a short recent transcript window

Minimal system prompt contract:

```txt
You are an entity in a 2D simulation room.
Act in short steps.
You may either call one tool or reply with one short public thought.
Your public thought must be under 90 characters.
Prefer semantic anchors over describing coordinates.
```

This is enough for the proof. Rich personality prompts come later.

## Runtime Boundaries

Split responsibilities cleanly.

- Client:
  - renders room and entities in PixiJS
  - renders thoughts and debug HUD
  - sends prompt edits / pause / resume actions
  - receives world snapshots over WebSocket
- Server:
  - owns authoritative world state
  - runs entity loops in Effect fibers
  - resolves tool calls
  - talks to LM Studio
  - broadcasts snapshots/events

Do not put LLM calls in the browser.

## Suggested Repo Shape

```txt
src/
  client/
    main.ts
    game/
      app.ts
      scene.ts
      entitySprite.ts
      thoughtBubble.ts
  server/
    main.ts
    api.ts
    runtime/
      world.ts
      entityLoop.ts
      tools.ts
      lmstudio.ts
      snapshots.ts
  shared/
    schema.ts
    anchors.ts
    entities.ts
```

## Smallest Useful API

- `GET /api/world`
- `POST /api/entities`
- `PATCH /api/entities/:id`
  - update prompt
  - replace thread
  - pause/resume
- `WS /ws`
  - snapshot stream
  - event stream

That is enough to prove hot-swappable entities.

## What Counts As "Done"

The proof is successful when all of this works:

- A room renders in PixiJS with at least 4 named anchors.
- Two entities are visible and move between anchors.
- Each entity is driven by LM Studio, not hardcoded behavior.
- Each entity shows a short thought bubble after each turn.
- You can edit one entity prompt while the sim is running.
- That entity changes behavior on its next or next-few ticks.
- You can pause one entity without stopping the rest.

## Explicitly Out Of Scope

Do not include these in the first proof:

- combat
- inventory
- freeform pathfinding
- procedural rooms
- large memory systems
- hidden internal reasoning capture
- multiplayer or remote model hosting

## Recommended Build Order

1. Static PixiJS room with anchors and 2 manually controlled entities.
2. Server-owned world state with WebSocket snapshots.
3. One fake entity loop using scripted actions.
4. Replace scripted loop with LM Studio tool loop for one entity.
5. Add second entity with a different prompt.
6. Add prompt/thread hot-swap controls.

## One Important Design Decision

Use LM Studio through its OpenAI-compatible interface first, not through a custom integration.

That keeps the proof:

- model-agnostic
- easy to test with curl/OpenAI clients
- easy to move later to another local or remote backend

If you later want model load/unload control from code, add LM Studio's TypeScript SDK as a second integration surface, not the first one.
