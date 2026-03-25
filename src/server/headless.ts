import { createBrainAdapter } from "./lmstudio";
import {
  applyBrainResult,
  buildObservation,
  createInitialWorld,
  executeTool,
  patchEntity,
  scheduleThinking,
} from "./runtime";

type World = ReturnType<typeof createInitialWorld>;

type HarnessTask = {
  name: string;
  objective: string;
  maxTurns: number;
  success: (world: World) => boolean;
};

const hasBlock = (world: World, x: number, y: number, z: number, type: "stone" | "wood" | "glass") =>
  world.blocks[`${x},${y},${z}`] === type;

const hasStoneRow = (world: World, length: number) => {
  for (let y = 0; y < world.gridDepth; y += 1) {
    for (let x = 0; x <= world.gridWidth - length; x += 1) {
      if (Array.from({ length }, (_, index) => hasBlock(world, x + index, y, 1, "stone")).every(Boolean)) {
        return true;
      }
    }
  }
  for (let x = 0; x < world.gridWidth; x += 1) {
    for (let y = 0; y <= world.gridDepth - length; y += 1) {
      if (Array.from({ length }, (_, index) => hasBlock(world, x, y + index, 1, "stone")).every(Boolean)) {
        return true;
      }
    }
  }
  return false;
};

const hasStonePad = (world: World, size: number) => {
  for (let x = 0; x <= world.gridWidth - size; x += 1) {
    for (let y = 0; y <= world.gridDepth - size; y += 1) {
      let full = true;
      for (let dx = 0; dx < size; dx += 1) {
        for (let dy = 0; dy < size; dy += 1) {
          if (!hasBlock(world, x + dx, y + dy, 1, "stone")) {
            full = false;
          }
        }
      }
      if (full) {
        return true;
      }
    }
  }
  return false;
};

const hasStoneTower = (world: World, height: number) => {
  for (let x = 0; x < world.gridWidth; x += 1) {
    for (let y = 0; y < world.gridDepth; y += 1) {
      if (Array.from({ length: height }, (_, index) => hasBlock(world, x, y, index + 1, "stone")).every(Boolean)) {
        return true;
      }
    }
  }
  return false;
};

const tasks: HarnessTask[] = [
  {
    name: "row-4",
    objective:
      "Build a straight row of 4 stone blocks on the ground. Use dz=1 only. Start near your current position and do not stack upward.",
    maxTurns: 18,
    success: (world) => hasStoneRow(world, 4),
  },
  {
    name: "pad-2x2",
    objective:
      "Build a 2x2 stone pad on the ground near you. Use dz=1 only. Fill four adjacent cells and do not stack upward.",
    maxTurns: 20,
    success: (world) => hasStonePad(world, 2),
  },
  {
    name: "tower-3",
    objective:
      "Build a 3-high stone tower near you. Keep the same local dx and dy, and stack dz=1 then dz=2 then dz=3.",
    maxTurns: 16,
    success: (world) => hasStoneTower(world, 3),
  },
];

const brain = createBrainAdapter({
  baseUrl: process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
  model: process.env.LMSTUDIO_MODEL ?? "qwen35-agent",
  apiKey: process.env.LMSTUDIO_API_KEY ?? "lm-studio",
  toolMode:
    process.env.LMSTUDIO_TOOL_MODE === "json" || process.env.LMSTUDIO_TOOL_MODE === "native" || process.env.LMSTUDIO_TOOL_MODE === "auto"
      ? process.env.LMSTUDIO_TOOL_MODE
      : "native",
  imageMode:
    process.env.LMSTUDIO_IMAGE_MODE === "always" || process.env.LMSTUDIO_IMAGE_MODE === "never" || process.env.LMSTUDIO_IMAGE_MODE === "auto"
      ? process.env.LMSTUDIO_IMAGE_MODE
      : "never",
  temperature: Number(process.env.LMSTUDIO_TEMPERATURE ?? "0.1"),
  maxTokens: Number(process.env.LMSTUDIO_MAX_TOKENS ?? "80"),
  topP: Number(process.env.LMSTUDIO_TOP_P ?? "0.9"),
});

const runTask = async (task: HarnessTask) => {
  let world = createInitialWorld();
  world = patchEntity(world, "builder", { prompt: task.objective, paused: false }).world;

  for (let turn = 1; turn <= task.maxTurns; turn += 1) {
    const entity = world.entities.builder;
    if (!entity) {
      throw new Error("Missing builder entity.");
    }
    const observation = buildObservation(world, "builder");
    world = scheduleThinking(world, "builder", observation);
    const result = await brain.runTurn({
      entity: {
        id: entity.id,
        name: entity.name,
        prompt: entity.prompt,
        memorySummary: entity.memorySummary,
        objectiveRevision: entity.objectiveRevision,
      },
      observation,
      thread: entity.thread,
      toolExecutor: async (invocation) => {
        const executed = executeTool(world, "builder", invocation);
        world = executed.world;
        return executed.result;
      },
    });
    world = applyBrainResult(world, "builder", result);
    if (task.success(world)) {
      return { ok: true, turns: turn, world };
    }
  }

  return { ok: false, turns: task.maxTurns, world };
};

const summarizeWorld = (world: World) => {
  const built = Object.entries(world.blocks)
    .filter(([, type]) => type !== "grass")
    .map(([key, type]) => `${key}:${type}`)
    .sort();
  return built.join(" | ");
};

const main = async () => {
  const requested = process.argv[2];
  const suite = requested ? tasks.filter((task) => task.name === requested) : tasks;
  if (suite.length === 0) {
    throw new Error(`Unknown task: ${requested}`);
  }

  for (const task of suite) {
    const started = Date.now();
    const result = await runTask(task);
    const durationMs = Date.now() - started;
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`\n[${status}] ${task.name} in ${result.turns} turns (${durationMs} ms)`);
    console.log(`objective: ${task.objective}`);
    console.log(`built: ${summarizeWorld(result.world) || "none"}`);
    const entity = result.world.entities.builder;
    const latestTrace = entity?.traces[0];
    if (latestTrace) {
      console.log(`last thought: ${latestTrace.thought}`);
      console.log(
        `last action: ${latestTrace.actionName}${latestTrace.actionArgs ? ` ${JSON.stringify(latestTrace.actionArgs)}` : ""}`,
      );
      console.log(`last result: ${latestTrace.actionResult ?? "none"}`);
    }
  }
};

await main();
