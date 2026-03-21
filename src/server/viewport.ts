import { PNG } from "pngjs";

export type ViewportRenderObstacle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ViewportRenderEntity = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  isSelf: boolean;
};

export type ViewportRenderInput = {
  worldWidth: number;
  worldHeight: number;
  floorY: number;
  cameraLeft: number;
  cameraTop: number;
  cameraWidth: number;
  cameraHeight: number;
  obstacles: readonly ViewportRenderObstacle[];
  entities: readonly ViewportRenderEntity[];
};

const VIEWPORT_PIXEL_WIDTH = 256;
const VIEWPORT_PIXEL_HEIGHT = 144;

type Rgba = {
  r: number;
  g: number;
  b: number;
  a?: number;
};

const hexToRgba = (hex: string): Rgba => {
  const normalized = hex.trim().replace("#", "");
  if (normalized.length !== 6) {
    return { r: 255, g: 255, b: 255, a: 255 };
  }

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
    a: 255,
  };
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const mix = (start: number, end: number, amount: number) => Math.round(start + (end - start) * amount);

const setPixel = (png: PNG, x: number, y: number, color: Rgba) => {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }

  const index = (png.width * y + x) << 2;
  png.data[index] = color.r;
  png.data[index + 1] = color.g;
  png.data[index + 2] = color.b;
  png.data[index + 3] = color.a ?? 255;
};

const fillRect = (png: PNG, left: number, top: number, width: number, height: number, color: Rgba) => {
  const clampedLeft = clamp(Math.round(left), 0, png.width);
  const clampedTop = clamp(Math.round(top), 0, png.height);
  const clampedRight = clamp(Math.round(left + width), 0, png.width);
  const clampedBottom = clamp(Math.round(top + height), 0, png.height);

  for (let y = clampedTop; y < clampedBottom; y += 1) {
    for (let x = clampedLeft; x < clampedRight; x += 1) {
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
    const doubledError = 2 * error;
    if (doubledError >= deltaY) {
      error += deltaY;
      currentX += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      currentY += stepY;
    }
  }
};

const drawBackground = (png: PNG) => {
  for (let y = 0; y < png.height; y += 1) {
    const amount = y / Math.max(1, png.height - 1);
    const rowColor = {
      r: mix(8, 23, amount),
      g: mix(23, 67, amount),
      b: mix(41, 108, amount),
      a: 255,
    };
    for (let x = 0; x < png.width; x += 1) {
      setPixel(png, x, y, rowColor);
    }
  }
};

const toViewportX = (input: ViewportRenderInput, worldX: number) =>
  ((worldX - input.cameraLeft) / input.cameraWidth) * VIEWPORT_PIXEL_WIDTH;

const toViewportY = (input: ViewportRenderInput, worldY: number) =>
  ((worldY - input.cameraTop) / input.cameraHeight) * VIEWPORT_PIXEL_HEIGHT;

export const renderViewportPngDataUrl = (input: ViewportRenderInput) => {
  const png = new PNG({
    width: VIEWPORT_PIXEL_WIDTH,
    height: VIEWPORT_PIXEL_HEIGHT,
  });

  drawBackground(png);
  strokeRect(png, 0, 0, VIEWPORT_PIXEL_WIDTH, VIEWPORT_PIXEL_HEIGHT, { r: 125, g: 211, b: 252, a: 255 }, 2);

  const floorY = toViewportY(input, input.floorY);
  fillRect(png, 0, floorY, VIEWPORT_PIXEL_WIDTH, VIEWPORT_PIXEL_HEIGHT - floorY, {
    r: 23,
    g: 84,
    b: 123,
    a: 255,
  });
  fillRect(png, 0, floorY, VIEWPORT_PIXEL_WIDTH, 3, { r: 34, g: 211, b: 238, a: 255 });

  for (const obstacle of input.obstacles) {
    const left = toViewportX(input, obstacle.x);
    const top = toViewportY(input, obstacle.y);
    const width = (obstacle.width / input.cameraWidth) * VIEWPORT_PIXEL_WIDTH;
    const height = (obstacle.height / input.cameraHeight) * VIEWPORT_PIXEL_HEIGHT;
    fillRect(png, left, top, width, height, { r: 29, g: 78, b: 137, a: 255 });
    strokeRect(png, left, top, width, height, { r: 147, g: 197, b: 253, a: 255 }, 2);
  }

  const self = input.entities.find((entity) => entity.isSelf);
  for (const entity of input.entities) {
    const left = toViewportX(input, entity.x - entity.width / 2);
    const top = toViewportY(input, entity.y - entity.height);
    const width = (entity.width / input.cameraWidth) * VIEWPORT_PIXEL_WIDTH;
    const height = (entity.height / input.cameraHeight) * VIEWPORT_PIXEL_HEIGHT;
    const fill = hexToRgba(entity.color);
    fillRect(png, left, top, width, height, fill);
    strokeRect(png, left, top, width, height, { r: 2, g: 6, b: 23, a: 255 }, 2);
    fillRect(png, left, top, width, 4, { r: 255, g: 255, b: 255, a: 72 });

    if (entity.isSelf) {
      strokeRect(png, left - 2, top - 2, width + 4, height + 4, { r: 255, g: 255, b: 255, a: 255 }, 2);
    }
  }

  if (self) {
    const selfCenterX = toViewportX(input, self.x);
    const selfCenterY = toViewportY(input, self.y - self.height / 2);
    for (const entity of input.entities) {
      if (entity.id === self.id) {
        continue;
      }
      drawLine(
        png,
        selfCenterX,
        selfCenterY,
        toViewportX(input, entity.x),
        toViewportY(input, entity.y - entity.height / 2),
        { r: 255, g: 255, b: 255, a: 72 },
      );
    }
  }

  const image = PNG.sync.write(png);
  return `data:image/png;base64,${image.toString("base64")}`;
};
