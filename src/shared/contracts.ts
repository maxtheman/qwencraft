import { Schema } from "effect";

export type RuntimeMode = "lmstudio" | "stub";
export type Facing = "north" | "east" | "south" | "west";
export type MoveDirection = "forward" | "backward" | "left" | "right";
export type TurnDirection = "left" | "right";
export type BlockType = "grass" | "stone" | "wood" | "glass";
export type EntityStatus = "idle" | "thinking" | "moving" | "paused" | "error";

export interface ToolRecord {
  name: string;
  args: unknown;
}

export interface BlockSnapshot {
  x: number;
  y: number;
  z: number;
  type: BlockType;
}

export interface BeaconSnapshot {
  id: string;
  x: number;
  y: number;
  label: string;
}

export interface EntitySnapshot {
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
  lastToolCall?: ToolRecord | undefined;
  lastActionResult?: string | undefined;
  lastViewportImageDataUrl?: string | undefined;
  recentEvents: readonly string[];
  threadLength: number;
  traces: readonly BrainTraceSnapshot[];
}

export interface LlmStatusSnapshot {
  mode: RuntimeMode;
  baseUrl: string;
  configuredModel?: string | undefined;
  activeModel?: string | undefined;
  lastError?: string | undefined;
}

export interface WorldMetricsSnapshot {
  totalPhysicsTicks: number;
  physicsTicksPerSecond: number;
  totalBrainTurns: number;
  brainTurnsPerSecond: number;
  averageBrainLatencyMs: number;
  averageCompletionTokensPerSecond: number;
}

export interface WorldSnapshot {
  generatedAt: number;
  gridWidth: number;
  gridDepth: number;
  gridHeight: number;
  blocks: readonly BlockSnapshot[];
  beacons: readonly BeaconSnapshot[];
  entities: readonly EntitySnapshot[];
  llm: LlmStatusSnapshot;
  metrics: WorldMetricsSnapshot;
}

export interface EntityPatchRequest {
  prompt?: string | undefined;
  paused?: boolean | undefined;
  resetThread?: boolean | undefined;
}

export interface ErrorResponse {
  error?: string | undefined;
}

export interface BeaconUpsertRequest {
  x: number;
  y: number;
  label: string;
}

export interface BrainTraceSnapshot {
  id: string;
  timestamp: number;
  mode: RuntimeMode;
  promptText: string;
  rawModelOutput: string;
  thought: string;
  actionName: string;
  actionArgs?: unknown;
  actionResult?: string | undefined;
  viewportImageDataUrl?: string | undefined;
  latencyMs: number;
  completionTokens?: number | undefined;
  completionTokensPerSecond?: number | undefined;
}

export const RuntimeModeSchema = Schema.Literal("lmstudio", "stub");
export const FacingSchema = Schema.Literal("north", "east", "south", "west");
export const MoveDirectionSchema = Schema.Literal("forward", "backward", "left", "right");
export const TurnDirectionSchema = Schema.Literal("left", "right");
export const BlockTypeSchema = Schema.Literal("grass", "stone", "wood", "glass");
export const EntityStatusSchema = Schema.Literal("idle", "thinking", "moving", "paused", "error");

export const ToolRecordSchema = Schema.Struct({
  name: Schema.String,
  args: Schema.Unknown,
});

export const BlockSnapshotSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  z: Schema.Number,
  type: BlockTypeSchema,
});

export const BeaconSnapshotSchema = Schema.Struct({
  id: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  label: Schema.String,
});

export const EntitySnapshotSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  prompt: Schema.String,
  visibleThought: Schema.String,
  status: EntityStatusSchema,
  gridX: Schema.Number,
  gridY: Schema.Number,
  gridZ: Schema.Number,
  facing: FacingSchema,
  paused: Schema.Boolean,
  memorySummary: Schema.String,
  lastObservation: Schema.String,
  lastToolCall: Schema.optional(ToolRecordSchema),
  lastActionResult: Schema.optional(Schema.String),
  lastViewportImageDataUrl: Schema.optional(Schema.String),
  recentEvents: Schema.Array(Schema.String),
  threadLength: Schema.Number,
  traces: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      timestamp: Schema.Number,
      mode: RuntimeModeSchema,
      promptText: Schema.String,
      rawModelOutput: Schema.String,
      thought: Schema.String,
      actionName: Schema.String,
      actionArgs: Schema.optional(Schema.Unknown),
      actionResult: Schema.optional(Schema.String),
      viewportImageDataUrl: Schema.optional(Schema.String),
      latencyMs: Schema.Number,
      completionTokens: Schema.optional(Schema.Number),
      completionTokensPerSecond: Schema.optional(Schema.Number),
    }),
  ),
});

export const LlmStatusSnapshotSchema = Schema.Struct({
  mode: RuntimeModeSchema,
  baseUrl: Schema.String,
  configuredModel: Schema.optional(Schema.String),
  activeModel: Schema.optional(Schema.String),
  lastError: Schema.optional(Schema.String),
});

export const WorldMetricsSnapshotSchema = Schema.Struct({
  totalPhysicsTicks: Schema.Number,
  physicsTicksPerSecond: Schema.Number,
  totalBrainTurns: Schema.Number,
  brainTurnsPerSecond: Schema.Number,
  averageBrainLatencyMs: Schema.Number,
  averageCompletionTokensPerSecond: Schema.Number,
});

export const WorldSnapshotSchema = Schema.Struct({
  generatedAt: Schema.Number,
  gridWidth: Schema.Number,
  gridDepth: Schema.Number,
  gridHeight: Schema.Number,
  blocks: Schema.Array(BlockSnapshotSchema),
  beacons: Schema.Array(BeaconSnapshotSchema),
  entities: Schema.Array(EntitySnapshotSchema),
  llm: LlmStatusSnapshotSchema,
  metrics: WorldMetricsSnapshotSchema,
});

export const EntityPatchRequestSchema = Schema.Struct({
  prompt: Schema.optional(Schema.String),
  paused: Schema.optional(Schema.Boolean),
  resetThread: Schema.optional(Schema.Boolean),
});

export const ErrorResponseSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
});

export const BeaconUpsertRequestSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  label: Schema.String,
});

export const decodeWorldSnapshot = Schema.decodeUnknownSync(WorldSnapshotSchema);
export const decodeEntityPatchRequest = Schema.decodeUnknownSync(EntityPatchRequestSchema);
export const decodeErrorResponse = Schema.decodeUnknownSync(ErrorResponseSchema);
export const decodeBeaconUpsertRequest = Schema.decodeUnknownSync(BeaconUpsertRequestSchema);
