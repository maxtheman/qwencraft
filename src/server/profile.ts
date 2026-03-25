import OpenAI from "openai";
import { Schema } from "effect";
import { buildObservation, createInitialWorld } from "./runtime";

type ProfileResult = {
  totalLatencyMs: number;
  completionTokens: number;
  completionTokensPerSecond: number;
  actionName: string;
  thought: string;
  rawModelOutput: string;
};

const StructuredActionSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("wait"),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("inspect_patch"),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("move"),
    direction: Schema.Literal("forward", "backward", "left", "right"),
    steps: Schema.Number,
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("turn"),
    direction: Schema.Literal("left", "right"),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("place_block"),
    blockType: Schema.Literal("stone", "wood", "glass"),
    dx: Schema.Number,
    dy: Schema.Number,
    dz: Schema.Number,
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("remove_block"),
    dx: Schema.Number,
    dy: Schema.Number,
    dz: Schema.Number,
    reason: Schema.optional(Schema.String),
  }),
);

const StructuredDecisionSchema = Schema.Struct({
  thought: Schema.String,
  action: StructuredActionSchema,
});

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

const baseUrl = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
const configuredModel = process.env.LMSTUDIO_MODEL;
const runs = Number(process.env.PROFILE_RUNS ?? "3");
const temperature = Number(process.env.LMSTUDIO_TEMPERATURE ?? "0.1");
const maxTokens = Number(process.env.LMSTUDIO_MAX_TOKENS ?? "80");
const topP = Number(process.env.LMSTUDIO_TOP_P ?? "0.9");
const imageMode = process.env.LMSTUDIO_IMAGE_MODE ?? "auto";

const client = new OpenAI({
  baseURL: baseUrl,
  apiKey: process.env.LMSTUDIO_API_KEY ?? "lm-studio",
});

const readContent = (message: OpenAI.Chat.Completions.ChatCompletionMessage) => {
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

  const reasoningContent = (message as { reasoning_content?: string }).reasoning_content?.trim();
  return reasoningContent ?? "";
};

const decodeStructuredDecision = (rawResponse: string): StructuredDecision => {
  const parsed = JSON.parse(rawResponse) as unknown;
  return Schema.decodeUnknownSync(StructuredDecisionSchema)(parsed);
};

const resolveModel = async () => {
  if (configuredModel) {
    return configuredModel;
  }
  const response = await client.models.list();
  const model = response.data.find((entry) => !entry.id.startsWith("text-embedding"))?.id;
  if (!model) {
    throw new Error("LM Studio returned no chat model identifiers.");
  }
  return model;
};

const buildMessages = (): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const world = createInitialWorld();
  const builder = world.entities.builder;
  if (!builder) {
    throw new Error("Expected builder entity in profile world.");
  }

  const observation = buildObservation(world, "builder");
  return [
    {
      role: "system",
      content: [
        "You are Builder in a tiny block-building sandbox.",
        "There is no default build goal. Only act on the current objective from the operator.",
        "The runtime is authoritative. Return one local action only.",
        "Relative coordinates are in your local frame. dx is left/right, dy is forward, dz is height above the floor under you.",
        "When viewport markers are present, use the numeric beacon markers in the image together with the viewport_markers text.",
        "Use inspect_patch when the patch is unclear.",
        "Keep thought under 90 characters.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `operator_directive=${builder.prompt}\n${observation.promptText}\nviewport=${imageMode === "never" ? "text-only" : "attached"}`,
        },
        ...(imageMode === "never"
          ? []
          : [
              {
                type: "image_url" as const,
                image_url: {
                  url: observation.viewportImageDataUrl,
                  detail: "low" as const,
                },
              },
            ]),
      ],
    },
  ];
};

const runProfileTurn = async (model: string): Promise<ProfileResult> => {
  const messages = buildMessages();
  const started = performance.now();
  const response = await client.chat.completions.create({
    model,
    messages,
    response_format: structuredDecisionFormat,
    temperature,
    top_p: topP,
    max_tokens: Math.max(maxTokens, 120),
  });
  const totalLatencyMs = performance.now() - started;
  const message = response.choices[0]?.message;
  if (!message) {
    throw new Error("Model returned no assistant message.");
  }
  const rawModelOutput = readContent(message);
  if (!rawModelOutput) {
    throw new Error("Model returned an empty structured response.");
  }
  const decision = decodeStructuredDecision(rawModelOutput);
  const completionTokens = response.usage?.completion_tokens ?? 0;

  return {
    totalLatencyMs,
    completionTokens,
    completionTokensPerSecond: completionTokens > 0 ? (completionTokens / totalLatencyMs) * 1000 : 0,
    actionName: decision.action.type,
    thought: decision.thought,
    rawModelOutput,
  };
};

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

const main = async () => {
  const model = await resolveModel();
  const results: ProfileResult[] = [];

  for (let index = 0; index < runs; index += 1) {
    const result = await runProfileTurn(model);
    results.push(result);
    console.log(
      [
        `run ${index + 1}/${runs}`,
        `total=${result.totalLatencyMs.toFixed(1)}ms`,
        `completion_tokens=${result.completionTokens}`,
        `completion_tok_s=${result.completionTokensPerSecond.toFixed(2)}`,
        `action=${result.actionName}`,
        `thought=${result.thought}`,
      ].join(" | "),
    );
    console.log(`raw=${result.rawModelOutput}`);
  }

  console.log("");
  console.log(`model=${model}`);
  console.log(`baseUrl=${baseUrl}`);
  console.log(`avg_total_latency_ms=${average(results.map((result) => result.totalLatencyMs)).toFixed(1)}`);
  console.log(`avg_completion_tokens=${average(results.map((result) => result.completionTokens)).toFixed(1)}`);
  console.log(
    `avg_completion_tokens_per_second=${average(results.map((result) => result.completionTokensPerSecond)).toFixed(2)}`,
  );
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
