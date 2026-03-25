import { Ref } from "effect";
import type {
  BeaconSnapshot,
  BlockSnapshot,
  BlockType,
  BrainTraceSnapshot,
  EntitySnapshot,
  EntityStatus,
  Facing,
  MoveDirection,
  ToolRecord,
  TurnDirection,
  WorldSnapshot,
} from "../shared/contracts";
import type { LlmStatus } from "./lmstudio";
import { renderViewportPngDataUrl } from "./viewport";

export type ThreadMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

type BuildBlockType = Exclude<BlockType, "grass">;

type BeaconState = {
  id: string;
  x: number;
  y: number;
  label: string;
};

type ReachableCell = {
  dx: number;
  dy: number;
  dz: number;
  current: BlockType | "empty";
  supported: boolean;
};

type EntityState = {
  id: string;
  name: string;
  color: string;
  prompt: string;
  visibleThought: string;
  status: EntityStatus;
  gridX: number;
  gridY: number;
  gridZ: number;
  facing: Facing;
  paused: boolean;
  memorySummary: string;
  lastObservation: string;
  lastToolCall?: ToolRecord;
  lastActionResult?: string;
  lastViewportImageDataUrl?: string;
  recentEvents: string[];
  thread: ThreadMessage[];
  traces: BrainTraceSnapshot[];
  objectiveRevision: number;
};

type MetricsState = {
  totalPhysicsTicks: number;
  totalBrainTurns: number;
  physicsTickTimestamps: number[];
  brainTurnTimestamps: number[];
  brainLatenciesMs: number[];
  completionTokenRates: number[];
};

type WorldState = {
  gridWidth: number;
  gridDepth: number;
  gridHeight: number;
  blocks: Record<string, BlockType>;
  beacons: Record<string, BeaconState>;
  entities: Record<string, EntityState>;
  metrics: MetricsState;
};

export type ViewObservation = {
  promptText: string;
  inspectText: string;
  viewportImageDataUrl: string;
  self: {
    x: number;
    y: number;
    z: number;
    facing: Facing;
  };
  builtCounts: Record<BuildBlockType, number>;
  reachableCells: ReachableCell[];
};

export type ToolInvocation =
  | { name: "inspect_patch"; args: Record<string, never> }
  | { name: "move"; args: { direction: MoveDirection; steps: number } }
  | { name: "turn"; args: { direction: TurnDirection } }
  | { name: "place_block"; args: { blockType: BuildBlockType; dx: number; dy: number; dz: number } }
  | { name: "remove_block"; args: { dx: number; dy: number; dz: number } };

export type BrainResult = {
  objectiveRevision: number;
  thought: string;
  threadEntries: ThreadMessage[];
  toolCall?: ToolInvocation;
  toolResult?: string;
  rawModelOutput: string;
  requestTranscriptText: string;
  latencyMs: number;
  completionTokens?: number;
  completionTokensPerSecond?: number;
  mode: LlmStatus["mode"];
  activeModel?: string;
  viewportImageDataUrl?: string;
};

export type WorldRef = Ref.Ref<WorldState>;

const PHYSICS_WINDOW_MS = 5_000;
const METRIC_SAMPLE_LIMIT = 40;
const THREAD_MESSAGE_LIMIT = 4;
const MEMORY_SUMMARY_LIMIT = 220;
const GRID_WIDTH = 12;
const GRID_DEPTH = 12;
const GRID_HEIGHT = 6;
const REACH_DX = [-1, 0, 1] as const;
const REACH_DY = [0, 1, 2, 3] as const;
const REACH_DZ = [0, 1, 2, 3] as const;
const BUILD_BLOCK_TYPES: readonly BuildBlockType[] = ["stone", "wood", "glass"];
const clipThought = (value: string) => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 88) {
    return compact || "Awaiting an objective.";
  }
  return `${compact.slice(0, 85).trimEnd()}...`;
};

const pruneSamples = (samples: number[], now: number, windowMs = PHYSICS_WINDOW_MS) =>
  samples.filter((sample) => now - sample <= windowMs);

const limitSample = (samples: number[]) => samples.slice(-METRIC_SAMPLE_LIMIT);

const pushEvent = (entity: EntityState, event: string) => {
  entity.recentEvents = [event, ...entity.recentEvents].slice(0, 6);
};

const pushTrace = (entity: EntityState, trace: BrainTraceSnapshot) => {
  entity.traces = [trace, ...entity.traces].slice(0, 8);
};

const sameToolCall = (left: ToolRecord | undefined, right: ToolInvocation) =>
  left?.name === right.name && JSON.stringify(left.args) === JSON.stringify(right.args);

const clipMemory = (value: string) => value.replace(/\s+/g, " ").trim();

const takeLastSegments = (segments: readonly string[], maxLength: number) => {
  const kept: string[] = [];
  for (const segment of [...segments].reverse()) {
    const candidate = [segment, ...kept].join(" || ");
    if (candidate.length > maxLength) {
      continue;
    }
    kept.unshift(segment);
  }
  return kept;
};

const summarizeDroppedThreadMessage = (message: ThreadMessage) => {
  const compact = clipMemory(message.content);
  if (message.role === "assistant") {
    return `assistant:${compact.slice(0, 120)}`;
  }
  return `user:${compact.slice(0, 120)}`;
};

const mergeCompressedMemory = (existing: string, droppedMessages: readonly ThreadMessage[]) => {
  if (droppedMessages.length === 0) {
    return clipMemory(existing) || "No summary yet.";
  }

  const existingSegments = existing
    .split(" || ")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const nextSegments = [...existingSegments, ...droppedMessages.map(summarizeDroppedThreadMessage)];
  return takeLastSegments(nextSegments, MEMORY_SUMMARY_LIMIT).join(" || ") || "No summary yet.";
};

const appendThreadEntries = (entity: EntityState, entries: readonly ThreadMessage[]) => {
  const nextThread = [...entity.thread, ...entries];
  const overflow = Math.max(0, nextThread.length - THREAD_MESSAGE_LIMIT);
  if (overflow > 0) {
    entity.memorySummary = mergeCompressedMemory(entity.memorySummary, nextThread.slice(0, overflow));
  } else {
    entity.memorySummary = clipMemory(entity.memorySummary);
  }
  entity.thread = nextThread.slice(-THREAD_MESSAGE_LIMIT);
};

const getEntity = (world: Pick<WorldState, "entities">, entityId: string) => world.entities[entityId];

const getEntityOrThrow = (world: Pick<WorldState, "entities">, entityId: string) => {
  const entity = getEntity(world, entityId);
  if (!entity) {
    throw new Error(`Unknown entity: ${entityId}`);
  }
  return entity;
};

const blockKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

const parseBlockKey = (key: string) => {
  const [rawX, rawY, rawZ] = key.split(",");
  if (rawX === undefined || rawY === undefined || rawZ === undefined) {
    throw new Error(`Invalid block key: ${key}`);
  }
  return {
    x: Number(rawX),
    y: Number(rawY),
    z: Number(rawZ),
  };
};

const isInsideGrid = (world: Pick<WorldState, "gridWidth" | "gridDepth" | "gridHeight">, x: number, y: number, z: number) =>
  x >= 0 && x < world.gridWidth && y >= 0 && y < world.gridDepth && z >= 0 && z < world.gridHeight;

const getBlock = (world: Pick<WorldState, "blocks">, x: number, y: number, z: number) => world.blocks[blockKey(x, y, z)];

const beaconList = (world: Pick<WorldState, "beacons">) =>
  Object.values(world.beacons).sort((a, b) => a.y - b.y || a.x - b.x || a.label.localeCompare(b.label));

const formatBeaconObservation = (world: Pick<WorldState, "beacons">, entity: Pick<EntityState, "facing" | "gridX" | "gridY">) =>
  beaconList(world)
    .map((beacon, index) => {
      const local = toLocalDelta(entity.facing, beacon.x - entity.gridX, beacon.y - entity.gridY);
      return `${index + 1}:${beacon.label}@(${beacon.x},${beacon.y}) local=(${local.dx},${local.dy})`;
    })
    .join(" | ");

const setBlock = (world: WorldState, x: number, y: number, z: number, blockType: BlockType) => {
  world.blocks[blockKey(x, y, z)] = blockType;
};

const removeBlock = (world: WorldState, x: number, y: number, z: number) => {
  delete world.blocks[blockKey(x, y, z)];
};

const highestSolidZ = (world: WorldState, x: number, y: number) => {
  for (let z = world.gridHeight - 1; z >= 0; z -= 1) {
    if (getBlock(world, x, y, z)) {
      return z;
    }
  }
  return -1;
};

const countBuiltBlocks = (world: WorldState): Record<BuildBlockType, number> => {
  const counts: Record<BuildBlockType, number> = { stone: 0, wood: 0, glass: 0 };
  for (const blockType of Object.values(world.blocks)) {
    if (blockType !== "grass") {
      counts[blockType] += 1;
    }
  }
  return counts;
};

const toWorldDelta = (facing: Facing, dx: number, dy: number) => {
  switch (facing) {
    case "north":
      return { x: dx, y: -dy };
    case "east":
      return { x: dy, y: dx };
    case "south":
      return { x: -dx, y: dy };
    case "west":
      return { x: -dy, y: -dx };
  }
};

const toLocalDelta = (facing: Facing, deltaX: number, deltaY: number) => {
  switch (facing) {
    case "north":
      return { dx: deltaX, dy: -deltaY };
    case "east":
      return { dx: deltaY, dy: deltaX };
    case "south":
      return { dx: -deltaX, dy: deltaY };
    case "west":
      return { dx: -deltaY, dy: -deltaX };
  }
};

const turnFacing = (facing: Facing, direction: TurnDirection): Facing => {
  const order: readonly Facing[] = ["north", "east", "south", "west"];
  const index = order.indexOf(facing);
  const nextIndex = direction === "right" ? (index + 1) % order.length : (index + order.length - 1) % order.length;
  return order[nextIndex]!;
};

const moveDeltaForDirection = (facing: Facing, direction: MoveDirection) => {
  switch (direction) {
    case "forward":
      return toWorldDelta(facing, 0, 1);
    case "backward":
      return toWorldDelta(facing, 0, -1);
    case "left":
      return toWorldDelta(facing, -1, 0);
    case "right":
      return toWorldDelta(facing, 1, 0);
  }
};

const clipObservationText = (value: string, maxLength: number) => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const simulateMoveStep = (world: WorldState, entity: EntityState, direction: MoveDirection) => {
  const delta = moveDeltaForDirection(entity.facing, direction);
  const targetX = entity.gridX + delta.x;
  const targetY = entity.gridY + delta.y;
  if (!isInsideGrid(world, targetX, targetY, 0)) {
    return `${direction}:edge`;
  }

  const targetStandZ = highestSolidZ(world, targetX, targetY) + 1;
  if (targetStandZ < 1 || targetStandZ >= world.gridHeight) {
    return `${direction}:void`;
  }
  if (Math.abs(targetStandZ - entity.gridZ) > 1) {
    return `${direction}:steep`;
  }

  return `${direction}:ok@(${targetX},${targetY},${targetStandZ})`;
};

const buildReachableCells = (world: WorldState, entity: EntityState): ReachableCell[] => {
  const baseSurfaceZ = entity.gridZ - 1;
  const cells: ReachableCell[] = [];

  for (const dx of REACH_DX) {
    for (const dy of REACH_DY) {
      for (const dz of REACH_DZ) {
        const worldDelta = toWorldDelta(entity.facing, dx, dy);
        const targetX = entity.gridX + worldDelta.x;
        const targetY = entity.gridY + worldDelta.y;
        const targetZ = baseSurfaceZ + dz;
        if (!isInsideGrid(world, targetX, targetY, targetZ)) {
          continue;
        }
        const current = getBlock(world, targetX, targetY, targetZ) ?? "empty";
        const supported = targetZ === 0 || Boolean(getBlock(world, targetX, targetY, targetZ - 1));
        cells.push({ dx, dy, dz, current, supported });
      }
    }
  }

  return cells;
};

const inspectPatchText = (world: WorldState, entity: EntityState, reachableCells: readonly ReachableCell[]) => {
  const counts = countBuiltBlocks(world);
  const beaconsText = formatBeaconObservation(world, entity);
  return [
    `self=(${entity.gridX},${entity.gridY},${entity.gridZ}) facing=${entity.facing}`,
    `built_counts=stone:${counts.stone} wood:${counts.wood} glass:${counts.glass}`,
    `beacons=${beaconsText || "none"}`,
    `reachable_cells=${reachableCells
      .map((cell) => `(${cell.dx},${cell.dy},${cell.dz})=${cell.current}:${cell.supported ? "supported" : "floating"}`)
      .join(" | ")}`,
  ].join("\n");
};

const formatCellList = (cells: readonly ReachableCell[], includeType = false) =>
  cells
    .map((cell) =>
      includeType
        ? `(${cell.dx},${cell.dy},${cell.dz})=${cell.current}`
        : `(${cell.dx},${cell.dy},${cell.dz})`,
    )
    .join(" | ");

const sortCellsForBuild = (cells: readonly ReachableCell[]) =>
  [...cells].sort(
    (left, right) => left.dy - right.dy || Math.abs(left.dx) - Math.abs(right.dx) || left.dx - right.dx || left.dz - right.dz,
  );

const buildObjectiveHint = (objective: string) => {
  const normalized = objective.toLowerCase();
  if (/(row|line)\b/.test(normalized)) {
    return "For a row, place only on empty supported cells at dz=1. After a successful placement, move or choose a different empty supported cell.";
  }
  if (/\b(2x2|square|pad|platform)\b/.test(normalized)) {
    return "For a pad, fill adjacent empty supported cells at dz=1. Do not stack upward unless the objective asks for height.";
  }
  if (/\b(tower|column|pillar|stack)\b/.test(normalized)) {
    return "For a tower, keep one local (dx,dy) and increase dz upward through supported cells.";
  }
  if (/\b(remove|clear|delete)\b/.test(normalized)) {
    return "For removal, use only removable_cells. Do not target grass.";
  }
  return "Use only buildable_cells for place_block and removable_cells for remove_block.";
};

const isBuilderOccupiedLocalCell = (cell: Pick<ReachableCell, "dx" | "dy" | "dz">) => cell.dx === 0 && cell.dy === 0 && cell.dz === 1;

export const createInitialWorld = (): WorldState => {
  const world: WorldState = {
    gridWidth: GRID_WIDTH,
    gridDepth: GRID_DEPTH,
    gridHeight: GRID_HEIGHT,
    blocks: {},
    beacons: {},
    entities: {
      builder: {
        id: "builder",
        name: "Builder",
        color: "#f97316",
        prompt: "",
        visibleThought: "Awaiting an objective.",
        status: "paused",
        gridX: 4,
        gridY: 6,
        gridZ: 1,
        facing: "east",
        paused: true,
        memorySummary: "No objective yet.",
        lastObservation: "Paused at launch.",
        recentEvents: ["Paused at launch."],
        thread: [],
        traces: [],
        objectiveRevision: 0,
      },
    },
    metrics: {
      totalPhysicsTicks: 0,
      totalBrainTurns: 0,
      physicsTickTimestamps: [],
      brainTurnTimestamps: [],
      brainLatenciesMs: [],
      completionTokenRates: [],
    },
  };

  for (let x = 0; x < world.gridWidth; x += 1) {
    for (let y = 0; y < world.gridDepth; y += 1) {
      setBlock(world, x, y, 0, "grass");
    }
  }

  for (const entityId of Object.keys(world.entities)) {
    const observation = buildObservation(world, entityId);
    world.entities[entityId]!.lastViewportImageDataUrl = observation.viewportImageDataUrl;
  }

  return world;
};

export const listEntityIds = (world: WorldState) => Object.keys(world.entities);

export const tickPhysics = (world: WorldState) => {
  const next = structuredClone(world);
  const now = Date.now();
  next.metrics.totalPhysicsTicks += 1;
  next.metrics.physicsTickTimestamps = pruneSamples([...next.metrics.physicsTickTimestamps, now], now);

  for (const entity of Object.values(next.entities)) {
    if (entity.paused) {
      entity.status = "paused";
    } else if (entity.status !== "thinking") {
      entity.status = "idle";
    }
  }

  return next;
};

export const buildObservation = (world: WorldState, entityId: string): ViewObservation => {
  const entity = getEntityOrThrow(world, entityId);
  const reachableCells = buildReachableCells(world, entity);
  const builtCounts = countBuiltBlocks(world);
  const inspectText = inspectPatchText(world, entity, reachableCells);
  const beaconsText = formatBeaconObservation(world, entity);
  const moveOptions = (["forward", "backward", "left", "right"] as const).map((direction) => simulateMoveStep(world, entity, direction)).join(" | ");
  const buildableCells = sortCellsForBuild(
    reachableCells.filter(
      (cell) => cell.dz >= 1 && cell.current === "empty" && cell.supported && !isBuilderOccupiedLocalCell(cell),
    ),
  ).slice(0, 12);
  const blockedPlaceCells = sortCellsForBuild(
    reachableCells.filter((cell) => cell.dz >= 1 && cell.current !== "empty"),
  ).slice(0, 8);
  const removableCells = sortCellsForBuild(
    reachableCells.filter((cell) => cell.current !== "empty" && cell.current !== "grass"),
  ).slice(0, 8);
  const promptText = [
    `self=pos(${entity.gridX},${entity.gridY},${entity.gridZ}) facing=${entity.facing}`,
    `built_counts=stone:${builtCounts.stone} wood:${builtCounts.wood} glass:${builtCounts.glass} total=${builtCounts.stone + builtCounts.wood + builtCounts.glass}`,
    `beacons=${beaconsText || "none"}`,
    `viewport_markers=${beaconsText || "none"}`,
    `objective_hint=${buildObjectiveHint(entity.prompt)}`,
    `buildable_cells=${formatCellList(buildableCells) || "none"}`,
    `blocked_place_cells=${formatCellList(blockedPlaceCells, true) || "none"}`,
    `removable_cells=${formatCellList(removableCells, true) || "none"}`,
    `move_options=${moveOptions}`,
    `last=${clipObservationText(entity.lastActionResult ?? "none", 140)}`,
    `recent=${clipObservationText(entity.recentEvents.slice(0, 2).join(" | ") || "none", 120)}`,
  ].join("\n");

  return {
    promptText,
    inspectText,
    viewportImageDataUrl: renderViewportPngDataUrl({
      gridWidth: world.gridWidth,
      gridDepth: world.gridDepth,
      gridHeight: world.gridHeight,
      blocks: Object.entries(world.blocks).map(([key, type]) => {
        const { x, y, z } = parseBlockKey(key);
        return { x, y, z, type } satisfies BlockSnapshot;
      }),
      beacons: beaconList(world).map((beacon, index) => ({
        x: beacon.x,
        y: beacon.y,
        label: beacon.label,
        marker: index + 1,
      })),
      entity: {
        x: entity.gridX,
        y: entity.gridY,
        z: entity.gridZ,
        facing: entity.facing,
        color: entity.color,
      },
    }),
    self: {
      x: entity.gridX,
      y: entity.gridY,
      z: entity.gridZ,
      facing: entity.facing,
    },
    builtCounts,
    reachableCells,
  };
};

export const scheduleThinking = (world: WorldState, entityId: string, observation: ViewObservation) => {
  const next = structuredClone(world);
  const entity = getEntity(next, entityId);
  if (!entity || entity.paused) {
    return next;
  }
  entity.status = "thinking";
  entity.lastObservation = observation.promptText;
  entity.lastViewportImageDataUrl = observation.viewportImageDataUrl;
  return next;
};

const tryMoveStep = (world: WorldState, entity: EntityState, direction: MoveDirection) => {
  const delta = moveDeltaForDirection(entity.facing, direction);
  const targetX = entity.gridX + delta.x;
  const targetY = entity.gridY + delta.y;
  if (!isInsideGrid(world, targetX, targetY, 0)) {
    return `Move blocked: ${direction} would leave the build plate.`;
  }

  const targetStandZ = highestSolidZ(world, targetX, targetY) + 1;
  if (targetStandZ < 1 || targetStandZ >= world.gridHeight) {
    return `Move blocked: ${direction} has no valid standing surface.`;
  }
  if (Math.abs(targetStandZ - entity.gridZ) > 1) {
    return `Move blocked: ${direction} is too steep from z${entity.gridZ} to z${targetStandZ}.`;
  }

  entity.gridX = targetX;
  entity.gridY = targetY;
  entity.gridZ = targetStandZ;
  return `Moved ${direction} to (${entity.gridX},${entity.gridY},${entity.gridZ}).`;
};

const resolveTargetBlock = (world: WorldState, entity: EntityState, dx: number, dy: number, dz: number) => {
  const baseSurfaceZ = entity.gridZ - 1;
  const worldDelta = toWorldDelta(entity.facing, dx, dy);
  const targetX = entity.gridX + worldDelta.x;
  const targetY = entity.gridY + worldDelta.y;
  const targetZ = baseSurfaceZ + dz;
  if (!isInsideGrid(world, targetX, targetY, targetZ)) {
    return undefined;
  }
  return { x: targetX, y: targetY, z: targetZ };
};

export const executeTool = (world: WorldState, entityId: string, invocation: ToolInvocation) => {
  const next = structuredClone(world);
  const entity = getEntity(next, entityId);
  if (!entity) {
    return { world: next, result: `Unknown entity: ${entityId}` };
  }

  if (
    invocation.name === "place_block" &&
    sameToolCall(entity.lastToolCall, invocation) &&
    entity.lastActionResult?.startsWith("Place blocked:")
  ) {
    const result = "Place blocked: repeated identical placement suppressed. Inspect or choose a different local cell.";
    entity.lastActionResult = result;
    pushEvent(entity, result);
    return { world: next, result };
  }

  entity.lastToolCall = { name: invocation.name, args: invocation.args };

  switch (invocation.name) {
    case "inspect_patch": {
      const observation = buildObservation(next, entityId);
      entity.lastActionResult = observation.inspectText;
      entity.lastViewportImageDataUrl = observation.viewportImageDataUrl;
      pushEvent(entity, "Inspected the local build patch.");
      return { world: next, result: observation.inspectText };
    }

    case "turn": {
      entity.facing = turnFacing(entity.facing, invocation.args.direction);
      entity.status = "moving";
      entity.lastActionResult = `Turned ${invocation.args.direction}; now facing ${entity.facing}.`;
      pushEvent(entity, entity.lastActionResult);
      return { world: next, result: entity.lastActionResult };
    }

    case "move": {
      const steps = Math.max(1, Math.min(2, Math.round(invocation.args.steps)));
      let result = `Move ${invocation.args.direction} failed.`;
      for (let step = 0; step < steps; step += 1) {
        result = tryMoveStep(next, entity, invocation.args.direction);
        if (result.startsWith("Move blocked")) {
          break;
        }
      }
      entity.status = "moving";
      entity.lastActionResult = result;
      pushEvent(entity, result);
      return { world: next, result };
    }

    case "place_block": {
      const target = resolveTargetBlock(
        next,
        entity,
        Math.max(-1, Math.min(1, Math.round(invocation.args.dx))),
        Math.max(0, Math.min(3, Math.round(invocation.args.dy))),
        Math.max(1, Math.min(3, Math.round(invocation.args.dz))),
      );
      if (!target) {
        const result = "Place blocked: target is outside the build plate.";
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }
      if (getBlock(next, target.x, target.y, target.z)) {
        const result = `Place blocked: (${target.x},${target.y},${target.z}) is already occupied.`;
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }
      if (target.x === entity.gridX && target.y === entity.gridY && target.z === entity.gridZ) {
        const result = "Place blocked: cannot place a block inside the builder.";
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }
      if (target.z > 0 && !getBlock(next, target.x, target.y, target.z - 1)) {
        const result = `Place blocked: (${target.x},${target.y},${target.z}) has no support below.`;
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }

      setBlock(next, target.x, target.y, target.z, invocation.args.blockType);
      entity.status = "moving";
      entity.lastActionResult = `Placed ${invocation.args.blockType} at (${target.x},${target.y},${target.z}).`;
      pushEvent(entity, entity.lastActionResult);
      return { world: next, result: entity.lastActionResult };
    }

    case "remove_block": {
      const target = resolveTargetBlock(
        next,
        entity,
        Math.max(-1, Math.min(1, Math.round(invocation.args.dx))),
        Math.max(0, Math.min(3, Math.round(invocation.args.dy))),
        Math.max(0, Math.min(3, Math.round(invocation.args.dz))),
      );
      if (!target) {
        const result = "Remove blocked: target is outside the build plate.";
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }
      const blockType = getBlock(next, target.x, target.y, target.z);
      if (!blockType || blockType === "grass") {
        const result = `Remove blocked: (${target.x},${target.y},${target.z}) has no removable block.`;
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }
      if (target.x === entity.gridX && target.y === entity.gridY && target.z === entity.gridZ - 1) {
        const result = "Remove blocked: cannot remove the support block beneath the builder.";
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }

      removeBlock(next, target.x, target.y, target.z);
      entity.status = "moving";
      entity.lastActionResult = `Removed ${blockType} at (${target.x},${target.y},${target.z}).`;
      pushEvent(entity, entity.lastActionResult);
      entity.gridZ = highestSolidZ(next, entity.gridX, entity.gridY) + 1;
      return { world: next, result: entity.lastActionResult };
    }
  }
};

export const applyBrainResult = (world: WorldState, entityId: string, result: BrainResult) => {
  const next = structuredClone(world);
  const entity = getEntity(next, entityId);
  if (!entity) {
    return next;
  }

  if (result.objectiveRevision !== entity.objectiveRevision) {
    return next;
  }

  const now = Date.now();
  next.metrics.totalBrainTurns += 1;
  next.metrics.brainTurnTimestamps = pruneSamples([...next.metrics.brainTurnTimestamps, now], now);
  next.metrics.brainLatenciesMs = limitSample([...next.metrics.brainLatenciesMs, result.latencyMs]);
  if (result.completionTokensPerSecond !== undefined) {
    next.metrics.completionTokenRates = limitSample([...next.metrics.completionTokenRates, result.completionTokensPerSecond]);
  }

  entity.visibleThought = clipThought(result.thought);
  if (result.toolCall) {
    entity.lastToolCall = { name: result.toolCall.name, args: result.toolCall.args };
  } else {
    delete entity.lastToolCall;
  }
  if (result.toolResult !== undefined) {
    entity.lastActionResult = result.toolResult;
  }
  entity.status = entity.paused ? "paused" : "idle";
  appendThreadEntries(entity, result.threadEntries);
  pushTrace(entity, {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    mode: result.mode,
    promptText: result.requestTranscriptText,
    rawModelOutput: result.rawModelOutput,
    thought: entity.visibleThought,
    actionName: result.toolCall?.name ?? "wait",
    ...(result.toolCall ? { actionArgs: result.toolCall.args } : {}),
    ...(result.toolResult !== undefined ? { actionResult: result.toolResult } : {}),
    ...(result.viewportImageDataUrl ? { viewportImageDataUrl: result.viewportImageDataUrl } : {}),
    latencyMs: result.latencyMs,
    ...(result.completionTokens !== undefined ? { completionTokens: result.completionTokens } : {}),
    ...(result.completionTokensPerSecond !== undefined ? { completionTokensPerSecond: result.completionTokensPerSecond } : {}),
  });
  return next;
};

export const markBrainFailure = (world: WorldState, entityId: string, message: string) => {
  const next = structuredClone(world);
  const entity = getEntity(next, entityId);
  if (!entity) {
    return next;
  }
  entity.status = "error";
  entity.visibleThought = clipThought(`Error: ${message}`);
  entity.lastActionResult = message;
  pushEvent(entity, `Brain error: ${message}`);
  return next;
};

export const patchEntity = (
  world: WorldState,
  entityId: string,
  patch: { prompt?: string; paused?: boolean; resetThread?: boolean },
) => {
  const next = structuredClone(world);
  const entity = getEntity(next, entityId);
  if (!entity) {
    return { world: next, updated: false };
  }

  if (patch.prompt !== undefined) {
    const nextPrompt = patch.prompt.trim();
    if (nextPrompt !== entity.prompt) {
      entity.prompt = nextPrompt;
      entity.objectiveRevision += 1;
      entity.thread = [];
      entity.memorySummary = "Operator objective changed. Start from the new objective and current observation only.";
      entity.lastActionResult = "Objective updated from UI. Previous short-term thread cleared.";
      entity.status = entity.paused ? "paused" : "idle";
      entity.visibleThought = nextPrompt.length > 0 ? entity.visibleThought : "Awaiting an objective.";
      pushEvent(entity, "Objective updated from UI.");
    }
  }

  if (patch.paused !== undefined) {
    entity.paused = patch.paused;
    entity.status = patch.paused ? "paused" : "idle";
    pushEvent(entity, patch.paused ? "Paused from debug UI." : "Resumed from debug UI.");
  }

  if (patch.resetThread) {
    entity.thread = [];
    entity.memorySummary = "Thread reset from debug UI. No compressed history retained.";
    entity.lastActionResult = "Thread reset from UI. Awaiting the next objective step.";
    pushEvent(entity, "Thread reset from debug UI.");
  }

  return { world: next, updated: true };
};

export const upsertBeacon = (world: WorldState, input: { x: number; y: number; label: string }) => {
  const next = structuredClone(world);
  const x = Math.max(0, Math.min(next.gridWidth - 1, Math.round(input.x)));
  const y = Math.max(0, Math.min(next.gridDepth - 1, Math.round(input.y)));
  const label = input.label.trim().slice(0, 32);

  const existing = Object.values(next.beacons).find((beacon) => beacon.x === x && beacon.y === y);
  if (label.length === 0) {
    if (existing) {
      delete next.beacons[existing.id];
    }
    return { world: next, updated: true };
  }

  const normalized = label.replace(/\s+/g, " ");
  const beaconId = existing?.id ?? `beacon-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  next.beacons[beaconId] = {
    id: beaconId,
    x,
    y,
    label: normalized,
  };
  return { world: next, updated: true };
};

export const removeBeacon = (world: WorldState, beaconId: string) => {
  const next = structuredClone(world);
  if (!next.beacons[beaconId]) {
    return { world: next, updated: false };
  }
  delete next.beacons[beaconId];
  return { world: next, updated: true };
};

export const worldSnapshot = (world: WorldState, llm: LlmStatus): WorldSnapshot => {
  const physicsTicksPerSecond = Number((world.metrics.physicsTickTimestamps.length / (PHYSICS_WINDOW_MS / 1000)).toFixed(2));
  const brainTurnsPerSecond = Number((world.metrics.brainTurnTimestamps.length / (PHYSICS_WINDOW_MS / 1000)).toFixed(2));
  const averageBrainLatencyMs =
    world.metrics.brainLatenciesMs.length > 0
      ? Number((world.metrics.brainLatenciesMs.reduce((sum, value) => sum + value, 0) / world.metrics.brainLatenciesMs.length).toFixed(1))
      : 0;
  const averageCompletionTokensPerSecond =
    world.metrics.completionTokenRates.length > 0
      ? Number((world.metrics.completionTokenRates.reduce((sum, value) => sum + value, 0) / world.metrics.completionTokenRates.length).toFixed(2))
      : 0;

  const entities: EntitySnapshot[] = Object.values(world.entities).map((entity) => ({
    id: entity.id,
    name: entity.name,
    color: entity.color,
    prompt: entity.prompt,
    visibleThought: entity.visibleThought,
    status: entity.status,
    gridX: entity.gridX,
    gridY: entity.gridY,
    gridZ: entity.gridZ,
    facing: entity.facing,
    paused: entity.paused,
    memorySummary: entity.memorySummary,
    lastObservation: entity.lastObservation,
    recentEvents: entity.recentEvents,
    threadLength: entity.thread.length,
    traces: entity.traces,
    ...(entity.lastToolCall ? { lastToolCall: entity.lastToolCall } : {}),
    ...(entity.lastActionResult ? { lastActionResult: entity.lastActionResult } : {}),
    ...(entity.lastViewportImageDataUrl ? { lastViewportImageDataUrl: entity.lastViewportImageDataUrl } : {}),
  }));

  const blocks: BlockSnapshot[] = Object.entries(world.blocks).map(([key, type]) => {
    const { x, y, z } = parseBlockKey(key);
    return { x, y, z, type };
  });

  const beacons: BeaconSnapshot[] = beaconList(world).map((beacon) => ({
    id: beacon.id,
    x: beacon.x,
    y: beacon.y,
    label: beacon.label,
  }));

  return {
    generatedAt: Date.now(),
    gridWidth: world.gridWidth,
    gridDepth: world.gridDepth,
    gridHeight: world.gridHeight,
    blocks,
    beacons,
    entities,
    llm,
    metrics: {
      totalPhysicsTicks: world.metrics.totalPhysicsTicks,
      physicsTicksPerSecond,
      totalBrainTurns: world.metrics.totalBrainTurns,
      brainTurnsPerSecond,
      averageBrainLatencyMs,
      averageCompletionTokensPerSecond,
    },
  };
};
