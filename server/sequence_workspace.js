const DEFAULT_STEP_DURATION = 1000;
const RESERVED_VARIABLE_NAMES = new Set([
  "sequence",
  "currentFrameDroplets",
  "selectedDroplets",
]);

function cloneWorkspaceValue(value) {
  if (value === undefined) throw new TypeError("workspace value cannot be undefined");
  return JSON.parse(JSON.stringify(value));
}

function normalizeRect(value) {
  if (!value || typeof value !== "object") return null;
  const source = Array.isArray(value)
    ? { x: value[0], y: value[1], w: value[2], h: value[3] }
    : value;
  const x = Number(source.x);
  const y = Number(source.y);
  const w = Number(source.w);
  const h = Number(source.h);
  if (![x, y, w, h].every(Number.isInteger) || w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function normalizeRects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeRect).filter(Boolean);
}

function normalizeDropletGroups(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (normalizeRect(item)) return [normalizeRect(item)];
      return normalizeRects(item);
    })
    .filter((group) => group.length);
}

function normalizeDuration(value) {
  const duration = Number(value);
  return Number.isInteger(duration) && duration >= 0
    ? duration
    : DEFAULT_STEP_DURATION;
}

function normalizeSequence(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((step, index) => {
    if (Array.isArray(step)) {
      return {
        timeStep: index,
        duration: DEFAULT_STEP_DURATION,
        rects: normalizeRects(step[1]),
      };
    }
    const source = step && typeof step === "object" ? step : {};
    return {
      timeStep: index,
      duration: normalizeDuration(source.duration),
      rects: normalizeRects(source.rects),
    };
  });
}

function parseSequenceText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, timeStep) => {
      const durationMatch = line.match(/^(.*?)-\s*(\d+)\s*$/);
      const rectPart = durationMatch ? durationMatch[1] : line;
      const duration = durationMatch
        ? normalizeDuration(Number.parseInt(durationMatch[2], 10))
        : DEFAULT_STEP_DURATION;
      const rects = rectPart
        .split(";")
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const match = chunk.match(
            /\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*\(([-+]?\d+)\s*,\s*([-+]?\d+)\)/
          );
          return match
            ? normalizeRect(match.slice(1, 5).map((part) => Number.parseInt(part, 10)))
            : null;
        })
        .filter(Boolean);
      return { timeStep, duration, rects };
    });
}

function sequenceToText(sequence) {
  return normalizeSequence(sequence)
    .map((step) => {
      const rectText = step.rects
        .map((rect) => `(${rect.x},${rect.y})(${rect.w},${rect.h})`)
        .join(";");
      return `${rectText}-${step.duration}`;
    })
    .join("\n");
}

function appendSequence(existing, delta) {
  return normalizeSequence([...normalizeSequence(existing), ...normalizeSequence(delta)]);
}

function getLastStepRects(sequence) {
  const normalized = normalizeSequence(sequence);
  return normalized.length ? normalized[normalized.length - 1].rects : [];
}

function rectKey(rect) {
  return `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

function mergeRects(dynamicRects, staticRects) {
  const merged = [];
  const seen = new Set();
  [...normalizeRects(dynamicRects), ...normalizeRects(staticRects)].forEach((rect) => {
    const key = rectKey(rect);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(rect);
  });
  return merged;
}

function mergeDeltaWithCurrentFrame(delta, frameRects, selectedDroplets) {
  const normalizedDelta = normalizeSequence(delta);
  const selectedKeys = new Set(normalizeRects(selectedDroplets).map(rectKey));
  const staticDroplets = normalizeRects(frameRects).filter(
    (rect) => !selectedKeys.has(rectKey(rect))
  );
  return normalizedDelta.map((step, timeStep) => ({
    ...step,
    timeStep,
    rects: mergeRects(step.rects, staticDroplets),
  }));
}

class SequenceWorkspace {
  constructor(sequence = []) {
    this.sequence = normalizeSequence(sequence);
    this.customVariables = {};
    this.droplets = [];
    this.nextDropletId = 1;
    this._seedDropletsFromFrame(getLastStepRects(this.sequence));
  }

  _seedDropletsFromFrame(rects) {
    this.droplets = normalizeRects(rects).map((rect) => ({
      id: `droplet-${this.nextDropletId++}`,
      rects: [rect],
    }));
  }

  clear() {
    this.sequence = [];
    this.customVariables = {};
    this.droplets = [];
    this.nextDropletId = 1;
  }

  replace(sequence) {
    this.sequence = normalizeSequence(sequence);
    this.customVariables = {};
    this.nextDropletId = 1;
    this._seedDropletsFromFrame(getLastStepRects(this.sequence));
  }

  importText(text) {
    this.sequence = parseSequenceText(text);
    this.customVariables = {};
    this.nextDropletId = 1;
    this._seedDropletsFromFrame(getLastStepRects(this.sequence));
  }

  snapshot() {
    return normalizeSequence(this.sequence);
  }

  currentFrame() {
    return this.droplets.flatMap((droplet) => droplet.rects);
  }

  dropletRecords() {
    return cloneWorkspaceValue(this.droplets);
  }

  variables(selectedDroplets = []) {
    return {
      ...cloneWorkspaceValue(this.customVariables),
      sequence: this.snapshot(),
      currentFrameDroplets: this.currentFrame(),
      selectedDroplets: normalizeRects(selectedDroplets),
      droplets: this.dropletRecords(),
    };
  }

  applyTransitions(transitions) {
    if (!Array.isArray(transitions)) return;
    transitions.forEach((transition) => {
      const consumedGroups = normalizeDropletGroups(transition && transition.consumedDroplets);
      const producedGroups = normalizeDropletGroups(transition && transition.producedDroplets);
      consumedGroups.forEach((group) => {
        const index = this.droplets.findIndex((droplet) =>
          droplet.rects.length === group.length &&
          droplet.rects.every((rect, rectIndex) => rectKey(rect) === rectKey(group[rectIndex]))
        );
        if (index >= 0) this.droplets.splice(index, 1);
        else {
          group.forEach((rect) => {
            const rectIndex = this.droplets.findIndex((droplet) =>
              droplet.rects.some((candidate) => rectKey(candidate) === rectKey(rect))
            );
            if (rectIndex >= 0) this.droplets.splice(rectIndex, 1);
          });
        }
      });
      producedGroups.forEach((group) => {
        this.droplets.push({ id: `droplet-${this.nextDropletId++}`, rects: group });
      });
    });
  }

  setVariable(name, value) {
    const normalizedName = String(name || "").trim();
    if (!normalizedName) throw new TypeError("workspace variable name is required");
    if (RESERVED_VARIABLE_NAMES.has(normalizedName)) {
      throw new TypeError(`workspace variable name is reserved: ${normalizedName}`);
    }
    this.customVariables[normalizedName] = cloneWorkspaceValue(value);
  }

  applyVariableUpdates(updates) {
    if (!updates || typeof updates !== "object" || Array.isArray(updates)) return;
    Object.entries(updates).forEach(([name, value]) => this.setVariable(name, value));
  }

  applyDelta(delta, selectedDroplets) {
    const processedDelta = mergeDeltaWithCurrentFrame(
      delta,
      this.currentFrame(),
      selectedDroplets
    );
    this.sequence = appendSequence(this.sequence, processedDelta);
    return processedDelta;
  }

  applyComposedDelta(delta) {
    const processedDelta = normalizeSequence(delta);
    this.sequence = appendSequence(this.sequence, processedDelta);
    return processedDelta;
  }

  toText() {
    return sequenceToText(this.sequence);
  }
}

module.exports = {
  DEFAULT_STEP_DURATION,
  SequenceWorkspace,
  appendSequence,
  getLastStepRects,
  mergeDeltaWithCurrentFrame,
  normalizeRect,
  normalizeRects,
  normalizeSequence,
  parseSequenceText,
  sequenceToText,
};
