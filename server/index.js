const express = require("express");

const app = express();
const port = process.env.PORT || 3001;

app.use(express.json());

function normalizePositive(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n > 0 ? Math.floor(n) : fallback;
}

function createStepsTextFromMessage(message) {
  const input = String(message || "").trim();
  if (!input) {
    return "(10,10)(6,4)-800\n(20,10)(6,4)-800";
  }

  // If user already sends lines in target format, return directly.
  const formatRegex =
    /\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*-\s*(\d+)/;
  if (formatRegex.test(input)) {
    return input;
  }

  // Minimal demo conversion: extract numbers from free text.
  const nums = (input.match(/-?\d+/g) || []).map(Number);
  const x = Number.isFinite(nums[0]) ? Math.floor(nums[0]) : 10;
  const y = Number.isFinite(nums[1]) ? Math.floor(nums[1]) : 10;
  const w = normalizePositive(nums[2], 6);
  const h = normalizePositive(nums[3], 4);
  const duration = Math.max(0, Number.isFinite(nums[4]) ? Math.floor(nums[4]) : 800);

  const nextX = x + w + 2;
  return `(${x},${y})(${w},${h})-${duration}\n(${nextX},${y})(${w},${h})-${duration}`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/steps-from-message", (req, res) => {
  const { message } = req.body || {};
  const stepsText = createStepsTextFromMessage(message);
  res.type("text/plain").send(stepsText);
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`);
});
