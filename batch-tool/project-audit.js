const path = require("path");
const { spawn } = require("child_process");
const { pythonPath } = require("../scripts/python-env");
const { parseSequenceText, sequenceToText } = require("../server/sequence_workspace");

const auditScript = path.join(__dirname, "audit_tool_calls.py");

function auditToolCalls(calls, actualRawText, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.env.PYTHON_BIN || pythonPath, [auditScript], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ checked: false, required: true, matches: false, reason: "项目语义重放超时" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      finish({ checked: false, required: true, matches: false, reason: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      let payload = {};
      try { payload = stdout.trim() ? JSON.parse(stdout.trim()) : {}; } catch (_error) { payload = {}; }
      if (code !== 0 || !Array.isArray(payload.sequence)) {
        finish({
          checked: false,
          required: true,
          matches: false,
          reason: payload.error || stderr.trim() || "项目语义重放失败",
        });
        return;
      }
      const expectedRawText = sequenceToText(payload.sequence);
      const actual = sequenceToText(parseSequenceText(actualRawText));
      const matches = expectedRawText === actual;
      const outputDroplets = Array.isArray(payload.outputs)
        ? payload.outputs.map((rect) => ({
            x: Number(rect?.[0]),
            y: Number(rect?.[1]),
            w: Number(rect?.[2]),
            h: Number(rect?.[3]),
          })).filter((rect) => Object.values(rect).every(Number.isInteger))
        : [];
      finish({
        checked: true,
        required: true,
        matches,
        reason: matches ? "激活序列与项目操作重放一致" : "激活序列与项目操作重放不一致",
        expectedSteps: parseSequenceText(expectedRawText).length,
        actualSteps: parseSequenceText(actual).length,
        outputDroplets,
      });
    });
    child.stdin.end(JSON.stringify({ calls }));
  });
}

module.exports = { auditToolCalls };
