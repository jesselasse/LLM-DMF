const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { ensurePythonEnvironment, projectRoot } = require("../scripts/python-env");

const children = [];
let stopping = false;

function backendIsRunning() {
  return new Promise((resolve) => {
    const request = http.get("http://127.0.0.1:3001/api/health", (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.setTimeout(800, () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

function startProcess(label, file, env) {
  const child = spawn(process.execPath, [file], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`[${label}] ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[${label}] exited with ${reason}`);
    stop(code || 1);
  });
  children.push(child);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  setTimeout(() => process.exit(code), 250);
}

async function main() {
  const pythonPath = ensurePythonEnvironment();
  const env = { ...process.env, PYTHON_BIN: pythonPath };
  if (!(await backendIsRunning())) {
    console.log("[batch] Starting the official backend on http://localhost:3001");
    startProcess("backend", path.join(projectRoot, "server", "index.js"), env);
  } else {
    console.log("[batch] Reusing the official backend on http://localhost:3001");
  }
  console.log("[batch] Starting the batch tool on http://localhost:3003");
  startProcess("batch", path.join(__dirname, "server.js"), env);
}

main().catch((error) => {
  console.error(`[batch] ${error.message}`);
  process.exitCode = 1;
});

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
