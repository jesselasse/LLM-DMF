const gifenc = require("gifenc");
const { parseSequenceText } = require("../server/sequence_workspace");

const { GIFEncoder } = gifenc;
const MAX_SIDE = 720;
const MAX_DELAY = 655350;
const PALETTE = [
  [255, 255, 255],
  [237, 241, 245],
  [210, 218, 229],
  [174, 185, 199],
  [51, 65, 85],
  [248, 113, 113],
];

function paintVertical(frame, width, height, x, color) {
  if (x < 0 || x >= width) return;
  for (let y = 0; y < height; y += 1) frame[y * width + x] = color;
}

function paintHorizontal(frame, width, height, y, color) {
  if (y < 0 || y >= height) return;
  frame.fill(color, y * width, (y + 1) * width);
}

function indexedFrame(step, rows, cols, scale) {
  const width = cols * scale + 1;
  const height = rows * scale + 1;
  const frame = new Uint8Array(width * height);
  frame.fill(0);

  for (let col = 0; col <= cols; col += 1) {
    const color = col % 32 === 0 ? 3 : col % 16 === 0 ? 2 : 1;
    paintVertical(frame, width, height, col * scale, color);
  }
  for (let row = 0; row <= rows; row += 1) {
    const color = row % 32 === 0 ? 3 : row % 16 === 0 ? 2 : 1;
    paintHorizontal(frame, width, height, row * scale, color);
  }

  for (const rect of step.rects) {
    const outOfBounds =
      rect.x < 0 || rect.y < 0 || rect.x + rect.w > cols || rect.y + rect.h > rows;
    const color = outOfBounds ? 5 : 4;
    const x0 = Math.max(0, rect.x * scale + 1);
    const y0 = Math.max(0, rect.y * scale + 1);
    const x1 = Math.min(width, (rect.x + rect.w) * scale);
    const y1 = Math.min(height, (rect.y + rect.h) * scale);
    for (let y = y0; y < y1; y += 1) {
      frame.fill(color, y * width + x0, y * width + x1);
    }
  }
  return { frame, width, height };
}

function encodeSequenceGif(sequenceText, rows, cols) {
  const steps = parseSequenceText(sequenceText);
  if (!steps.length) return null;
  const scale = Math.max(1, Math.floor(MAX_SIDE / Math.max(rows, cols)));
  const gif = GIFEncoder();
  steps.forEach((step) => {
    const { frame, width, height } = indexedFrame(step, rows, cols, scale);
    gif.writeFrame(frame, width, height, {
      palette: PALETTE,
      delay: Math.min(MAX_DELAY, Math.max(20, Number(step.duration) || 300)),
      repeat: 0,
    });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

module.exports = { encodeSequenceGif };
