export function parseStepsTxt(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const steps = [];

  for (const line of lines) {
    const durationMatch = line.match(/^(.*?)-\s*(\d+)\s*$/);
    const rectPart = durationMatch ? durationMatch[1] : line;
    const durationPart = durationMatch ? durationMatch[2] : "0";
    const duration = Math.max(0, parseInt(durationPart, 10) || 0);

    const rects = rectPart
      .split(";")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const match = chunk.match(
          /\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*\(([-+]?\d+)\s*,\s*([-+]?\d+)\)/
        );
        if (!match) return null;

        const x = parseInt(match[1], 10);
        const y = parseInt(match[2], 10);
        const w = parseInt(match[3], 10);
        const h = parseInt(match[4], 10);
        return { x, y, w, h };
      })
      .filter(Boolean);

    steps.push({ rects, duration, raw: line });
  }

  return steps;
}
