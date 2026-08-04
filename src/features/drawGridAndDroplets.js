export function drawGridAndDroplets({
  ctx,
  rows,
  cols,
  cellSize,
  step,
  selectedRects = [],
  showLabels = true,
  majorGridEvery = 0,
  viewportScale = 1,
}) {
  const width = cols * cellSize;
  const height = rows * cellSize;
  let hasOutOfBounds = false;

  ctx.clearRect(0, 0, width, height);

  // Grid background
  ctx.fillStyle = majorGridEvery > 0 ? "#ffffff" : "#f7f8fa";
  ctx.fillRect(0, 0, width, height);

  // Grid lines. The live viewport can opt into a major/minor hierarchy while
  // exports retain the original single-weight grid by omitting majorGridEvery.
  if (majorGridEvery > 0) {
    const safeScale = Math.max(0.01, Number(viewportScale) || 1);
    const screenCellSize = cellSize * safeScale;
    const minorGridEvery =
      screenCellSize >= 12
        ? 1
        : screenCellSize >= 6
          ? 2
          : screenCellSize >= 3
            ? 4
            : screenCellSize >= 1.5
              ? 8
              : majorGridEvery;
    const strokeGridLines = ({ color, lineWidth, include }) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth / safeScale;
      ctx.beginPath();
      for (let c = 0; c <= cols; c += 1) {
        if (!include(c)) continue;
        const x = c * cellSize;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let r = 0; r <= rows; r += 1) {
        if (!include(r)) continue;
        const y = r * cellSize;
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    };

    if (minorGridEvery < majorGridEvery) {
      strokeGridLines({
        color: "#edf1f5",
        lineWidth: 0.6,
        include: (value) =>
          value % minorGridEvery === 0 && value % majorGridEvery !== 0,
      });
    }
    strokeGridLines({
      color: "#b9c4d1",
      lineWidth: 1,
      include: (value) => value % majorGridEvery === 0,
    });
    ctx.strokeStyle = "#9eacbd";
    ctx.lineWidth = 1 / safeScale;
    ctx.strokeRect(0, 0, width, height);
  } else {
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
  }

  if (step && Array.isArray(step.rects)) {
    const selectedKeys = new Set(
      selectedRects.map((rect) => `${rect.x},${rect.y},${rect.w},${rect.h}`)
    );
    step.rects.forEach((rect, idx) => {
      const { x, y, w, h } = rect;
      const outOfBounds = x < 0 || y < 0 || x + w > cols || y + h > rows;
      const isSelected = selectedKeys.has(`${x},${y},${w},${h}`);
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

      if (isSelected) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#2563eb";
        ctx.strokeRect(px + 3, py + 3, Math.max(0, pw - 5), Math.max(0, ph - 5));
      }

      if (showLabels) {
        ctx.fillStyle = "#111827";
        ctx.font = "bold 12px system-ui, sans-serif";
        ctx.fillText(
          `D${idx + 1}: (${x},${y})(${w},${h})`,
          px + 6,
          py + 16
        );
      }
    });
  }

  return {
    warning: hasOutOfBounds
      ? "Some droplets are out of bounds (shown in red)."
      : "",
  };
}
