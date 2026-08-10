const express = require("express");
const path = require("path");
const { spawn } = require("child_process");
const { ensurePythonEnvironment } = require("../scripts/python-env");
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
const {
  createLlmProcessEnv,
  listLlmModels,
  normalizeLlmConfig,
  sanitizeLlmError,
} = require("./llm_runtime_config");
const {
  activeLlmConfig,
  normalizePresets,
  normalizeSettings,
  publicSettings,
  readLocalSettings,
  saveProfile,
  writeLocalSettings,
} = require("./local_settings");

const app = express();
const port = process.env.PORT || 3001;
const BACKEND_VERSION = "llm-move-v5-generic-array-tools";

// session_id -> { workspace, conversation, selectedDroplets, updatedAt }
const sessionStore = new Map();
let resolvedPythonBin = "";

app.use(express.json());

function normalizeSessionId(raw) {
  const value = String(raw || "").trim();
  return value || "default";
}

function getPythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  if (!resolvedPythonBin) resolvedPythonBin = ensurePythonEnvironment();
  return resolvedPythonBin;
}

function ensureSessionState(sessionId) {
  const existing = sessionStore.get(sessionId);
  if (existing) {
    if (!Array.isArray(existing.turns)) existing.turns = [];
    return existing;
  }
  const created = {
    workspace: new SequenceWorkspace(),
    conversation: [],
    turns: [],
    selectedDroplets: [],
    updatedAt: Date.now(),
  };
  sessionStore.set(sessionId, created);
  return created;
}

function normalizeSelectedDroplets(raw) {
  return normalizeRects(raw);
}

function resolveLlmConfig(raw) {
  return {
    ...activeLlmConfig(readLocalSettings()),
    ...normalizeLlmConfig(raw),
  };
}

function normalizeTokenUsage(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const tokenCount = (value) => {
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
  };
  const inputTokens = tokenCount(source.inputTokens);
  const outputTokens = tokenCount(source.outputTokens);
  return {
    available: Boolean(source.available),
    inputTokens,
    outputTokens,
    totalTokens: tokenCount(source.totalTokens) || inputTokens + outputTokens,
  };
}

function sumTurnTokenUsage(turns) {
  return (Array.isArray(turns) ? turns : []).reduce(
    (total, turn) => {
      const usage = normalizeTokenUsage(turn && turn.tokenUsage);
      total.available = total.available || usage.available;
      total.inputTokens += usage.inputTokens;
      total.outputTokens += usage.outputTokens;
      total.totalTokens += usage.totalTokens;
      return total;
    },
    { available: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}

function syncSessionState(state, payload) {
  if (payload && Object.prototype.hasOwnProperty.call(payload, "sequenceText")) {
    state.workspace.importText(payload.sequenceText);
    state.conversation = [];
    state.turns = [];
  } else if (payload && Object.prototype.hasOwnProperty.call(payload, "sequence")) {
    state.workspace.replace(payload.sequence);
    state.conversation = [];
    state.turns = [];
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, "selectedDroplets")) {
    state.selectedDroplets = normalizeSelectedDroplets(payload.selectedDroplets);
  }
  state.updatedAt = Date.now();
  return state;
}

function rewindSessionToTurn(state, turnIndex) {
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= state.turns.length) {
    throw new Error("editTurnIndex does not identify an existing conversation turn");
  }
  const turn = state.turns[turnIndex];
  state.workspace.replace(turn.sequenceBefore);
  state.selectedDroplets = normalizeSelectedDroplets(turn.selectedDropletsBefore);
  state.conversation = state.conversation.slice(0, turn.conversationLengthBefore);
  state.turns = state.turns.slice(0, turnIndex);
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
    const pythonBin = getPythonBin();
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
          sanitizeLlmError(
            stderr.trim() || `llm_move_agent.py exited with non-zero code: ${code}`,
            [llmConfig.apiKey]
          )
        )
      );
    });

    child.stdin.write(JSON.stringify({ message, context }));
    child.stdin.end();
  });
}

function runLlmConnectionTest(llmConfig) {
  return new Promise((resolve, reject) => {
    const pythonBin = getPythonBin();
    const scriptPath = path.join(__dirname, "llm_connection_test.py");
    const child = spawn(pythonBin, [scriptPath], {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
      env: createLlmProcessEnv(process.env, llmConfig),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("LLM connection test timed out."));
    }, 25000);
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => settle(reject, error));
    child.on("close", (code) => {
      if (code !== 0) {
        settle(
          reject,
          new Error(
            sanitizeLlmError(
              stderr || `LLM connection test exited with non-zero code: ${code}`,
              [llmConfig.apiKey]
            )
          )
        );
        return;
      }
      try {
        settle(resolve, JSON.parse(stdout.trim()));
      } catch (_error) {
        settle(reject, new Error("LLM connection test returned invalid output."));
      }
    });
  });
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    version: BACKEND_VERSION,
    sessions: sessionStore.size,
  });
});

app.get("/api/local-settings", (_req, res) => {
  return res.json(publicSettings(readLocalSettings()));
});

app.put("/api/local-settings/profile", (req, res) => {
  try {
    const saved = writeLocalSettings(
      saveProfile(readLocalSettings(), req.body && req.body.profile)
    );
    return res.json({ ok: true, ...publicSettings(saved) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.put("/api/local-settings/active-profile", (req, res) => {
  try {
    const current = readLocalSettings();
    const activeProfileId = String((req.body && req.body.profileId) || "").trim();
    if (!current.profiles.some((profile) => profile.id === activeProfileId)) {
      throw new Error("profile does not exist");
    }
    const saved = writeLocalSettings({ ...current, activeProfileId });
    return res.json({ ok: true, ...publicSettings(saved) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/api/local-settings/profile/:profileId", (req, res) => {
  try {
    const current = readLocalSettings();
    const profiles = current.profiles.filter(
      (profile) => profile.id !== String(req.params.profileId || "")
    );
    const saved = writeLocalSettings({ ...current, profiles });
    return res.json({ ok: true, ...publicSettings(saved) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.put("/api/local-settings/presets", (req, res) => {
  try {
    const current = readLocalSettings();
    const presets = normalizePresets(req.body && req.body.presets);
    const saved = writeLocalSettings({ ...current, presets });
    return res.json({ ok: true, presets: saved.presets });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/local-settings/export", (req, res) => {
  const includeSecrets = req.query.includeSecrets === "true";
  res.set("Content-Disposition", "attachment; filename=llm-dmf-settings.json");
  return res.json(publicSettings(readLocalSettings(), includeSecrets));
});

app.put("/api/local-settings/import", (req, res) => {
  try {
    const current = readLocalSettings();
    const imported = normalizeSettings(req.body);
    imported.profiles = imported.profiles.map((profile) => {
      const existing = current.profiles.find((entry) => entry.id === profile.id);
      return !profile.apiKey && existing?.apiKey
        ? { ...profile, apiKey: existing.apiKey }
        : profile;
    });
    const saved = writeLocalSettings(imported);
    return res.json({ ok: true, ...publicSettings(saved) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/llm-config/test", async (req, res) => {
  let llmConfig;
  try {
    llmConfig = resolveLlmConfig(req.body && req.body.llmConfig);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  try {
    const result = await runLlmConnectionTest(llmConfig);
    return res.json({
      ok: true,
      model: String(result.model || llmConfig.model || ""),
      latencyMs: Math.max(0, Number(result.latencyMs) || 0),
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: sanitizeLlmError(error.message, [llmConfig.apiKey]),
    });
  }
});

app.post("/api/llm-config/models", async (req, res) => {
  let llmConfig;
  try {
    llmConfig = resolveLlmConfig(req.body && req.body.llmConfig);
    const result = await listLlmModels(llmConfig);
    return res.json({ ok: true, models: result.models });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: sanitizeLlmError(error.message, [llmConfig?.apiKey]),
    });
  }
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
    const hasEditTurn =
      req.body && Object.prototype.hasOwnProperty.call(req.body, "editTurnIndex");
    const editTurnIndex = hasEditTurn ? Number(req.body.editTurnIndex) : null;
    let llmConfig;
    try {
      llmConfig = resolveLlmConfig(req.body && req.body.llmConfig);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const state = ensureSessionState(sessionId);
    const editRollback = hasEditTurn
      ? {
          sequence: state.workspace.snapshot(),
          conversation: [...state.conversation],
          turns: [...state.turns],
          selectedDroplets: normalizeSelectedDroplets(state.selectedDroplets),
        }
      : null;
    if (resetContext) {
      state.workspace.clear();
      state.conversation = [];
      state.turns = [];
      state.selectedDroplets = [];
    }
    if (hasEditTurn) {
      rewindSessionToTurn(state, editTurnIndex);
    } else {
      syncSessionState(state, req.body || {});
    }
    const turnIndex = state.turns.length;
    const turnSnapshot = {
      sequenceBefore: state.workspace.snapshot(),
      selectedDropletsBefore: normalizeSelectedDroplets(state.selectedDroplets),
      conversationLengthBefore: state.conversation.length,
    };
    const currentFrameRects = state.workspace.currentFrame();

    const context = {
      sequence: state.workspace.snapshot(),
      workspaceVariables: state.workspace.variables(state.selectedDroplets),
      conversation: state.conversation,
      selectedDroplets: state.selectedDroplets,
    };

    let result;
    try {
      result = await runLlmAgent(message, context, llmConfig);
    } catch (error) {
      if (editRollback) {
        state.workspace.replace(editRollback.sequence);
        state.conversation = editRollback.conversation;
        state.turns = editRollback.turns;
        state.selectedDroplets = editRollback.selectedDroplets;
        state.updatedAt = Date.now();
      }
      throw error;
    }
    const assistantReply = String(result.assistantReply || "");
    const tokenUsage = normalizeTokenUsage(result.tokenUsage);
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
    state.turns.push({ ...turnSnapshot, tokenUsage });
    state.selectedDroplets = normalizeSelectedDroplets(effectiveSelectedDroplets);
    state.updatedAt = Date.now();
    sessionStore.set(sessionId, state);

    res.set("x-backend-version", BACKEND_VERSION);
    return res.json({
      sessionId,
      turnIndex,
      baseStepCount: turnSnapshot.sequenceBefore.length,
      assistantReply,
      tokenUsage,
      sessionTokenUsage: sumTurnTokenUsage(state.turns),
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
  normalizeTokenUsage,
  resolveLlmConfig,
  rewindSessionToTurn,
  sumTurnTokenUsage,
  sessionStore,
};
