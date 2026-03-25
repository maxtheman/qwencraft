import { type MouseEvent, useEffect, useMemo, useState } from "react";
import {
  decodeErrorResponse,
  decodeWorldSnapshot,
  type BlockSnapshot,
  type BrainTraceSnapshot,
  type EntityPatchRequest,
  type EntitySnapshot,
  type WorldSnapshot,
} from "../shared/contracts";

type PromptState = Record<string, string>;
type TileSelection = {
  x: number;
  y: number;
};

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

const upsertBeacon = async (input: { x: number; y: number; label: string }) => {
  const response = await fetch("/api/beacons", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const payload = decodeErrorResponse(await response.json());
    throw new Error(payload.error ?? "Failed to save beacon.");
  }
};

const deleteBeacon = async (beaconId: string) => {
  const response = await fetch(`/api/beacons/${beaconId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const payload = decodeErrorResponse(await response.json());
    throw new Error(payload.error ?? "Failed to remove beacon.");
  }
};

const resetWorld = async () => {
  const response = await fetch("/api/reset", {
    method: "POST",
  });

  if (!response.ok) {
    const payload = decodeErrorResponse(await response.json());
    throw new Error(payload.error ?? "Failed to reset world.");
  }
};

const formatTraceTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const VIEWBOX_WIDTH = 1040;
const VIEWBOX_HEIGHT = 760;
const TILE_WIDTH = 56;
const TILE_HEIGHT = 28;
const BLOCK_HEIGHT = 22;
const THOUGHT_BUBBLE_WIDTH = 214;
const THOUGHT_BUBBLE_HEIGHT = 74;
const ORIGIN_X = VIEWBOX_WIDTH / 2;
const ORIGIN_Y = 166;
const toIso = (x: number, y: number, z: number) => ({
  x: ORIGIN_X + (x - y) * (TILE_WIDTH / 2),
  y: ORIGIN_Y + (x + y) * (TILE_HEIGHT / 2) - z * BLOCK_HEIGHT,
});

const screenToTile = (screenX: number, screenY: number): TileSelection => {
  const centeredY = screenY - ORIGIN_Y - TILE_HEIGHT / 2;
  const projectedX = (screenX - ORIGIN_X) / (TILE_WIDTH / 2);
  const projectedY = centeredY / (TILE_HEIGHT / 2);
  const x = Math.round((projectedX + projectedY) / 2);
  const y = Math.round((projectedY - projectedX) / 2);
  return { x, y };
};

const tileDiamondPoints = (x: number, y: number) => {
  const top = toIso(x, y, 0);
  return [
    [top.x, top.y],
    [top.x + TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2],
    [top.x, top.y + TILE_HEIGHT],
    [top.x - TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2],
  ] as const;
};

const blockFill = (type: BlockSnapshot["type"]) => {
  switch (type) {
    case "grass":
      return { top: "#5ee173", left: "#2c8741", right: "#439c54" };
    case "stone":
      return { top: "#d8dee9", left: "#7c8799", right: "#a8b3c4" };
    case "wood":
      return { top: "#f2a65a", left: "#8a4b14", right: "#c6701a" };
    case "glass":
      return { top: "#d9fbff", left: "#67d8f7", right: "#9cecfb" };
  }
};

const blockSort = (a: BlockSnapshot, b: BlockSnapshot) =>
  a.x + a.y + a.z - (b.x + b.y + b.z) || a.z - b.z || a.x - b.x || a.y - b.y;

const blockKey = (block: Pick<BlockSnapshot, "x" | "y" | "z">) => `${block.x},${block.y},${block.z}`;

const formatTool = (entity: EntitySnapshot) =>
  entity.lastToolCall ? `${entity.lastToolCall.name} ${JSON.stringify(entity.lastToolCall.args)}` : "none";

const MetricChip = ({ label, value }: { label: string; value: string | number }) => (
  <div className="metric-chip">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const MiniMap = ({ snapshot, activeEntityId }: { snapshot: WorldSnapshot; activeEntityId?: string }) => {
  const cellSize = 13;
  const mapWidth = snapshot.gridWidth * cellSize;
  const mapHeight = snapshot.gridDepth * cellSize;

  const highest = new Map<string, BlockSnapshot>();
  for (const block of snapshot.blocks) {
    const key = `${block.x},${block.y}`;
    const current = highest.get(key);
    if (!current || current.z <= block.z) {
      highest.set(key, block);
    }
  }

  return (
    <svg viewBox={`0 0 ${mapWidth} ${mapHeight}`} className="minimap" role="img" aria-label="Build plate minimap">
      <rect x={0} y={0} width={mapWidth} height={mapHeight} rx={12} fill="rgba(2, 6, 23, 0.9)" />
      {Array.from({ length: snapshot.gridWidth * snapshot.gridDepth }).map((_, index) => {
        const x = index % snapshot.gridWidth;
        const y = Math.floor(index / snapshot.gridWidth);
        const top = highest.get(`${x},${y}`);
        const fill =
          top?.type === "wood" ? "#f59e0b" : top?.type === "glass" ? "#67e8f9" : top?.type === "stone" ? "#cbd5e1" : "#16365c";
        return (
          <rect
            key={`${x}-${y}`}
            x={x * cellSize + 1}
            y={y * cellSize + 1}
            width={cellSize - 2}
            height={cellSize - 2}
            rx={3}
            fill={fill}
            opacity={0.82}
          />
        );
      })}

      {snapshot.entities.map((entity) => (
        <g key={entity.id}>
          <circle
            cx={entity.gridX * cellSize + cellSize / 2}
            cy={entity.gridY * cellSize + cellSize / 2}
            r={activeEntityId === entity.id ? 4.6 : 3.2}
            fill={entity.color}
            stroke={activeEntityId === entity.id ? "#f8fafc" : "rgba(248,250,252,0.4)"}
            strokeWidth={activeEntityId === entity.id ? 2 : 1}
          />
        </g>
      ))}

      {snapshot.beacons.map((beacon) => (
        <g key={beacon.id}>
          <rect
            x={beacon.x * cellSize + cellSize / 2 - 3}
            y={beacon.y * cellSize + cellSize / 2 - 3}
            width={6}
            height={6}
            rx={2}
            fill="#f8fafc"
            stroke="#0ea5e9"
            strokeWidth={1.2}
          />
        </g>
      ))}
    </svg>
  );
};

const WorldView = ({
  snapshot,
  activeEntityId,
  selectedTile,
  onSelectTile,
}: {
  snapshot: WorldSnapshot;
  activeEntityId?: string;
  selectedTile: TileSelection | undefined;
  onSelectTile: (tile: TileSelection | undefined) => void;
}) => {
  const clipId = "world-clip";
  const innerLeft = 36;
  const innerTop = 48;
  const innerWidth = VIEWBOX_WIDTH - 72;
  const innerHeight = VIEWBOX_HEIGHT - 96;
  const sortedBlocks = [...snapshot.blocks].sort(blockSort);
  const boardCorners = [
    toIso(0, 0, 0),
    toIso(snapshot.gridWidth, 0, 0),
    toIso(snapshot.gridWidth, snapshot.gridDepth, 0),
    toIso(0, snapshot.gridDepth, 0),
  ];
  const handleClick = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenX = ((event.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH;
    const screenY = ((event.clientY - rect.top) / rect.height) * VIEWBOX_HEIGHT;
    const tile = screenToTile(screenX, screenY);
    if (tile.x < 0 || tile.y < 0 || tile.x >= snapshot.gridWidth || tile.y >= snapshot.gridDepth) {
      return;
    }
    if (selectedTile && selectedTile.x === tile.x && selectedTile.y === tile.y) {
      onSelectTile(undefined);
      return;
    }
    onSelectTile(tile);
  };

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      className="world-view world-view-interactive"
      role="img"
      aria-label="Block builder world"
      onClick={handleClick}
    >
      <defs>
        <linearGradient id="worldBg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#040a14" />
          <stop offset="55%" stopColor="#0c2038" />
          <stop offset="100%" stopColor="#0f3256" />
        </linearGradient>
        <linearGradient id="plateGlow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#67e8f9" stopOpacity="0.02" />
        </linearGradient>
        <clipPath id={clipId}>
          <rect x={innerLeft} y={innerTop} width={innerWidth} height={innerHeight} rx={28} />
        </clipPath>
      </defs>

      <rect x={0} y={0} width={VIEWBOX_WIDTH} height={VIEWBOX_HEIGHT} rx={26} fill="url(#worldBg)" />
      <rect x={24} y={24} width={VIEWBOX_WIDTH - 48} height={VIEWBOX_HEIGHT - 48} rx={28} fill="url(#plateGlow)" stroke="#67e8f9" strokeWidth={2} />
      <g clipPath={`url(#${clipId})`}>
        <polygon
          points={boardCorners.map((corner) => `${corner.x},${corner.y + TILE_HEIGHT / 2}`).join(" ")}
          fill="rgba(15, 52, 92, 0.55)"
          stroke="rgba(125, 211, 252, 0.22)"
          strokeWidth={3}
        />

        {selectedTile ? (
          <polygon
            points={tileDiamondPoints(selectedTile.x, selectedTile.y)
              .map(([x, y]) => `${x},${y}`)
              .join(" ")}
            fill="rgba(248,250,252,0.08)"
            stroke="#7dd3fc"
            strokeWidth={2.2}
            strokeDasharray="7 5"
          />
        ) : null}

        {sortedBlocks.map((block) => {
          const top = toIso(block.x, block.y, block.z);
          const fill = blockFill(block.type);
          const topFace = [
            [top.x, top.y],
            [top.x + TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2],
            [top.x, top.y + TILE_HEIGHT],
            [top.x - TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2],
          ];
          const leftFace = [
            [top.x - TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2],
            [top.x, top.y + TILE_HEIGHT],
            [top.x, top.y + TILE_HEIGHT + BLOCK_HEIGHT],
            [top.x - TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2 + BLOCK_HEIGHT],
          ];
          const rightFace = [
            [top.x + TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2],
            [top.x, top.y + TILE_HEIGHT],
            [top.x, top.y + TILE_HEIGHT + BLOCK_HEIGHT],
            [top.x + TILE_WIDTH / 2, top.y + TILE_HEIGHT / 2 + BLOCK_HEIGHT],
          ];

          return (
            <g key={blockKey(block)}>
              <polygon points={leftFace.map(([x, y]) => `${x},${y}`).join(" ")} fill={fill.left} stroke="rgba(2,6,23,0.28)" strokeWidth={1.2} />
              <polygon points={rightFace.map(([x, y]) => `${x},${y}`).join(" ")} fill={fill.right} stroke="rgba(2,6,23,0.28)" strokeWidth={1.2} />
              <polygon points={topFace.map(([x, y]) => `${x},${y}`).join(" ")} fill={fill.top} stroke="rgba(255,255,255,0.14)" strokeWidth={1.2} />
            </g>
          );
        })}

        {snapshot.beacons.map((beacon) => {
          const marker = toIso(beacon.x, beacon.y, 1);
          return (
            <g key={beacon.id}>
              <circle cx={marker.x} cy={marker.y + 8} r={8} fill="#020617" opacity={0.8} />
              <circle cx={marker.x} cy={marker.y + 8} r={5.5} fill="#f8fafc" stroke="#38bdf8" strokeWidth={2} />
              <path d={`M ${marker.x} ${marker.y + 16} l 0 18`} stroke="#7dd3fc" strokeWidth={2} strokeLinecap="round" />
              <text x={marker.x} y={marker.y - 4} textAnchor="middle" className="beacon-label">
                {beacon.label}
              </text>
            </g>
          );
        })}

        {snapshot.entities.map((entity) => {
          const stand = toIso(entity.gridX, entity.gridY, entity.gridZ);
          const isActive = entity.id === activeEntityId;
          const showThought = isActive && entity.visibleThought.trim().length > 0;
          const bubbleX = clamp(
            stand.x - THOUGHT_BUBBLE_WIDTH / 2,
            innerLeft + 10,
            innerLeft + innerWidth - THOUGHT_BUBBLE_WIDTH - 10,
          );
          const bubbleY = clamp(
            stand.y - 132,
            innerTop + 10,
            innerTop + innerHeight - THOUGHT_BUBBLE_HEIGHT - 10,
          );

          return (
            <g key={entity.id}>
              {showThought ? (
                <foreignObject x={bubbleX} y={bubbleY} width={THOUGHT_BUBBLE_WIDTH} height={THOUGHT_BUBBLE_HEIGHT}>
                  <div className="world-thought-bubble">{entity.visibleThought}</div>
                </foreignObject>
              ) : null}
              <ellipse cx={stand.x} cy={stand.y + TILE_HEIGHT - 2} rx={18} ry={9} fill="rgba(2,6,23,0.42)" />
              <rect
                x={stand.x - 16}
                y={stand.y - 38}
                width={32}
                height={42}
                rx={10}
                fill={entity.color}
                stroke={isActive ? "#f8fafc" : "#020617"}
                strokeWidth={isActive ? 3.5 : 3}
              />
              <rect x={stand.x - 16} y={stand.y - 38} width={32} height={10} rx={8} fill="rgba(255,255,255,0.22)" />
              <path d={`M ${stand.x} ${stand.y - 52} l 10 14 h -20 z`} fill="#e2e8f0" opacity={0.9} />
              <text x={stand.x} y={stand.y + 34} textAnchor="middle" className="entity-label">
                {entity.id}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
};

const TraceDrawer = ({
  entity,
  open,
  selectedTraceId,
  onSelect,
  onClose,
}: {
  entity: EntitySnapshot;
  open: boolean;
  selectedTraceId: string | undefined;
  onSelect: (traceId: string) => void;
  onClose: () => void;
}) => {
  const selectedTrace = entity.traces.find((trace) => trace.id === selectedTraceId) ?? entity.traces[0];

  return (
    <aside className={`trace-drawer${open ? " trace-drawer-open" : ""}`} aria-hidden={!open}>
      <div className="drawer-header">
        <div>
          <span className="drawer-eyebrow">Trace archive</span>
          <h2>{entity.name} history</h2>
        </div>
        <button className="ghost-button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="trace-drawer-body">
        <div className="trace-index">
          {entity.traces.length === 0 ? <p className="empty-state">No traces yet.</p> : null}
          {entity.traces.map((trace) => (
            <button
              key={trace.id}
              className={`trace-row${selectedTrace?.id === trace.id ? " trace-row-active" : ""}`}
              onClick={() => onSelect(trace.id)}
            >
              <div>
                <strong>{trace.actionName}</strong>
                <span>{trace.thought}</span>
              </div>
              <small>{formatTraceTime(trace.timestamp)}</small>
            </button>
          ))}
        </div>
        <div className="trace-detail">
          {selectedTrace ? (
            <>
              <div className="trace-meta">
                <span>{formatTraceTime(selectedTrace.timestamp)}</span>
                <span>{selectedTrace.mode}</span>
                <span>{selectedTrace.latencyMs.toFixed(1)} ms</span>
                <span>{selectedTrace.completionTokensPerSecond?.toFixed(2) ?? "n/a"} tok/s</span>
              </div>
              <p>
                <strong>thought:</strong> {selectedTrace.thought}
              </p>
              <p>
                <strong>action:</strong> {selectedTrace.actionName}
                {selectedTrace.actionArgs ? ` ${JSON.stringify(selectedTrace.actionArgs)}` : ""}
              </p>
              <p>
                <strong>result:</strong> {selectedTrace.actionResult ?? "none"}
              </p>
              <details open>
                <summary>Prompt</summary>
                <pre>{selectedTrace.promptText}</pre>
              </details>
              <details>
                <summary>Raw model output</summary>
                <pre>{selectedTrace.rawModelOutput}</pre>
              </details>
            </>
          ) : (
            <p className="empty-state">No trace selected.</p>
          )}
        </div>
      </div>
    </aside>
  );
};

const DebugDrawer = ({ entity, open, onClose }: { entity: EntitySnapshot; open: boolean; onClose: () => void }) => (
  <aside className={`debug-drawer${open ? " debug-drawer-open" : ""}`} aria-hidden={!open}>
    <div className="drawer-header">
      <div>
        <span className="drawer-eyebrow">Debug</span>
        <h2>{entity.name} telemetry</h2>
      </div>
      <button className="ghost-button" onClick={onClose}>
        Close
      </button>
    </div>

    <div className="debug-grid">
      <div className="debug-card">
        <span>Grid</span>
        <strong>
          {entity.gridX}, {entity.gridY}, {entity.gridZ}
        </strong>
      </div>
      <div className="debug-card">
        <span>Facing</span>
        <strong>{entity.facing}</strong>
      </div>
      <div className="debug-card">
        <span>Status</span>
        <strong>{entity.status}</strong>
      </div>
      <div className="debug-card">
        <span>Thread</span>
        <strong>{entity.threadLength} msgs</strong>
      </div>
    </div>

    <section className="drawer-section">
      <h3>Last tool</h3>
      <p>{formatTool(entity)}</p>
    </section>

    <section className="drawer-section">
      <h3>Last action result</h3>
      <p>{entity.lastActionResult || "none"}</p>
    </section>

    <section className="drawer-section">
      <h3>Last observation</h3>
      <pre>{entity.lastObservation}</pre>
    </section>

    <section className="drawer-section">
      <h3>Recent events</h3>
      <ul>
        {entity.recentEvents.map((event, index) => (
          <li key={`${entity.id}-event-${index}`}>{event}</li>
        ))}
      </ul>
    </section>

  </aside>
);

const BeaconEditor = ({
  tile,
  label,
  saving,
  onChange,
  onSave,
  onRemove,
  onClose,
  canRemove,
}: {
  tile: TileSelection;
  label: string;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onRemove: () => void;
  onClose: () => void;
  canRemove: boolean;
}) => (
  <section className="beacon-editor">
    <div className="console-header">
      <span className="drawer-eyebrow">Beacon Tile</span>
      <span>
        {tile.x}, {tile.y}
      </span>
    </div>
    <input
      value={label}
      placeholder="Name this tile"
      maxLength={32}
      onChange={(event) => onChange(event.target.value)}
    />
    <div className="button-row beacon-actions">
      <button onClick={onSave} disabled={saving || (!canRemove && label.trim().length === 0)}>
        {saving ? "Saving..." : canRemove ? "Update beacon" : "Create beacon"}
      </button>
      {canRemove ? (
        <button className="ghost-button" onClick={onRemove} disabled={saving}>
          Remove
        </button>
      ) : null}
      <button className="ghost-button" onClick={onClose} disabled={saving}>
        Close
      </button>
    </div>
  </section>
);

export const App = () => {
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<PromptState>({});
  const [savingEntityId, setSavingEntityId] = useState<string | null>(null);
  const [savingBeacon, setSavingBeacon] = useState(false);
  const [activeEntityId, setActiveEntityId] = useState<string | undefined>(undefined);
  const [showTraces, setShowTraces] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>(undefined);
  const [selectedTile, setSelectedTile] = useState<TileSelection | undefined>(undefined);
  const [beaconDraft, setBeaconDraft] = useState("");

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
    }, 300);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const sortedEntities = useMemo(
    () => snapshot?.entities.slice().sort((a, b) => a.gridX + a.gridY - (b.gridX + b.gridY)) ?? [],
    [snapshot],
  );

  useEffect(() => {
    if (sortedEntities.length === 0) {
      return;
    }
    if (!activeEntityId || !sortedEntities.some((entity) => entity.id === activeEntityId)) {
      setActiveEntityId(sortedEntities[0]?.id);
    }
  }, [sortedEntities, activeEntityId]);

  const activeEntity = sortedEntities.find((entity) => entity.id === activeEntityId) ?? sortedEntities[0];

  useEffect(() => {
    if (!activeEntity) {
      return;
    }
    if (!selectedTraceId || !activeEntity.traces.some((trace) => trace.id === selectedTraceId)) {
      setSelectedTraceId(activeEntity.traces[0]?.id);
    }
  }, [activeEntity, selectedTraceId]);

  const handleRefresh = async () => {
    const next = await pollState();
    setSnapshot(next);
  };

  const handleReset = async () => {
    if (!activeEntity) {
      return;
    }

    setSavingEntityId(activeEntity.id);
    try {
      await resetWorld();
      setSelectedTile(undefined);
      setSelectedTraceId(undefined);
      setShowDebug(false);
      setShowTraces(false);
      setError(null);
      await handleRefresh();
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    } finally {
      setSavingEntityId(null);
    }
  };

  const handleTogglePause = async (entity: EntitySnapshot) => {
    const draft = promptDrafts[entity.id] ?? entity.prompt;
    setSavingEntityId(entity.id);
    try {
      await patchEntity(entity.id, entity.paused ? { prompt: draft, paused: false } : { paused: true });
      await handleRefresh();
    } catch (pauseError) {
      setError(pauseError instanceof Error ? pauseError.message : String(pauseError));
    } finally {
      setSavingEntityId(null);
    }
  };

  const selectedBeacon = useMemo(
    () =>
      selectedTile && snapshot
        ? snapshot.beacons.find((beacon) => beacon.x === selectedTile.x && beacon.y === selectedTile.y)
        : undefined,
    [selectedTile, snapshot],
  );

  useEffect(() => {
    setBeaconDraft(selectedBeacon?.label ?? "");
  }, [selectedBeacon?.id, selectedTile?.x, selectedTile?.y]);

  const handleSaveBeacon = async () => {
    if (!selectedTile) {
      return;
    }
    setSavingBeacon(true);
    try {
      await upsertBeacon({
        x: selectedTile.x,
        y: selectedTile.y,
        label: beaconDraft,
      });
      await handleRefresh();
      setSelectedTile(undefined);
    } catch (beaconError) {
      setError(beaconError instanceof Error ? beaconError.message : String(beaconError));
    } finally {
      setSavingBeacon(false);
    }
  };

  const handleRemoveBeacon = async () => {
    if (!selectedBeacon) {
      return;
    }
    setSavingBeacon(true);
    try {
      await deleteBeacon(selectedBeacon.id);
      await handleRefresh();
      setSelectedTile(undefined);
    } catch (beaconError) {
      setError(beaconError instanceof Error ? beaconError.message : String(beaconError));
    } finally {
      setSavingBeacon(false);
    }
  };

  if (!snapshot || !activeEntity) {
    return <div className="game-shell">Loading builder sandbox...</div>;
  }

  const activePromptDraft = promptDrafts[activeEntity.id] ?? activeEntity.prompt;
  const objectiveStatus =
    savingEntityId === activeEntity.id
      ? "syncing"
      : activeEntity.paused
        ? "paused"
        : activeEntity.status;

  return (
    <div className="game-shell">
      <main className="game-main">
        <section className="stage-shell">
          <div className="stage-hud stage-hud-top">
            <header className="top-strip">
              <div className="top-strip-title">
                <span className="eyebrow">Builder Sandbox</span>
                <strong>{activeEntity.name}</strong>
              </div>
              <section className="hud-strip">
                <MetricChip label="TPS" value={snapshot.metrics.physicsTicksPerSecond} />
                <MetricChip label="Turns" value={snapshot.metrics.brainTurnsPerSecond} />
                <MetricChip label="Lag" value={`${snapshot.metrics.averageBrainLatencyMs}ms`} />
                <MetricChip label="Tok/s" value={snapshot.metrics.averageCompletionTokensPerSecond || "n/a"} />
                <MetricChip label="Model" value={snapshot.llm.activeModel || snapshot.llm.configuredModel || "auto"} />
              </section>
              <div className="header-actions">
                <span className={`mode-pill mode-pill-${snapshot.llm.mode}`}>{snapshot.llm.mode.toUpperCase()}</span>
                <button className="ghost-button" onClick={() => void handleReset()}>
                  Reset
                </button>
                <button className="ghost-button" onClick={() => setShowDebug((current) => !current)}>
                  Debug
                </button>
                <button className="ghost-button" onClick={() => setShowTraces((current) => !current)}>
                  History
                </button>
              </div>
            </header>
            {error ? <section className="error-banner">{error}</section> : null}
          </div>

          <div className="stage-overlay stage-overlay-bottom">
            <div className="minimap-shell">
              <span>Minimap</span>
              <MiniMap snapshot={snapshot} activeEntityId={activeEntity.id} />
            </div>
          </div>

          {selectedTile ? (
            <div className="stage-overlay stage-overlay-right">
              <BeaconEditor
                tile={selectedTile}
                label={beaconDraft}
                saving={savingBeacon}
                onChange={setBeaconDraft}
                onSave={() => void handleSaveBeacon()}
                onRemove={() => void handleRemoveBeacon()}
                onClose={() => setSelectedTile(undefined)}
                canRemove={Boolean(selectedBeacon)}
              />
            </div>
          ) : null}

          <section className="command-deck command-deck-overlay">
            <div className="deck-grid deck-grid-tight">
              <div className="prompt-console">
                <div className="console-header">
                  <span className="drawer-eyebrow">Objective Console</span>
                  <span>{objectiveStatus}</span>
                </div>
                {activeEntity.paused ? (
                  <textarea
                    value={activePromptDraft}
                    placeholder="Type an objective, then press Start. Example: walk to beacon Dock and build a 2x2 stone pad beside it."
                    onChange={(event) =>
                      setPromptDrafts((current) => ({
                        ...current,
                        [activeEntity.id]: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <div className="objective-readout">{activeEntity.prompt.trim() || "No objective set."}</div>
                )}
                <div className="console-footnote">
                  {activeEntity.paused
                    ? "Paused. Click a tile to add or rename a beacon, then press Start."
                    : "Live. Pause to edit the objective or manage beacons."}
                </div>
              </div>

              <div className="deck-sidecar control-tile">
                <div className="control-cell">
                  <div>
                    <span>Pos</span>
                    <strong>
                      {activeEntity.gridX}, {activeEntity.gridY}, {activeEntity.gridZ}
                    </strong>
                  </div>
                </div>
                <div className="control-cell">
                  <div>
                    <span>Facing</span>
                    <strong>{activeEntity.facing}</strong>
                  </div>
                </div>
                <div className="control-cell">
                  <div>
                    <span>Thought</span>
                    <strong>{activeEntity.visibleThought.trim() || "..."}</strong>
                  </div>
                </div>
                <div className="control-cell control-cell-action">
                  <button onClick={() => void handleTogglePause(activeEntity)}>
                    {savingEntityId === activeEntity.id ? "Syncing..." : activeEntity.paused ? "Start" : "Pause"}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <WorldView
            snapshot={snapshot}
            activeEntityId={activeEntity.id}
            selectedTile={selectedTile}
            onSelectTile={setSelectedTile}
          />
        </section>
      </main>

      <TraceDrawer
        entity={activeEntity}
        open={showTraces}
        selectedTraceId={selectedTraceId}
        onSelect={setSelectedTraceId}
        onClose={() => setShowTraces(false)}
      />
      <DebugDrawer entity={activeEntity} open={showDebug} onClose={() => setShowDebug(false)} />
    </div>
  );
};
