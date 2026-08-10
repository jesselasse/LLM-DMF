const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLlmProcessEnv,
  listLlmModels,
  llmModelsUrl,
  normalizeLlmConfig,
  sanitizeLlmError,
} = require("./llm_runtime_config");

test("blank runtime settings preserve server defaults", () => {
  const baseEnv = {
    OPENAI_BASE_URL: "https://server.example/v1",
    OPENAI_API_KEY: "server-key",
    OPENAI_MODEL: "server-model",
  };

  const normalized = normalizeLlmConfig({ baseUrl: "", apiKey: "", model: "" });
  const childEnv = createLlmProcessEnv(baseEnv, normalized);

  assert.deepEqual(normalized, {});
  assert.equal(childEnv.OPENAI_BASE_URL, baseEnv.OPENAI_BASE_URL);
  assert.equal(childEnv.OPENAI_API_KEY, baseEnv.OPENAI_API_KEY);
  assert.equal(childEnv.OPENAI_MODEL, baseEnv.OPENAI_MODEL);
  assert.notEqual(childEnv, baseEnv);
});

test("runtime settings override only the current child environment", () => {
  const baseEnv = {
    OPENAI_BASE_URL: "https://server.example/v1",
    OPENAI_API_KEY: "server-key",
    OPENAI_MODEL: "server-model",
  };
  const normalized = normalizeLlmConfig({
    baseUrl: " https://custom.example/v1 ",
    apiKey: " temporary-key ",
    model: " custom-model ",
    thinkingMode: "disabled",
  });
  const childEnv = createLlmProcessEnv(baseEnv, normalized);

  assert.equal(childEnv.OPENAI_BASE_URL, "https://custom.example/v1");
  assert.equal(childEnv.OPENAI_API_KEY, "temporary-key");
  assert.equal(childEnv.OPENAI_MODEL, "custom-model");
  assert.equal(childEnv.OPENAI_THINKING_MODE, "disabled");
  assert.equal(baseEnv.OPENAI_API_KEY, "server-key");
});

test("runtime settings reject invalid shapes and URLs", () => {
  assert.throws(() => normalizeLlmConfig("invalid"), /must be an object/);
  assert.throws(
    () => normalizeLlmConfig({ baseUrl: "file:///tmp/model" }),
    /must use http or https/
  );
  assert.throws(
    () => normalizeLlmConfig({ apiKey: "x".repeat(4097) }),
    /apiKey is too long/
  );
  assert.throws(
    () => normalizeLlmConfig({ thinkingMode: "sometimes" }),
    /must be auto, enabled, or disabled/
  );
});

test("automatic reasoning mode removes an inherited override", () => {
  const childEnv = createLlmProcessEnv(
    { OPENAI_THINKING_MODE: "enabled" },
    normalizeLlmConfig({ thinkingMode: "auto" })
  );
  assert.equal(childEnv.OPENAI_THINKING_MODE, undefined);
});

test("LLM errors hide secrets and collapse HTML responses", () => {
  assert.equal(
    sanitizeLlmError("request failed with temporary-secret", ["temporary-secret"]),
    "request failed with [redacted]"
  );
  assert.equal(
    sanitizeLlmError("NotFoundError: <!DOCTYPE html><html>not found</html>"),
    "LLM endpoint returned an HTML error page. Check the API URL."
  );
});

test("model discovery appends the standard models path", () => {
  assert.equal(
    llmModelsUrl("https://custom.example/v1/"),
    "https://custom.example/v1/models"
  );
});

test("model discovery accepts OpenAI-compatible lists and sends the API key", async () => {
  let request;
  const result = await listLlmModels(
    { baseUrl: "https://custom.example/v1", apiKey: "plain-key" },
    async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ id: "model-10" }, { id: "model-2" }, { id: "model-2" }],
        }),
      };
    }
  );

  assert.equal(request.url, "https://custom.example/v1/models");
  assert.equal(request.options.headers.Authorization, "Bearer plain-key");
  assert.deepEqual(result.models, ["model-2", "model-10"]);
});

test("model discovery also accepts simple local model lists", async () => {
  const result = await listLlmModels(
    { baseUrl: "http://127.0.0.1:11434/v1" },
    async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ models: [{ name: "local-model" }] }),
    })
  );
  assert.deepEqual(result.models, ["local-model"]);
});
