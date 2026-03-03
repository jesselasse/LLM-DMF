export function drawGridAndDroplets({
  ctx,
  rows,
  cols,
  cellSize,
  step,
}) {
  const width = cols * cellSize;
  const height = rows * cellSize;
  let hasOutOfBounds = false;

  ctx.clearRect(0, 0, width, height);

  // Grid background
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(0, 0, width, height);

  // Grid lines
  ctx.strokeStyle = "#d0d4dc";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= cols; c += 1) {
    const x = Math.round(c * cellSize) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let r = 0; r <= rows; r += 1) {
    const y = Math.round(r * cellSize) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  if (step && Array.isArray(step.rects)) {
    step.rects.forEach((rect, idx) => {
      const { x, y, w, h } = rect;
      const outOfBounds = x < 0 || y < 0 || x + w > cols || y + h > rows;
      hasOutOfBounds = hasOutOfBounds || outOfBounds;

      const px = x * cellSize;
      const py = y * cellSize;
      const pw = w * cellSize;
      const ph = h * cellSize;

      ctx.fillStyle = outOfBounds ? "#f87171" : "#334155";
      ctx.globalAlpha = 0.85;
      ctx.fillRect(px + 1, py + 1, Math.max(0, pw - 1), Math.max(0, ph - 1));

      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = outOfBounds ? "#dc2626" : "#0f172a";
      ctx.strokeRect(px + 1, py + 1, Math.max(0, pw - 1), Math.max(0, ph - 1));

      ctx.fillStyle = "#111827";
      ctx.font = "bold 12px system-ui, sans-serif";
      ctx.fillText(
        `D${idx + 1}: (${x},${y})(${w},${h})`,
        px + 6,
        py + 16
      );
    });
  }

  return {
    warning: hasOutOfBounds
      ? "Some droplets are out of bounds (shown in red)."
      : "",
  };
}
