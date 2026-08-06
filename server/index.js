const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const {
  getLastStepRects,
  mergeDeltaWithCurrentFrame: mergeSequenceDeltaWithCurrentFrame,
  normalizeRect,
  normalizeRects,
  normalizeSequence,
  parseSequenceText,
  SequenceWorkspace,
  sequenceToText,
} = require("./sequence_workspace");
const { createLlmProcessEnv, normalizeLlmConfig } = require("./llm_runtime_config");

const app = express();
const port = process.env.PORT || 3001;
const BACKEND_VERSION = "llm-move-v5-generic-array-tools";

// session_id -> { workspace, conversation, selectedDroplets, updatedAt }
const sessionStore = new Map();

app.use(express.json());

function normalizeSessionId(raw) {
  const value = String(raw || "").trim();
  return value || "default";
}

function ensureSessionState(sessionId) {
  const existing = sessionStore.get(sessionId);
  if (existing) return existing;
  const created = {
    workspace: new SequenceWorkspace(),
    conversation: [],
    selectedDroplets: [],
    updatedAt: Date.now(),
  };
  sessionStore.set(sessionId, created);
  return created;
}

function normalizeSelectedDroplets(raw) {
  return normalizeRects(raw);
}

function syncSessionState(state, payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, "sequenceText")) {
    state.workspace.importText(payload.sequenceText);
    state.conversation = [];
  } else if (payload && Object.prototype.hasOwnProperty.call(payload, "sequence")) {
    state.workspace.replace(payload.sequence);
    state.conversation = [];
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, "selectedDroplets")) {
    state.selectedDroplets = normalizeSelectedDroplets(payload.selectedDroplets);
  }
  state.updatedAt = Date.now();
  return state;
}

function resolveDropletsFromCall(call, selectedDroplets) {
  if (!call || typeof call !== "object") return [];
  const resolvedDroplets = normalizeSelectedDroplets(call.resolvedDroplets);
  if (resolvedDroplets.length) return resolvedDroplets;
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const droplets = normalizeSelectedDroplets(args.droplets);
  const hasExplicitSingle = ["x", "y", "w", "h"].some((key) => args[key] !== null && args[key] !== undefined);

  if (droplets.length && hasExplicitSingle) {
    return [];
  }
  if (droplets.length) {
    return droplets;
  }
  if (hasExplicitSingle) {
    const single = normalizeRect({
      x: args.x,
      y: args.y,
      w: args.w,
      h: args.h,
    });
    return single ? [single] : [];
  }
  if (call.tool === "move" || call.tool === "rotate_mix") {
    return normalizeSelectedDroplets(selectedDroplets);
  }
  return [];
}

function getLastStepRectsFromSequenceText(text) {
  return getLastStepRects(parseSequenceText(text));
}

function mergeDeltaWithCurrentFrame(deltaText, frameRects, selectedDroplets) {
  return sequenceToText(
    mergeSequenceDeltaWithCurrentFrame(
      parseSequenceText(deltaText),
      frameRects,
      selectedDroplets
    )
  );
}

function runLlmAgent(message, context, llmConfig) {
  return new Promise((resolve, reject) => {
    const pythonBin = process.env.PYTHON_BIN || "python3";
    const scriptPath = path.join(__dirname, "llm_move_agent.py");
    const child = spawn(pythonBin, [scriptPath], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      env: createLlmProcessEnv(process.env, llmConfig),
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        try {
          const payload = JSON.parse(stdout.trim());
          resolve(payload);
        } catch (err) {
          reject(new Error(`Invalid JSON from llm_move_agent.py: ${stdout.trim()}`));
        }
        return;
      }
      reject(
        new Error(
          stderr.trim() || `llm_move_agent.py exited with non-zero code: ${code}`
        )
      );
    });

    child.stdin.write(JSON.stringify({ message, context }));
    child.stdin.end();
  });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: BACKEND_VERSION,
    sessions: sessionStore.size,
  });
});

app.post("/api/session-state", (req, res) => {
  try {
    const sessionId = normalizeSessionId(req.body && req.body.sessionId);
    const state = ensureSessionState(sessionId);
    syncSessionState(state, req.body || {});
    sessionStore.set(sessionId, state);
    return res.json({
      sessionId,
      selectedDroplets: state.selectedDroplets,
      currentFrameRects: state.workspace.currentFrame(),
    });
  } catch (error) {
    return res.status(400).json({
      error: error.message || "failed to sync session state",
    });
  }
});

app.post("/api/steps-from-message", async (req, res) => {
  try {
    const message = String((req.body && req.body.message) || "").trim();
    const sessionId = normalizeSessionId(req.body && req.body.sessionId);
    const resetContext = Boolean(req.body && req.body.resetContext);
    let llmConfig;
    try {
      llmConfig = normalizeLlmConfig(req.body && req.body.llmConfig);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const state = ensureSessionState(sessionId);
    if (resetContext) {
      state.workspace.clear();
      state.conversation = [];
      state.selectedDroplets = [];
    }

    syncSessionState(state, req.body || {});
    const currentFrameRects = state.workspace.currentFrame();

    const context = {
      sequence: state.workspace.snapshot(),
      workspaceVariables: state.workspace.variables(state.selectedDroplets),
      conversation: state.conversation,
      selectedDroplets: state.selectedDroplets,
    };

    const result = await runLlmAgent(message, context, llmConfig);
    const assistantReply = String(result.assistantReply || "");
    state.workspace.applyVariableUpdates(result.workspaceUpdates);
    const rawDelta = normalizeSequence(result.sequenceDelta);
    const moveCalls = Array.isArray(result.moveCalls) ? result.moveCalls : [];
    const resolvedSelectedDroplets = moveCalls.flatMap((call) =>
      resolveDropletsFromCall(call, state.selectedDroplets)
    );
    const effectiveSelectedDroplets = resolvedSelectedDroplets.length
      ? resolvedSelectedDroplets
      : state.selectedDroplets;
    const delta = state.workspace.applyDelta(rawDelta, effectiveSelectedDroplets);

    state.conversation.push({ role: "user", content: message });
    state.conversation.push({ role: "assistant", content: assistantReply });
    state.selectedDroplets = normalizeSelectedDroplets(effectiveSelectedDroplets);
    state.updatedAt = Date.now();
    sessionStore.set(sessionId, state);

    res.set("x-backend-version", BACKEND_VERSION);
    return res.json({
      sessionId,
      assistantReply,
      stepsTextDelta: sequenceToText(delta),
      stepsTextDeltaRaw: sequenceToText(rawDelta),
      stepsText: state.workspace.toText(),
      moveCalls,
      selectedDroplets: state.selectedDroplets,
      currentFrameRects,
    });
  } catch (error) {
    return res.status(502).json({
      error: error.message || "failed to generate steps from message",
    });
  }
});

if (require.main === module) {
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Backend listening on http://localhost:${port}`);
  });
}

module.exports = {
  app,
  getLastStepRectsFromSequenceText,
  mergeDeltaWithCurrentFrame,
  parseStepsText: parseSequenceText,
  sessionStore,
};
