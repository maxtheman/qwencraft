import { Ref } from "effect";
import type {
  BrainTraceSnapshot,
  Direction,
  EntitySnapshot,
  EntityStatus,
  ToolRecord,
  WorldSnapshot,
} from "../shared/contracts";
import type { LlmStatus } from "./lmstudio";
import { renderViewportPngDataUrl } from "./viewport";

export type ThreadMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
};

type Obstacle = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type WalkIntent = {
  kind: "walk";
  direction: Direction;
  remaining: number;
};

type JumpIntent = {
  kind: "jump";
  direction: Direction;
  remaining: number;
  strength: number;
  launched: boolean;
};

type MoveIntent = WalkIntent | JumpIntent;

type EntityState = {
  id: string;
  name: string;
  color: string;
  prompt: string;
  visibleThought: string;
  status: EntityStatus;
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  onGround: boolean;
  paused: boolean;
  lastBrainSampleX: number;
  lastBrainSampleY: number;
  memorySummary: string;
  lastObservation: string;
  lastToolCall?: ToolRecord;
  lastActionResult?: string;
  lastViewportImageDataUrl?: string;
  targetEntityId?: string;
  recentEvents: string[];
  thread: ThreadMessage[];
  traces: BrainTraceSnapshot[];
  intent?: MoveIntent;
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
  width: number;
  height: number;
  floorY: number;
  obstacles: Obstacle[];
  entities: Record<string, EntityState>;
  metrics: MetricsState;
};

type RayObstacleHint = {
  direction: Direction;
  distance: number;
  height: number;
  jumpRecommended: boolean;
};

export type VisibleEntity = {
  id: string;
  name: string;
  distance: number;
  direction: Direction;
  lineOfSight: boolean;
};

export type ViewObservation = {
  promptText: string;
  visibleEntities: VisibleEntity[];
  obstacleHints: RayObstacleHint[];
  urgentHints: string[];
  viewportImageDataUrl: string;
};

export type ToolInvocation =
  | { name: "inspect_view"; args: Record<string, never> }
  | { name: "move"; args: { direction: Direction; distance: number } }
  | { name: "jump"; args: { direction: Direction; distance: number; strength: number } }
  | { name: "approach_entity"; args: { entityId: string; stopWithin: number } };

export type BrainResult = {
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
const WALK_SPEED = 130;
const AIR_SPEED = 110;
const GRAVITY = 780;
const DEFAULT_WIDTH = 1100;
const DEFAULT_HEIGHT = 420;
const DEFAULT_FLOOR_Y = 360;
const VIEWPORT_WORLD_WIDTH = 420;
const VIEWPORT_WORLD_HEIGHT = 240;
const THREAD_MESSAGE_LIMIT = 8;
const MEMORY_SUMMARY_LIMIT = 320;
const ROOM_FRAME_INSET = 18;
const ROOM_CONTENT_PADDING = 12;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const clipThought = (value: string) => {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 88) {
    return compact || "Waiting for a better angle.";
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

  const interestingLines = compact
    .split(/(?=urgent=|visible=|obstacles=|last=|repeat_warning=)/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(" | ");
  return `user:${(interestingLines || compact).slice(0, 120)}`;
};

const mergeCompressedMemory = (existing: string, droppedMessages: readonly ThreadMessage[]) => {
  if (droppedMessages.length === 0) {
    return clipMemory(existing) || "No summary yet.";
  }

  const existingSegments = existing
    .split(" || ")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const nextSegments = [
    ...existingSegments,
    ...droppedMessages.map(summarizeDroppedThreadMessage),
  ];
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

const entityRect = (entity: Pick<EntityState, "x" | "y" | "width" | "height">) => ({
  left: entity.x - entity.width / 2,
  right: entity.x + entity.width / 2,
  top: entity.y - entity.height,
  bottom: entity.y,
});

const rectsOverlap = (
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number },
) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

const obstacleRect = (obstacle: Obstacle) => ({
  left: obstacle.x,
  right: obstacle.x + obstacle.width,
  top: obstacle.y,
  bottom: obstacle.y + obstacle.height,
});

const resolveHorizontal = (entity: EntityState, dx: number, obstacles: Obstacle[]) => {
  if (dx === 0) {
    return { x: entity.x, blocked: false };
  }

  const next = { ...entity, x: entity.x + dx };
  const nextRect = entityRect(next);

  for (const obstacle of obstacles) {
    if (rectsOverlap(nextRect, obstacleRect(obstacle))) {
      return { x: entity.x, blocked: true };
    }
  }

  return { x: entity.x + dx, blocked: false };
};

const resolveVertical = (entity: EntityState, dy: number, obstacles: Obstacle[], floorY: number) => {
  let nextY = entity.y + dy;
  let onGround = false;
  let hitCeiling = false;
  const currentRect = entityRect(entity);
  const nextRect = entityRect({ ...entity, y: nextY });

  if (dy >= 0 && nextY >= floorY) {
    return { y: floorY, onGround: true, hitCeiling: false };
  }

  let landingY: number | undefined;
  let ceilingY: number | undefined;

  for (const obstacle of obstacles) {
    const rect = obstacleRect(obstacle);
    if (!rectsOverlap(nextRect, rect)) {
      continue;
    }

    if (dy > 0 && currentRect.bottom <= rect.top) {
      const candidate = rect.top;
      if (landingY === undefined || candidate < landingY) {
        landingY = candidate;
        onGround = true;
      }
    } else if (dy < 0 && currentRect.top >= rect.bottom) {
      const candidate = rect.bottom + entity.height;
      if (ceilingY === undefined || candidate > ceilingY) {
        ceilingY = candidate;
        hitCeiling = true;
      }
    }
  }

  if (landingY !== undefined) {
    nextY = landingY;
  } else if (ceilingY !== undefined) {
    nextY = ceilingY;
  }

  return { y: nextY, onGround, hitCeiling };
};

const ccw = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);

const segmentsIntersect = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
) => ccw(ax, ay, cx, cy, dx, dy) !== ccw(bx, by, cx, cy, dx, dy) && ccw(ax, ay, bx, by, cx, cy) !== ccw(ax, ay, bx, by, dx, dy);

const pointInRect = (x: number, y: number, rect: ReturnType<typeof obstacleRect>) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

const lineIntersectsRect = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  obstacle: Obstacle,
) => {
  const rect = obstacleRect(obstacle);
  if (pointInRect(ax, ay, rect) || pointInRect(bx, by, rect)) {
    return true;
  }

  const edges: Array<[number, number, number, number]> = [
    [rect.left, rect.top, rect.right, rect.top],
    [rect.right, rect.top, rect.right, rect.bottom],
    [rect.right, rect.bottom, rect.left, rect.bottom],
    [rect.left, rect.bottom, rect.left, rect.top],
  ];

  return edges.some(([cx, cy, dx, dy]) => segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy));
};

const findNearestObstacle = (entity: EntityState, direction: Direction, obstacles: Obstacle[]): RayObstacleHint | undefined => {
  const rect = entityRect(entity);
  const candidates = obstacles
    .map((obstacle) => {
      const obsRect = obstacleRect(obstacle);
      const verticalOverlap = obsRect.bottom > rect.top && obsRect.top < rect.bottom;
      if (!verticalOverlap) {
        return undefined;
      }

      if (direction === "right" && obsRect.left >= rect.right) {
        return {
          direction,
          distance: Math.round(obsRect.left - rect.right),
          height: obstacle.height,
          jumpRecommended: obstacle.height <= 120,
        };
      }

      if (direction === "left" && obsRect.right <= rect.left) {
        return {
          direction,
          distance: Math.round(rect.left - obsRect.right),
          height: obstacle.height,
          jumpRecommended: obstacle.height <= 120,
        };
      }

      return undefined;
    })
    .filter((candidate): candidate is RayObstacleHint => Boolean(candidate))
    .sort((a, b) => a.distance - b.distance);

  return candidates[0];
};

const buildViewportImageDataUrl = (world: WorldState, entityId: string) => {
  const entity = getEntityOrThrow(world, entityId);
  const cameraLeft = clamp(entity.x - VIEWPORT_WORLD_WIDTH / 2, 0, world.width - VIEWPORT_WORLD_WIDTH);
  const cameraTop = clamp(entity.y - entity.height - VIEWPORT_WORLD_HEIGHT / 2, 0, world.height - VIEWPORT_WORLD_HEIGHT);

  return renderViewportPngDataUrl({
    worldWidth: world.width,
    worldHeight: world.height,
    floorY: world.floorY,
    cameraLeft,
    cameraTop,
    cameraWidth: VIEWPORT_WORLD_WIDTH,
    cameraHeight: VIEWPORT_WORLD_HEIGHT,
    obstacles: world.obstacles,
    entities: Object.values(world.entities)
      .filter((candidate) => {
        const left = candidate.x - candidate.width / 2;
        const right = candidate.x + candidate.width / 2;
        const top = candidate.y - candidate.height;
        const bottom = candidate.y;
        return (
          right >= cameraLeft &&
          left <= cameraLeft + VIEWPORT_WORLD_WIDTH &&
          bottom >= cameraTop &&
          top <= cameraTop + VIEWPORT_WORLD_HEIGHT
        );
      })
      .map((candidate) => ({
        id: candidate.id,
        x: candidate.x,
        y: candidate.y,
        width: candidate.width,
        height: candidate.height,
        color: candidate.color,
        isSelf: candidate.id === entityId,
      })),
  });
};

export const createInitialWorld = (): WorldState => {
  const world: WorldState = {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    floorY: DEFAULT_FLOOR_Y,
    obstacles: [
      { id: "block-a", x: 290, y: 296, width: 92, height: 64 },
      { id: "pillar-b", x: 615, y: 250, width: 74, height: 110 },
      { id: "platform-c", x: 800, y: 230, width: 140, height: 18 },
    ],
    entities: {
      alpha: {
        id: "alpha",
        name: "Alpha",
        color: "#f97316",
        prompt:
          "You are Alpha, a practical scout. Prefer closing distance to visible entities and narrate brief tactical thoughts.",
        visibleThought: "Spinning up.",
        status: "idle",
        x: 120,
        y: DEFAULT_FLOOR_Y,
        width: 28,
        height: 40,
        vx: 0,
        vy: 0,
        onGround: true,
        paused: false,
        lastBrainSampleX: 120,
        lastBrainSampleY: DEFAULT_FLOOR_Y,
        memorySummary: "Alpha starts near the left wall.",
        lastObservation: "Booting simulation.",
        recentEvents: ["Booted into the habitat room."],
        thread: [],
        traces: [],
      },
      bravo: {
        id: "bravo",
        name: "Bravo",
        color: "#38bdf8",
        prompt:
          "You are Bravo, a curious analyst. Inspect the space, keep an eye on Alpha, and prefer line-of-sight positioning.",
        visibleThought: "Watching the room.",
        status: "idle",
        x: 880,
        y: DEFAULT_FLOOR_Y,
        width: 28,
        height: 40,
        vx: 0,
        vy: 0,
        onGround: true,
        paused: false,
        lastBrainSampleX: 880,
        lastBrainSampleY: DEFAULT_FLOOR_Y,
        memorySummary: "Bravo starts near the right side of the room.",
        lastObservation: "Booting simulation.",
        recentEvents: ["Sensor suite online."],
        thread: [],
        traces: [],
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

  for (const entityId of Object.keys(world.entities)) {
    world.entities[entityId]!.lastViewportImageDataUrl = buildViewportImageDataUrl(world, entityId);
  }

  return world;
};

export const listEntityIds = (world: WorldState) => Object.keys(world.entities);

export const tickPhysics = (world: WorldState) => {
  const next = structuredClone(world);
  const now = Date.now();
  next.metrics.totalPhysicsTicks += 1;
  next.metrics.physicsTickTimestamps = pruneSamples([...next.metrics.physicsTickTimestamps, now], now);
  const roomLeft = ROOM_FRAME_INSET + ROOM_CONTENT_PADDING;
  const roomRight = next.width - ROOM_FRAME_INSET - ROOM_CONTENT_PADDING;
  const roomCeiling = ROOM_FRAME_INSET + ROOM_CONTENT_PADDING;

  for (const entity of Object.values(next.entities)) {
    if (entity.paused) {
      entity.status = "paused";
      entity.vx = 0;
      continue;
    }

    if (!entity.onGround || entity.intent?.kind === "jump") {
      entity.vy += GRAVITY * 0.05;
    }

    let horizontalStep = 0;
    if (entity.intent?.kind === "walk") {
      const maxStep = WALK_SPEED * 0.05;
      horizontalStep = Math.min(entity.intent.remaining, maxStep) * (entity.intent.direction === "right" ? 1 : -1);
      entity.intent.remaining = Math.max(0, entity.intent.remaining - Math.abs(horizontalStep));
      entity.status = "moving";
    } else if (entity.intent?.kind === "jump") {
      if (!entity.intent.launched && entity.onGround) {
        entity.vy = -entity.intent.strength;
        entity.onGround = false;
        entity.intent.launched = true;
        pushEvent(entity, `Jumped ${entity.intent.direction}.`);
      }
      const maxStep = AIR_SPEED * 0.05;
      horizontalStep = Math.min(entity.intent.remaining, maxStep) * (entity.intent.direction === "right" ? 1 : -1);
      entity.intent.remaining = Math.max(0, entity.intent.remaining - Math.abs(horizontalStep));
      entity.status = "moving";
    }

    if (horizontalStep !== 0) {
      const horizontal = resolveHorizontal(entity, horizontalStep, next.obstacles);
      if (horizontal.blocked) {
        delete entity.intent;
        entity.status = "idle";
        entity.lastActionResult = "Movement blocked by nearby geometry.";
        pushEvent(entity, "Movement blocked by an obstacle.");
      } else {
        entity.x = clamp(horizontal.x, roomLeft + entity.width / 2, roomRight - entity.width / 2);
      }
    }

    const vertical = resolveVertical(entity, entity.vy * 0.05, next.obstacles, next.floorY);
    entity.y = Math.max(vertical.y, roomCeiling + entity.height);
    if (vertical.onGround) {
      entity.onGround = true;
      entity.vy = 0;
      if (entity.intent?.kind === "jump" && entity.intent.remaining <= 0) {
        delete entity.intent;
        entity.status = "idle";
      }
    } else {
      entity.onGround = false;
      if (vertical.hitCeiling) {
        entity.vy = 0;
      }
    }

    if (entity.intent?.kind === "walk" && entity.intent.remaining <= 0) {
      delete entity.intent;
      entity.status = "idle";
    }

    entity.x = clamp(entity.x, roomLeft + entity.width / 2, roomRight - entity.width / 2);

    if (!entity.intent && entity.status !== "thinking") {
      entity.status = "idle";
    }
  }

  return next;
};

export const buildObservation = (world: WorldState, entityId: string): ViewObservation => {
  const entity = getEntityOrThrow(world, entityId);
  const selfCenterX = entity.x;
  const selfCenterY = entity.y - entity.height / 2;
  const progressDx = Math.round(entity.x - entity.lastBrainSampleX);
  const progressDy = Math.round(entity.y - entity.lastBrainSampleY);
  const viewportImageDataUrl = buildViewportImageDataUrl(world, entityId);

  const visibleEntities = Object.values(world.entities)
    .filter((candidate) => candidate.id !== entityId)
    .map((candidate) => {
      const targetCenterX = candidate.x;
      const targetCenterY = candidate.y - candidate.height / 2;
      const lineOfSight = !world.obstacles.some((obstacle) =>
        lineIntersectsRect(selfCenterX, selfCenterY, targetCenterX, targetCenterY, obstacle),
      );
      return {
        id: candidate.id,
        name: candidate.name,
        distance: Math.round(Math.abs(candidate.x - entity.x)),
        direction: candidate.x >= entity.x ? "right" : "left",
        lineOfSight,
      } satisfies VisibleEntity;
    })
    .filter((candidate) => candidate.distance <= 900)
    .sort((a, b) => a.distance - b.distance);

  const obstacleHints = (["left", "right"] as const)
    .map((direction) => findNearestObstacle(entity, direction, world.obstacles))
    .filter((hint): hint is RayObstacleHint => Boolean(hint))
    .filter((hint) => hint.distance <= 220);

  const urgentHints: string[] = [];
  const immediateObstacle = obstacleHints.find((hint) => hint.distance < 90);
  if (immediateObstacle) {
    urgentHints.push(
      `${immediateObstacle.direction.toUpperCase()} obstacle ${immediateObstacle.distance}px away; ${
        immediateObstacle.jumpRecommended ? "jump is viable" : "jump may not clear it"
      }.`,
    );
  }

  if (visibleEntities.length > 0) {
    urgentHints.push(
      `Visible entity ids: ${visibleEntities
        .map((candidate) => `${candidate.id} (${candidate.direction}, ${candidate.distance}px, los=${candidate.lineOfSight})`)
        .join("; ")}`,
    );
  } else {
    urgentHints.push("No other entities are currently visible.");
  }

  const lastTrace = entity.traces[0];
  const repeatedBlockedActionWarning =
    lastTrace &&
    entity.lastActionResult?.toLowerCase().includes("blocked") &&
    Math.abs(progressDx) < 6 &&
    Math.abs(progressDy) < 6
      ? `Do not repeat ${lastTrace.actionName} with the same args; it made no progress. Choose a different action or inspect_view.`
      : undefined;

  const promptText = [
    `urgent=${urgentHints.join(" | ")}`,
    `self=x:${Math.round(entity.x)} y:${Math.round(entity.y)} ground:${entity.onGround} paused:${entity.paused}`,
    `progress_since_last_turn=dx:${progressDx} dy:${progressDy}`,
    `visible=${
      visibleEntities.length > 0
        ? visibleEntities
            .map((candidate) => `${candidate.id}:${candidate.direction}:${candidate.distance}:los=${candidate.lineOfSight}`)
            .join(", ")
        : "none"
    }`,
    `obstacles=${
      obstacleHints.length > 0
        ? obstacleHints
            .map(
              (hint) =>
                `${hint.direction}:${hint.distance}:h=${hint.height}:jump=${hint.jumpRecommended}`,
            )
            .join(", ")
        : "none"
    }`,
    `last=${entity.lastActionResult ?? "none"}`,
    `recent=${entity.recentEvents.slice(0, 2).join(" | ") || "none"}`,
    ...(repeatedBlockedActionWarning ? [`repeat_warning=${repeatedBlockedActionWarning}`] : []),
  ].join("\n");

  return { promptText, visibleEntities, obstacleHints, urgentHints, viewportImageDataUrl };
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
  entity.lastBrainSampleX = entity.x;
  entity.lastBrainSampleY = entity.y;
  return next;
};

const inspectViewText = (observation: ViewObservation) =>
  [
    `Visible entities: ${
      observation.visibleEntities.length > 0
        ? observation.visibleEntities
            .map(
              (candidate) =>
                `${candidate.id} (${candidate.name}) ${candidate.distance}px ${candidate.direction}, los=${candidate.lineOfSight}`,
            )
            .join("; ")
        : "none"
    }.`,
    `Obstacle hints: ${
      observation.obstacleHints.length > 0
        ? observation.obstacleHints
            .map(
              (hint) =>
                `${hint.direction} ${hint.distance}px, height=${hint.height}, jumpRecommended=${hint.jumpRecommended}`,
            )
            .join("; ")
        : "none"
    }.`,
  ].join(" ");

export const executeTool = (world: WorldState, entityId: string, invocation: ToolInvocation) => {
  const next = structuredClone(world);
  const entity = getEntity(next, entityId);
  if (!entity) {
    return { world: next, result: `Unknown entity: ${entityId}` };
  }

  entity.lastToolCall = { name: invocation.name, args: invocation.args };

  switch (invocation.name) {
    case "inspect_view": {
      const observation = buildObservation(next, entityId);
      const result = inspectViewText(observation);
      entity.lastActionResult = result;
      pushEvent(entity, "Inspected the visible room state.");
      return { world: next, result };
    }

    case "move": {
      const distance = clamp(Math.round(invocation.args.distance), 20, 240);
      entity.intent = {
        kind: "walk",
        direction: invocation.args.direction,
        remaining: distance,
      };
      entity.status = "moving";
      entity.lastActionResult = `Scheduled walk ${invocation.args.direction} for ${distance}px.`;
      pushEvent(entity, entity.lastActionResult);
      return { world: next, result: entity.lastActionResult };
    }

    case "jump": {
      if (!entity.onGround) {
        const result = "Jump ignored: entity is airborne.";
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }
      const distance = clamp(Math.round(invocation.args.distance), 40, 220);
      const strength = clamp(Math.round(invocation.args.strength), 260, 420);
      entity.intent = {
        kind: "jump",
        direction: invocation.args.direction,
        remaining: distance,
        strength,
        launched: false,
      };
      entity.status = "moving";
      entity.lastActionResult = `Scheduled jump ${invocation.args.direction} for ${distance}px at strength ${strength}.`;
      pushEvent(entity, entity.lastActionResult);
      return { world: next, result: entity.lastActionResult };
    }

    case "approach_entity": {
      const target = next.entities[invocation.args.entityId];
      if (!target || target.id === entityId) {
        const result = `Approach ignored: target ${invocation.args.entityId} is invalid.`;
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }

      const stopWithin = clamp(Math.round(invocation.args.stopWithin), 28, 140);
      const distanceToTarget = Math.round(Math.abs(target.x - entity.x));
      const remaining = Math.max(0, distanceToTarget - stopWithin);
      const direction: Direction = target.x >= entity.x ? "right" : "left";
      entity.targetEntityId = target.id;

      if (remaining === 0) {
        const result = `Already within ${stopWithin}px of ${target.id}.`;
        entity.lastActionResult = result;
        pushEvent(entity, result);
        return { world: next, result };
      }

      entity.intent = {
        kind: "walk",
        direction,
        remaining: clamp(remaining, 20, 260),
      };
      entity.status = "moving";
      entity.lastActionResult = `Approaching ${target.id} from the ${direction} within ${stopWithin}px.`;
      pushEvent(entity, entity.lastActionResult);
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

  const now = Date.now();
  next.metrics.totalBrainTurns += 1;
  next.metrics.brainTurnTimestamps = pruneSamples([...next.metrics.brainTurnTimestamps, now], now);
  next.metrics.brainLatenciesMs = limitSample([...next.metrics.brainLatenciesMs, result.latencyMs]);

  if (result.completionTokensPerSecond !== undefined) {
    next.metrics.completionTokenRates = limitSample([
      ...next.metrics.completionTokenRates,
      result.completionTokensPerSecond,
    ]);
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
  entity.status = entity.paused ? "paused" : entity.intent ? "moving" : "idle";
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
    ...(result.completionTokensPerSecond !== undefined
      ? { completionTokensPerSecond: result.completionTokensPerSecond }
      : {}),
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
    entity.prompt = patch.prompt.trim() || entity.prompt;
    pushEvent(entity, "Prompt updated from debug UI.");
  }

  if (patch.paused !== undefined) {
    entity.paused = patch.paused;
    entity.status = patch.paused ? "paused" : "idle";
    pushEvent(entity, patch.paused ? "Paused from debug UI." : "Resumed from debug UI.");
  }

  if (patch.resetThread) {
    entity.thread = [];
    entity.memorySummary = "Thread reset from debug UI. No compressed history retained.";
    pushEvent(entity, "Thread reset from debug UI.");
  }

  return { world: next, updated: true };
};

export const worldSnapshot = (world: WorldState, llm: LlmStatus): WorldSnapshot => {
  const physicsTicksPerSecond = Number((world.metrics.physicsTickTimestamps.length / (PHYSICS_WINDOW_MS / 1000)).toFixed(2));
  const brainTurnsPerSecond = Number((world.metrics.brainTurnTimestamps.length / (PHYSICS_WINDOW_MS / 1000)).toFixed(2));
  const averageBrainLatencyMs =
    world.metrics.brainLatenciesMs.length > 0
      ? Number(
          (
            world.metrics.brainLatenciesMs.reduce((sum, value) => sum + value, 0) / world.metrics.brainLatenciesMs.length
          ).toFixed(1),
        )
      : 0;
  const averageCompletionTokensPerSecond =
    world.metrics.completionTokenRates.length > 0
      ? Number(
          (
            world.metrics.completionTokenRates.reduce((sum, value) => sum + value, 0) /
            world.metrics.completionTokenRates.length
          ).toFixed(2),
        )
      : 0;

  const entities: EntitySnapshot[] = Object.values(world.entities).map((entity) => ({
    id: entity.id,
    name: entity.name,
    color: entity.color,
    prompt: entity.prompt,
    visibleThought: entity.visibleThought,
    status: entity.status,
    x: entity.x,
    y: entity.y,
    width: entity.width,
    height: entity.height,
    onGround: entity.onGround,
    paused: entity.paused,
    memorySummary: entity.memorySummary,
    lastObservation: entity.lastObservation,
    recentEvents: entity.recentEvents,
    threadLength: entity.thread.length,
    traces: entity.traces,
    ...(entity.lastToolCall ? { lastToolCall: entity.lastToolCall } : {}),
    ...(entity.lastActionResult ? { lastActionResult: entity.lastActionResult } : {}),
    ...(entity.lastViewportImageDataUrl ? { lastViewportImageDataUrl: entity.lastViewportImageDataUrl } : {}),
    ...(entity.targetEntityId ? { targetEntityId: entity.targetEntityId } : {}),
  }));

  return {
    generatedAt: Date.now(),
    width: world.width,
    height: world.height,
    floorY: world.floorY,
    obstacles: world.obstacles,
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
