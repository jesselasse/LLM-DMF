const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const {
  callsMatch,
  createJob,
  promptWithObservedDroplets,
  publicJob,
  runJob,
  safeName,
  setManualReview,
} = require("./core");
const { auditToolCalls } = require("./project-audit");
const { createTemplateBuffer, parseWorkbookBuffer } = require("./workbook");

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

async function startFakeBackend({ failSecondMulti = false, rawDeltaAvailable = false } = {}) {
  const sessions = new Map();
  const requests = [];
  const profile = {
    id: "test-profile",
    name: "Test Model",
    baseUrl: "https://example.invalid/v1",
    model: "test-model",
    thinkingMode: "disabled",
    hasApiKey: true,
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, { ok: true, version: "test-backend" });
    }
    if (req.method === "GET" && req.url === "/api/local-settings") {
      return json(res, 200, {
        activeProfileId: profile.id,
        profiles: [profile],
      });
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "POST" && req.url === "/api/session-state") {
      sessions.set(body.sessionId, {
        turns: 0,
        stepsText: String(body.sequenceText || ""),
      });
      return json(res, 200, { sessionId: body.sessionId, selectedDroplets: [] });
    }
    if (req.method === "POST" && req.url === "/api/steps-from-message") {
      requests.push(body);
      const session = sessions.get(body.sessionId);
      session.turns += 1;
      const id = body.sessionId.match(/-(E00[1-3])-/)?.[1];
      let assistantReply = "已完成";
      let moveCalls = [];
      let delta = "";
      if (id === "E001") {
        moveCalls = [{ tool: "squeeze", args: { count: 1, x: 20, y: 20, direction: "right", size: "1x1" } }];
        delta = "(20,20)(1,1)-1000";
      } else if (id === "E002" && session.turns === 1) {
        assistantReply = "请确认液滴数量与尺寸";
      } else if (id === "E002") {
        moveCalls = [{ tool: "squeeze", args: { count: 1, x: 40, y: 90, direction: "up", size: "1x1" } }];
        delta = "(40,90)(1,1)-1000";
      } else if (id === "E003" && session.turns === 1) {
        moveCalls = [{ tool: "squeeze", args: { count: 3, x: 20, y: 24, direction: "right", size: "1x1" } }];
        delta = "(20,24)(1,1)-1000";
      } else if (id === "E003" && session.turns === 2) {
        if (failSecondMulti) return json(res, 502, { error: "模拟第二步失败" });
        moveCalls = [{ tool: "rotate_mix", args: { duration: 3, droplets: [{ x: 20, y: 24, w: 1, h: 1 }] } }];
        delta = "(20,25)(1,1)-1000";
      } else if (id === "E003") {
        moveCalls = [{ tool: "move", args: { direction: "down", t: 10, droplets: [{ x: 20, y: 25, w: 1, h: 1 }] } }];
        delta = "(20,35)(1,1)-1000";
      }
      if (delta) session.stepsText = [session.stepsText, delta].filter(Boolean).join("\n");
      return json(
        res,
        200,
        {
          sessionId: body.sessionId,
          assistantReply,
          stepsTextDelta: delta,
          ...(rawDeltaAvailable ? { stepsTextDeltaRaw: delta } : {}),
          stepsText: session.stepsText,
          moveCalls,
          selectedDroplets: [],
          tokenUsage: { available: true, inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
        { "x-backend-version": "test-backend" }
      );
    }
    return json(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("structured expected calls use generic partial argument matching", () => {
  assert.equal(
    callsMatch(
      [{ tool: "move", args: { direction: "right", t: 2 } }],
      [{ tool: "move", args: { direction: "right", t: 2, x: 10, y: 10 } }]
    ),
    true
  );
  assert.equal(callsMatch([], []), null);
  assert.equal(
    callsMatch(
      [{ tool: "move", args: { x: 20, y: 20, w: 1, h: 1, direction: "down", t: 10 } }],
      [{ tool: "move", args: { direction: "down", t: 10, droplets: [
        { x: 20, y: 20, w: 1, h: 1 },
        { x: 28, y: 20, w: 1, h: 1 },
      ] } }]
    ),
    null
  );
  assert.equal(
    callsMatch(
      [{ tool: "move", args: { x: 20, y: 20, w: 1, h: 1, direction: "right", t: 10 } }],
      [{ tool: "move", args: { direction: "down", t: 10, droplets: [
        { x: 20, y: 20, w: 1, h: 1 },
        { x: 28, y: 20, w: 1, h: 1 },
      ] } }]
    ),
    false
  );
});

test("artifact names are portable to Windows and macOS", () => {
  assert.equal(safeName('移动/A:B*?"<>|'), "移动-A-B------");
  assert.equal(safeName("CON"), "_CON");
  assert.equal(/[<>:"/\\|?*]/.test(safeName("配置/模型:1")), false);
});

test("project replay treats squeeze coordinates as a source, not a final position", async () => {
  const audit = await auditToolCalls(
    [
      {
        tool: "squeeze",
        args: { count: 1, direction: "right" },
        resolvedDroplets: [{ x: 20, y: 20, w: 1, h: 1 }],
      },
    ],
    "(20,20)(1,1)-1000"
  );
  assert.equal(audit.checked, true);
  assert.equal(audit.matches, false);
  assert.equal(audit.expectedSteps, 6);
  assert.equal(audit.outputDroplets.length, 1);
  assert.notDeepEqual(audit.outputDroplets[0], { x: 20, y: 20, w: 1, h: 1 });
});

test("multi-flow observation context describes outputs without leaking the squeeze source", () => {
  const message = promptWithObservedDroplets("把刚才生成的液滴混合。", [
    { x: 24, y: 26, w: 2, h: 2 },
    { x: 34, y: 26, w: 2, h: 2 },
  ]);
  assert.match(message, /上一轮操作得到 2 个液滴/);
  assert.match(message, /位置（24，26），尺寸 2×2/);
  assert.match(message, /位置（34，26），尺寸 2×2/);
  assert.match(message, /本轮用户操作：把刚才生成的液滴混合。/);
  assert.equal(message.includes("源液滴"), false);
});

test("batch runner preserves official session flow and exports auditable artifacts", async (t) => {
  const backend = await startFakeBackend();
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-dmf-batch-test-"));
  t.after(async () => {
    await backend.close();
    await fs.rm(outputRoot, { recursive: true, force: true });
  });

  const suite = await parseWorkbookBuffer(await createTemplateBuffer());
  suite.experiments.forEach((experiment) => {
    experiment.repeats = 1;
  });
  suite.totalRuns = 3;
  const job = await createJob({
    suite,
    backendUrl: backend.url,
    outputRoot,
    overrides: { concurrency: 3, configLabel: "Test" },
  });
  await runJob(job);

  assert.equal(job.status, "completed");
  assert.equal(job.completed, 3);
  assert.deepEqual(job.results.map((result) => result.status), ["passed", "passed", "review"]);
  assert.equal(job.results.find((result) => result.experimentId === "E002").autoReplyCount, 1);
  assert.equal(job.results.find((result) => result.experimentId === "E003").conversationRounds, 3);
  assert.ok(backend.requests.length > 0);
  backend.requests.forEach((body) => {
    assert.deepEqual(Object.keys(body).sort(), ["message", "selectedDroplets", "sessionId"]);
    assert.equal(JSON.stringify(body).includes("expected"), false);
  });

  const outputFiles = await fs.readdir(job.outputPath);
  assert.ok(outputFiles.includes("实验结果.xlsx"));
  assert.ok(outputFiles.includes("运行状态.json"));
  const runFiles = [];
  for (const category of await fs.readdir(path.join(job.outputPath, "实验"))) {
    const categoryPath = path.join(job.outputPath, "实验", category);
    const stat = await fs.stat(categoryPath);
    if (stat.isDirectory()) runFiles.push(...(await fs.readdir(categoryPath)));
  }
  assert.equal(runFiles.filter((name) => name.endsWith(".json")).length, 3);
  assert.equal(runFiles.filter((name) => name.endsWith(".txt")).length, 3);
  assert.equal(runFiles.filter((name) => name.endsWith(".gif")).length, 3);

  const resultWorkbook = new ExcelJS.Workbook();
  await resultWorkbook.xlsx.readFile(path.join(job.outputPath, "实验结果.xlsx"));
  assert.ok(resultWorkbook.getWorksheet("实验汇总"));
  assert.equal(resultWorkbook.getWorksheet("逐次结果").rowCount, 4);
  const stateText = await fs.readFile(path.join(job.outputPath, "运行状态.json"), "utf8");
  assert.equal(stateText.includes("apiKey"), false);
  const persisted = JSON.parse(stateText);
  assert.equal(persisted.completed, 3);
  assert.equal(persisted.status, "completed");
  assert.ok(persisted.logs.some((entry) => entry.message.includes("结果表已生成，共 3 条结果")));
  assert.equal((await fs.readdir(job.outputPath)).some((name) => name.endsWith(".tmp")), false);

  const reviewed = job.results.find((result) => result.experimentId === "E001");
  await setManualReview(job, reviewed.key, "failed");
  assert.equal(reviewed.status, "passed");
  assert.equal(reviewed.manualReview.verdict, "failed");
  assert.equal(publicJob(job).effectiveCounts.failed, 1);
  const reviewedRecord = JSON.parse(
    await fs.readFile(path.join(job.outputPath, reviewed.relativePaths.json), "utf8")
  );
  assert.equal(reviewedRecord.result.status, "passed");
  assert.equal(reviewedRecord.result.manualReview.verdict, "failed");
  const reviewedWorkbook = new ExcelJS.Workbook();
  await reviewedWorkbook.xlsx.readFile(path.join(job.outputPath, "实验结果.xlsx"));
  const runs = reviewedWorkbook.getWorksheet("逐次结果");
  assert.deepEqual(runs.getRow(1).values.slice(1, 9), [
    "大项", "实验编号", "实验类型", "重复序号", "自动判定", "人工判定", "最终状态", "人工判定时间",
  ]);
  assert.deepEqual(runs.getRow(2).values.slice(5, 8), ["通过", "失败", "失败"]);

  await setManualReview(job, reviewed.key, null);
  assert.equal(reviewed.manualReview, undefined);
  assert.equal(publicJob(job).effectiveCounts.passed, 2);
  assert.equal(publicJob(job).effectiveCounts.review, 1);
});

test("multi-flow runs require review and share a verdict across identical outputs", async (t) => {
  const backend = await startFakeBackend({ rawDeltaAvailable: true });
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-dmf-batch-group-review-test-"));
  t.after(async () => {
    await backend.close();
    await fs.rm(outputRoot, { recursive: true, force: true });
  });

  const suite = await parseWorkbookBuffer(await createTemplateBuffer());
  suite.experiments = suite.experiments.filter((experiment) => experiment.id === "E003");
  suite.experiments[0].repeats = 3;
  suite.totalRuns = 3;
  const job = await createJob({
    suite,
    backendUrl: backend.url,
    outputRoot,
    overrides: { concurrency: 3, configLabel: "Grouped review" },
  });
  await runJob(job);

  assert.deepEqual(job.results.map((result) => result.status), ["review", "review", "review"]);
  const secondTurnMessages = backend.requests
    .map((request) => request.message)
    .filter((message) => message.includes("对刚才生成的液滴做 3 圈阵列混匀"));
  assert.equal(secondTurnMessages.length, 3);
  secondTurnMessages.forEach((message) => {
    assert.match(message, /上一轮操作得到 3 个液滴/);
    assert.equal(message.includes("位置（20，24），尺寸 1×1"), false);
  });
  const grouped = publicJob(job).results.sort((left, right) => left.repeatIndex - right.repeatIndex);
  assert.deepEqual(grouped.map((result) => result.outputGroupSize), [3, 3, 3]);
  assert.deepEqual(grouped.map((result) => result.isOutputGroupRepresentative), [true, false, false]);
  assert.deepEqual(grouped[0].outputGroupRepeatIndexes, [1, 2, 3]);

  await setManualReview(job, grouped[0].key, "passed");
  assert.ok(job.results.every((result) => result.manualReview?.verdict === "passed"));
  assert.equal(publicJob(job).effectiveCounts.passed, 3);
  for (const result of job.results) {
    const record = JSON.parse(await fs.readFile(path.join(job.outputPath, result.relativePaths.json), "utf8"));
    assert.equal(record.result.manualReview.verdict, "passed");
    assert.equal(record.result.manualReview.outputGroupSize, 3);
  }

  await setManualReview(job, grouped[0].key, null);
  assert.ok(job.results.every((result) => result.manualReview === undefined));
  assert.equal(publicJob(job).effectiveCounts.review, 3);
});

test("a later multi-flow error preserves earlier steps and artifacts", async (t) => {
  const backend = await startFakeBackend({ failSecondMulti: true });
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llm-dmf-batch-error-test-"));
  t.after(async () => {
    await backend.close();
    await fs.rm(outputRoot, { recursive: true, force: true });
  });

  const suite = await parseWorkbookBuffer(await createTemplateBuffer());
  suite.experiments = suite.experiments.filter((experiment) => experiment.id === "E003");
  suite.experiments[0].repeats = 1;
  suite.totalRuns = 1;
  const job = await createJob({
    suite,
    backendUrl: backend.url,
    outputRoot,
    overrides: { concurrency: 1, configLabel: "Test" },
  });
  await runJob(job);

  assert.equal(job.status, "completed");
  assert.equal(job.results[0].status, "error");
  assert.equal(job.results[0].failedStep, 2);
  assert.equal(job.results[0].sequenceSteps, 1);
  assert.equal(job.results[0].stepResults.length, 1);
  assert.ok(job.results[0].relativePaths.txt);
  assert.ok(job.results[0].relativePaths.gif);
});
