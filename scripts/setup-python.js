const { ensurePythonEnvironment } = require("./python-env");

try {
  const pythonPath = ensurePythonEnvironment();
  console.log(`[setup] Python environment ready: ${pythonPath}`);
} catch (error) {
  console.error(`[setup] ${error.message}`);
  process.exitCode = 1;
}
