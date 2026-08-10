const MAX_BASE_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;
const THINKING_MODES = new Set(["auto", "enabled", "disabled"]);

function normalizeOptionalString(value, fieldName, maxLength) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw new Error(`${fieldName} must be a string`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} is too long`);
  }
  if (normalized.includes("\0")) {
    throw new Error(`${fieldName} contains an invalid character`);
  }
  return normalized;
}

function normalizeLlmConfig(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("llmConfig must be an object");
  }

  const baseUrl = normalizeOptionalString(
    raw.baseUrl,
    "llmConfig.baseUrl",
    MAX_BASE_URL_LENGTH
  );
  const apiKey = normalizeOptionalString(
    raw.apiKey,
    "llmConfig.apiKey",
    MAX_API_KEY_LENGTH
  );
  const model = normalizeOptionalString(
    raw.model,
    "llmConfig.model",
    MAX_MODEL_LENGTH
  );
  let thinkingMode;
  if (Object.prototype.hasOwnProperty.call(raw, "thinkingMode")) {
    thinkingMode = normalizeOptionalString(
      raw.thinkingMode,
      "llmConfig.thinkingMode",
      16
    ) || "auto";
    if (!THINKING_MODES.has(thinkingMode)) {
      throw new Error("llmConfig.thinkingMode must be auto, enabled, or disabled");
    }
  }

  if (baseUrl) {
    let parsedUrl;
    try {
      parsedUrl = new URL(baseUrl);
    } catch (_error) {
      throw new Error("llmConfig.baseUrl must be a valid URL");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("llmConfig.baseUrl must use http or https");
    }
  }

  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(thinkingMode ? { thinkingMode } : {}),
  };
}

function createLlmProcessEnv(baseEnv, llmConfig) {
  const childEnv = {
    ...baseEnv,
    ...(llmConfig.baseUrl ? { OPENAI_BASE_URL: llmConfig.baseUrl } : {}),
    ...(llmConfig.apiKey ? { OPENAI_API_KEY: llmConfig.apiKey } : {}),
    ...(llmConfig.model ? { OPENAI_MODEL: llmConfig.model } : {}),
  };
  if (llmConfig.thinkingMode === "enabled" || llmConfig.thinkingMode === "disabled") {
    childEnv.OPENAI_THINKING_MODE = llmConfig.thinkingMode;
  } else if (llmConfig.thinkingMode === "auto") {
    delete childEnv.OPENAI_THINKING_MODE;
  }
  return childEnv;
}

function llmModelsUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function listLlmModels(llmConfig, fetchImpl = fetch) {
  const normalized = normalizeLlmConfig(llmConfig);
  if (!normalized.baseUrl) throw new Error("API URL is required to load models");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchImpl(llmModelsUrl(normalized.baseUrl), {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(normalized.apiKey
          ? { Authorization: `Bearer ${normalized.apiKey}` }
          : {}),
      },
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_error) {
      throw new Error("Model endpoint did not return JSON");
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
      throw new Error(`Unable to load models: ${detail}`);
    }
    const entries = Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload.models)
        ? payload.models
        : [];
    const models = [...new Set(entries.map((entry) => {
      if (typeof entry === "string") return entry.trim();
      return String(entry?.id || entry?.model || entry?.name || "").trim();
    }).filter(Boolean))]
      .slice(0, 1000)
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    if (!models.length) throw new Error("Model endpoint returned no model IDs");
    return { models, url: llmModelsUrl(normalized.baseUrl) };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Loading models timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeLlmError(raw, secrets = []) {
  let message = String(raw || "LLM request failed").trim();
  secrets.filter(Boolean).forEach((secret) => {
    message = message.split(secret).join("[redacted]");
  });
  if (/<!doctype html|<html[\s>]/i.test(message)) {
    return "LLM endpoint returned an HTML error page. Check the API URL.";
  }
  return message.replace(/\s+/g, " ").slice(0, 400);
}

module.exports = {
  createLlmProcessEnv,
  listLlmModels,
  llmModelsUrl,
  normalizeLlmConfig,
  sanitizeLlmError,
};
