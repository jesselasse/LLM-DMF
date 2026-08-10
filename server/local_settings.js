const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeLlmConfig } = require("./llm_runtime_config");

const SETTINGS_PATH = path.resolve(__dirname, "..", ".local", "settings.json");
const SETTINGS_VERSION = 1;

function normalizePresets(raw) {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > 32) {
    throw new Error("presets must contain at most 32 entries");
  }
  return raw.map((preset, index) => {
    const labels = preset && typeof preset.labels === "object" ? preset.labels : {};
    const normalized = {
      id: String(preset?.id || "").trim(),
      labels: {
        zh: String(labels.zh || "").trim(),
        en: String(labels.en || "").trim(),
      },
      text: String(preset?.text || "").trim(),
    };
    if (!normalized.id || !normalized.labels.zh || !normalized.labels.en || !normalized.text) {
      throw new Error(`presets[${index}] is incomplete`);
    }
    if (
      normalized.id.length > 128 ||
      normalized.labels.zh.length > 256 ||
      normalized.labels.en.length > 256 ||
      normalized.text.length > 10000
    ) {
      throw new Error(`presets[${index}] is too long`);
    }
    return normalized;
  });
}

function normalizeProfile(raw, index = 0) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`profiles[${index}] must be an object`);
  }
  const id = String(raw.id || "").trim();
  const name = String(raw.name || "").trim();
  if (!id || !name) throw new Error(`profiles[${index}] is incomplete`);
  if (id.length > 128 || name.length > 128) {
    throw new Error(`profiles[${index}] is too long`);
  }
  return { id, name, thinkingMode: "auto", ...normalizeLlmConfig(raw) };
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (Array.isArray(source.profiles) && source.profiles.length > 32) {
    throw new Error("profiles must contain at most 32 entries");
  }
  const profiles = Array.isArray(source.profiles) ? source.profiles.map(normalizeProfile) : [];
  const requestedActiveId = String(source.activeProfileId || "").trim();
  const activeProfileId = profiles.some((profile) => profile.id === requestedActiveId)
    ? requestedActiveId
    : profiles[0]?.id || "";
  return {
    version: SETTINGS_VERSION,
    activeProfileId,
    profiles,
    presets: normalizePresets(source.presets),
  };
}

function readLocalSettings(settingsPath = SETTINGS_PATH) {
  try {
    const text = fs.readFileSync(settingsPath, "utf8");
    if (text.length > 1024 * 1024) return normalizeSettings({});
    return normalizeSettings(JSON.parse(text));
  } catch (_error) {
    return normalizeSettings({});
  }
}

function writeLocalSettings(settings, settingsPath = SETTINGS_PATH) {
  const normalized = normalizeSettings(settings);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

function publicSettings(settings, includeSecrets = false) {
  const normalized = normalizeSettings(settings);
  return {
    version: SETTINGS_VERSION,
    activeProfileId: normalized.activeProfileId,
    profiles: normalized.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.baseUrl || "",
      model: profile.model || "",
      thinkingMode: profile.thinkingMode || "auto",
      hasApiKey: Boolean(profile.apiKey),
      ...(includeSecrets && profile.apiKey ? { apiKey: profile.apiKey } : {}),
    })),
    presets: normalized.presets,
  };
}

function saveProfile(settings, rawProfile) {
  const current = normalizeSettings(settings);
  const requestedId = String(rawProfile?.id || "").trim();
  const existing = current.profiles.find((profile) => profile.id === requestedId);
  const id = existing?.id || crypto.randomUUID();
  const submittedConfig = normalizeLlmConfig(rawProfile);
  const submittedThinkingMode = Object.prototype.hasOwnProperty.call(
    rawProfile || {},
    "thinkingMode"
  );
  const profile = normalizeProfile({
    id,
    name: rawProfile?.name,
    ...submittedConfig,
    ...(!submittedConfig.apiKey && existing?.apiKey ? { apiKey: existing.apiKey } : {}),
    ...(!submittedThinkingMode && existing?.thinkingMode
      ? { thinkingMode: existing.thinkingMode }
      : {}),
  });
  const profiles = existing
    ? current.profiles.map((entry) => (entry.id === id ? profile : entry))
    : [...current.profiles, profile];
  return normalizeSettings({ ...current, profiles, activeProfileId: id });
}

function activeLlmConfig(settings) {
  const normalized = normalizeSettings(settings);
  return normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) || {};
}

module.exports = {
  SETTINGS_PATH,
  activeLlmConfig,
  normalizePresets,
  normalizeSettings,
  publicSettings,
  readLocalSettings,
  saveProfile,
  writeLocalSettings,
};
