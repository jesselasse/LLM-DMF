const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { after, test } = require("node:test");
const {
  activeLlmConfig,
  publicSettings,
  readLocalSettings,
  saveProfile,
  writeLocalSettings,
} = require("./local_settings");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "llm-dmf-local-"));
const settingsPath = path.join(temporaryDirectory, "settings.json");

after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

test("multiple local profiles persist while public settings hide secrets", () => {
  let settings = saveProfile({}, {
    name: "Profile A",
    baseUrl: "https://example.test/v1",
    apiKey: "secret-a",
    model: "model-a",
    thinkingMode: "disabled",
  });
  settings = saveProfile(settings, { name: "Profile B", model: "model-b" });
  writeLocalSettings(settings, settingsPath);

  const loaded = readLocalSettings(settingsPath);
  assert.equal(loaded.profiles.length, 2);
  assert.equal(activeLlmConfig(loaded).model, "model-b");
  assert.equal(loaded.profiles[0].thinkingMode, "disabled");
  assert.equal(loaded.profiles[1].thinkingMode, "auto");
  assert.equal(JSON.stringify(publicSettings(loaded)).includes("secret-a"), false);
  assert.equal(JSON.stringify(publicSettings(loaded, true)).includes("secret-a"), true);
});

test("saving an existing profile with a blank key preserves its local key", () => {
  let settings = saveProfile({}, {
    name: "Default",
    apiKey: "keep-me",
    thinkingMode: "disabled",
  });
  settings = saveProfile(settings, {
    id: settings.activeProfileId,
    name: "Renamed",
    apiKey: "",
    model: "new-model",
  });
  assert.equal(activeLlmConfig(settings).apiKey, "keep-me");
  assert.equal(activeLlmConfig(settings).model, "new-model");
  assert.equal(activeLlmConfig(settings).thinkingMode, "disabled");
});
