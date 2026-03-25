import OpenAI from "openai";
import { Schema } from "effect";
import type { Facing, MoveDirection, RuntimeMode, TurnDirection } from "../shared/contracts";
import type { BrainResult, ThreadMessage, ToolInvocation, ViewObservation } from "./runtime";

type BrainInput = {
  entity: {
    id: string;
    name: string;
    prompt: string;
    memorySummary: string;
    objectiveRevision: number;
  };
  observation: ViewObservation;
  thread: ThreadMessage[];
  toolExecutor: (invocation: ToolInvocation) => Promise<string>;
};

export type LlmStatus = {
  mode: RuntimeMode;
  baseUrl: string;
  configuredModel?: string;
  activeModel?: string;
  lastError?: string;
};

type LlmConfig = {
  baseUrl: string;
  model?: string;
  apiKey: string;
  toolMode?: "auto" | "native" | "json";
  imageMode?: "auto" | "always" | "never";
  temperature?: number;
  maxTokens?: number;
  topP?: number;
};

type BuildBlockType = "stone" | "wood" | "glass";

type PromptOverride = {
  thought?: string;
  toolCall?: ToolInvocation;
};

type NativeToolName = ToolInvocation["name"] | "wait";

const withOptionalString = <Key extends string>(key: Key, value: string | undefined) =>
  value !== undefined ? ({ [key]: value } as Record<Key, string>) : {};

const withOptionalNumber = <Key extends string>(key: Key, value: number | undefined) =>
  value !== undefined ? ({ [key]: value } as Record<Key, number>) : {};

const MoveDirectionSchema = Schema.Literal("forward", "backward", "left", "right");
const TurnDirectionSchema = Schema.Literal("left", "right");
const BuildBlockTypeSchema = Schema.Literal("stone", "wood", "glass");

const WaitActionSchema = Schema.Struct({
  type: Schema.Literal("wait"),
  reason: Schema.optional(Schema.String),
});

const InspectPatchActionSchema = Schema.Struct({
  type: Schema.Literal("inspect_patch"),
  reason: Schema.optional(Schema.String),
});

const MoveActionSchema = Schema.Struct({
  type: Schema.Literal("move"),
  direction: MoveDirectionSchema,
  steps: Schema.Number,
  reason: Schema.optional(Schema.String),
});

const TurnActionSchema = Schema.Struct({
  type: Schema.Literal("turn"),
  direction: TurnDirectionSchema,
  reason: Schema.optional(Schema.String),
});

const PlaceBlockActionSchema = Schema.Struct({
  type: Schema.Literal("place_block"),
  blockType: BuildBlockTypeSchema,
  dx: Schema.Number,
  dy: Schema.Number,
  dz: Schema.Number,
  reason: Schema.optional(Schema.String),
});

const RemoveBlockActionSchema = Schema.Struct({
  type: Schema.Literal("remove_block"),
  dx: Schema.Number,
  dy: Schema.Number,
  dz: Schema.Number,
  reason: Schema.optional(Schema.String),
});

const StructuredActionSchema = Schema.Union(
  WaitActionSchema,
  InspectPatchActionSchema,
  MoveActionSchema,
  TurnActionSchema,
  PlaceBlockActionSchema,
  RemoveBlockActionSchema,
);

const StructuredDecisionSchema = Schema.Struct({
  thought: Schema.String,
  action: StructuredActionSchema,
});

type StructuredAction = typeof StructuredActionSchema.Type;
type StructuredDecision = typeof StructuredDecisionSchema.Type;

const structuredDecisionFormat = {
  type: "json_schema",
  json_schema: {
    name: "builder_turn",
    strict: true,
    schema: {
      type: "object",
      properties: {
        thought: { type: "string" },
        action: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { type: "string", const: "wait" },
                reason: { type: "string" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "inspect_patch" },
                reason: { type: "string" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "move" },
                direction: { type: "string", enum: ["forward", "backward", "left", "right"] },
                steps: { type: "number" },
                reason: { type: "string" },
              },
              required: ["type", "direction", "steps"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "turn" },
                direction: { type: "string", enum: ["left", "right"] },
                reason: { type: "string" },
              },
              required: ["type", "direction"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "place_block" },
                blockType: { type: "string", enum: ["stone", "wood", "glass"] },
                dx: { type: "number" },
                dy: { type: "number" },
                dz: { type: "number" },
                reason: { type: "string" },
              },
              required: ["type", "blockType", "dx", "dy", "dz"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { type: "string", const: "remove_block" },
                dx: { type: "number" },
                dy: { type: "number" },
                dz: { type: "number" },
                reason: { type: "string" },
              },
              required: ["type", "dx", "dy", "dz"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["thought", "action"],
      additionalProperties: false,
    },
  },
} satisfies {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
};

const nativeTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "wait",
      description: "Hold position when no action should be taken this turn.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_patch",
      description: "Inspect the local build patch when the state is unclear or a previous action failed.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move",
      description: "Move one or two steps in local space.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["forward", "backward", "left", "right"] },
          steps: { type: "number" },
        },
        required: ["direction", "steps"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "turn",
      description: "Turn in place to face left or right relative to the current facing.",
      parameters: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["left", "right"] },
        },
        required: ["direction"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "place_block",
      description: "Place a supported block in a reachable local cell.",
      parameters: {
        type: "object",
        properties: {
          blockType: { type: "string", enum: ["stone", "wood", "glass"] },
          dx: { type: "number" },
          dy: { type: "number" },
          dz: { type: "number" },
        },
        required: ["blockType", "dx", "dy", "dz"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_block",
      description: "Remove an existing non-grass block from a reachable local cell.",
      parameters: {
        type: "object",
        properties: {
          dx: { type: "number" },
          dy: { type: "number" },
          dz: { type: "number" },
        },
        required: ["dx", "dy", "dz"],
        additionalProperties: false,
      },
    },
  },
];

const clipThought = (text: string) => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 88) {
    return compact || "Working the build plan.";
  }
  return `${compact.slice(0, 85).trimEnd()}...`;
};

const clipText = (text: string, limit: number) => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
};

const normalizeReasoningTrace = (text: string) => {
  const compact = text
    .replace(/<think>/gi, " ")
    .replace(/<\/think>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) {
    return "";
  }
  return clipThought(compact);
};

const normalizePublicThought = (candidate: string, fallback: string) => {
  const compact = candidate.replace(/\s+/g, " ").trim();
  if (!compact || compact.startsWith("{") || compact.startsWith("TOOL_CALL") || compact.includes("\"type\"")) {
    return clipThought(fallback);
  }
  return clipThought(compact);
};

const readReasoningContent = (message: OpenAI.Chat.Completions.ChatCompletionMessage) =>
  normalizeReasoningTrace((message as { reasoning_content?: string }).reasoning_content?.trim() ?? "");

const readAssistantTextContent = (message: OpenAI.Chat.Completions.ChatCompletionMessage) => {
  const content = message.content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => ("text" in item ? item.text : ""))
      .join(" ")
      .trim();
    if (text) {
      return text;
    }
  }

  return "";
};

const readContent = (message: OpenAI.Chat.Completions.ChatCompletionMessage) => {
  const textContent = readAssistantTextContent(message);
  if (textContent) {
    return textContent;
  }
  return readReasoningContent(message);
};

const buildMemoryMessage = (memorySummary: string) => {
  const compact = clipText(memorySummary, 140);
  if (!compact || compact === "No summary yet.") {
    return undefined;
  }
  return `Working memory: ${compact}`;
};

const buildRecentTurnsText = (thread: ThreadMessage[]) =>
  thread
    .filter((message) => message.role === "assistant")
    .slice(-2)
    .map((message, index) => `${index + 1}. ${clipText(message.content, 180)}`)
    .join("\n");

const buildTurnSections = ({
  objective,
  memorySummary,
  thread,
  observationText,
}: {
  objective: string;
  memorySummary: string;
  thread: ThreadMessage[];
  observationText: string;
}) => {
  const recentTurns = buildRecentTurnsText(thread);
  const memoryText = buildMemoryMessage(memorySummary);

  return [
    `[objective]\n${objective}`,
    ...(memoryText ? [`[memory]\n${memoryText}`] : []),
    ...(recentTurns ? [`[recent_turns]\n${recentTurns}`] : []),
    `[observation]\n${observationText}`,
  ];
};

const renderTurnContext = ({
  objective,
  memorySummary,
  thread,
  observationText,
  withImage,
}: {
  objective: string;
  memorySummary: string;
  thread: ThreadMessage[];
  observationText: string;
  withImage: boolean;
}) => {
  return [
    ...buildTurnSections({
      objective,
      memorySummary,
      thread,
      observationText,
    }),
    `[viewport]\n${withImage ? "attached (low detail)" : "text-only"}`,
  ].join("\n\n");
};

const isImageProcessingError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).toLowerCase().includes("failed to process image");

const isToolCallingError = (error: unknown) => {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("tool") || message.includes("function call") || message.includes("tool_choice");
};

const shouldAttachViewport = (input: BrainInput, imageMode: NonNullable<LlmConfig["imageMode"]>) => {
  if (imageMode === "always") {
    return true;
  }
  if (imageMode === "never") {
    return false;
  }

  return input.observation.viewportImageDataUrl.length > 0;
};

const shouldAppendThinkDirective = (model: string) => model.toLowerCase().includes("qwen");

const summarizeTurn = (thought: string, toolCall?: ToolInvocation, toolResult?: string) =>
  [
    `thought=${thought}`,
    `action=${toolCall?.name ?? "wait"}`,
    ...(toolCall ? [`args=${JSON.stringify(toolCall.args)}`] : []),
    ...(toolResult ? [`result=${toolResult}`] : []),
  ]
    .join(" | ")
    .slice(0, 260);

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const clampInt = (value: number | undefined, min: number, max: number, fallback: number) =>
  clamp(Math.round(value ?? fallback), min, max);

const readPromptThoughtDirective = (prompt: string) => {
  const explicitMatch = prompt.match(/thought(?:\s*[:=]|\s+is\s+)\s*"([^"]{1,90})"/i);
  if (explicitMatch?.[1]) {
    return clipThought(explicitMatch[1]);
  }
  return undefined;
};

const parseMoveDirection = (value: string | undefined): MoveDirection | undefined => {
  if (value === "forward" || value === "backward" || value === "left" || value === "right") {
    return value;
  }
  return undefined;
};

const parseTurnDirection = (value: string | undefined): TurnDirection | undefined => {
  if (value === "left" || value === "right") {
    return value;
  }
  return undefined;
};

const readPromptActionDirective = (prompt: string): ToolInvocation | undefined => {
  const actionType = prompt.match(/action\.type\s*=\s*["']?([a-z_]+)["']?/i)?.[1]?.toLowerCase();
  const direction = prompt.match(/direction\s*=\s*["']?([a-z_]+)["']?/i)?.[1]?.toLowerCase();
  const steps = Number(prompt.match(/steps\s*=\s*(\d+)/i)?.[1] ?? Number.NaN);
  const blockType = prompt.match(/blocktype\s*=\s*["']?(stone|wood|glass)["']?/i)?.[1]?.toLowerCase() as
    | BuildBlockType
    | undefined;
  const dx = Number(prompt.match(/dx\s*=\s*(-?\d+)/i)?.[1] ?? Number.NaN);
  const dy = Number(prompt.match(/dy\s*=\s*(-?\d+)/i)?.[1] ?? Number.NaN);
  const dz = Number(prompt.match(/dz\s*=\s*(-?\d+)/i)?.[1] ?? Number.NaN);
  const normalized = prompt.toLowerCase();

  if (actionType === "wait" || /hold position|stay still|do not move|wait/.test(normalized)) {
    return undefined;
  }

  if (actionType === "inspect_patch") {
    return { name: "inspect_patch", args: {} };
  }

  if (actionType === "turn") {
    const turnDirection = parseTurnDirection(direction);
    if (turnDirection) {
      return { name: "turn", args: { direction: turnDirection } };
    }
  }

  if (actionType === "move") {
    const moveDirection = parseMoveDirection(direction);
    if (moveDirection) {
      return { name: "move", args: { direction: moveDirection, steps: Number.isFinite(steps) ? steps : 1 } };
    }
  }

  if (actionType === "place_block" && blockType) {
    return {
      name: "place_block",
      args: {
        blockType,
        dx: Number.isFinite(dx) ? dx : 0,
        dy: Number.isFinite(dy) ? dy : 1,
        dz: Number.isFinite(dz) ? dz : 1,
      },
    };
  }

  if (actionType === "remove_block") {
    return {
      name: "remove_block",
      args: {
        dx: Number.isFinite(dx) ? dx : 0,
        dy: Number.isFinite(dy) ? dy : 1,
        dz: Number.isFinite(dz) ? dz : 1,
      },
    };
  }

  return undefined;
};

const readPromptOverride = (prompt: string): PromptOverride | undefined => {
  const overridePrefix = prompt.match(/^\s*(?:@override|override:)\s*/i);
  if (!overridePrefix) {
    return undefined;
  }

  const directiveBody = prompt.slice(overridePrefix[0].length);
  const thought = readPromptThoughtDirective(directiveBody);
  const toolCall = readPromptActionDirective(directiveBody);
  if (thought === undefined && toolCall === undefined && !/wait|hold position|stay still|do not move/i.test(directiveBody)) {
    return undefined;
  }

  return {
    ...(thought !== undefined ? { thought } : {}),
    ...(toolCall !== undefined ? { toolCall } : {}),
  };
};

const findReachableCell = (observation: ViewObservation, dx: number, dy: number, dz: number) =>
  observation.reachableCells.find((cell) => cell.dx === dx && cell.dy === dy && cell.dz === dz);

const isBuildableCell = (observation: ViewObservation, dx: number, dy: number, dz: number) =>
  !(dx === 0 && dy === 0 && dz === 1) &&
  Boolean(findReachableCell(observation, dx, dy, dz)?.supported) &&
  findReachableCell(observation, dx, dy, dz)?.current === "empty" &&
  dz >= 1;

const isRemovableCell = (observation: ViewObservation, dx: number, dy: number, dz: number) => {
  const cell = findReachableCell(observation, dx, dy, dz);
  if (!cell) {
    return false;
  }
  return cell.current !== "empty" && cell.current !== "grass";
};

const sortedBuildableCells = (observation: ViewObservation) =>
  [...observation.reachableCells]
    .filter((cell) => isBuildableCell(observation, cell.dx, cell.dy, cell.dz))
    .sort((left, right) => left.dy - right.dy || Math.abs(left.dx) - Math.abs(right.dx) || left.dx - right.dx || left.dz - right.dz);

const sortedRemovableCells = (observation: ViewObservation) =>
  [...observation.reachableCells]
    .filter((cell) => isRemovableCell(observation, cell.dx, cell.dy, cell.dz))
    .sort((left, right) => left.dz - right.dz || left.dy - right.dy || Math.abs(left.dx) - Math.abs(right.dx) || left.dx - right.dx);

const inferObjectiveKind = (objective: string) => {
  const normalized = objective.toLowerCase();
  if (/\b(tower|column|pillar|stack)\b/.test(normalized)) {
    return "tower";
  }
  if (/\b(2x2|square|pad|platform)\b/.test(normalized)) {
    return "pad";
  }
  if (/\b(row|line)\b/.test(normalized)) {
    return "row";
  }
  if (/\b(remove|clear|delete)\b/.test(normalized)) {
    return "remove";
  }
  return "generic";
};

const normalizeToolInvocation = (
  toolCall: ToolInvocation | undefined,
  observation: ViewObservation,
  objective: string,
): ToolInvocation | undefined => {
  if (!toolCall) {
    return undefined;
  }

  if (toolCall.name === "place_block") {
    if (isBuildableCell(observation, toolCall.args.dx, toolCall.args.dy, toolCall.args.dz)) {
      return toolCall;
    }

    const objectiveKind = inferObjectiveKind(objective);
    const buildable = sortedBuildableCells(observation);
    if (buildable.length === 0) {
      return { name: "inspect_patch", args: {} };
    }

    const candidate =
      objectiveKind === "tower"
        ? [...buildable].sort((left, right) => left.dy - right.dy || Math.abs(left.dx) - Math.abs(right.dx) || left.dx - right.dx || right.dz - left.dz)[0]
        : objectiveKind === "row" || objectiveKind === "pad"
          ? buildable.find((cell) => cell.dz === 1) ?? buildable[0]
          : buildable[0];

    if (!candidate) {
      return { name: "inspect_patch", args: {} };
    }

    return {
      name: "place_block",
      args: {
        blockType: toolCall.args.blockType,
        dx: candidate.dx,
        dy: candidate.dy,
        dz: candidate.dz,
      },
    };
  }

  if (toolCall.name === "remove_block") {
    if (isRemovableCell(observation, toolCall.args.dx, toolCall.args.dy, toolCall.args.dz)) {
      return toolCall;
    }
    const candidate = sortedRemovableCells(observation)[0];
    return candidate
      ? { name: "remove_block", args: { dx: candidate.dx, dy: candidate.dy, dz: candidate.dz } }
      : { name: "inspect_patch", args: {} };
  }

  return toolCall;
};

const moveDeltaForDirection = (facing: Facing, direction: MoveDirection) => {
  switch (facing) {
    case "north":
      return direction === "forward"
        ? { x: 0, y: -1 }
        : direction === "backward"
          ? { x: 0, y: 1 }
          : direction === "left"
            ? { x: -1, y: 0 }
            : { x: 1, y: 0 };
    case "east":
      return direction === "forward"
        ? { x: 1, y: 0 }
        : direction === "backward"
          ? { x: -1, y: 0 }
          : direction === "left"
            ? { x: 0, y: -1 }
            : { x: 0, y: 1 };
    case "south":
      return direction === "forward"
        ? { x: 0, y: 1 }
        : direction === "backward"
          ? { x: 0, y: -1 }
          : direction === "left"
            ? { x: 1, y: 0 }
            : { x: -1, y: 0 };
    case "west":
      return direction === "forward"
        ? { x: -1, y: 0 }
        : direction === "backward"
          ? { x: 1, y: 0 }
          : direction === "left"
            ? { x: 0, y: 1 }
            : { x: 0, y: -1 };
  }
};

const worldStepToLocalMove = (facing: Facing, deltaX: number, deltaY: number): MoveDirection | undefined => {
  const directions: readonly MoveDirection[] = ["forward", "backward", "left", "right"];
  return directions.find((direction) => {
    const delta = moveDeltaForDirection(facing, direction);
    return delta.x === deltaX && delta.y === deltaY;
  });
};

const nextTurnToward = (facing: Facing, desired: Facing): TurnDirection => {
  const order: readonly Facing[] = ["north", "east", "south", "west"];
  const fromIndex = order.indexOf(facing);
  const toIndex = order.indexOf(desired);
  const rightSteps = (toIndex - fromIndex + order.length) % order.length;
  const leftSteps = (fromIndex - toIndex + order.length) % order.length;
  return rightSteps <= leftSteps ? "right" : "left";
};

const buildFallbackAction = (_observation: ViewObservation): ToolInvocation | undefined => undefined;

const readStubPromptDirective = (prompt: string): ToolInvocation | undefined => {
  const normalized = prompt.toLowerCase();
  if (/inspect_patch|inspect|scan/.test(normalized)) {
    return { name: "inspect_patch", args: {} };
  }
  if (/hold position|stay still|do not move|wait/.test(normalized)) {
    return undefined;
  }
  if (/turn left/.test(normalized)) {
    return { name: "turn", args: { direction: "left" } };
  }
  if (/turn right/.test(normalized)) {
    return { name: "turn", args: { direction: "right" } };
  }
  if (/move forward/.test(normalized)) {
    return { name: "move", args: { direction: "forward", steps: 1 } };
  }
  if (/move backward/.test(normalized)) {
    return { name: "move", args: { direction: "backward", steps: 1 } };
  }
  if (/move left/.test(normalized)) {
    return { name: "move", args: { direction: "left", steps: 1 } };
  }
  if (/move right/.test(normalized)) {
    return { name: "move", args: { direction: "right", steps: 1 } };
  }
  return undefined;
};

const inferMoveDirection = (_observation: ViewObservation): MoveDirection => "forward";

const inferBlockType = (contextText: string, reason?: string): BuildBlockType => {
  const normalized = `${contextText} ${reason ?? ""}`.toLowerCase();
  if (normalized.includes("glass")) {
    return "glass";
  }
  if (normalized.includes("wood")) {
    return "wood";
  }
  return "stone";
};

const parseJsonObject = (raw: string | undefined) => {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed;
  } catch {
    return {};
  }
};

const parseNativeToolInvocation = (
  toolCall: OpenAI.Chat.Completions.ChatCompletionMessageToolCall | undefined,
  observation: ViewObservation,
  contextText: string,
): ToolInvocation | undefined => {
  if (!toolCall || toolCall.type !== "function") {
    return undefined;
  }

  const args = parseJsonObject(toolCall.function.arguments);
  const name = toolCall.function.name as NativeToolName;

  switch (name) {
    case "wait":
      return undefined;
    case "inspect_patch":
      return { name: "inspect_patch", args: {} };
    case "turn": {
      const direction = parseTurnDirection(typeof args.direction === "string" ? args.direction : undefined);
      return {
        name: "turn",
        args: {
          direction: direction ?? "left",
        },
      };
    }
    case "move": {
      const direction = parseMoveDirection(typeof args.direction === "string" ? args.direction : undefined);
      const steps = typeof args.steps === "number" ? args.steps : undefined;
      return {
        name: "move",
        args: {
          direction: direction ?? inferMoveDirection(observation),
          steps: clampInt(steps, 1, 2, 1),
        },
      };
    }
    case "place_block": {
      const blockType =
        typeof args.blockType === "string" && (args.blockType === "stone" || args.blockType === "wood" || args.blockType === "glass")
          ? args.blockType
          : undefined;
      return {
        name: "place_block",
        args: {
          blockType: blockType ?? inferBlockType(contextText),
          dx: clampInt(typeof args.dx === "number" ? args.dx : undefined, -1, 1, 0),
          dy: clampInt(typeof args.dy === "number" ? args.dy : undefined, 0, 3, 1),
          dz: clampInt(typeof args.dz === "number" ? args.dz : undefined, 1, 3, 1),
        },
      };
    }
    case "remove_block":
      return {
        name: "remove_block",
        args: {
          dx: clampInt(typeof args.dx === "number" ? args.dx : undefined, -1, 1, 0),
          dy: clampInt(typeof args.dy === "number" ? args.dy : undefined, 0, 3, 1),
          dz: clampInt(typeof args.dz === "number" ? args.dz : undefined, 0, 3, 1),
        },
      };
    default:
      return undefined;
  }
};

const actionToToolInvocation = (
  action: StructuredAction,
  observation: ViewObservation,
  contextText: string,
): ToolInvocation | undefined => {
  switch (action.type) {
    case "wait":
      return undefined;
    case "inspect_patch":
      return { name: "inspect_patch", args: {} };
    case "turn": {
      const direction = parseTurnDirection(action.direction);
      return {
        name: "turn",
        args: {
          direction: direction ?? "left",
        },
      };
    }
    case "move": {
      const direction = parseMoveDirection(action.direction);
      return {
        name: "move",
        args: {
          direction: direction ?? inferMoveDirection(observation),
          steps: clampInt(action.steps, 1, 2, 1),
        },
      };
    }
    case "place_block":
      return {
        name: "place_block",
        args: {
          blockType: inferBlockType(contextText, action.reason),
          dx: clampInt(action.dx, -1, 1, 0),
          dy: clampInt(action.dy, 0, 3, 1),
          dz: clampInt(action.dz, 1, 3, 1),
        },
      };
    case "remove_block":
      return {
        name: "remove_block",
        args: {
          dx: clampInt(action.dx, -1, 1, 0),
          dy: clampInt(action.dy, 0, 3, 1),
          dz: clampInt(action.dz, 0, 3, 1),
        },
      };
  }
};

const makeStubThought = (toolCall?: ToolInvocation, toolResult?: string) => {
  if (toolCall?.name === "move") {
    return `Moving ${toolCall.args.direction} to explore the build plate.`;
  }
  if (toolCall?.name === "turn") {
    return `Turning ${toolCall.args.direction} to reframe the workspace.`;
  }
  if (toolCall?.name === "place_block") {
    return `Placing ${toolCall.args.blockType} at the selected local cell.`;
  }
  if (toolCall?.name === "remove_block") {
    return "Removing a block from the local patch.";
  }
  if (toolCall?.name === "inspect_patch") {
    return "Inspecting the local build patch.";
  }
  if (toolResult) {
    return toolResult;
  }
  return "Awaiting the next objective.";
};

const decodeStructuredDecision = (rawResponse: string): StructuredDecision => {
  const parsed = JSON.parse(rawResponse) as unknown;
  return Schema.decodeUnknownSync(StructuredDecisionSchema)(parsed);
};

export class BrainAdapter {
  readonly #client: OpenAI;
  readonly #status: LlmStatus;
  #lastProbeAt = 0;

  constructor(private readonly config: LlmConfig) {
    this.#client = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey,
    });
    this.#status = {
      mode: "stub",
      baseUrl: config.baseUrl,
      ...withOptionalString("configuredModel", config.model),
    };
  }

  getStatus(): LlmStatus {
    return { ...this.#status };
  }

  async #ensureModel() {
    if (this.#status.activeModel) {
      return this.#status.activeModel;
    }

    const now = Date.now();
    if (now - this.#lastProbeAt < 2_000 && this.#status.lastError) {
      throw new Error(this.#status.lastError);
    }

    this.#lastProbeAt = now;
    if (this.config.model) {
      this.#status.activeModel = this.config.model;
      this.#status.mode = "lmstudio";
      delete this.#status.lastError;
      return this.config.model;
    }

    const models = await this.#client.models.list();
    const model = models.data[0]?.id;
    if (!model) {
      throw new Error("LM Studio returned no loaded models.");
    }
    this.#status.activeModel = model;
    this.#status.mode = "lmstudio";
    delete this.#status.lastError;
    return model;
  }

  async #runStubTurn(input: BrainInput): Promise<BrainResult> {
    const started = performance.now();
    const requestTranscriptText = renderTurnContext({
      objective: clipText(input.entity.prompt, 420),
      memorySummary: input.entity.memorySummary,
      thread: input.thread,
      observationText: input.observation.promptText,
      withImage: false,
    });

    const threadEntries: ThreadMessage[] = [];
    const promptDirectedTool = readStubPromptDirective(input.entity.prompt);
    const toolCall = promptDirectedTool ?? buildFallbackAction(input.observation);
    const toolResult = toolCall ? await input.toolExecutor(toolCall) : "Builder is holding position.";
    const thought = normalizePublicThought(makeStubThought(toolCall, toolResult), "Builder is holding position.");

    threadEntries.push({
      role: "assistant",
      content: summarizeTurn(thought, toolCall, toolResult),
    });

    return {
      objectiveRevision: input.entity.objectiveRevision,
      thought,
      threadEntries,
      rawModelOutput: JSON.stringify(
        {
          source: "stub_builder_policy",
          thought,
          action: toolCall === undefined ? { type: "wait", reason: "stub fallback" } : { type: toolCall.name, ...toolCall.args },
        },
        null,
        2,
      ),
      requestTranscriptText,
      latencyMs: performance.now() - started,
      mode: "stub",
      ...(toolCall !== undefined ? { toolCall } : {}),
      ...(toolResult !== undefined ? { toolResult } : {}),
    };
  }

  async #runPromptOverrideTurn(input: BrainInput, override: PromptOverride, mode: LlmStatus["mode"]): Promise<BrainResult> {
    const started = performance.now();
    const requestTranscriptText = renderTurnContext({
      objective: clipText(input.entity.prompt, 420),
      memorySummary: input.entity.memorySummary,
      thread: input.thread,
      observationText: input.observation.promptText,
      withImage: false,
    });
    const threadEntries: ThreadMessage[] = [];
    const toolResult = override.toolCall ? await input.toolExecutor(override.toolCall) : "Holding position by prompt override.";
    const thought = normalizePublicThought(
      override.thought ?? makeStubThought(override.toolCall, toolResult),
      "Holding position by prompt override.",
    );
    threadEntries.push({
      role: "assistant",
      content: summarizeTurn(thought, override.toolCall, toolResult),
    });

    return {
      objectiveRevision: input.entity.objectiveRevision,
      thought,
      threadEntries,
      rawModelOutput: JSON.stringify(
        {
          source: "prompt_override",
          thought,
          action: override.toolCall === undefined ? { type: "wait", reason: "prompt override" } : { type: override.toolCall.name, ...override.toolCall.args },
        },
        null,
        2,
      ),
      requestTranscriptText,
      latencyMs: performance.now() - started,
      mode,
      ...(override.toolCall !== undefined ? { toolCall: override.toolCall } : {}),
      ...(toolResult !== undefined ? { toolResult } : {}),
    };
  }

  async runTurn(input: BrainInput): Promise<BrainResult> {
    if (input.entity.prompt.trim().length === 0) {
      return this.#runPromptOverrideTurn(
        input,
        {
          thought: "Awaiting an objective.",
        },
        this.#status.activeModel ? "lmstudio" : "stub",
      );
    }

    const promptOverride = readPromptOverride(input.entity.prompt);
    if (promptOverride) {
      return this.#runPromptOverrideTurn(input, promptOverride, this.#status.activeModel ? "lmstudio" : "stub");
    }

    let model: string;
    try {
      model = await this.#ensureModel();
    } catch (error) {
      this.#status.mode = "stub";
      this.#status.lastError = error instanceof Error ? error.message : String(error);
      return this.#runStubTurn(input);
    }

    const started = performance.now();
    const threadEntries: ThreadMessage[] = [];
    const thinkDirective = shouldAppendThinkDirective(model) ? "\n/think" : "";
    const toolMode = this.config.toolMode ?? "auto";
    const imageMode = this.config.imageMode ?? "auto";
    const includeImage = shouldAttachViewport(input, imageMode);
    const temperature = this.config.temperature ?? 0.1;
    const maxTokens = this.config.maxTokens ?? 80;
    const topP = this.config.topP ?? 0.9;

    const systemPrompt = [
      `You are ${input.entity.name} (${input.entity.id}) in a tiny block-building sandbox.`,
      "Treat the current objective as authoritative. Follow it even if it differs from older turns.",
      "You only control one local action per turn. The runtime is authoritative.",
      "Relative coordinates are in your local frame. dx is left/right, dy is forward, dz is height above the floor under you.",
      "There is no default build goal. Only act on the current objective from the operator.",
      "Structured text is authoritative for coordinates, occupancy, and support.",
      "When viewport markers are present, use the numeric beacon markers in the image together with the viewport_markers text.",
      "For place_block, choose only cells listed in buildable_cells.",
      "Never place into blocked_place_cells or grass. dz=1 is the first build layer above the floor.",
      "If a placement failed, pick a different buildable cell or move before placing again.",
      "Use inspect_patch when the local state is unclear before building.",
      "Do not repeat a failed action unchanged.",
      "Keep any public thought short and concrete.",
    ].join("\n");
    const buildMessages = (withImage: boolean): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `${buildTurnSections({
                objective: clipText(input.entity.prompt, 420),
                memorySummary: input.entity.memorySummary,
                thread: input.thread,
                observationText: input.observation.promptText,
              }).join("\n\n")}\n\n` + `[viewport]\n${withImage ? "attached" : "text-only"}${thinkDirective}`,
          },
          ...(withImage
            ? [
                {
                  type: "image_url" as const,
                  image_url: {
                    url: input.observation.viewportImageDataUrl,
                    detail: "low" as const,
                  },
                },
              ]
            : []),
        ],
      },
    ];

    const finalizeTurn = async (
      requestTranscriptText: string,
      rawModelOutput: string,
      thoughtCandidate: string,
      toolCall: ToolInvocation | undefined,
      completionTokens: number,
    ): Promise<BrainResult> => {
      const normalizedToolCall = normalizeToolInvocation(toolCall, input.observation, input.entity.prompt);
      const toolResult = normalizedToolCall ? await input.toolExecutor(normalizedToolCall) : "No action requested.";
      const fallbackThought = makeStubThought(normalizedToolCall, toolResult);
      const thought = normalizePublicThought(thoughtCandidate, fallbackThought);
      const latencyMs = performance.now() - started;
      const completionTokensPerSecond = completionTokens > 0 && latencyMs > 0 ? (completionTokens / latencyMs) * 1000 : undefined;

      threadEntries.push({
        role: "assistant",
        content: summarizeTurn(thought, toolCall, toolResult),
      });

      this.#status.mode = "lmstudio";
      this.#status.activeModel = model;
      delete this.#status.lastError;

      return {
        objectiveRevision: input.entity.objectiveRevision,
        thought,
        threadEntries,
        rawModelOutput,
        requestTranscriptText,
        latencyMs,
        mode: "lmstudio",
        activeModel: model,
        ...(includeImage ? { viewportImageDataUrl: input.observation.viewportImageDataUrl } : {}),
        ...(normalizedToolCall !== undefined ? { toolCall: normalizedToolCall } : {}),
        ...(toolResult !== undefined ? { toolResult } : {}),
        ...(completionTokens > 0 ? { completionTokens } : {}),
        ...withOptionalNumber("completionTokensPerSecond", completionTokensPerSecond),
      };
    };

    const attemptToolTurn = async (withImage: boolean) => {
      const messages = buildMessages(withImage);
      const requestTranscriptText = renderTurnContext({
        objective: clipText(input.entity.prompt, 420),
        memorySummary: input.entity.memorySummary,
        thread: input.thread,
        observationText: input.observation.promptText,
        withImage,
      });
      const response = await this.#client.chat.completions.create({
        model,
        messages,
        tools: nativeTools,
        tool_choice: "required",
        parallel_tool_calls: false,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
      });
      const message = response.choices[0]?.message;
      if (!message) {
        throw new Error("Model returned no assistant message.");
      }

      const reasoningTrace = readReasoningContent(message);
      const thoughtCandidate = reasoningTrace || readContent(message);
      const toolCall = parseNativeToolInvocation(message.tool_calls?.[0], input.observation, thoughtCandidate);
      const rawModelOutput = JSON.stringify(
        {
          content: readAssistantTextContent(message),
          reasoning_content: reasoningTrace,
          tool_calls: message.tool_calls ?? [],
        },
        null,
        2,
      );
      if (!message.tool_calls?.length) {
        throw new Error("Model returned no tool call.");
      }
      return finalizeTurn(requestTranscriptText, rawModelOutput, thoughtCandidate, toolCall, response.usage?.completion_tokens ?? 0);
    };

    const attemptStructuredTurn = async (withImage: boolean) => {
      const messages = buildMessages(withImage);
      const requestTranscriptText = renderTurnContext({
        objective: clipText(input.entity.prompt, 420),
        memorySummary: input.entity.memorySummary,
        thread: input.thread,
        observationText: input.observation.promptText,
        withImage,
      });
      const response = await this.#client.chat.completions.create({
        model,
        messages,
        response_format: structuredDecisionFormat,
        temperature,
        top_p: topP,
        max_tokens: Math.max(maxTokens, 120),
      });
      const message = response.choices[0]?.message;
      if (!message) {
        throw new Error("Model returned no assistant message.");
      }
      const rawModelOutput = readContent(message);
      if (!rawModelOutput) {
        throw new Error("Model returned an empty structured response.");
      }

      const decision = decodeStructuredDecision(rawModelOutput);
      const toolCall = actionToToolInvocation(decision.action, input.observation, decision.thought);
      return finalizeTurn(requestTranscriptText, rawModelOutput, decision.thought, toolCall, response.usage?.completion_tokens ?? 0);
    };

    const attemptWithFallback = async <T,>(run: (withImage: boolean) => Promise<T>) => {
      try {
        return await run(includeImage);
      } catch (error) {
        if (includeImage && isImageProcessingError(error)) {
          return run(false);
        }
        throw error;
      }
    };

    try {
      if (toolMode === "native") {
        return await attemptWithFallback(attemptToolTurn);
      }
      if (toolMode === "json") {
        return await attemptWithFallback(attemptStructuredTurn);
      }

      try {
        return await attemptWithFallback(attemptToolTurn);
      } catch (toolError) {
        if (!isToolCallingError(toolError) && !isImageProcessingError(toolError)) {
          throw toolError;
        }
        return await attemptWithFallback(attemptStructuredTurn);
      }
    } catch (error) {
      this.#status.mode = "stub";
      this.#status.lastError = error instanceof Error ? error.message : String(error);
      return this.#runStubTurn(input);
    }
  }
}

export const createBrainAdapter = (config: LlmConfig) => new BrainAdapter(config);
