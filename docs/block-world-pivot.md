# Block World Pivot

## Why This Pivot

The current side-view harness proved the hard parts:

- local LM Studio turns
- Effect-driven entity loops
- prompt/thread hot-swapping
- runtime-owned execution
- visible thought traces

What it did not prove cleanly is "let the AI build things in a toy world."

For that, a tiny block sandbox is a better target than a platformer.

## What I Took From The `json-render` Game Engine Example

Reference:

- [vercel-labs/json-render/examples/game-engine](https://github.com/vercel-labs/json-render/tree/main/examples/game-engine)

The useful idea in that example is not "copy the whole engine."

The useful idea is:

- keep the world as structured state
- derive a scene spec from that state
- let AI operate over a compact game abstraction instead of raw rendering details

That maps well to this repo.

We should keep the current loop and swap the world model.

## Simpler Goal

Build a minimal "agent sandbox" that feels like tiny Minecraft:

- one builder agent
- one small block grid
- a flat floor
- a few block types
- one fixed camera
- the agent is told to build simple things:
  - a wall
  - a tower
  - a house outline
  - a staircase

This is enough to prove tool-driven construction without needing combat, navmeshes, or platformer physics.

## Recommended World

Use a tiny discrete voxel grid.

- size: `12 x 12 x 6`
- origin: bottom-left of the build plate
- floor: solid grass or stone at `z = 0`
- mutable blocks above floor
- one agent with:
  - position `(x, y, z)` on the grid
  - facing direction

Keep the world deterministic and server-owned.

## Rendering

Do not jump to a complex 3D renderer first.

First pass should use one of these:

1. Isometric SVG blocks in React
2. Simple orthographic top-down grid with a height indicator

I would start with isometric SVG because:

- it reads more like "Minecraft"
- it stays easy to inspect and debug
- it does not require a full 3D stack

The client should still only render state. The server should own all mutations.

## Observation Model

The agent should not receive the whole world every turn.

Give it:

- its current position and facing
- a small local patch around itself
- a simple build goal
- a short memory summary
- the latest viewport image

Recommended local patch:

- `5 x 5 x 4` cells centered around the agent

Represent it in text like:

```txt
self=pos(4,4,1) facing=north
goal=build a 3-block-high stone tower
front column:
- (0,1,0)=empty
- (0,1,1)=empty
- (0,1,2)=empty
nearby blocks:
- (-1,0,0)=stone
- (1,0,0)=stone
- (0,-1,0)=grass
```

That keeps token cost low and makes building decisions local.

## Tool Surface

Keep the tool surface tiny and discrete.

Recommended first set:

1. `inspect_patch()`
2. `move(direction, steps)`
3. `turn(direction)`
4. `place_block(blockType, dx, dy, dz)`
5. `remove_block(dx, dy, dz)`

Where:

- `direction` is one of `forward | backward | left | right`
- `turn` is `left | right`
- `dx/dy/dz` are relative offsets from the agent, not absolute world coordinates

This is the key simplification.

Do not let the model author arbitrary scene JSON and do not let it place blocks by global coordinates in the first pass.

Relative offsets are enough to build meaningful structures while staying safe and debuggable.

## Same Core Loop

We can reuse the current loop almost directly:

1. Build observation for the agent
2. Send structured turn request to LM Studio
3. Get one action + one short public thought
4. Execute action in runtime
5. Record trace
6. Repeat on a slow tick

The existing pieces that largely carry over:

- [src/server/main.ts](/Users/max/Documents/agent_game/src/server/main.ts)
- [src/server/lmstudio.ts](/Users/max/Documents/agent_game/src/server/lmstudio.ts)
- [src/server/profile.ts](/Users/max/Documents/agent_game/src/server/profile.ts)
- [src/shared/contracts.ts](/Users/max/Documents/agent_game/src/shared/contracts.ts)

The main replacement is [src/server/runtime.ts](/Users/max/Documents/agent_game/src/server/runtime.ts), which would stop being a platformer world and become a block-grid world.

## Minimal POC Definition

The proof is successful when:

- one builder agent is visible in a tiny block world
- the agent gets a goal like "build a 3-high stone tower"
- it takes several turns to complete that goal
- each turn shows a short thought bubble
- each turn is traceable in the debug UI
- you can change the goal prompt live and the behavior changes within the next few turns

## Suggested Runtime Shape

```ts
type BlockType = "air" | "grass" | "stone" | "wood" | "glass"

type BuilderWorld = {
  width: number
  depth: number
  height: number
  blocks: Record<string, BlockType>
  agent: {
    x: number
    y: number
    z: number
    facing: "north" | "east" | "south" | "west"
    prompt: string
    visibleThought: string
    memorySummary: string
    thread: ThreadMessage[]
    traces: BrainTrace[]
  }
}
```

## Why This Is Better Than The Current Side-View World

- fewer movement edge cases
- cleaner tool semantics
- easier to verify correct behavior
- better fit for "build some stuff"
- easier to score success automatically

Instead of asking:

- did the jump clear?
- did the raycast read correctly?
- did line-of-sight and obstacle heuristics confuse the agent?

we ask:

- did it place the right block in the right relative location?
- did it move to the correct place before building?
- did the structure converge toward the goal?

That is a much better fit for a first "builder agent" proof.

## Good First Tasks For The Agent

Use goals that are easy to evaluate:

1. Build a `3` block stone pillar directly in front of you.
2. Build a `4` wide wood wall.
3. Build a two-step staircase.
4. Place glass around a `2x2` square.

Do not start with "build a house" as the first benchmark.

## Recommended Build Order

1. Replace the world model with a block grid and one builder agent.
2. Render the grid in a simple isometric SVG view.
3. Replace jump/approach tools with block tools.
4. Keep the existing LM Studio loop and traces.
5. Add one goal field in the UI separate from persona.
6. Add a tiny success checker for simple build tasks.

## One Important Constraint

Do not let the model mutate the whole world in one shot.

Keep it to:

- one action per turn
- one small local mutation at a time

That preserves the same valuable property we already proved in this repo:

- the model chooses intent
- the runtime owns execution
- the UI shows the process, not just the end state
