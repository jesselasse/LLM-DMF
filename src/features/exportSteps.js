import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { drawGridAndDroplets } from "./drawGridAndDroplets";

const MAX_GIF_SIDE = 720;
const MAX_FRAME_DELAY_MS = 655350;

export function stepToTxtLine(step) {
  if (!step) return "";
  if (typeof step.raw === "string" && step.raw.trim()) {
    return step.raw.trim();
  }

  const rects = Array.isArray(step.rects) ? step.rects : [];
  const rectText = rects
    .map((rect) => `(${rect.x},${rect.y})(${rect.w},${rect.h})`)
    .join(";");
  const duration = Math.max(0, Number(step.duration) || 0);
  return rectText ? `${rectText}-${duration}` : `-${duration}`;
}

export function stepsToTxt(steps) {
  return `${steps.map(stepToTxtLine).join("\n")}\n`;
}

function createDateStamp(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

export function createExportBaseName(sequenceNumber, now = new Date()) {
  const dateStamp = createDateStamp(now);
  const suffix = Math.max(1, Number.parseInt(sequenceNumber, 10) || 1);
  return `${dateStamp}-dmf_steps-${suffix}`;
}

export function contextToJson({ sessionId, messages, exchanges, exportedAt = new Date() }) {
  return `${JSON.stringify(
    {
      format: "llm-dmf-context-v1",
      exportedAt: exportedAt.toISOString(),
      sessionId,
      messages: messages.map(({ role, text, error }) => ({
        role,
        content: text,
        ...(error ? { error: true } : {}),
      })),
      exchanges,
    },
    null,
    2
  )}\n`;
}

export function downloadBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

export function encodeStepsGif({ steps, rows, cols }) {
  if (!steps.length) {
    throw new Error("No steps to export.");
  }

  const cellSize = Math.max(
    0.25,
    Math.min(8, MAX_GIF_SIDE / Math.max(1, rows), MAX_GIF_SIDE / Math.max(1, cols))
  );
  const width = Math.max(1, Math.ceil(cols * cellSize));
  const height = Math.max(1, Math.ceil(rows * cellSize));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas is unavailable, so the GIF could not be generated.");
  }

  const gif = GIFEncoder();
  steps.forEach((step) => {
    drawGridAndDroplets({ ctx, rows, cols, cellSize, step, showLabels: false });
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const palette = quantize(rgba, 256);
    const indexed = applyPalette(rgba, palette);
    const delay = Math.min(
      MAX_FRAME_DELAY_MS,
      Math.max(20, Math.round(Number(step.duration) || 300))
    );
    gif.writeFrame(indexed, width, height, {
      palette,
      delay,
      repeat: 0,
    });
  });
  gif.finish();

  return new Blob([gif.bytes()], { type: "image/gif" });
}
