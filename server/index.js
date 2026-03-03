const express = require("express");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const port = process.env.PORT || 3001;
const BACKEND_VERSION = "llm-move-v3-context";

// session_id -> { sequenceText, conversation, updatedAt }
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
    sequenceText: "",
    conversation: [],
    updatedAt: Date.now(),
  };
  sessionStore.set(sessionId, created);
  return created;
}

function appendSequence(existing, delta) {
  const left = String(existing || "").trim();
  const right = String(delta || "").trim();
  if (!left) return right;
  if (!right) return left;
  return `${left}\n${right}`;
}

function runLlmAgent(message, context) {
  return new Promise((resolve, reject) => {
    const pythonBin = process.env.PYTHON_BIN || "python3";
    const scriptPath = path.join(__dirname, "llm_move_agent.py");
    const child = spawn(pythonBin, [scriptPath], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
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

app.post("/api/steps-from-message", async (req, res) => {
  try {
    const message = String((req.body && req.body.message) || "").trim();
    const sessionId = normalizeSessionId(req.body && req.body.sessionId);
    const resetContext = Boolean(req.body && req.body.resetContext);

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const state = ensureSessionState(sessionId);
    if (resetContext) {
      state.sequenceText = "";
      state.conversation = [];
    }

    const context = {
      sequenceText: state.sequenceText,
      conversation: state.conversation,
    };

    const result = await runLlmAgent(message, context);
    const assistantReply = String(result.assistantReply || "");
    const delta = String(result.stepsTextDelta || "");
    const moveCalls = Array.isArray(result.moveCalls) ? result.moveCalls : [];

    state.conversation.push({ role: "user", content: message });
    state.conversation.push({ role: "assistant", content: assistantReply });
    state.sequenceText = appendSequence(state.sequenceText, delta);
    state.updatedAt = Date.now();
    sessionStore.set(sessionId, state);

    res.set("x-backend-version", BACKEND_VERSION);
    return res.json({
      sessionId,
      assistantReply,
      stepsTextDelta: delta,
      stepsText: state.sequenceText,
      moveCalls,
    });
  } catch (error) {
    return res.status(502).json({
      error: error.message || "failed to generate steps from message",
    });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}`);
});
