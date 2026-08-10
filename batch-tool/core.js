const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { execFileSync } = require("child_process");
const { encodeSequenceGif } = require("./gif");
const { auditToolCalls } = require("./project-audit");
const { createResultsBuffer } = require("./workbook");
const { parseSequenceText, sequenceToText } = require("../server/sequence_workspace");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_ROOT = path.join(PROJECT_ROOT, ".local", "experiments");
const CODE_FINGERPRINT_FILES = [
  "server/index.js",
  "server/llm_move_agent.py",
  "server/move_backend.py",
  "server/sequence_workspace.js",
  "batch-tool/audit_tool_calls.py",
  "batch-tool/project-audit.js",
];

function isoNow() {
  return new Date().toISOString();
}

function dateStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function safeName(value, fallback = "未命名") {
  let text = String(value || fallback)
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!text) text = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) text = `_${text}`;
  return [...text].slice(0, 60).join("");
}

function tokenUsage(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const count = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  const inputTokens = count(source.inputTokens);
  const outputTokens = count(source.outputTokens);
  return {
    available: Boolean(source.available),
    inputTokens,
    outputTokens,
    totalTokens: count(source.totalTokens) || inputTokens + outputTokens,
  };
}

function addUsage(total, value) {
  const usage = tokenUsage(value);
  total.available = total.available || usage.available;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.totalTokens += usage.totalTokens;
  return total;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function partialMatch(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length &&
      expected.every((item, index) => partialMatch(item, actual[index]));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(actual, key) && partialMatch(value, actual[key])
    );
  }
  return Object.is(expected, actual);
}

function callsMatch(expected, actual) {
  const details = callMatchDetails(expected, actual);
  return details.specified ? details.tools && details.arguments : null;
}

function singleRectFromArgs(args) {
  if (![args?.x, args?.y, args?.w, args?.h].every(Number.isInteger)) return null;
  return { x: args.x, y: args.y, w: args.w, h: args.h };
}

function compareCallArguments(expected, actual) {
  const expectedRect = singleRectFromArgs(expected.args);
  const actualDroplets = normalizeRects(actual.args?.droplets);
  if (expectedRect && actualDroplets.length > 1) {
    const containsExpected = actualDroplets.some((rect) => partialMatch(expectedRect, rect));
    if (!containsExpected) return { matches: false, ambiguousTarget: false };
    const expectedWithoutTarget = { ...expected.args };
    ["x", "y", "w", "h", "size"].forEach((key) => delete expectedWithoutTarget[key]);
    if (!partialMatch(expectedWithoutTarget, actual.args || {})) {
      return { matches: false, ambiguousTarget: false };
    }
    return { matches: null, ambiguousTarget: true };
  }
  return {
    matches: partialMatch(expected.args || {}, actual.args || {}),
    ambiguousTarget: false,
  };
}

function normalizeRects(rects) {
  if (!Array.isArray(rects)) return [];
  return rects
    .map((rect) => ({
      x: Number(rect?.x ?? rect?.[0]),
      y: Number(rect?.y ?? rect?.[1]),
      w: Number(rect?.w ?? rect?.[2]),
      h: Number(rect?.h ?? rect?.[3]),
    }))
    .filter((rect) => Object.values(rect).every(Number.isInteger))
    .sort((a, b) => a.x - b.x || a.y - b.y || a.w - b.w || a.h - b.h);
}

function promptWithObservedDroplets(prompt, droplets) {
  const observed = normalizeRects(droplets);
  if (!observed.length) return String(prompt || "");
  const descriptions = observed.map(
    (rect, index) => `${index + 1}. 位置（${rect.x}，${rect.y}），尺寸 ${rect.w}×${rect.h}`
  );
  return [
    `自动化测试界面观察：上一轮操作得到 ${observed.length} 个液滴，具体为：${descriptions.join("；")}。`,
    "本轮如果需要操作上一轮得到的液滴，请以上述界面观察结果为准。",
    "",
    `本轮用户操作：${String(prompt || "")}`,
  ].join("\n");
}

function normalizeSize(value) {
  if (Number.isInteger(value) && value > 0) return [value, value];
  if (Array.isArray(value) && value.length === 2) {
    const pair = value.map(Number);
    return pair.every((item) => Number.isInteger(item) && item > 0) ? pair : null;
  }
  const parts = String(value || "").trim().toLowerCase().replaceAll("×", "x").replaceAll("*", "x").split("x").map(Number);
  return parts.length === 2 && parts.every((item) => Number.isInteger(item) && item > 0)
    ? parts
    : null;
}

function normalizeDirection(value) {
  const text = String(value || "").trim().toLowerCase();
  return {
    上: "up",
    下: "down",
    左: "left",
    右: "right",
    north: "up",
    south: "down",
    west: "left",
    east: "right",
  }[text] || text;
}

function normalizeCall(call) {
  const source = call && typeof call === "object" ? call : {};
  const args = canonical(source.args && typeof source.args === "object" ? source.args : {});
  if (args.direction !== undefined) args.direction = normalizeDirection(args.direction);
  const size = normalizeSize(args.size);
  if (size) {
    args.w = size[0];
    args.h = size[1];
    args.size = `${size[0]}x${size[1]}`;
  }
  const resolved = normalizeRects(source.resolvedDroplets).length
    ? normalizeRects(source.resolvedDroplets)
    : normalizeRects(args.droplets);
  if (resolved.length) {
    args.droplets = resolved;
    if (resolved.length === 1) {
      const [rect] = resolved;
      args.x = rect.x;
      args.y = rect.y;
      args.w = rect.w;
      args.h = rect.h;
      args.size = `${rect.w}x${rect.h}`;
    }
  } else if ([args.x, args.y, args.w, args.h].every(Number.isInteger)) {
    args.size = `${args.w}x${args.h}`;
  }
  return { tool: String(source.tool || ""), args };
}

function callMatchDetails(expected, actual) {
  if (!expected.length) return { specified: false, tools: null, arguments: null };
  const normalizedExpected = expected.map(normalizeCall);
  const normalizedActual = actual.map(normalizeCall);
  const tools =
    normalizedExpected.length === normalizedActual.length &&
    normalizedExpected.every((call, index) => call.tool === normalizedActual[index]?.tool);
  if (!tools) return { specified: true, tools: false, arguments: false, ambiguousTarget: false };
  const comparisons = normalizedExpected.map((call, index) =>
    compareCallArguments(call, normalizedActual[index])
  );
  const argumentsMatch = comparisons.some((comparison) => comparison.matches === false)
    ? false
    : comparisons.some((comparison) => comparison.matches === null)
      ? null
      : true;
  return {
    specified: true,
    tools: true,
    arguments: argumentsMatch,
    ambiguousTarget: comparisons.some((comparison) => comparison.ambiguousTarget),
  };
}

function finalRects(sequenceText) {
  const steps = parseSequenceText(sequenceText);
  return steps.length ? normalizeRects(steps[steps.length - 1].rects) : [];
}

function rectsMatch(expected, actual) {
  return JSON.stringify(normalizeRects(expected)) === JSON.stringify(normalizeRects(actual));
}

function boundsOk(sequenceText, rows, cols) {
  const steps = parseSequenceText(sequenceText);
  return steps.every((step) =>
    step.rects.every(
      (rect) =>
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.w > 0 &&
        rect.h > 0 &&
        rect.x + rect.w <= cols &&
        rect.y + rect.h <= rows
    )
  );
}

function publicProfile(settings) {
  const profiles = Array.isArray(settings?.profiles) ? settings.profiles : [];
  const active = profiles.find((profile) => profile.id === settings.activeProfileId);
  if (!active) throw new Error("请先在正式网页中保存并启用一个 LLM 配置");
  return {
    id: String(active.id || ""),
    name: String(active.name || ""),
    baseUrl: String(active.baseUrl || ""),
    model: String(active.model || ""),
    thinkingMode: String(active.thinkingMode || "auto"),
    hasApiKey: Boolean(active.hasApiKey),
  };
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: options.signal || controller.signal });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_error) {
      payload = {};
    }
    return { response, raw, payload };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadBackendSnapshot(backendUrl) {
  const [health, settings] = await Promise.all([
    fetchJson(`${backendUrl}/api/health`),
    fetchJson(`${backendUrl}/api/local-settings`),
  ]);
  if (!health.response.ok || !health.payload.ok) {
    throw new Error("正式后端未启动或健康检查失败");
  }
  if (!settings.response.ok) throw new Error("无法读取正式后端的本地配置");
  return {
    version: String(health.payload.version || ""),
    profile: publicProfile(settings.payload),
  };
}

function profileEqual(left, right) {
  return ["id", "name", "baseUrl", "model", "thinkingMode", "hasApiKey"].every(
    (key) => left[key] === right[key]
  );
}

async function provenance() {
  let gitCommit = "unknown";
  let gitDirty = true;
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    gitDirty = Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    );
  } catch (_error) {
    // The file fingerprint still identifies the executed code outside Git.
  }
  const hash = crypto.createHash("sha256");
  for (const relative of CODE_FINGERPRINT_FILES) {
    hash.update(relative);
    hash.update(await fs.readFile(path.join(PROJECT_ROOT, relative)));
  }
  return { gitCommit, gitDirty, codeFingerprint: hash.digest("hex") };
}

async function uniqueOutputDirectory(outputRoot, baseName) {
  await fs.mkdir(outputRoot, { recursive: true });
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const name = suffix === 1 ? baseName : `${baseName}-${String(suffix).padStart(2, "0")}`;
    const full = path.join(outputRoot, name);
    try {
      await fs.mkdir(full);
      return { name, full };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error("无法创建唯一实验目录");
}

async function atomicJson(filePath, value) {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function addJobLog(job, level, message, context = {}) {
  const entry = {
    id: crypto.randomUUID(),
    at: isoNow(),
    level,
    message,
    ...context,
  };
  job.logs.push(entry);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  return entry;
}

function updateActiveRun(job, key, patch) {
  const current = job.activeRuns.get(key) || { key, startedAt: isoNow() };
  const next = { ...current, ...patch, updatedAt: isoNow() };
  job.activeRuns.set(key, next);
  job.current = next;
  if (next.phase) job.phase = next.phase;
  return next;
}

function finishActiveRun(job, key) {
  job.activeRuns.delete(key);
  job.current = [...job.activeRuns.values()].at(-1) || null;
}

function effectiveResultStatus(result) {
  const verdict = result?.manualReview?.verdict;
  return verdict === "passed" || verdict === "failed" ? verdict : result?.status;
}

function effectiveResultCounts(results) {
  const counts = { passed: 0, failed: 0, review: 0, error: 0 };
  for (const result of results || []) {
    const status = effectiveResultStatus(result);
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
  }
  return counts;
}

function outputSignature(sequenceText) {
  const normalized = sequenceToText(parseSequenceText(sequenceText).map((step) => ({
    ...step,
    rects: [...step.rects].sort(
      (left, right) => left.x - right.x || left.y - right.y || left.w - right.w || left.h - right.h
    ),
  })));
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function resultsWithOutputGroups(results) {
  const groups = new Map();
  for (const result of results || []) {
    if (
      result.experimentType !== "多流程" ||
      result.status === "error" ||
      !result.outputSignature
    ) continue;
    const groupKey = `${result.experimentId}:${result.outputSignature}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(result);
  }

  const metadata = new Map();
  for (const [groupKey, members] of groups) {
    members.sort((left, right) => left.repeatIndex - right.repeatIndex);
    const representativeKey = members[0].key;
    const repeatIndexes = members.map((member) => member.repeatIndex);
    members.forEach((member) => metadata.set(member.key, {
      outputGroupKey: groupKey,
      outputGroupSize: members.length,
      outputGroupRepresentativeKey: representativeKey,
      outputGroupRepeatIndexes: repeatIndexes,
      isOutputGroupRepresentative: member.key === representativeKey,
    }));
  }

  return (results || []).map((result) => ({
    ...result,
    ...(metadata.get(result.key) || {
      outputGroupKey: "",
      outputGroupSize: 1,
      outputGroupRepresentativeKey: result.key,
      outputGroupRepeatIndexes: [result.repeatIndex],
      isOutputGroupRepresentative: true,
    }),
  }));
}

function publicJob(job, { includeResults = true } = {}) {
  const results = Array.isArray(job.results) ? job.results : [];
  const publicResults = resultsWithOutputGroups(results);
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    outputName: job.outputName,
    outputPath: job.outputPath,
    total: job.total,
    completed: job.completed,
    current: job.current,
    phase: job.phase,
    activeRuns: [...job.activeRuns.values()],
    logs: job.logs,
    counts: job.counts,
    effectiveCounts: effectiveResultCounts(results),
    manualReviewCount: results.filter((result) => result.manualReview?.verdict).length,
    error: job.error,
    backendUrl: job.backendUrl,
    backendVersion: job.backendVersion,
    profile: job.profile,
    options: job.options,
    resultsWorkbook: job.resultsWorkbook,
    results: includeResults
      ? publicResults.map((result) => ({
          ...result,
          effectiveStatus: effectiveResultStatus(result),
        }))
      : undefined,
  };
}

function runBasename(job, experiment, repeatIndex) {
  const category = experiment.category ? `${safeName(experiment.category)}-` : "";
  return `${dateStamp()}-${category}${safeName(experiment.id)}-${String(repeatIndex).padStart(2, "0")}-${safeName(job.options.configLabel)}`;
}

async function waitWhilePaused(job) {
  while (job.status === "paused") {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (job.status === "stopping" || job.status === "stopped") {
    throw Object.assign(new Error("实验已停止"), { code: "JOB_STOPPED" });
  }
}

async function assertProfileLocked(job) {
  const current = await loadBackendSnapshot(job.backendUrl);
  if (current.version !== job.backendVersion || !profileEqual(current.profile, job.profile)) {
    throw new Error("实验运行期间正式后端版本或 LLM 配置发生变化，已停止本次运行");
  }
}

async function backendPost(job, endpoint, body) {
  await waitWhilePaused(job);
  await assertProfileLocked(job);
  const requestRaw = JSON.stringify(body);
  const controller = new AbortController();
  job.controllers.add(controller);
  const timeout = setTimeout(() => controller.abort(), job.options.timeoutSeconds * 1000);
  const requestedAt = isoNow();
  try {
    const response = await fetch(`${job.backendUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestRaw,
      signal: controller.signal,
    });
    const responseRaw = await response.text();
    let payload;
    try {
      payload = responseRaw ? JSON.parse(responseRaw) : {};
    } catch (_error) {
      payload = {};
    }
    return {
      requestRaw,
      responseRaw,
      status: response.status,
      payload,
      requestedAt,
      respondedAt: isoNow(),
      backendVersion: response.headers.get("x-backend-version") || job.backendVersion,
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(job.status === "stopping" ? "实验已停止" : "后端请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    job.controllers.delete(controller);
  }
}

function evaluateStep({ experiment, step, actualCalls, deltaText, fullText, autoReplyCount, projectAudit }) {
  const reasons = [];
  const callChecks = callMatchDetails(step.expectedCalls, actualCalls);
  const deltaSteps = parseSequenceText(deltaText).length;
  if (experiment.type === "缺省" && autoReplyCount === 0) {
    reasons.push("缺省实验未追问即执行");
  }
  if (callChecks.tools === false) reasons.push("实际操作与预期操作不一致");
  else if (callChecks.arguments === false) reasons.push("实际操作参数与预期参数不一致");
  if (projectAudit.checked && !projectAudit.matches) reasons.push(projectAudit.reason);
  if (step.expectedDeltaSteps !== null && deltaSteps !== step.expectedDeltaSteps) {
    reasons.push(`新增步骤数应为 ${step.expectedDeltaSteps}，实际为 ${deltaSteps}`);
  }
  if (
    step.expectedFinalDroplets !== null &&
    !rectsMatch(step.expectedFinalDroplets, finalRects(fullText))
  ) {
    reasons.push("最终液滴与预期不一致");
  }
  if (!boundsOk(fullText, experiment.gridRows, experiment.gridCols)) {
    reasons.push("激活序列存在越界液滴");
  }
  const checks = {
    operationCorrect: callChecks.tools,
    parametersCorrect: callChecks.arguments,
    projectSequenceCorrect: projectAudit.checked ? projectAudit.matches : null,
    boundsCorrect: boundsOk(fullText, experiment.gridRows, experiment.gridCols),
  };
  if (reasons.length) return { status: "failed", reason: reasons.join("；"), deltaSteps, checks };
  if (callChecks.ambiguousTarget) {
    return {
      status: "review",
      reason: "预期规则只描述了单个液滴，但实际操作作用于包含该液滴的液滴组，需人工复核目标范围",
      deltaSteps,
      checks,
    };
  }
  if (projectAudit.required && !projectAudit.checked) {
    return { status: "review", reason: `无法完成项目语义复核：${projectAudit.reason}`, deltaSteps, checks };
  }
  if (!callChecks.specified && step.expectedDeltaSteps === null && step.expectedFinalDroplets === null) {
    return { status: "review", reason: "未填写预期操作，需人工复核", deltaSteps, checks };
  }
  return { status: "passed", reason: "预期操作、参数和项目激活序列均一致", deltaSteps, checks };
}

async function runAuthoredStep(job, experiment, step, session, runKey) {
  const started = Date.now();
  const exchanges = [];
  const messages = [];
  const actualCalls = [];
  const usage = tokenUsage();
  const observedInputDroplets = experiment.type === "多流程"
    ? normalizeRects(session.observedDroplets)
    : [];
  let currentMessage = promptWithObservedDroplets(step.prompt, observedInputDroplets);
  let autoReplyCount = 0;
  let lastPayload = {};
  let deltaText = "";
  let rawDeltaText = "";
  let rawDeltaAvailable = false;

  while (true) {
    updateActiveRun(job, runKey, {
      phase: autoReplyCount ? "提交缺省回答" : "等待 LLM 回复",
      stepOrder: step.order,
      prompt: currentMessage,
    });
    messages.push({
      role: "user",
      content: currentMessage,
      automatedDefaultConfirmation: autoReplyCount > 0,
    });
    const exchange = await backendPost(job, "/api/steps-from-message", {
      message: currentMessage,
      sessionId: session.id,
      selectedDroplets: session.selectedDroplets,
    });
    exchanges.push(exchange);
    if (exchange.status < 200 || exchange.status >= 300) {
      throw new Error(exchange.payload.error || `正式后端返回 ${exchange.status}`);
    }
    lastPayload = exchange.payload;
    const reply = String(lastPayload.assistantReply || "");
    messages.push({ role: "assistant", content: reply });
    addUsage(usage, lastPayload.tokenUsage);
    const calls = Array.isArray(lastPayload.moveCalls) ? lastPayload.moveCalls : [];
    actualCalls.push(...calls);
    const currentDelta = String(lastPayload.stepsTextDelta || "").trim();
    if (currentDelta) deltaText = [deltaText, currentDelta].filter(Boolean).join("\n");
    if (Object.prototype.hasOwnProperty.call(lastPayload, "stepsTextDeltaRaw")) {
      rawDeltaAvailable = true;
      const currentRawDelta = String(lastPayload.stepsTextDeltaRaw || "").trim();
      if (currentRawDelta) rawDeltaText = [rawDeltaText, currentRawDelta].filter(Boolean).join("\n");
    }
    session.stepsText = String(lastPayload.stepsText || session.stepsText || "").trim();
    session.selectedDroplets = Array.isArray(lastPayload.selectedDroplets)
      ? lastPayload.selectedDroplets
      : session.selectedDroplets;

    const isFollowup = calls.length === 0 && !currentDelta;
    if (!isFollowup) break;
    if (experiment.type !== "缺省") {
      return {
        order: step.order,
        prompt: step.prompt,
        expectedCalls: step.expectedCalls,
        actualCalls,
        status: "failed",
        reason: "模型未执行任何工具，也未生成激活步骤",
        autoReplyCount,
        deltaSteps: 0,
        assistantReply: reply,
        tokenUsage: usage,
        elapsedSeconds: (Date.now() - started) / 1000,
        messages,
        exchanges,
        checks: {
          operationCorrect: null,
          parametersCorrect: null,
          projectSequenceCorrect: null,
          boundsCorrect: null,
        },
      };
    }
    if (autoReplyCount >= experiment.maxFollowups) {
      return {
        order: step.order,
        prompt: step.prompt,
        expectedCalls: step.expectedCalls,
        actualCalls,
        status: "failed",
        reason: `达到最大追问次数 ${experiment.maxFollowups} 后仍未执行`,
        autoReplyCount,
        deltaSteps: 0,
        assistantReply: reply,
        tokenUsage: usage,
        elapsedSeconds: (Date.now() - started) / 1000,
        messages,
        exchanges,
        checks: {
          operationCorrect: null,
          parametersCorrect: null,
          projectSequenceCorrect: null,
          boundsCorrect: null,
        },
      };
    }
    autoReplyCount += 1;
    currentMessage = job.options.defaultFollowupReply;
  }

  updateActiveRun(job, runKey, { phase: "审查工具调用与激活序列" });
  const projectAudit = rawDeltaAvailable
    ? await auditToolCalls(actualCalls, rawDeltaText)
    : {
        checked: false,
        required: false,
        matches: null,
        reason: "后端未提供原始激活序列",
        outputDroplets: [],
      };
  const evaluation = evaluateStep({
    experiment,
    step,
    actualCalls,
    deltaText,
    fullText: session.stepsText,
    autoReplyCount,
    projectAudit,
  });
  return {
    order: step.order,
    prompt: step.prompt,
    expectedCalls: step.expectedCalls,
    actualCalls: actualCalls.map((call) => canonical(call)),
    status: evaluation.status,
    reason: evaluation.reason,
    autoReplyCount,
    deltaSteps: evaluation.deltaSteps,
    checks: evaluation.checks,
    projectAudit,
    observedInputDroplets,
    observedOutputDroplets: normalizeRects(projectAudit.outputDroplets),
    assistantReply: String(lastPayload.assistantReply || ""),
    tokenUsage: usage,
    elapsedSeconds: (Date.now() - started) / 1000,
    messages,
    exchanges,
  };
}

async function writeRunArtifacts(job, experiment, repeatIndex, record, stepsText) {
  const experimentRoot = path.join(job.outputPath, "实验");
  const categoryRoot = experiment.category
    ? path.join(experimentRoot, safeName(experiment.category))
    : experimentRoot;
  await fs.mkdir(categoryRoot, { recursive: true });
  const basename = runBasename(job, experiment, repeatIndex);
  const jsonPath = path.join(categoryRoot, `${basename}.json`);
  const txtPath = stepsText ? path.join(categoryRoot, `${basename}.txt`) : "";
  const gifPath = stepsText ? path.join(categoryRoot, `${basename}.gif`) : "";
  await fs.writeFile(jsonPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (stepsText) {
    await fs.writeFile(txtPath, `${stepsText}\n`, "utf8");
    const gif = encodeSequenceGif(stepsText, job.suite.config.rows, job.suite.config.cols);
    if (gif) await fs.writeFile(gifPath, gif);
  }
  const relative = (filePath) =>
    filePath ? path.relative(job.outputPath, filePath).split(path.sep).join("/") : "";
  return { json: relative(jsonPath), txt: relative(txtPath), gif: relative(gifPath) };
}

async function runOne(job, task) {
  const { experiment, repeatIndex, experimentOrder } = task;
  const runKey = `${experiment.id}-${repeatIndex}`;
  const started = Date.now();
  const session = {
    id: `batch-${job.id}-${safeName(experiment.id, "experiment")}-${repeatIndex}-${crypto.randomUUID()}`,
    selectedDroplets: experiment.selectedDroplets,
    stepsText: experiment.initialStepsText,
    observedDroplets: [],
  };
  experiment.gridRows = job.suite.config.rows;
  experiment.gridCols = job.suite.config.cols;
  updateActiveRun(job, runKey, {
    experimentId: experiment.id,
    category: experiment.category,
    repeatIndex,
    stepOrder: 0,
    phase: "初始化正式后端会话",
  });
  addJobLog(job, "info", "开始实验", {
    experimentId: experiment.id,
    repeatIndex,
  });
  const sync = await backendPost(job, "/api/session-state", {
    sessionId: session.id,
    sequenceText: session.stepsText,
    selectedDroplets: session.selectedDroplets,
  });
  if (sync.status < 200 || sync.status >= 300) {
    throw new Error(sync.payload.error || "无法同步正式后端会话状态");
  }

  const stepResults = [];
  const messages = [];
  const exchanges = [];
  const totalUsage = tokenUsage();
  let failedStep = null;
  for (const step of experiment.steps) {
    await waitWhilePaused(job);
    updateActiveRun(job, runKey, {
      experimentId: experiment.id,
      category: experiment.category,
      repeatIndex,
      stepOrder: step.order,
      prompt: step.prompt,
      phase: "准备发送 Prompt",
    });
    addJobLog(job, "info", `开始步骤 ${step.order}`, {
      experimentId: experiment.id,
      repeatIndex,
      stepOrder: step.order,
    });
    let result;
    try {
      result = await runAuthoredStep(job, experiment, step, session, runKey);
    } catch (error) {
      error.batchRunContext = {
        sessionId: session.id,
        startedAt: new Date(started).toISOString(),
        failedStep: step.order,
        stepsText: session.stepsText,
        messages,
        exchanges,
        stepResults,
        tokenUsage: totalUsage,
        elapsedSeconds: (Date.now() - started) / 1000,
      };
      throw error;
    }
    stepResults.push(result);
    session.observedDroplets = normalizeRects(result.observedOutputDroplets);
    addJobLog(job, result.status === "passed" ? "success" : "warning", `步骤 ${step.order}：${result.reason}`, {
      experimentId: experiment.id,
      repeatIndex,
      stepOrder: step.order,
    });
    messages.push(...result.messages);
    exchanges.push(...result.exchanges);
    addUsage(totalUsage, result.tokenUsage);
    if (
      experiment.type !== "多流程" &&
      (result.status === "failed" || result.status === "error")
    ) {
      failedStep = step.order;
      break;
    }
  }

  const statuses = stepResults.map((step) => step.status);
  const auditStatus = statuses.includes("failed")
    ? "failed"
    : statuses.includes("error")
      ? "error"
      : statuses.includes("review")
        ? "review"
        : "passed";
  const auditReason =
    stepResults.find((step) => step.status === "failed" || step.status === "error")?.reason ||
    (auditStatus === "review"
      ? stepResults.find((step) => step.status === "review")?.reason || "至少一个步骤需要人工复核"
      : "全部步骤通过结构化审计");
  const status = experiment.type === "多流程" ? "review" : auditStatus;
  const reason = experiment.type === "多流程"
    ? `多流程实验不自动判定，需人工复核；自动审计：${auditReason}`
    : auditReason;
  const record = {
    format: "llm-dmf-batch-run-v1",
    experiment: {
      category: experiment.category,
      id: experiment.id,
      type: experiment.type,
      repeatIndex,
      notes: experiment.notes,
    },
    runtime: {
      sessionId: session.id,
      backendUrl: job.backendUrl,
      backendVersion: job.backendVersion,
      profile: job.profile,
      provenance: job.provenance,
      defaultFollowupReply: job.options.defaultFollowupReply,
      startedAt: new Date(started).toISOString(),
      finishedAt: isoNow(),
    },
    messages,
    exchanges,
    stepResults,
    result: {
      status,
      automaticAuditStatus: auditStatus,
      reason,
      failedStep,
      stepsText: session.stepsText,
      finalDroplets: finalRects(session.stepsText),
      sequenceSteps: parseSequenceText(session.stepsText).length,
      tokenUsage: totalUsage,
    },
  };
  updateActiveRun(job, runKey, { phase: "写入 JSON、TXT 与 GIF" });
  const relativePaths = await writeRunArtifacts(
    job,
    experiment,
    repeatIndex,
    record,
    session.stepsText
  );
  const output = {
    key: `${experiment.id}-${repeatIndex}`,
    experimentOrder,
    category: experiment.category,
    experimentId: experiment.id,
    experimentType: experiment.type,
    repeatIndex,
    status,
    automaticAuditStatus: auditStatus,
    reason,
    failedStep,
    conversationRounds: exchanges.length,
    autoReplyCount: stepResults.reduce((sum, step) => sum + step.autoReplyCount, 0),
    sequenceSteps: parseSequenceText(session.stepsText).length,
    tokenUsage: totalUsage,
    elapsedSeconds: (Date.now() - started) / 1000,
    stepResults: stepResults.map(({ messages: _messages, exchanges: _exchanges, ...step }) => step),
    outputSignature: outputSignature(session.stepsText),
    relativePaths,
  };
  addJobLog(job, status === "passed" ? "success" : "warning", `实验完成：${reason}`, {
    experimentId: experiment.id,
    repeatIndex,
  });
  return output;
}

async function writeJobState(job) {
  const snapshot = JSON.parse(JSON.stringify({
    format: "llm-dmf-batch-state-v1",
    ...publicJob(job),
    suite: job.suite,
    provenance: job.provenance,
  }));
  const previous = job.stateWriteQueue;
  const write = previous.then(() =>
    atomicJson(path.join(job.outputPath, "运行状态.json"), snapshot)
  );
  job.stateWriteQueue = write.catch(() => {});
  return write;
}

function incrementCount(job, status) {
  if (Object.prototype.hasOwnProperty.call(job.counts, status)) job.counts[status] += 1;
}

async function finishWorkbook(job) {
  const workbook = await createResultsBuffer(job);
  const fileName = "实验结果.xlsx";
  await fs.writeFile(path.join(job.outputPath, fileName), workbook);
  job.resultsWorkbook = fileName;
}

async function setManualReview(job, resultKey, verdict) {
  if (![null, "passed", "failed"].includes(verdict)) {
    throw new Error("人工判定只能是通过、失败或撤销");
  }
  const result = job.results.find((entry) => entry.key === resultKey);
  if (!result) throw new Error("实验结果不存在");
  const targets = result.experimentType === "多流程" && result.status !== "error" && result.outputSignature
    ? job.results.filter((entry) =>
        entry.experimentType === "多流程" &&
        entry.status !== "error" &&
        entry.experimentId === result.experimentId &&
        entry.outputSignature === result.outputSignature
      )
    : [result];
  targets.forEach((target) => delete target.effectiveStatus);

  const nextReview = verdict
    ? {
      verdict,
      reviewedAt: isoNow(),
      reviewer: "local-user",
      representativeKey: result.key,
      outputGroupSize: targets.length,
    }
    : null;

  for (const target of targets) {
    const relativeJson = String(target.relativePaths?.json || "");
    if (relativeJson) {
      const artifactPath = path.resolve(job.outputPath, relativeJson);
      const outputRoot = `${path.resolve(job.outputPath)}${path.sep}`;
      if (!artifactPath.startsWith(outputRoot)) throw new Error("实验结果文件路径不安全");
      const record = JSON.parse(await fs.readFile(artifactPath, "utf8"));
      if (!record.result || typeof record.result !== "object") record.result = {};
      if (nextReview) record.result.manualReview = nextReview;
      else delete record.result.manualReview;
      await atomicJson(artifactPath, record);
    }
    if (nextReview) target.manualReview = nextReview;
    else delete target.manualReview;
  }

  addJobLog(
    job,
    "info",
    verdict
      ? `人工判定：${verdict === "passed" ? "通过" : "失败"}，应用到 ${targets.length} 条相同输出`
      : `已撤销 ${targets.length} 条相同输出的人工判定`,
    { experimentId: result.experimentId, repeatIndex: result.repeatIndex, outputGroupSize: targets.length }
  );
  await finishWorkbook(job);
  await writeJobState(job);
  return {
    ...result,
    effectiveStatus: effectiveResultStatus(result),
  };
}

async function runJob(job) {
  job.status = "running";
  job.phase = "准备运行";
  job.startedAt = isoNow();
  addJobLog(job, "info", `任务开始，共 ${job.total} 次运行，并发数 ${job.options.concurrency}`);
  const tasks = [];
  job.suite.experiments.filter((experiment) => experiment.enabled).forEach((experiment, experimentOrder) => {
    for (let repeatIndex = 1; repeatIndex <= experiment.repeats; repeatIndex += 1) {
      tasks.push({ experiment, repeatIndex, experimentOrder });
    }
  });
  let cursor = 0;
  const nextTask = () => {
    const index = cursor;
    cursor += 1;
    return tasks[index];
  };
  const worker = async () => {
    while (true) {
      await waitWhilePaused(job);
      const task = nextTask();
      if (!task) return;
      const runKey = `${task.experiment.id}-${task.repeatIndex}`;
      try {
        const result = await runOne(job, task);
        job.results.push(result);
        incrementCount(job, result.status);
      } catch (error) {
        if (job.status === "stopping" || error.code === "JOB_STOPPED") return;
        addJobLog(job, "error", String(error.message || error), {
          experimentId: task.experiment.id,
          repeatIndex: task.repeatIndex,
        });
        const context = error.batchRunContext || {};
        const stepsText = String(context.stepsText || task.experiment.initialStepsText || "");
        const stepResults = Array.isArray(context.stepResults) ? context.stepResults : [];
        const messages = Array.isArray(context.messages) ? context.messages : [];
        const exchanges = Array.isArray(context.exchanges) ? context.exchanges : [];
        const usage = tokenUsage(context.tokenUsage);
        const failedStep = context.failedStep || null;
        const errorRecord = {
          format: "llm-dmf-batch-run-v1",
          experiment: {
            category: task.experiment.category,
            id: task.experiment.id,
            type: task.experiment.type,
            repeatIndex: task.repeatIndex,
            notes: task.experiment.notes,
          },
          runtime: {
            sessionId: context.sessionId || "",
            backendUrl: job.backendUrl,
            backendVersion: job.backendVersion,
            profile: job.profile,
            provenance: job.provenance,
            startedAt: context.startedAt || isoNow(),
            finishedAt: isoNow(),
          },
          messages,
          exchanges,
          stepResults,
          result: {
            status: "error",
            reason: String(error.message || error),
            failedStep,
            stepsText,
            finalDroplets: finalRects(stepsText),
            sequenceSteps: parseSequenceText(stepsText).length,
            tokenUsage: usage,
          },
        };
        const relativePaths = await writeRunArtifacts(
          job,
          task.experiment,
          task.repeatIndex,
          errorRecord,
          stepsText
        );
        const result = {
          key: `${task.experiment.id}-${task.repeatIndex}`,
          experimentOrder: task.experimentOrder,
          category: task.experiment.category,
          experimentId: task.experiment.id,
          experimentType: task.experiment.type,
          repeatIndex: task.repeatIndex,
          status: "error",
          reason: String(error.message || error),
          failedStep,
          conversationRounds: exchanges.length,
          autoReplyCount: stepResults.reduce((sum, step) => sum + step.autoReplyCount, 0),
          sequenceSteps: parseSequenceText(stepsText).length,
          tokenUsage: usage,
          elapsedSeconds: Number(context.elapsedSeconds || 0),
          stepResults: stepResults.map(({ messages: _messages, exchanges: _exchanges, ...step }) => step),
          outputSignature: outputSignature(stepsText),
          relativePaths,
        };
        job.results.push(result);
        incrementCount(job, "error");
      } finally {
        finishActiveRun(job, runKey);
      }
      job.completed = job.results.length;
      await writeJobState(job);
    }
  };

  try {
    await writeJobState(job);
    const workers = await Promise.allSettled(
      Array.from({ length: job.options.concurrency }, () => worker())
    );
    const rejected = workers.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    if (job.status === "stopping") {
      job.status = "stopped";
      job.phase = "已停止";
    } else {
      job.status = "completed";
      job.phase = "生成结果表";
    }
  } catch (error) {
    job.status = "error";
    job.phase = "任务异常";
    job.error = String(error.message || error);
    addJobLog(job, "error", `任务异常：${job.error}`);
  } finally {
    job.finishedAt = isoNow();
    job.current = null;
    job.activeRuns.clear();
    addJobLog(job, "info", "正在生成完整结果表");
    try {
      await finishWorkbook(job);
      addJobLog(job, "success", `结果表已生成，共 ${job.completed} 条结果`);
      if (job.status === "completed") job.phase = "运行完成";
    } catch (error) {
      job.status = "error";
      job.phase = "结果表生成失败";
      job.error = `结果表生成失败：${String(error.message || error)}`;
      addJobLog(job, "error", job.error);
    }
    await writeJobState(job);
  }
}

async function createJob({ suite, backendUrl, outputRoot = DEFAULT_OUTPUT_ROOT, overrides = {} }) {
  const backend = await loadBackendSnapshot(backendUrl);
  const info = await provenance();
  if (!Number.isInteger(suite.totalRuns) || suite.totalRuns < 1 || suite.totalRuns > 10000) {
    throw new Error("单个任务的运行次数必须是 1 到 10000");
  }
  const options = {
    concurrency: Number(overrides.concurrency || suite.config.concurrency),
    timeoutSeconds: Number(overrides.timeoutSeconds || suite.config.timeoutSeconds),
    defaultFollowupReply:
      String(overrides.defaultFollowupReply || suite.config.defaultFollowupReply).trim() ||
      "请使用默认参数并生成",
    configLabel: String(overrides.configLabel || suite.config.configLabel || backend.profile.name),
  };
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 10) {
    throw new Error("并发数必须是 1 到 10 之间的整数");
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds < 5 || options.timeoutSeconds > 1800) {
    throw new Error("超时时间必须是 5 到 1800 秒");
  }
  const baseName = `${dateStamp()}-${safeName(suite.config.experimentName)}-${safeName(options.configLabel)}`;
  const output = await uniqueOutputDirectory(outputRoot, baseName);
  await fs.mkdir(path.join(output.full, "实验"), { recursive: true });
  return {
    id: crypto.randomUUID(),
    status: "queued",
    createdAt: isoNow(),
    startedAt: "",
    finishedAt: "",
    outputName: output.name,
    outputPath: output.full,
    backendUrl,
    backendVersion: backend.version,
    profile: backend.profile,
    provenance: info,
    suite,
    options,
    total: suite.totalRuns,
    completed: 0,
    current: null,
    counts: { passed: 0, failed: 0, review: 0, error: 0 },
    results: [],
    resultsWorkbook: "",
    error: "",
    controllers: new Set(),
    activeRuns: new Map(),
    logs: [],
    phase: "等待开始",
    stateWriteQueue: Promise.resolve(),
  };
}

function pauseJob(job) {
  if (job.status === "running") {
    job.status = "paused";
    job.phase = "已暂停";
    addJobLog(job, "info", "任务已暂停");
  }
}

function resumeJob(job) {
  if (job.status === "paused") {
    job.status = "running";
    job.phase = "继续运行";
    addJobLog(job, "info", "任务继续运行");
  }
}

function stopJob(job) {
  if (!["completed", "error", "stopped"].includes(job.status)) {
    job.status = "stopping";
    job.phase = "正在停止";
    addJobLog(job, "warning", "正在停止任务");
    job.controllers.forEach((controller) => controller.abort());
  }
}

module.exports = {
  DEFAULT_OUTPUT_ROOT,
  callsMatch,
  createJob,
  loadBackendSnapshot,
  pauseJob,
  publicJob,
  resumeJob,
  runJob,
  safeName,
  setManualReview,
  promptWithObservedDroplets,
  resultsWithOutputGroups,
  stopJob,
};
