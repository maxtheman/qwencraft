import { PNG } from "pngjs";
import type { BlockSnapshot, Facing } from "../shared/contracts";

type ViewportRenderEntity = {
  x: number;
  y: number;
  z: number;
  facing: Facing;
  color: string;
};

type ViewportBeacon = {
  x: number;
  y: number;
  label: string;
  marker: number;
};

export type ViewportRenderInput = {
  gridWidth: number;
  gridDepth: number;
  gridHeight: number;
  blocks: readonly BlockSnapshot[];
  beacons: readonly ViewportBeacon[];
  entity: ViewportRenderEntity;
};

type Rgba = {
  r: number;
  g: number;
  b: number;
  a?: number;
};

const IMAGE_SIZE = 256;
const FRAME_LEFT = 18;
const FRAME_TOP = 18;
const FRAME_SIZE = 168;
const SCANLINE_ALPHA = 18;

const BG = { r: 7, g: 12, b: 10, a: 255 } satisfies Rgba;
const BG_2 = { r: 14, g: 24, b: 18, a: 255 } satisfies Rgba;
const FRAME_BG = { r: 11, g: 18, b: 14, a: 255 } satisfies Rgba;
const PANEL_BG = { r: 9, g: 14, b: 12, a: 242 } satisfies Rgba;
const FRAME_LINE = { r: 111, g: 156, b: 52, a: 210 } satisfies Rgba;
const GRID_LINE = { r: 72, g: 109, b: 38, a: 110 } satisfies Rgba;
const EMPTY_CELL = { r: 16, g: 28, b: 22, a: 255 } satisfies Rgba;
const TEXT = { r: 226, g: 237, b: 201, a: 255 } satisfies Rgba;
const TEXT_DIM = { r: 137, g: 164, b: 103, a: 255 } satisfies Rgba;
const ALERT = { r: 246, g: 169, b: 52, a: 255 } satisfies Rgba;
const ENTITY_CORE = { r: 255, g: 122, b: 39, a: 255 } satisfies Rgba;
const BEACON = { r: 93, g: 223, b: 255, a: 255 } satisfies Rgba;

const BLOCK_FILL: Record<Exclude<BlockSnapshot["type"], "grass">, Rgba> = {
  stone: { r: 160, g: 170, b: 184, a: 255 },
  wood: { r: 205, g: 121, b: 48, a: 255 },
  glass: { r: 103, g: 222, b: 238, a: 255 },
};

const DIGITS: Record<string, readonly string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "001", "001", "001"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

const hexToRgba = (hex: string): Rgba => {
  const normalized = hex.replace("#", "");
  if (normalized.length !== 6) {
    return TEXT;
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
    a: 255,
  };
};

const setPixel = (png: PNG, x: number, y: number, color: Rgba) => {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }

  const alpha = (color.a ?? 255) / 255;
  const index = (png.width * y + x) << 2;
  const currentR = png.data[index] ?? 0;
  const currentG = png.data[index + 1] ?? 0;
  const currentB = png.data[index + 2] ?? 0;

  png.data[index] = Math.round(currentR * (1 - alpha) + color.r * alpha);
  png.data[index + 1] = Math.round(currentG * (1 - alpha) + color.g * alpha);
  png.data[index + 2] = Math.round(currentB * (1 - alpha) + color.b * alpha);
  png.data[index + 3] = 255;
};

const fillRect = (png: PNG, left: number, top: number, width: number, height: number, color: Rgba) => {
  for (let y = Math.floor(top); y < Math.ceil(top + height); y += 1) {
    for (let x = Math.floor(left); x < Math.ceil(left + width); x += 1) {
      setPixel(png, x, y, color);
    }
  }
};

const strokeRect = (png: PNG, left: number, top: number, width: number, height: number, color: Rgba, thickness: number) => {
  fillRect(png, left, top, width, thickness, color);
  fillRect(png, left, top + height - thickness, width, thickness, color);
  fillRect(png, left, top, thickness, height, color);
  fillRect(png, left + width - thickness, top, thickness, height, color);
};

const drawLine = (png: PNG, x0: number, y0: number, x1: number, y1: number, color: Rgba) => {
  let currentX = Math.round(x0);
  let currentY = Math.round(y0);
  const targetX = Math.round(x1);
  const targetY = Math.round(y1);
  const deltaX = Math.abs(targetX - currentX);
  const deltaY = -Math.abs(targetY - currentY);
  const stepX = currentX < targetX ? 1 : -1;
  const stepY = currentY < targetY ? 1 : -1;
  let error = deltaX + deltaY;

  while (true) {
    setPixel(png, currentX, currentY, color);
    if (currentX === targetX && currentY === targetY) {
      break;
    }
    const nextError = 2 * error;
    if (nextError >= deltaY) {
      error += deltaY;
      currentX += stepX;
    }
    if (nextError <= deltaX) {
      error += deltaX;
      currentY += stepY;
    }
  }
};

const fillCircle = (png: PNG, centerX: number, centerY: number, radius: number, color: Rgba) => {
  const radiusSquared = radius * radius;
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy <= radiusSquared) {
        setPixel(png, x, y, color);
      }
    }
  }
};

const drawDigit = (png: PNG, digit: string, left: number, top: number, color: Rgba) => {
  const glyph = DIGITS[digit];
  if (!glyph) {
    return;
  }
  glyph.forEach((row, rowIndex) => {
    row.split("").forEach((cell, cellIndex) => {
      if (cell === "1") {
        fillRect(png, left + cellIndex * 2, top + rowIndex * 2, 2, 2, color);
      }
    });
  });
};

const facingVector = (facing: Facing) => {
  switch (facing) {
    case "north":
      return { x: 0, y: -1 };
    case "east":
      return { x: 1, y: 0 };
    case "south":
      return { x: 0, y: 1 };
    case "west":
      return { x: -1, y: 0 };
  }
};

const highestBlocks = (blocks: readonly BlockSnapshot[]) => {
  const highest = new Map<string, BlockSnapshot>();
  for (const block of blocks) {
    const key = `${block.x},${block.y}`;
    const current = highest.get(key);
    if (!current || current.z <= block.z) {
      highest.set(key, block);
    }
  }
  return highest;
};

const drawBackground = (png: PNG) => {
  for (let y = 0; y < png.height; y += 1) {
    const t = y / Math.max(1, png.height - 1);
    const color = {
      r: mix(BG.r, BG_2.r, t),
      g: mix(BG.g, BG_2.g, t),
      b: mix(BG.b, BG_2.b, t),
      a: 255,
    };
    for (let x = 0; x < png.width; x += 1) {
      setPixel(png, x, y, color);
    }
    if (y % 3 === 0) {
      fillRect(png, 0, y, png.width, 1, { r: 140, g: 180, b: 92, a: SCANLINE_ALPHA });
    }
  }
};

const drawFrameCorners = (png: PNG, left: number, top: number, size: number) => {
  const right = left + size;
  const bottom = top + size;
  const length = 22;
  fillRect(png, left, top, length, 2, FRAME_LINE);
  fillRect(png, left, top, 2, length, FRAME_LINE);
  fillRect(png, right - length, top, length, 2, FRAME_LINE);
  fillRect(png, right - 2, top, 2, length, FRAME_LINE);
  fillRect(png, left, bottom - 2, length, 2, FRAME_LINE);
  fillRect(png, left, bottom - length, 2, length, FRAME_LINE);
  fillRect(png, right - length, bottom - 2, length, 2, FRAME_LINE);
  fillRect(png, right - 2, bottom - length, 2, length, FRAME_LINE);
};

const renderTopDownGrid = (png: PNG, input: ViewportRenderInput) => {
  const blocks = highestBlocks(input.blocks);
  fillRect(png, FRAME_LEFT, FRAME_TOP, FRAME_SIZE, FRAME_SIZE, FRAME_BG);
  strokeRect(png, FRAME_LEFT, FRAME_TOP, FRAME_SIZE, FRAME_SIZE, { ...FRAME_LINE, a: 90 }, 1);
  drawFrameCorners(png, FRAME_LEFT, FRAME_TOP, FRAME_SIZE);

  const mapPadding = 14;
  const mapSize = FRAME_SIZE - mapPadding * 2;
  const cell = Math.floor(mapSize / Math.max(input.gridWidth, input.gridDepth));
  const mapWidth = input.gridWidth * cell;
  const mapHeight = input.gridDepth * cell;
  const mapLeft = FRAME_LEFT + Math.floor((FRAME_SIZE - mapWidth) / 2);
  const mapTop = FRAME_TOP + Math.floor((FRAME_SIZE - mapHeight) / 2);

  for (let y = 0; y < input.gridDepth; y += 1) {
    for (let x = 0; x < input.gridWidth; x += 1) {
      const topBlock = blocks.get(`${x},${y}`);
      const fill = topBlock && topBlock.type !== "grass" ? BLOCK_FILL[topBlock.type] : EMPTY_CELL;
      const left = mapLeft + x * cell;
      const top = mapTop + y * cell;
      fillRect(png, left, top, cell - 1, cell - 1, fill);
      strokeRect(png, left, top, cell - 1, cell - 1, GRID_LINE, 1);
    }
  }

  const centerX = mapLeft + input.entity.x * cell + Math.floor(cell / 2);
  const centerY = mapTop + input.entity.y * cell + Math.floor(cell / 2);
  const entityColor = hexToRgba(input.entity.color);
  fillCircle(png, centerX, centerY, Math.max(3, Math.floor(cell / 2)), entityColor);
  fillCircle(png, centerX, centerY, 2, TEXT);
  const heading = facingVector(input.entity.facing);
  drawLine(png, centerX, centerY, centerX + heading.x * 10, centerY + heading.y * 10, TEXT);

  input.beacons.forEach((beacon) => {
    const left = mapLeft + beacon.x * cell + Math.floor(cell / 2);
    const top = mapTop + beacon.y * cell + Math.floor(cell / 2);
    strokeRect(png, left - 5, top - 5, 10, 10, BEACON, 1);
    drawLine(png, left - 6, top, left + 6, top, BEACON);
    drawLine(png, left, top - 6, left, top + 6, BEACON);
    fillRect(png, left + 6, top - 8, 10, 12, FRAME_BG);
    strokeRect(png, left + 6, top - 8, 10, 12, { ...BEACON, a: 180 }, 1);
    drawDigit(png, String(beacon.marker % 10), left + 8, top - 5, TEXT);
  });

  drawLine(png, FRAME_LEFT + FRAME_SIZE / 2, FRAME_TOP + 8, FRAME_LEFT + FRAME_SIZE / 2, FRAME_TOP + FRAME_SIZE - 8, { ...FRAME_LINE, a: 80 });
  drawLine(png, FRAME_LEFT + 8, FRAME_TOP + FRAME_SIZE / 2, FRAME_LEFT + FRAME_SIZE - 8, FRAME_TOP + FRAME_SIZE / 2, { ...FRAME_LINE, a: 80 });
};

const renderTelemetry = (png: PNG, input: ViewportRenderInput) => {
  const panelLeft = 18;
  const panelTop = 196;
  const panelWidth = 104;
  const panelHeight = 42;
  fillRect(png, panelLeft, panelTop, panelWidth, panelHeight, PANEL_BG);
  strokeRect(png, panelLeft, panelTop, panelWidth, panelHeight, { ...FRAME_LINE, a: 120 }, 1);
  fillRect(png, panelLeft, panelTop, panelWidth, 8, { r: 36, g: 58, b: 22, a: 220 });
  drawDigit(png, String(input.entity.x % 10), panelLeft + 8, panelTop + 14, ALERT);
  drawDigit(png, String(input.entity.y % 10), panelLeft + 18, panelTop + 14, ALERT);
  drawDigit(png, String(input.beacons.length % 10), panelLeft + 80, panelTop + 14, TEXT);

  const statusLeft = 136;
  const statusTop = 196;
  const statusWidth = 102;
  fillRect(png, statusLeft, statusTop, statusWidth, panelHeight, PANEL_BG);
  strokeRect(png, statusLeft, statusTop, statusWidth, panelHeight, { ...FRAME_LINE, a: 120 }, 1);
  fillRect(png, statusLeft, statusTop + 28, statusWidth - 8, 5, { r: 32, g: 52, b: 18, a: 255 });
  fillRect(png, statusLeft + 4, statusTop + 29, statusWidth - 18, 3, ALERT);
};

export const renderViewportPngDataUrl = (input: ViewportRenderInput) => {
  const png = new PNG({
    width: IMAGE_SIZE,
    height: IMAGE_SIZE,
  });

  drawBackground(png);
  renderTopDownGrid(png, input);
  renderTelemetry(png, input);
  strokeRect(png, 1, 1, IMAGE_SIZE - 2, IMAGE_SIZE - 2, { r: 64, g: 99, b: 38, a: 150 }, 1);

  const image = PNG.sync.write(png);
  return `data:image/png;base64,${image.toString("base64")}`;
};
