const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeBatchSettings,
  portableBatchSettings,
  readBatchSettings,
  writeBatchSettings,
} = require("./local-settings");

test("batch settings keep portable local paths, language, and theme", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llm-dmf-batch-settings-"));
  const settingsPath = path.join(root, "settings.json");
  const saved = writeBatchSettings({
    projectRoot: path.join(root, "projects"),
    outputRoot: path.join(root, "results"),
    language: "en",
    theme: "dark",
  }, settingsPath);
  assert.equal(saved.language, "en");
  assert.equal(saved.theme, "dark");
  assert.deepEqual(readBatchSettings(settingsPath), saved);
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid language and theme use safe defaults", () => {
  const settings = normalizeBatchSettings({ language: "xx", theme: "blue" });
  assert.equal(settings.language, "zh");
  assert.equal(settings.theme, "light");
});

test("Spanish is a supported persistent interface language", () => {
  assert.equal(normalizeBatchSettings({ language: "es" }).language, "es");
});

test("configuration export keeps repository-local paths portable", () => {
  const exported = portableBatchSettings({
    projectRoot: ".local/projects",
    outputRoot: ".local/experiments",
  });
  assert.equal(exported.projectRoot, ".local/projects");
  assert.equal(exported.outputRoot, ".local/experiments");
});
