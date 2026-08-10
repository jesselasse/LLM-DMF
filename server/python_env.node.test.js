const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultBootstrapPython, pythonPath } = require("../scripts/python-env");

test("Python environment paths are selected for Windows and Unix platforms", () => {
  assert.equal(defaultBootstrapPython("win32"), "python");
  assert.equal(defaultBootstrapPython("darwin"), "python3");
  assert.equal(defaultBootstrapPython("linux"), "python3");
  assert.match(
    pythonPath,
    process.platform === "win32" ? /Scripts[\\/]python\.exe$/ : /bin[\\/]python$/
  );
});
