const { spawn } = require("child_process");
const path = require("path");
const { ensurePythonEnvironment, projectRoot } = require("./python-env");

let children = [];
let stopping = false;

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  setTimeout(() => process.exit(exitCode), 250);
}

function startProcess(label, command, args, env) {
  const child = spawn(command, args, {
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

try {
  const pythonPath = ensurePythonEnvironment();
  const sharedEnv = {
    ...process.env,
    PYTHON_BIN: pythonPath,
    WATCHPACK_POLLING: process.env.WATCHPACK_POLLING || "true",
  };
  const backendPath = path.join(projectRoot, "server", "index.js");
  const frontendPath = path.join(
    projectRoot,
    "node_modules",
    "react-scripts",
    "scripts",
    "start.js"
  );

  console.log(`[dev] Python: ${pythonPath}`);
  console.log("[dev] Starting backend on http://localhost:3001");
  startProcess("backend", process.execPath, [backendPath], sharedEnv);
  console.log("[dev] Starting frontend on http://localhost:3000");
  startProcess("frontend", process.execPath, [frontendPath], sharedEnv);
} catch (error) {
  console.error(`[dev] ${error.message}`);
  process.exitCode = 1;
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
