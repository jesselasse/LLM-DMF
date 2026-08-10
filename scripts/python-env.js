const { spawnSync } = require("child_process");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const pythonPath = path.join(
  projectRoot,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
);

function run(command, args) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

function succeeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "ignore",
  });
  return result.status === 0;
}

function ensureUv(bootstrapPython) {
  if (succeeds(bootstrapPython, ["-m", "uv", "--version"])) return;

  console.log("[setup] Installing uv for Python dependency management...");
  const install = run(bootstrapPython, ["-m", "pip", "install", "--user", "uv"]);
  if (install.status !== 0 || !succeeds(bootstrapPython, ["-m", "uv", "--version"])) {
    throw new Error("Unable to install uv. Install uv manually, then run npm start again.");
  }
}

function ensurePythonEnvironment() {
  const imports = ["-c", "import langchain_core, langchain_openai, pydantic"];
  if (succeeds(pythonPath, imports)) return pythonPath;

  const bootstrapPython =
    process.env.PYTHON_BOOTSTRAP || defaultBootstrapPython(process.platform);
  if (!succeeds(bootstrapPython, ["--version"])) {
    throw new Error(
      `Python bootstrap interpreter not found: ${bootstrapPython}. ` +
        "Set PYTHON_BOOTSTRAP to a Python 3.12+ executable."
    );
  }

  ensureUv(bootstrapPython);
  console.log("[setup] Creating/updating .venv from uv.lock...");
  const sync = run(bootstrapPython, ["-m", "uv", "sync", "--locked"]);
  if (sync.status !== 0 || !succeeds(pythonPath, imports)) {
    throw new Error("Python environment setup failed.");
  }
  return pythonPath;
}

function defaultBootstrapPython(platform) {
  return platform === "win32" ? "python" : "python3";
}

module.exports = {
  defaultBootstrapPython,
  ensurePythonEnvironment,
  projectRoot,
  pythonPath,
};
