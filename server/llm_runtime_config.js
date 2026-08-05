const MAX_BASE_URL_LENGTH = 2048;
const MAX_API_KEY_LENGTH = 4096;
const MAX_MODEL_LENGTH = 256;

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
  };
}

function createLlmProcessEnv(baseEnv, llmConfig) {
  return {
    ...baseEnv,
    ...(llmConfig.baseUrl ? { OPENAI_BASE_URL: llmConfig.baseUrl } : {}),
    ...(llmConfig.apiKey ? { OPENAI_API_KEY: llmConfig.apiKey } : {}),
    ...(llmConfig.model ? { OPENAI_MODEL: llmConfig.model } : {}),
  };
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
  normalizeLlmConfig,
  sanitizeLlmError,
};
