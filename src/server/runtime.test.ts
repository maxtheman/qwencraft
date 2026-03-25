import test from "node:test";
import assert from "node:assert/strict";
import { buildObservation, createInitialWorld, executeTool } from "./runtime";

test("place_block coerces dz=0 requests onto the first build layer", () => {
  const world = createInitialWorld();
  const result = executeTool(world, "builder", {
    name: "place_block",
    args: {
      blockType: "stone",
      dx: -1,
      dy: 0,
      dz: 0,
    },
  });

  assert.equal(result.result, "Placed stone at (4,5,1).");
});

test("repeating the same blocked placement is suppressed", () => {
  const world = createInitialWorld();

  const first = executeTool(world, "builder", {
    name: "place_block",
    args: {
      blockType: "stone",
      dx: -1,
      dy: 0,
      dz: 0,
    },
  });

  const second = executeTool(first.world, "builder", {
    name: "place_block",
    args: {
      blockType: "stone",
      dx: -1,
      dy: 0,
      dz: 0,
    },
  });

  assert.equal(second.result, "Place blocked: (4,5,1) is already occupied.");

  const third = executeTool(second.world, "builder", {
    name: "place_block",
    args: {
      blockType: "stone",
      dx: -1,
      dy: 0,
      dz: 0,
    },
  });

  assert.equal(
    third.result,
    "Place blocked: repeated identical placement suppressed. Inspect or choose a different local cell.",
  );
});

test("prompt observation prefers buildable cells over raw floor cells", () => {
  const world = createInitialWorld();
  const observation = buildObservation(world, "builder");

  assert.match(observation.promptText, /buildable_cells=.*\(0,1,1\)/);
  assert.doesNotMatch(observation.promptText, /buildable_cells=.*\(0,0,1\)/);
  assert.match(observation.promptText, /blocked_place_cells=none/);
  assert.doesNotMatch(observation.promptText, /reachable_cells=/);
  assert.doesNotMatch(observation.promptText, /\(0,1,0\)=grass/);
});

test("prompt observation reports occupied place targets separately", () => {
  const world = createInitialWorld();
  const first = executeTool(world, "builder", {
    name: "place_block",
    args: {
      blockType: "stone",
      dx: 0,
      dy: 1,
      dz: 1,
    },
  });

  const observation = buildObservation(first.world, "builder");
  assert.match(observation.promptText, /blocked_place_cells=.*\(0,1,1\)=stone/);
});
