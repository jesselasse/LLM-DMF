const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { ensurePythonEnvironment } = require("../scripts/python-env");
const { createLlmProcessEnv, sanitizeLlmError } = require("../server/llm_runtime_config");
const { activeLlmConfig, readLocalSettings } = require("../server/local_settings");
const {
  DEFAULT_OUTPUT_ROOT,
  createJob,
  loadBackendSnapshot,
  pauseJob,
  publicJob,
  resumeJob,
  runJob,
  safeName,
  setManualReview,
  stopJob,
} = require("./core");
const {
  createInputWorkbookBuffer,
  createTemplateBuffer,
  parseWorkbookBuffer,
} = require("./workbook");
const {
  normalizeBatchSettings,
  portableBatchSettings,
  readBatchSettings,
  writeBatchSettings,
} = require("./local-settings");

const app = express();
const port = Number(process.env.BATCH_PORT || 3003);
const host = String(process.env.BATCH_HOST || "127.0.0.1");
const backendUrl = String(process.env.DMF_BACKEND_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
const suites = new Map();
const jobs = new Map();

function dateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function normalizedProjectName(value) {
  const raw = safeName(String(value || "").trim(), "未命名方案");
  return /^\d{8}-.+/.test(raw) ? raw : `${dateStamp()}-${raw}`;
}

async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function uniqueProjectDirectory(root, preferredName, currentDirectory = "") {
  await fs.mkdir(root, { recursive: true });
  for (let suffix = 1; suffix <= 999; suffix += 1) {
    const name = suffix === 1 ? preferredName : `${preferredName}-${String(suffix).padStart(2, "0")}`;
    const directory = path.join(root, name);
    if (currentDirectory && path.resolve(directory) === path.resolve(currentDirectory)) return { name, directory };
    try {
      await fs.access(directory);
    } catch (_error) {
      return { name, directory };
    }
  }
  throw new Error("无法为方案创建唯一目录");
}

async function projectLocations(root) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.flatMap((entry) => {
    if (entry.isDirectory()) return [{ kind: "directory", file: path.join(root, entry.name, "project.json"), directory: path.join(root, entry.name) }];
    if (entry.isFile() && entry.name.endsWith(".json")) return [{ kind: "legacy", file: path.join(root, entry.name), directory: "" }];
    return [];
  });
}

async function locateProject(projectId) {
  const safeId = String(projectId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(safeId)) throw new Error("项目编号无效");
  const root = readBatchSettings().projectRoot;
  for (const location of await projectLocations(root)) {
    try {
      const project = JSON.parse(await fs.readFile(location.file, "utf8"));
      if (project.id === safeId && project.suite) return { project, ...location };
    } catch (_error) {
      // Ignore malformed or unrelated files.
    }
  }
  throw new Error("实验方案不存在");
}

async function restorePersistedJobs() {
  const settings = readBatchSettings();
  const roots = [settings.outputRoot || DEFAULT_OUTPUT_ROOT];
  for (const location of await projectLocations(settings.projectRoot)) {
    if (location.directory) roots.push(path.join(location.directory, "runs"));
  }
  const directories = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    entries.filter((entry) => entry.isDirectory()).forEach((entry) => directories.push(path.join(root, entry.name)));
  }
  for (const outputPath of directories) {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(outputPath, "运行状态.json"), "utf8"));
      if (!saved.id || !Array.isArray(saved.results) || !saved.suite) continue;
      const wasActive = ["queued", "running", "paused", "stopping"].includes(saved.status);
      jobs.set(saved.id, {
        ...saved,
        status: wasActive ? "stopped" : saved.status,
        phase: wasActive ? "上次运行已中断" : saved.phase,
        error: wasActive ? "批量工具关闭时任务尚未完成" : saved.error,
        outputPath,
        current: null,
        activeRuns: new Map(),
        logs: Array.isArray(saved.logs) ? saved.logs : [],
        controllers: new Set(),
        stateWriteQueue: Promise.resolve(),
      });
    } catch (_error) {
      // Ignore unrelated or incomplete directories while restoring history.
    }
  }
}

async function backendJson(endpoint, options = {}) {
  const response = await fetch(`${backendUrl}${endpoint}`, options);
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }
  if (!response.ok) throw new Error(payload.error || `正式后端返回 ${response.status}`);
  return payload;
}

async function saveProject(suite, source, options = {}) {
  const settings = readBatchSettings();
  await fs.mkdir(settings.projectRoot, { recursive: true });
  const existing = options.projectId ? await locateProject(options.projectId).catch(() => null) : null;
  const requestedName = normalizedProjectName(options.name || suite.config.experimentName);
  const target = await uniqueProjectDirectory(settings.projectRoot, requestedName, existing?.directory || "");
  let directory = existing?.directory || target.directory;
  if (!existing?.directory) await fs.mkdir(directory, { recursive: true });
  if (existing?.directory && path.resolve(existing.directory) !== path.resolve(target.directory)) {
    await fs.rename(existing.directory, target.directory);
    directory = target.directory;
  }
  suite.config.experimentName = target.name;
  const now = new Date().toISOString();
  const project = {
    format: "llm-dmf-project-v2",
    id: existing?.project.id || crypto.randomUUID(),
    name: target.name,
    source,
    createdAt: existing?.project.createdAt || now,
    updatedAt: now,
    revision: Number(existing?.project.revision || 0) + 1,
    aiMessages: Array.isArray(options.aiMessages) ? options.aiMessages.slice(-100) : (existing?.project.aiMessages || []),
    suite,
  };
  await fs.mkdir(path.join(directory, "plan"), { recursive: true });
  await fs.mkdir(path.join(directory, "ai"), { recursive: true });
  await fs.mkdir(path.join(directory, "runs"), { recursive: true });
  await atomicJson(path.join(directory, "project.json"), project);
  await atomicJson(path.join(directory, "plan", "suite.json"), suite);
  await atomicJson(path.join(directory, "ai", "conversation.json"), { messages: project.aiMessages, updatedAt: now });
  if (Array.isArray(suite.editorRows) && suite.editorRows.length) {
    const workbook = await createInputWorkbookBuffer(suite.editorRows, { title: project.name });
    await fs.writeFile(path.join(directory, "plan", "experiments.xlsx"), Buffer.from(workbook));
  }
  if (existing?.kind === "legacy") await fs.rm(existing.file, { force: true });
  return { ...project, directory };
}

async function listProjects() {
  const root = readBatchSettings().projectRoot;
  const projects = [];
  const seen = new Set();
  for (const location of await projectLocations(root)) {
    try {
      const project = JSON.parse(await fs.readFile(location.file, "utf8"));
      if (!project.id || !project.suite || seen.has(project.id)) continue;
      seen.add(project.id);
      projects.push({
        id: project.id,
        name: project.name,
        source: project.source,
        updatedAt: project.updatedAt,
        totalRuns: project.suite.totalRuns,
        experimentCount: project.suite.experiments?.length || 0,
        revision: Number(project.revision || 1),
        directory: location.directory || path.dirname(location.file),
      });
    } catch (_error) {
      // Skip malformed unrelated files.
    }
  }
  return projects.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function loadProject(projectId) {
  const located = await locateProject(projectId);
  return { ...located.project, directory: located.directory || path.dirname(located.file) };
}

async function saveProjectConversation(projectId, messages, draft = null) {
  if (!projectId) return null;
  const located = await locateProject(projectId);
  const now = new Date().toISOString();
  const project = {
    ...located.project,
    aiMessages: Array.isArray(messages) ? messages.slice(-100) : [],
    aiDraft: draft || located.project.aiDraft || null,
    updatedAt: now,
  };
  await atomicJson(located.file, project);
  if (located.directory) {
    await atomicJson(path.join(located.directory, "ai", "conversation.json"), {
      messages: project.aiMessages,
      draft: project.aiDraft,
      updatedAt: now,
    });
  }
  return project;
}

function projectHasActiveJob(projectId) {
  return [...jobs.values()].some((job) => job.projectId === projectId && ["queued", "running", "paused", "stopping"].includes(job.status));
}

async function experimentDesigner(messages, currentDraft) {
  const llmConfig = activeLlmConfig(readLocalSettings());
  const skillRoot = path.join(__dirname, "skills", "generate-dmf-experiments");
  const skill = [
    await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    await fs.readFile(path.join(skillRoot, "references", "schema.md"), "utf8"),
    await fs.readFile(path.join(skillRoot, "references", "tool-parameters.md"), "utf8"),
  ].join("\n\n");
  return new Promise((resolve, reject) => {
    const python = process.env.PYTHON_BIN || ensurePythonEnvironment();
    const script = path.join(__dirname, "ai_experiment_designer.py");
    const child = spawn(python, [script], {
      cwd: __dirname,
      stdio: ["pipe", "pipe", "pipe"],
      env: createLlmProcessEnv(process.env, llmConfig),
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 600000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`AI 方案生成超过 600 秒，已停止（模型：${llmConfig.model || "未设置"}）。请先在设置中测试连接`));
        return;
      }
      if (code !== 0) {
        const lines = String(stderr || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const detail = lines.slice(-2).join(" ") || "AI 实验生成失败";
        reject(new Error(sanitizeLlmError(detail, [llmConfig.apiKey])));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); }
      catch (_error) { reject(new Error("AI 实验生成返回了无效数据")); }
    });
    child.stdin.end(JSON.stringify({ messages, currentDraft, skill }));
  });
}

app.use("/shared", express.static(path.resolve(__dirname, "..", "src", "features")));
app.use("/vendor/lucide", express.static(path.resolve(__dirname, "..", "node_modules", "lucide", "dist", "umd")));
app.use(express.static(path.resolve(__dirname, "public")));

app.get("/api/health", async (_req, res) => {
  try {
    const backend = await loadBackendSnapshot(backendUrl);
    return res.json({ ok: true, backendUrl, ...backend });
  } catch (error) {
    return res.status(503).json({ ok: false, backendUrl, error: error.message });
  }
});

app.get("/api/template", async (_req, res) => {
  try {
    const buffer = await createTemplateBuffer();
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", "attachment; filename*=UTF-8''LLM-DMF-batch-template.xlsx");
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.post(
  "/api/import",
  express.raw({
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    limit: "20mb",
  }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        throw new Error("请选择有效的 .xlsx 文件");
      }
      const suite = await parseWorkbookBuffer(req.body);
      const id = crypto.randomUUID();
      const project = await saveProject(suite, "file");
      suites.set(id, { suite, projectId: project.id });
      return res.json({ id, suite, project });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
);

app.use(express.json({ limit: "5mb" }));

app.get("/api/projects", async (_req, res) => {
  return res.json({ projects: await listProjects() });
});

app.post("/api/projects/draft", async (req, res) => {
  try {
    const name = normalizedProjectName(req.body?.name || "AI-方案");
    const suite = {
      format: "llm-dmf-batch-input-v2",
      config: { experimentName: name, defaultRepeats: 1, concurrency: 1, timeoutSeconds: 240, defaultFollowupReply: "请使用默认参数并生成", maxFollowups: 3, rows: 120, cols: 140, configLabel: "当前配置" },
      experiments: [], editorRows: [], totalRuns: 0,
    };
    const project = await saveProject(suite, "ai", { name, aiMessages: req.body?.aiMessages });
    return res.status(201).json({ project });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/projects/:projectId", async (req, res) => {
  try {
    const project = await loadProject(req.params.projectId);
    const suiteId = crypto.randomUUID();
    suites.set(suiteId, { suite: project.suite, projectId: project.id });
    return res.json({ project, id: suiteId, suite: project.suite });
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

app.patch("/api/projects/:projectId", async (req, res) => {
  try {
    if (projectHasActiveJob(req.params.projectId)) throw new Error("方案正在运行，暂时不能重命名");
    const current = await loadProject(req.params.projectId);
    const project = await saveProject(current.suite, current.source, {
      projectId: current.id,
      name: req.body?.name,
      aiMessages: current.aiMessages,
    });
    return res.json({ project });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete("/api/projects/:projectId", async (req, res) => {
  try {
    if (projectHasActiveJob(req.params.projectId)) throw new Error("方案正在运行，暂时不能删除");
    const located = await locateProject(req.params.projectId);
    if (located.directory) await fs.rm(located.directory, { recursive: true, force: true });
    else await fs.rm(located.file, { force: true });
    for (const [id, record] of suites.entries()) {
      if (record?.projectId === req.params.projectId) suites.delete(id);
    }
    for (const [id, job] of jobs.entries()) {
      if (job.projectId === req.params.projectId) jobs.delete(id);
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

app.post("/api/projects/:projectId/reset-runs", async (req, res) => {
  try {
    if (projectHasActiveJob(req.params.projectId)) throw new Error("方案正在运行，暂时不能清除结果");
    const located = await locateProject(req.params.projectId);
    if (!located.directory) throw new Error("旧版方案需先保存后才能清除运行结果");
    const runs = path.join(located.directory, "runs");
    await fs.rm(runs, { recursive: true, force: true });
    await fs.mkdir(runs, { recursive: true });
    for (const [id, job] of jobs.entries()) {
      if (job.projectId === req.params.projectId) jobs.delete(id);
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/projects/:projectId/export", async (req, res) => {
  try {
    const project = await loadProject(req.params.projectId);
    res.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(project.name)}.json`);
    return res.json({ format: "dmf-tester-project-v1", project: { ...project, directory: undefined } });
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

app.post("/api/projects/import", async (req, res) => {
  try {
    if (req.body?.format !== "dmf-tester-project-v1" || !req.body?.project?.suite) throw new Error("方案文件格式无效");
    const source = req.body.project;
    let suite;
    if (Array.isArray(source.suite.editorRows) && source.suite.editorRows.length) {
      const buffer = await createInputWorkbookBuffer(source.suite.editorRows, { title: source.name });
      suite = await parseWorkbookBuffer(buffer);
    } else if (Array.isArray(source.suite.experiments) && source.suite.experiments.length) {
      throw new Error("方案缺少可验证的编辑表数据");
    } else {
      suite = structuredClone(source.suite);
      suite.experiments = []; suite.editorRows = []; suite.totalRuns = 0;
    }
    const project = await saveProject(suite, source.source || "import", {
      name: source.name,
      aiMessages: source.aiMessages,
    });
    const suiteId = crypto.randomUUID();
    suites.set(suiteId, { suite: project.suite, projectId: project.id });
    return res.json({ project, id: suiteId, suite: project.suite });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/settings", async (_req, res) => {
  try {
    const llm = await backendJson("/api/local-settings");
    return res.json({ batch: readBatchSettings(), llm });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    return res.json({ ok: true, batch: writeBatchSettings(req.body?.batch || {}) });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put("/api/settings/llm-profile", async (req, res) => {
  try {
    const payload = await backendJson("/api/local-settings/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: req.body?.profile || {} }),
    });
    return res.json(payload);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/settings/test-llm", async (req, res) => {
  try {
    const payload = await backendJson("/api/llm-config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llmConfig: req.body?.llmConfig || {} }),
    });
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post("/api/settings/llm-models", async (req, res) => {
  try {
    const payload = await backendJson("/api/llm-config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llmConfig: req.body?.llmConfig || {} }),
    });
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.get("/api/settings/export", async (_req, res) => {
  try {
    const llm = await backendJson("/api/local-settings/export");
    res.set("Content-Disposition", "attachment; filename=llm-dmf-batch-settings.json");
    return res.json({
      format: "llm-dmf-batch-settings-v1",
      batch: portableBatchSettings(readBatchSettings()),
      llm,
    });
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.put("/api/settings/import", async (req, res) => {
  try {
    if (req.body?.format !== "llm-dmf-batch-settings-v1") throw new Error("配置文件格式无效");
    const batch = writeBatchSettings(normalizeBatchSettings(req.body.batch));
    const llm = await backendJson("/api/local-settings/import", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body.llm || {}),
    });
    return res.json({ ok: true, batch, llm });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/ai/chat", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages)
      ? req.body.messages.slice(-20).map((message) => ({
          role: message?.role === "assistant" ? "assistant" : "user",
          content: String(message?.content || "").trim().slice(0, 20000),
        })).filter((message) => message.content)
      : [];
    if (!messages.length) throw new Error("请先描述希望生成的实验");
    const result = await experimentDesigner(messages, req.body?.currentDraft || null);
    const completeMessages = [...messages, { role: "assistant", content: String(result.assistantReply || "") }].filter((message) => message.content);
    if (req.body?.projectId) await saveProjectConversation(req.body.projectId, completeMessages, result.project || null);
    return res.json(result);
  } catch (error) {
    return res.status(502).json({ error: error.message });
  }
});

app.post("/api/editor/validate", async (req, res) => {
  try {
    if (!Array.isArray(req.body?.rows) || !req.body.rows.length) {
      throw new Error("请至少添加一条实验步骤");
    }
    const buffer = await createInputWorkbookBuffer(req.body.rows, {
      title: req.body.experimentName,
    });
    const suite = await parseWorkbookBuffer(buffer);
    const id = crypto.randomUUID();
    const project = req.body?.saveProject === false
      ? null
      : await saveProject(suite, req.body?.source === "ai" ? "ai" : "editor", {
          projectId: req.body?.projectId,
          name: req.body?.experimentName,
          aiMessages: req.body?.aiMessages,
        });
    suites.set(id, { suite, projectId: project?.id || req.body?.projectId || "" });
    return res.json({ id, suite, project });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/editor/export", async (req, res) => {
  try {
    if (!Array.isArray(req.body?.rows) || !req.body.rows.length) {
      throw new Error("请至少添加一条实验步骤");
    }
    const buffer = await createInputWorkbookBuffer(req.body.rows, {
      title: req.body.experimentName,
    });
    await parseWorkbookBuffer(buffer);
    res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.set("Content-Disposition", "attachment; filename*=UTF-8''LLM-DMF-edited-experiments.xlsx");
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/connection-test", async (_req, res) => {
  try {
    const started = Date.now();
    const response = await fetch(`${backendUrl}/api/llm-config/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_error) {
      payload = {};
    }
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `连接测试失败：${response.status}`);
    }
    return res.json({ ...payload, totalLatencyMs: Date.now() - started });
  } catch (error) {
    return res.status(502).json({ ok: false, error: error.message });
  }
});

app.post("/api/jobs", async (req, res) => {
  try {
    const record = suites.get(String(req.body?.suiteId || ""));
    const suite = record?.suite || record;
    if (!suite) throw new Error("请重新载入实验方案");
    const located = record?.projectId ? await locateProject(record.projectId).catch(() => null) : null;
    const job = await createJob({
      suite,
      backendUrl,
      outputRoot: located?.directory ? path.join(located.directory, "runs") : readBatchSettings().outputRoot,
      overrides: {
        concurrency: req.body?.concurrency,
        timeoutSeconds: req.body?.timeoutSeconds,
        defaultFollowupReply: req.body?.defaultFollowupReply,
        configLabel: req.body?.configLabel,
      },
    });
    job.projectId = record?.projectId || "";
    jobs.set(job.id, job);
    runJob(job).catch((error) => {
      job.status = "error";
      job.error = String(error.message || error);
      job.finishedAt = new Date().toISOString();
    });
    return res.status(202).json(publicJob(job));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "实验任务不存在" });
  return res.json(publicJob(job));
});

app.get("/api/history/latest", (_req, res) => {
  const latest = [...jobs.values()].sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  )[0];
  if (!latest) return res.status(404).json({ error: "尚无历史实验" });
  return res.json({ job: publicJob(latest), suite: latest.suite });
});

app.get("/api/projects/:projectId/history/latest", (req, res) => {
  const latest = [...jobs.values()].filter((job) => job.projectId === req.params.projectId).sort((a, b) =>
    String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  )[0];
  if (!latest) return res.status(404).json({ error: "该方案尚无运行记录" });
  return res.json({ job: publicJob(latest), suite: latest.suite });
});

app.post("/api/jobs/:jobId/pause", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "实验任务不存在" });
  pauseJob(job);
  return res.json(publicJob(job));
});

app.post("/api/jobs/:jobId/resume", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "实验任务不存在" });
  resumeJob(job);
  return res.json(publicJob(job));
});

app.post("/api/jobs/:jobId/stop", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "实验任务不存在" });
  stopJob(job);
  return res.json(publicJob(job));
});

function resolveArtifact(job, relativePath) {
  const requested = String(relativePath || "").replaceAll("\\", "/");
  const absolute = path.resolve(job.outputPath, requested);
  const root = `${path.resolve(job.outputPath)}${path.sep}`;
  if (!absolute.startsWith(root)) throw new Error("文件路径不安全");
  return absolute;
}

app.get("/api/jobs/:jobId/artifact", async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "实验任务不存在" });
    const absolute = resolveArtifact(job, req.query.path);
    await fs.access(absolute);
    return res.sendFile(absolute);
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

app.put("/api/jobs/:jobId/results/:key/manual-review", async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "实验任务不存在" });
    if (["queued", "running", "paused", "stopping"].includes(job.status)) {
      return res.status(409).json({ error: "实验仍在运行，完成或停止后才能人工判定" });
    }
    const requested = req.body?.verdict;
    const verdict = requested === "" || requested === undefined ? null : requested;
    if (![null, "passed", "failed"].includes(verdict)) {
      return res.status(400).json({ error: "人工判定只能是 passed、failed 或空值" });
    }
    const result = await setManualReview(job, req.params.key, verdict);
    return res.json({ job: publicJob(job), result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/jobs/:jobId/results/:key", async (req, res) => {
  try {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "实验任务不存在" });
    const result = job.results.find((entry) => entry.key === req.params.key);
    if (!result) return res.status(404).json({ error: "实验结果不存在" });
    const publicResult = publicJob(job).results.find((entry) => entry.key === req.params.key);
    let record = null;
    let stepsText = "";
    if (result.relativePaths.json) {
      record = JSON.parse(
        await fs.readFile(resolveArtifact(job, result.relativePaths.json), "utf8")
      );
    }
    if (result.relativePaths.txt) {
      stepsText = await fs.readFile(resolveArtifact(job, result.relativePaths.txt), "utf8");
    }
    return res.json({
      result: publicResult,
      record,
      stepsText,
      gifUrl: result.relativePaths.gif
        ? `/api/jobs/${encodeURIComponent(job.id)}/artifact?path=${encodeURIComponent(result.relativePaths.gif)}`
        : "",
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

if (require.main === module) {
  restorePersistedJobs()
    .catch((error) => console.warn(`Unable to restore experiment history: ${error.message}`))
    .finally(() => {
      app.listen(port, host, () => {
        console.log(`LLM-DMF batch tool: http://localhost:${port}`);
        console.log(`Official backend: ${backendUrl}`);
      });
    });
}

module.exports = { app, backendUrl, host, normalizedProjectName, restorePersistedJobs, uniqueProjectDirectory };
