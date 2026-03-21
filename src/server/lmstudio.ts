import OpenAI from "openai";
import { Schema } from "effect";
import type { RuntimeMode } from "../shared/contracts";
import type { BrainResult, ThreadMessage, ToolInvocation, ViewObservation, VisibleEntity } from "./runtime";

type BrainInput = {
  entity: {
    id: string;
    name: string;
    prompt: string;
    memorySummary: string;
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
};

const withOptionalString = <Key extends string>(key: Key, value: string | undefined) =>
  value !== undefined ? ({ [key]: value } as Record<Key, string>) : {};

const withOptionalNumber = <Key extends string>(key: Key, value: number | undefined) =>
  value !== undefined ? ({ [key]: value } as Record<Key, number>) : {};

const MoveArgs = Schema.Struct({
  direction: Schema.Literal("left", "right"),
  distance: Schema.Number,
});

const JumpArgs = Schema.Struct({
  direction: Schema.Literal("left", "right"),
  distance: Schema.Number,
  strength: Schema.Number,
});

const ApproachArgs = Schema.Struct({
  entityId: Schema.String,
  stopWithin: Schema.Number,
});

const StructuredActionSchema = Schema.Struct({
  type: Schema.Literal("wait", "inspect_view", "move", "jump", "approach_entity"),
  direction: Schema.optional(Schema.Literal("left", "right")),
  distance: Schema.optional(Schema.Number),
  strength: Schema.optional(Schema.Number),
  entityId: Schema.optional(Schema.String),
  stopWithin: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
});

const StructuredDecisionSchema = Schema.Struct({
  thought: Schema.String,
  action: StructuredActionSchema,
});

type StructuredAction = typeof StructuredActionSchema.Type;
type StructuredDecision = typeof StructuredDecisionSchema.Type;
type PromptOverride = {
  thought?: string;
  toolCall?: ToolInvocation;
};
type ParsedPromptDirective = {
  thought?: string;
  toolCall?: ToolInvocation;
  hasActionDirective: boolean;
};

const structuredDecisionFormat = {
  type: "json_schema",
  json_schema: {
    name: "brain_turn",
    strict: true,
    schema: {
      type: "object",
      properties: {
        thought: { type: "string" },
        action: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["wait", "inspect_view", "move", "jump", "approach_entity"],
            },
            direction: { type: "string", enum: ["left", "right"] },
            distance: { type: "number" },
            strength: { type: "number" },
            entityId: { type: "string" },
            stopWithin: { type: "number" },
            reason: { type: "string" },
          },
          required: ["type"],
          additionalProperties: false,
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

const readContent = (content: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam["content"] | null | undefined) => {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => ("text" in item ? item.text : ""))
      .join(" ")
      .trim();
  }

  return "";
};

const clipThought = (text: string) => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 88) {
    return compact || "Holding position.";
  }
  return `${compact.slice(0, 85).trimEnd()}...`;
};

const normalizePublicThought = (candidate: string, fallback: string) => {
  const compact = candidate.replace(/\s+/g, " ").trim();
  if (!compact || compact.startsWith("TOOL_CALL") || compact.startsWith("{") || compact.includes("\"direction\"")) {
    return clipThought(fallback);
  }
  return clipThought(compact);
};

const clipText = (text: string, limit: number) => {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
};

const toChatHistoryRole = (role: ThreadMessage["role"]): "user" | "assistant" => (role === "assistant" ? "assistant" : "user");

const buildHistoryMessages = (thread: ThreadMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] =>
  thread.map((message) => ({
    role: toChatHistoryRole(message.role),
    content: clipText(message.content, 420),
  }));

const buildObservationHistoryEntry = (observation: ViewObservation): ThreadMessage => ({
  role: "user",
  content: clipText(`Observation:\n${observation.promptText}\nViewport image attached.`, 520),
});

const renderRequestTranscript = (messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]) =>
  messages
    .map((message) => {
      const content =
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .map((part) => {
                if (part.type === "text") {
                  return part.text;
                }
                if (part.type === "image_url") {
                  return `[image attached detail=${part.image_url.detail ?? "auto"}]`;
                }
                return `[${part.type}]`;
              })
              .join("\n");
      return `[${message.role}]\n${content}`;
    })
    .join("\n\n");

const readPromptThoughtDirective = (prompt: string) => {
  const explicitMatch = prompt.match(/thought(?:\s*[:=]|\s+is\s+)\s*"([^"]{1,90})"/i);
  if (explicitMatch?.[1]) {
    return clipThought(explicitMatch[1]);
  }

  if (/scream/i.test(prompt)) {
    return "SCREAM";
  }

  return undefined;
};

const readPromptActionDirective = (prompt: string): ToolInvocation | undefined => {
  const normalized = prompt.toLowerCase();
  const actionType = prompt.match(/action\.type\s*=\s*["']?([a-z_]+)["']?/i)?.[1]?.toLowerCase();
  const direction = prompt.match(/direction\s*=\s*["']?(left|right)["']?/i)?.[1]?.toLowerCase() as
    | "left"
    | "right"
    | undefined;
  const distance = Number(prompt.match(/distance\s*=\s*(\d+)/i)?.[1] ?? Number.NaN);
  const strength = Number(prompt.match(/strength\s*=\s*(\d+)/i)?.[1] ?? Number.NaN);
  const entityId = prompt.match(/entityid\s*=\s*["']?([a-z0-9_-]+)["']?/i)?.[1];
  const stopWithin = Number(prompt.match(/stopwithin\s*=\s*(\d+)/i)?.[1] ?? Number.NaN);

  if (actionType === "wait" || /always wait|hold position|stay still|do not move/.test(normalized)) {
    return undefined;
  }

  if (actionType === "inspect_view") {
    return { name: "inspect_view", args: {} };
  }

  if (actionType === "move" && direction) {
    return {
      name: "move",
      args: {
        direction,
        distance: Number.isFinite(distance) ? distance : 80,
      },
    };
  }

  if (actionType === "jump" && direction) {
    return {
      name: "jump",
      args: {
        direction,
        distance: Number.isFinite(distance) ? distance : 120,
        strength: Number.isFinite(strength) ? strength : 320,
      },
    };
  }

  if (actionType === "approach_entity" && entityId) {
    return {
      name: "approach_entity",
      args: {
        entityId,
        stopWithin: Number.isFinite(stopWithin) ? stopWithin : 72,
      },
    };
  }

  return undefined;
};

const readPromptDirective = (prompt: string): ParsedPromptDirective | undefined => {
  const thought = readPromptThoughtDirective(prompt);
  const hasActionDirective =
    /action\.type\s*=/.test(prompt) || /always wait|hold position|stay still|do not move/i.test(prompt);
  const toolCall = hasActionDirective ? readPromptActionDirective(prompt) : undefined;

  if (thought === undefined && !hasActionDirective) {
    return undefined;
  }

  return {
    ...(thought !== undefined ? { thought } : {}),
    ...(toolCall !== undefined ? { toolCall } : {}),
    hasActionDirective,
  };
};

const readPromptOverride = (prompt: string): PromptOverride | undefined => {
  const overridePrefix = prompt.match(/^\s*(?:@override|override:)\s*/i);
  if (!overridePrefix) {
    return undefined;
  }

  const directiveBody = prompt.slice(overridePrefix[0].length);
  const parsed = readPromptDirective(directiveBody);
  if (!parsed) {
    return undefined;
  }

  return {
    ...(parsed.thought !== undefined ? { thought: parsed.thought } : {}),
    ...(parsed.toolCall !== undefined ? { toolCall: parsed.toolCall } : {}),
  };
};

const readStubPromptDirective = (prompt: string, observation: ViewObservation): ToolInvocation | undefined => {
  const normalized = prompt.toLowerCase();

  if (/inspect|scan|look around/.test(normalized)) {
    return { name: "inspect_view", args: {} };
  }

  if (/wait|hold position|stay still|do nothing/.test(normalized)) {
    return undefined;
  }

  if (/approach bravo/.test(normalized) && observation.visibleEntities.some((candidate) => candidate.id === "bravo")) {
    return { name: "approach_entity", args: { entityId: "bravo", stopWithin: 64 } };
  }

  if (/approach alpha/.test(normalized) && observation.visibleEntities.some((candidate) => candidate.id === "alpha")) {
    return { name: "approach_entity", args: { entityId: "alpha", stopWithin: 64 } };
  }

  if (/move left|go left|only left/.test(normalized)) {
    return { name: "move", args: { direction: "left", distance: 80 } };
  }

  if (/move right|go right|only right/.test(normalized)) {
    return { name: "move", args: { direction: "right", distance: 80 } };
  }

  return undefined;
};

const decodeTool = (name: string, rawArguments: string): ToolInvocation => {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  switch (name) {
    case "inspect_view":
      return { name: "inspect_view", args: {} };
    case "move":
      return { name: "move", args: Schema.decodeUnknownSync(MoveArgs)(parsed) };
    case "jump":
      return { name: "jump", args: Schema.decodeUnknownSync(JumpArgs)(parsed) };
    case "approach_entity":
      return { name: "approach_entity", args: Schema.decodeUnknownSync(ApproachArgs)(parsed) };
    default:
      throw new Error(`Unsupported tool: ${name}`);
  }
};

const decodeStructuredDecision = (rawResponse: string): StructuredDecision => {
  const parsed = JSON.parse(rawResponse) as unknown;
  return Schema.decodeUnknownSync(StructuredDecisionSchema)(parsed);
};

const summarizeTurn = (thought: string, toolCall?: ToolInvocation, toolResult?: string) =>
  [
    `thought=${thought}`,
    `action=${toolCall?.name ?? "wait"}`,
    ...(toolCall ? [`args=${JSON.stringify(toolCall.args)}`] : []),
    ...(toolResult ? [`result=${toolResult}`] : []),
  ]
    .join(" | ")
    .slice(0, 220);

const chooseTarget = (visibleEntities: VisibleEntity[]) =>
  visibleEntities.find((candidate) => candidate.lineOfSight) ?? visibleEntities[0];

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const findTargetById = (visibleEntities: VisibleEntity[], entityId: string | undefined) =>
  entityId ? visibleEntities.find((candidate) => candidate.id === entityId) : undefined;

const inferDirection = (action: StructuredAction, observation: ViewObservation) => {
  if (action.direction) {
    return action.direction;
  }
  const target = findTargetById(observation.visibleEntities, action.entityId) ?? chooseTarget(observation.visibleEntities);
  if (target) {
    return target.direction;
  }
  const immediateObstacle = observation.obstacleHints.find((hint) => hint.distance < 90);
  if (immediateObstacle) {
    return immediateObstacle.direction;
  }
  return "right" as const;
};

const inferDistance = (action: StructuredAction, observation: ViewObservation, fallback: number, max: number) => {
  if (action.distance !== undefined) {
    return action.distance;
  }
  const target = findTargetById(observation.visibleEntities, action.entityId) ?? chooseTarget(observation.visibleEntities);
  if (target) {
    return clamp(Math.round(target.distance * 0.45), 40, max);
  }
  const immediateObstacle = observation.obstacleHints.find((hint) => hint.direction === inferDirection(action, observation));
  if (immediateObstacle) {
    return clamp(immediateObstacle.distance + 48, 40, max);
  }
  return fallback;
};

const actionToToolInvocation = (action: StructuredAction, observation: ViewObservation): ToolInvocation | undefined => {
  switch (action.type) {
    case "wait":
      return undefined;
    case "inspect_view":
      return { name: "inspect_view", args: {} };
    case "move":
      if (action.entityId && (action.direction === undefined || action.distance === undefined)) {
        return {
          name: "approach_entity",
          args: Schema.decodeUnknownSync(ApproachArgs)({
            entityId: action.entityId,
            stopWithin: action.stopWithin ?? 72,
          }),
        };
      }
      return {
        name: "move",
        args: Schema.decodeUnknownSync(MoveArgs)({
          direction: inferDirection(action, observation),
          distance: inferDistance(action, observation, 80, 240),
        }),
      };
    case "jump":
      return {
        name: "jump",
        args: Schema.decodeUnknownSync(JumpArgs)({
          direction: inferDirection(action, observation),
          distance: inferDistance(action, observation, 120, 220),
          strength: action.strength ?? 320,
        }),
      };
    case "approach_entity": {
      const targetId =
        action.entityId ??
        findTargetById(observation.visibleEntities, action.entityId)?.id ??
        chooseTarget(observation.visibleEntities)?.id;
      if (!targetId) {
        return undefined;
      }
      return {
        name: "approach_entity",
        args: Schema.decodeUnknownSync(ApproachArgs)({
          entityId: targetId,
          stopWithin: action.stopWithin ?? 72,
        }),
      };
    }
  }
};

const makeStubThought = (input: BrainInput, toolCall?: ToolInvocation, toolResult?: string) => {
  const directedThought = readPromptThoughtDirective(input.entity.prompt);
  if (directedThought) {
    return directedThought;
  }
  if (toolCall?.name === "approach_entity") {
    return `Closing on ${toolCall.args.entityId}; keeping line of sight.`;
  }
  if (toolCall?.name === "jump") {
    return `Jumping ${toolCall.args.direction}; geometry is getting tight.`;
  }
  if (toolCall?.name === "move") {
    return `Walking ${toolCall.args.direction} ${toolCall.args.distance}px.`;
  }
  if (toolResult) {
    return toolResult;
  }
  return input.observation.urgentHints[0] ?? "Scanning the room.";
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
    const requestTranscriptText = [
      "[system]",
      `Stub fallback for ${input.entity.name}.`,
      "",
      "[user]",
      input.observation.promptText,
      "[image attached detail=low]",
    ].join("\n");
    const threadEntries: ThreadMessage[] = [buildObservationHistoryEntry(input.observation)];
    let toolCall: ToolInvocation | undefined;
    let toolResult: string | undefined;

    const promptDirectedTool = readStubPromptDirective(input.entity.prompt, input.observation);

    if (promptDirectedTool !== undefined || /wait|hold position|stay still|do nothing/i.test(input.entity.prompt)) {
      toolCall = promptDirectedTool;
    } else {
      const immediateObstacle = input.observation.obstacleHints.find((hint) => hint.distance < 90 && hint.jumpRecommended);
      const target = chooseTarget(input.observation.visibleEntities);

      if (immediateObstacle) {
        toolCall = {
          name: "jump",
          args: {
            direction: immediateObstacle.direction,
            distance: 120,
            strength: 320,
          },
        };
      } else if (target) {
        toolCall = {
          name: "approach_entity",
          args: {
            entityId: target.id,
            stopWithin: target.distance > 140 ? 90 : 42,
          },
        };
      } else {
        toolCall = {
          name: "move",
          args: {
            direction: Math.random() > 0.5 ? "right" : "left",
            distance: 80,
          },
        };
      }
    }

    toolResult = toolCall ? await input.toolExecutor(toolCall) : "Holding position by prompt directive.";
    const thought = normalizePublicThought(makeStubThought(input, toolCall, toolResult), "Holding position.");
    threadEntries.push({
      role: "assistant",
      content: summarizeTurn(thought, toolCall, toolResult),
    });

    const rawModelOutput = JSON.stringify({
      thought,
      action:
        toolCall === undefined
          ? { type: "wait", reason: "stub fallback" }
          : { type: toolCall.name, ...toolCall.args },
    });

    return {
      thought,
      threadEntries,
      rawModelOutput,
      requestTranscriptText,
      latencyMs: performance.now() - started,
      mode: "stub",
      viewportImageDataUrl: input.observation.viewportImageDataUrl,
      ...(toolCall !== undefined ? { toolCall } : {}),
      ...(toolResult !== undefined ? { toolResult } : {}),
    };
  }

  async #runPromptOverrideTurn(
    input: BrainInput,
    override: PromptOverride,
    mode: LlmStatus["mode"],
  ): Promise<BrainResult> {
    const started = performance.now();
    const requestTranscriptText = [
      "[system]",
      `Prompt override for ${input.entity.name}.`,
      "",
      "[user]",
      input.observation.promptText,
      "[image attached detail=low]",
    ].join("\n");
    const threadEntries: ThreadMessage[] = [buildObservationHistoryEntry(input.observation)];
    const toolResult = override.toolCall ? await input.toolExecutor(override.toolCall) : "Holding position by prompt directive.";
    const thought = normalizePublicThought(
      override.thought ?? makeStubThought(input, override.toolCall, toolResult),
      "Holding position by prompt directive.",
    );
    threadEntries.push({
      role: "assistant",
      content: summarizeTurn(thought, override.toolCall, toolResult),
    });

    return {
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
      viewportImageDataUrl: input.observation.viewportImageDataUrl,
      ...(override.toolCall !== undefined ? { toolCall: override.toolCall } : {}),
      ...(toolResult !== undefined ? { toolResult } : {}),
    };
  }

  async runTurn(input: BrainInput): Promise<BrainResult> {
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
    const threadEntries: ThreadMessage[] = [buildObservationHistoryEntry(input.observation)];

    const systemPrompt = [
      `You are ${input.entity.name} (${input.entity.id}) in a side-view simulation harness.`,
      `Compressed earlier context: ${clipText(input.entity.memorySummary, 220)}`,
      "The latest user message contains an OPERATOR DIRECTIVE. Treat it as the current objective and style update.",
      "You receive up to four recent turns of chat history plus the latest viewport image.",
      "Return one JSON object with a short public thought and one action.",
      "Use action.type='wait' if no action is needed.",
      "If action.type is move or jump, include direction and distance.",
      "If action.type is approach_entity, include entityId and stopWithin.",
      "Prefer short moves and only jump when obstacle advisories indicate it is needed.",
      "If the latest observation includes repeat_warning or blocked movement, do not repeat the same action and args.",
      "When stuck, inspect_view or choose a materially different action type or direction.",
      "Use visible entity IDs when selecting a target.",
      "Keep thought under 90 characters.",
    ].join("\n");

    const historyMessages = buildHistoryMessages(input.thread);
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `operator_directive=${input.entity.prompt}\n${input.observation.promptText}\nviewport=attached`,
          },
          {
            type: "image_url",
            image_url: {
              url: input.observation.viewportImageDataUrl,
              detail: "low",
            },
          },
        ],
      },
    ];
    const requestTranscriptText = renderRequestTranscript(messages);

    try {
      const response = await this.#client.chat.completions.create({
        model,
        messages,
        response_format: structuredDecisionFormat,
        temperature: 0.2,
        max_tokens: 96,
      });
      const rawModelOutput = readContent(response.choices[0]?.message?.content);
      if (!rawModelOutput) {
        throw new Error("Model returned an empty structured response.");
      }
      const decision = decodeStructuredDecision(rawModelOutput);
      const toolCall = actionToToolInvocation(decision.action, input.observation);
      const toolResult = toolCall ? await input.toolExecutor(toolCall) : decision.action.reason ?? "No action requested.";
      const fallbackThought = toolCall
        ? makeStubThought(input, toolCall, toolResult)
        : decision.action.reason ?? makeStubThought(input);
      const thought = normalizePublicThought(decision.thought, fallbackThought);
      const completionTokens = response.usage?.completion_tokens ?? 0;

      threadEntries.push({
        role: "assistant",
        content: summarizeTurn(thought, toolCall, toolResult),
      });
      const latencyMs = performance.now() - started;
      const completionTokensPerSecond = completionTokens > 0 && latencyMs > 0 ? (completionTokens / latencyMs) * 1000 : undefined;
      this.#status.mode = "lmstudio";
      this.#status.activeModel = model;
      delete this.#status.lastError;

      return {
        thought,
        threadEntries,
        rawModelOutput,
        requestTranscriptText,
        latencyMs,
        mode: "lmstudio",
        activeModel: model,
        viewportImageDataUrl: input.observation.viewportImageDataUrl,
        ...(toolCall !== undefined ? { toolCall } : {}),
        ...(toolResult !== undefined ? { toolResult } : {}),
        ...(completionTokens > 0 ? { completionTokens } : {}),
        ...withOptionalNumber("completionTokensPerSecond", completionTokensPerSecond),
      };
    } catch (error) {
      this.#status.mode = "stub";
      this.#status.lastError = error instanceof Error ? error.message : String(error);
      return this.#runStubTurn(input);
    }
  }
}

export const createBrainAdapter = (config: LlmConfig) => new BrainAdapter(config);
