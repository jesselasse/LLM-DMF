const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { DEFAULT_OUTPUT_ROOT } = require("./core");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SETTINGS_PATH = path.join(PROJECT_ROOT, ".local", "batch-tool-settings.json");

function localPath(value, fallback) {
  const text = String(value || "").trim();
  const resolved = text ? path.resolve(PROJECT_ROOT, text) : fallback;
  if (!path.isAbsolute(resolved)) throw new Error("存储位置必须是有效的本地路径");
  return resolved;
}

function normalizeBatchSettings(raw = {}) {
  return {
    version: 1,
    projectRoot: localPath(raw.projectRoot, path.join(PROJECT_ROOT, ".local", "projects")),
    outputRoot: localPath(raw.outputRoot, DEFAULT_OUTPUT_ROOT),
    language: ["zh", "en", "es"].includes(raw.language) ? raw.language : "zh",
    theme: raw.theme === "dark" ? "dark" : "light",
  };
}

function readBatchSettings(settingsPath = SETTINGS_PATH) {
  try {
    return normalizeBatchSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch (_error) {
    return normalizeBatchSettings();
  }
}

function writeBatchSettings(raw, settingsPath = SETTINGS_PATH) {
  const settings = normalizeBatchSettings(raw);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(settings.projectRoot, { recursive: true });
  fs.mkdirSync(settings.outputRoot, { recursive: true });
  const temporary = `${settingsPath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, settingsPath);
  return settings;
}

function portableBatchSettings(raw) {
  const settings = normalizeBatchSettings(raw);
  const portablePath = (value) => {
    const relative = path.relative(PROJECT_ROOT, value);
    return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".."
      ? relative.replaceAll(path.sep, "/")
      : value;
  };
  return {
    ...settings,
    projectRoot: portablePath(settings.projectRoot),
    outputRoot: portablePath(settings.outputRoot),
  };
}

module.exports = {
  SETTINGS_PATH,
  normalizeBatchSettings,
  portableBatchSettings,
  readBatchSettings,
  writeBatchSettings,
};
