const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizedProjectName, uniqueProjectDirectory } = require("./server");

test("project names use the required date-description convention", () => {
  assert.match(normalizedProjectName("合并实验"), /^\d{8}-合并实验$/);
  assert.equal(normalizedProjectName("20260808-合并实验"), "20260808-合并实验");
});

test("duplicate project directories receive a deterministic suffix", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dmf-tester-projects-"));
  await fs.mkdir(path.join(root, "20260808-合并实验"));
  const target = await uniqueProjectDirectory(root, "20260808-合并实验");
  assert.equal(target.name, "20260808-合并实验-02");
  await fs.rm(root, { recursive: true, force: true });
});
