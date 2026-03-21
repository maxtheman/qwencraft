import { useEffect, useMemo, useState } from "react";
import {
  decodeErrorResponse,
  decodeWorldSnapshot,
  type EntityPatchRequest,
  type EntitySnapshot,
  type WorldSnapshot,
} from "../shared/contracts";

type PromptState = Record<string, string>;

const pollState = async () => {
  const response = await fetch("/api/state");
  if (!response.ok) {
    throw new Error(`Failed to fetch state: ${response.status}`);
  }
  return decodeWorldSnapshot(await response.json());
};

const patchEntity = async (entityId: string, patch: EntityPatchRequest) => {
  const response = await fetch(`/api/entities/${entityId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });

  if (!response.ok) {
    const payload = decodeErrorResponse(await response.json());
    throw new Error(payload.error ?? "Failed to patch entity.");
  }
};

const formatTool = (entity: EntitySnapshot) =>
  entity.lastToolCall ? `${entity.lastToolCall.name} ${JSON.stringify(entity.lastToolCall.args)}` : "none";

const formatTraceTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const RoomView = ({ snapshot }: { snapshot: WorldSnapshot }) => {
  const roomInset = 18;
  const roomPadding = 12;
  const innerLeft = roomInset + roomPadding;
  const innerRight = snapshot.width - roomInset - roomPadding;
  const innerTop = roomInset + roomPadding;
  const innerBottom = snapshot.height - roomInset - roomPadding;
  const bubbleWidth = 220;
  const bubbleHeight = 76;
  const clipId = "room-content-clip";

  return (
    <svg viewBox={`0 0 ${snapshot.width} ${snapshot.height}`} className="room-view" role="img" aria-label="Simulation room">
      <defs>
        <linearGradient id="roomBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#081221" />
          <stop offset="100%" stopColor="#15324f" />
        </linearGradient>
        <linearGradient id="floorGlow" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.8" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x={innerLeft} y={innerTop} width={innerRight - innerLeft} height={innerBottom - innerTop} rx={12} />
        </clipPath>
      </defs>

      <rect x={0} y={0} width={snapshot.width} height={snapshot.height} rx={18} fill="url(#roomBg)" />
      <rect x={18} y={18} width={snapshot.width - 36} height={snapshot.height - 36} rx={14} fill="#113d67" stroke="#7dd3fc" strokeWidth={4} />
      <rect x={18} y={snapshot.floorY + 4} width={snapshot.width - 36} height={12} fill="url(#floorGlow)" />
      <text x={snapshot.width - 260} y={56} className="room-title">
        Debug Habitat
      </text>

      <g clipPath={`url(#${clipId})`}>
        {snapshot.obstacles.map((obstacle) => (
          <g key={obstacle.id}>
            <rect
              x={obstacle.x}
              y={obstacle.y}
              width={obstacle.width}
              height={obstacle.height}
              rx={8}
              fill="#1d4e89"
              stroke="#93c5fd"
              strokeWidth={3}
            />
            <text x={clamp(obstacle.x + 8, innerLeft + 8, innerRight - 120)} y={Math.max(obstacle.y - 8, innerTop + 18)} className="obstacle-label">
              {obstacle.id}
            </text>
          </g>
        ))}

        {snapshot.entities.map((entity) => {
          const entityX = clamp(entity.x, innerLeft + entity.width / 2, innerRight - entity.width / 2);
          const entityY = clamp(entity.y, innerTop + entity.height, snapshot.floorY);
          const bubbleX = clamp(entityX - bubbleWidth / 2, innerLeft + 4, innerRight - bubbleWidth - 4);
          const bubbleY = clamp(entityY - entity.height - 106, innerTop + 4, innerBottom - bubbleHeight - 4);
          const targetBadgeX = clamp(entityX, innerLeft + 60, innerRight - 60);

          return (
            <g key={entity.id}>
              {entity.targetEntityId ? (
                <text x={targetBadgeX} y={Math.max(entityY - entity.height - 54, innerTop + 18)} textAnchor="middle" className="target-badge">
                  target: {entity.targetEntityId}
                </text>
              ) : null}
              <foreignObject x={bubbleX} y={bubbleY} width={bubbleWidth} height={bubbleHeight}>
                <div className="thought-bubble">{entity.visibleThought}</div>
              </foreignObject>
              <rect
                x={entityX - entity.width / 2}
                y={entityY - entity.height}
                width={entity.width}
                height={entity.height}
                rx={8}
                fill={entity.color}
                stroke="#020617"
                strokeWidth={3}
              />
              <rect
                x={entityX - entity.width / 2}
                y={entityY - entity.height}
                width={entity.width}
                height={10}
                rx={6}
                fill="rgba(255,255,255,0.25)"
              />
              <text x={entityX} y={Math.min(entityY + 22, innerBottom - 8)} textAnchor="middle" className="entity-label">
                {entity.id}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
};

export const App = () => {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<PromptState>({});
  const [savingEntityId, setSavingEntityId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await pollState();
        if (cancelled) {
          return;
        }
        setSnapshot(next);
        setError(null);
        setPromptDrafts((current) => {
          const merged = { ...current };
          for (const entity of next.entities) {
            if (!(entity.id in merged)) {
              merged[entity.id] = entity.prompt;
            }
          }
          return merged;
        });
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const sortedEntities = useMemo(() => snapshot?.entities.slice().sort((a, b) => a.x - b.x) ?? [], [snapshot]);

  const handleSave = async (entityId: string) => {
    const prompt = promptDrafts[entityId];
    if (prompt === undefined) {
      setError(`Missing prompt draft for ${entityId}.`);
      return;
    }
    setSavingEntityId(entityId);
    try {
      await patchEntity(entityId, { prompt });
      const next = await pollState();
      setSnapshot(next);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingEntityId(null);
    }
  };

  const handleTogglePause = async (entity: EntitySnapshot) => {
    try {
      await patchEntity(entity.id, { paused: !entity.paused });
      const next = await pollState();
      setSnapshot(next);
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : String(pauseError));
    }
  };

  const handleResetThread = async (entityId: string) => {
    try {
      await patchEntity(entityId, { resetThread: true });
      const next = await pollState();
      setSnapshot(next);
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    }
  };

  if (!snapshot) {
    return <div className="shell">Loading simulation...</div>;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Local Agent Harness</div>
          <h1>Effect Runtime Debug UI</h1>
        </div>
        <div className="metrics-grid">
          <div className="metric-card">
            <span>Physics TPS</span>
            <strong>{snapshot.metrics.physicsTicksPerSecond}</strong>
          </div>
          <div className="metric-card">
            <span>Brain turns/s</span>
            <strong>{snapshot.metrics.brainTurnsPerSecond}</strong>
          </div>
          <div className="metric-card">
            <span>Avg brain latency</span>
            <strong>{snapshot.metrics.averageBrainLatencyMs} ms</strong>
          </div>
          <div className="metric-card">
            <span>Completion tok/s</span>
            <strong>{snapshot.metrics.averageCompletionTokensPerSecond || "n/a"}</strong>
          </div>
        </div>
      </header>

      <section className="status-strip">
        <span className={`pill pill-${snapshot.llm.mode}`}>{snapshot.llm.mode.toUpperCase()}</span>
        <span>Base URL: {snapshot.llm.baseUrl}</span>
        <span>Configured model: {snapshot.llm.configuredModel || "auto-discover"}</span>
        <span>Active model: {snapshot.llm.activeModel || "stub policy"}</span>
        <span>Last error: {snapshot.llm.lastError || "none"}</span>
      </section>

      {error ? <section className="error-banner">{error}</section> : null}

      <main className="content-grid">
        <section className="room-panel">
          <RoomView snapshot={snapshot} />
        </section>

        <section className="inspector-panel">
          {sortedEntities.map((entity) => (
            <article key={entity.id} className="entity-card">
              <div className="entity-card-header">
                <div>
                  <span className="swatch" style={{ backgroundColor: entity.color }} />
                  <h2>
                    {entity.name} <code>{entity.id}</code>
                  </h2>
                </div>
                <span className={`status status-${entity.status}`}>{entity.status}</span>
              </div>

              <label className="field">
                <span>Prompt</span>
                <textarea
                  value={promptDrafts[entity.id] ?? entity.prompt}
                  onChange={(event) =>
                    setPromptDrafts((current) => ({
                      ...current,
                      [entity.id]: event.target.value,
                    }))
                  }
                />
              </label>

              <div className="button-row">
                <button onClick={() => void handleSave(entity.id)} disabled={savingEntityId === entity.id}>
                  {savingEntityId === entity.id ? "Saving..." : "Save prompt"}
                </button>
                <button onClick={() => void handleTogglePause(entity)}>{entity.paused ? "Resume" : "Pause"}</button>
                <button className="secondary" onClick={() => void handleResetThread(entity.id)}>
                  Reset thread
                </button>
              </div>

              <dl className="entity-stats">
                <div>
                  <dt>Position</dt>
                  <dd>
                    {Math.round(entity.x)}, {Math.round(entity.y)}
                  </dd>
                </div>
                <div>
                  <dt>On ground</dt>
                  <dd>{String(entity.onGround)}</dd>
                </div>
                <div>
                  <dt>Thread messages</dt>
                  <dd>{entity.threadLength}</dd>
                </div>
                <div>
                  <dt>Last tool</dt>
                  <dd>{formatTool(entity)}</dd>
                </div>
              </dl>

              <div className="stack">
                <section>
                  <h3>Viewport</h3>
                  {entity.lastViewportImageDataUrl ? (
                    <img className="viewport-preview" src={entity.lastViewportImageDataUrl} alt={`${entity.name} viewport`} />
                  ) : (
                    <p>No viewport captured yet.</p>
                  )}
                </section>

                <section>
                  <h3>Last action result</h3>
                  <p>{entity.lastActionResult || "none"}</p>
                </section>

                <section>
                  <h3>Last observation</h3>
                  <pre>{entity.lastObservation}</pre>
                </section>

                <section>
                  <h3>Recent events</h3>
                  <ul>
                    {entity.recentEvents.map((event) => (
                      <li key={event}>{event}</li>
                    ))}
                  </ul>
                </section>

                <section>
                  <h3>Traces</h3>
                  <div className="trace-list">
                    {entity.traces.length === 0 ? <p>No traces yet.</p> : null}
                    {entity.traces.map((trace) => (
                      <article key={trace.id} className="trace-card">
                        <div className="trace-meta">
                          <span>{formatTraceTime(trace.timestamp)}</span>
                          <span>{trace.mode}</span>
                          <span>{trace.latencyMs.toFixed(1)} ms</span>
                          <span>{trace.completionTokensPerSecond?.toFixed(2) ?? "n/a"} tok/s</span>
                        </div>
                        <p>
                          <strong>thought:</strong> {trace.thought}
                        </p>
                        <p>
                          <strong>action:</strong> {trace.actionName}
                          {trace.actionArgs ? ` ${JSON.stringify(trace.actionArgs)}` : ""}
                        </p>
                        <p>
                          <strong>result:</strong> {trace.actionResult ?? "none"}
                        </p>
                        <details>
                          <summary>Prompt</summary>
                          <pre>{trace.promptText}</pre>
                        </details>
                        {trace.viewportImageDataUrl ? (
                          <details>
                            <summary>Viewport</summary>
                            <img className="viewport-preview" src={trace.viewportImageDataUrl} alt={`${entity.name} trace viewport`} />
                          </details>
                        ) : null}
                        <details>
                          <summary>Raw model output</summary>
                          <pre>{trace.rawModelOutput}</pre>
                        </details>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
};
