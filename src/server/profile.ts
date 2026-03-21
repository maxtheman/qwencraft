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

type StructuredDecision = typeof StructuredDecisionSchema.Type;

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

const baseUrl = process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
const model = process.env.LMSTUDIO_MODEL ?? "qwen35-agent";
const runs = Number(process.env.PROFILE_RUNS ?? "3");

const client = new OpenAI({
  baseURL: baseUrl,
  apiKey: process.env.LMSTUDIO_API_KEY ?? "lm-studio",
});

const readContent = (content: OpenAI.Chat.Completions.ChatCompletionMessageParam["content"] | null | undefined) => {
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

const decodeStructuredDecision = (rawResponse: string): StructuredDecision => {
  const parsed = JSON.parse(rawResponse) as unknown;
  return Schema.decodeUnknownSync(StructuredDecisionSchema)(parsed);
};

const buildMessages = (): OpenAI.Chat.Completions.ChatCompletionMessageParam[] => {
  const world = createInitialWorld();
  const alpha = world.entities.alpha;
  const bravo = world.entities.bravo;
  if (!alpha || !bravo) {
    throw new Error("Expected alpha and bravo entities in profile world.");
  }
  alpha.x = 276;
  bravo.x = 588;
  const observation = buildObservation(world, "alpha");

  return [
    {
      role: "system",
      content: [
        "You are Alpha in a side-view simulation harness.",
        "Compressed earlier context: Alpha has been trying to close on Bravo but needs cleaner jump setup.",
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
      ].join("\n"),
    },
    {
      role: "user",
      content:
        "Observation: urgent=RIGHT obstacle 64px away; jump is viable.\nself=x:232 y:360 ground:true paused:false\nvisible=bravo:right:356:los=true\nobstacles=right:64:h=64:jump=true\nlast=Movement blocked by nearby geometry.\nrecent=Movement blocked by an obstacle. | Jumped right.\nViewport image attached.",
    },
    {
      role: "assistant",
      content:
        'thought=Bravo is close; jump over the 64px gap to maintain momentum. | action=jump | args={"direction":"right","distance":96,"strength":320} | result=Scheduled jump right for 96px at strength 320.',
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${observation.promptText}\nviewport=attached`,
        },
        {
          type: "image_url",
          image_url: {
            url: observation.viewportImageDataUrl,
            detail: "low",
          },
        },
      ],
    },
  ];
};

const runProfileTurn = async (): Promise<ProfileResult> => {
  const messages = buildMessages();
  const started = performance.now();
  const response = await client.chat.completions.create({
    model,
    messages,
    response_format: structuredDecisionFormat,
    temperature: 0.2,
    max_tokens: 96,
  });
  const totalLatencyMs = performance.now() - started;
  const rawModelOutput = readContent(response.choices[0]?.message?.content);
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
  const results: ProfileResult[] = [];

  for (let index = 0; index < runs; index += 1) {
    const result = await runProfileTurn();
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
