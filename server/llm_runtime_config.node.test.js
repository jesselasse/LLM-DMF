const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLlmProcessEnv,
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
  });
  const childEnv = createLlmProcessEnv(baseEnv, normalized);

  assert.equal(childEnv.OPENAI_BASE_URL, "https://custom.example/v1");
  assert.equal(childEnv.OPENAI_API_KEY, "temporary-key");
  assert.equal(childEnv.OPENAI_MODEL, "custom-model");
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
