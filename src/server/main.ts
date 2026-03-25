import cors from "cors";
import express from "express";
import { Duration, Effect, Ref } from "effect";
import { decodeBeaconUpsertRequest, decodeEntityPatchRequest } from "../shared/contracts";
import { createBrainAdapter } from "./lmstudio";
import {
  applyBrainResult,
  buildObservation,
  createInitialWorld,
  executeTool,
  listEntityIds,
  markBrainFailure,
  patchEntity,
  removeBeacon,
  scheduleThinking,
  tickPhysics,
  upsertBeacon,
  worldSnapshot,
  type WorldRef,
} from "./runtime";

const port = Number(process.env.PORT ?? "3001");
const lmStudioModel = process.env.LMSTUDIO_MODEL;
const lmStudioToolMode =
  process.env.LMSTUDIO_TOOL_MODE === "native" || process.env.LMSTUDIO_TOOL_MODE === "json" || process.env.LMSTUDIO_TOOL_MODE === "auto"
    ? process.env.LMSTUDIO_TOOL_MODE
    : undefined;
const lmStudioImageMode =
  process.env.LMSTUDIO_IMAGE_MODE === "always" || process.env.LMSTUDIO_IMAGE_MODE === "never" || process.env.LMSTUDIO_IMAGE_MODE === "auto"
    ? process.env.LMSTUDIO_IMAGE_MODE
    : "auto";
const lmStudioTemperature = Number(process.env.LMSTUDIO_TEMPERATURE ?? "0.1");
const lmStudioMaxTokens = Number(process.env.LMSTUDIO_MAX_TOKENS ?? "80");
const lmStudioTopP = Number(process.env.LMSTUDIO_TOP_P ?? "0.9");
const brain = createBrainAdapter({
  baseUrl: process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1",
  ...(lmStudioModel ? { model: lmStudioModel } : {}),
  apiKey: process.env.LMSTUDIO_API_KEY ?? "lm-studio",
  ...(lmStudioToolMode ? { toolMode: lmStudioToolMode } : {}),
  ...(lmStudioImageMode ? { imageMode: lmStudioImageMode } : {}),
  ...(Number.isFinite(lmStudioTemperature) ? { temperature: lmStudioTemperature } : {}),
  ...(Number.isFinite(lmStudioMaxTokens) ? { maxTokens: lmStudioMaxTokens } : {}),
  ...(Number.isFinite(lmStudioTopP) ? { topP: lmStudioTopP } : {}),
});

const physicsLoop = (worldRef: WorldRef) =>
  Effect.gen(function* () {
    while (true) {
      yield* Ref.update(worldRef, tickPhysics);
      yield* Effect.sleep(Duration.millis(50));
    }
  });

const brainLoop = (worldRef: WorldRef, entityId: string, delayMs: number) =>
  Effect.gen(function* () {
    while (true) {
      const world = yield* Ref.get(worldRef);
      const entity = world.entities[entityId];
      if (entity && !entity.paused) {
        const observation = buildObservation(world, entityId);
        yield* Ref.update(worldRef, (state) => scheduleThinking(state, entityId, observation));
        const result = yield* Effect.tryPromise({
          try: () =>
            brain.runTurn({
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
                const before = await Effect.runPromise(Ref.get(worldRef));
                if (before.entities[entityId]?.objectiveRevision !== entity.objectiveRevision) {
                  return "Skipped stale action after objective update.";
                }
                const executed = executeTool(before, entityId, invocation);
                await Effect.runPromise(Ref.set(worldRef, executed.world));
                return executed.result;
              },
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          Effect.catchAll((error) => {
            return Ref.update(worldRef, (state) => markBrainFailure(state, entityId, error.message)).pipe(
              Effect.as(undefined),
            );
          }),
        );

        if (result) {
          yield* Ref.update(worldRef, (state) => applyBrainResult(state, entityId, result));
        }
      }

      yield* Effect.sleep(Duration.millis(delayMs));
    }
  });

const startServer = (worldRef: WorldRef) =>
  Effect.sync(() => {
    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get("/api/state", async (_req, res) => {
      const world = await Effect.runPromise(Ref.get(worldRef));
      res.json(worldSnapshot(world, brain.getStatus()));
    });

    app.post("/api/reset", async (_req, res) => {
      await Effect.runPromise(Ref.set(worldRef, createInitialWorld()));
      res.json({ ok: true });
    });

    app.patch("/api/entities/:entityId", async (req, res) => {
      const decodedPatch = decodeEntityPatchRequest(req.body);
      const patch = {
        ...(decodedPatch.prompt !== undefined ? { prompt: decodedPatch.prompt } : {}),
        ...(decodedPatch.paused !== undefined ? { paused: decodedPatch.paused } : {}),
        ...(decodedPatch.resetThread !== undefined ? { resetThread: decodedPatch.resetThread } : {}),
      };
      const current = await Effect.runPromise(Ref.get(worldRef));
      const updated = patchEntity(current, req.params.entityId, patch);
      if (!updated.updated) {
        res.status(404).json({ error: `Unknown entity ${req.params.entityId}` });
        return;
      }
      await Effect.runPromise(Ref.set(worldRef, updated.world));
      res.json({ ok: true });
    });

    app.post("/api/beacons", async (req, res) => {
      const payload = decodeBeaconUpsertRequest(req.body);
      const current = await Effect.runPromise(Ref.get(worldRef));
      const updated = upsertBeacon(current, payload);
      await Effect.runPromise(Ref.set(worldRef, updated.world));
      res.json({ ok: true });
    });

    app.delete("/api/beacons/:beaconId", async (req, res) => {
      const current = await Effect.runPromise(Ref.get(worldRef));
      const updated = removeBeacon(current, req.params.beaconId);
      if (!updated.updated) {
        res.status(404).json({ error: `Unknown beacon ${req.params.beaconId}` });
        return;
      }
      await Effect.runPromise(Ref.set(worldRef, updated.world));
      res.json({ ok: true });
    });

    app.listen(port, () => {
      console.log(`debug server listening on http://127.0.0.1:${port}`);
    });
  });

const program = Effect.gen(function* () {
  const worldRef = yield* Ref.make(createInitialWorld());
  yield* Effect.forkDaemon(physicsLoop(worldRef));

  const entityIds = listEntityIds(createInitialWorld());
  for (const [index, entityId] of entityIds.entries()) {
    yield* Effect.forkDaemon(brainLoop(worldRef, entityId, 1_250 + index * 350));
  }

  yield* startServer(worldRef);
  yield* Effect.never;
});

Effect.runPromise(program).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
