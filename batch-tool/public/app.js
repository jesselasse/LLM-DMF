import { parseStepsTxt } from "/shared/parseStepsTxt.js";
import { drawGridAndDroplets } from "/shared/drawGridAndDroplets.js";

const $ = (id) => document.getElementById(id);
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const todayStamp = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
const localized = (zh, en, es = en) => state.language === "en" ? en : state.language === "es" ? es : zh;
const icon = (name) => {
  const element = document.createElement("i");
  element.dataset.lucide = name;
  element.setAttribute("aria-hidden", "true");
  return element;
};
const renderIcons = () => globalThis.lucide?.createIcons?.({ attrs: { "stroke-width": 1.8 } });
const iconAction = (name, label, className = "icon-button") => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  return button;
};

const state = {
  suiteId: "",
  suite: null,
  project: null,
  projects: [],
  job: null,
  filteredResults: [],
  selectedKey: "",
  selectedPayload: null,
  steps: [],
  stepIndex: 0,
  pollTimer: null,
  editorExperiments: [],
  source: "file",
  sourceCollapsed: false,
  resultsSidebarCollapsed: false,
  evidenceCollapsed: false,
  aiMessages: [],
  aiBusy: false,
  aiEditingIndex: null,
  backendSnapshot: null,
  modelConnectionState: "unknown",
  modelConnectionError: "",
  playbackTimer: null,
  settings: null,
  language: localStorage.getItem("llm-dmf-batch-language") || "zh",
  theme: localStorage.getItem("llm-dmf-batch-theme") || "light",
};

const translations = {
  zh: {
    productLabel: "自动化测评", navPrepare: "方案设计", navRun: "实验运行",
    navResults: "结果审查", navSettings: "设置", stepOne: "方案设计",
    prepareTitle: "方案设计", prepareSubtitle: "管理方案、测试用例与评测规则。",
    savedProjects: "方案库", sourceMethod: "方案来源", changeLocation: "修改位置", open: "打开", newProject: "新建", renameProject: "重命名",
    importProject: "导入", exportProject: "导出", clearRuns: "清除结果", deleteProject: "删除", fromFile: "文件",
    fromManual: "编辑", fromAi: "AI 生成", dropFile: "拖入或选择 Excel",
    dropFileHint: "支持 .xlsx", downloadTemplate: "下载模板",
    manualReady: "编辑区已准备好", manualHint: "添加实验与对话步骤即可，编号和排序由系统完成。",
    aiDesigner: "AI 方案生成", aiUsesProfile: "调用当前 LLM 配置",
    aiEmpty: "描述实验目标与覆盖范围。", aiPlaceholder: "描述实验目标、范围与重复次数",
    send: "发送", draft: "方案状态", noDraft: "等待生成", draftHint: "生成结果将载入编辑区，提交前可继续调整。",
    projectName: "方案名称", addExperiment: "新增用例", exportExcel: "导出表格", applyAllRepeats: "统一次数",
    saveAndRun: "提交方案", editorHelp: "用例编号、轮次和分组由系统自动维护。",
    stepTwo: "实验运行", runTitle: "实验运行", noRunProject: "请先选择实验方案。",
    editProject: "返回方案", followupReply: "默认追问响应", configLabel: "运行标识",
    advancedRun: "运行参数", concurrency: "并发任务数", timeout: "任务超时（秒）", start: "启动运行",
    pause: "暂停", stop: "终止", downloadResults: "导出结果", activeRuns: "活动任务",
    runLogs: "运行日志", logLimit: "最近 400 条", stepThree: "结果审查", resultsTitle: "结果审查",
    experimentResults: "运行记录", allStatuses: "全部状态", statusPassed: "通过", statusFailed: "失败",
    statusReview: "待复核", statusError: "运行错误", experimentPrompt: "输入提示", criteria: "评测规则",
    manualReview: "人工判定", manualUnreviewed: "未设置", markPassed: "判为通过", markFailed: "判为失败", clearManualReview: "撤销",
    automaticVerdict: "自动判定", manualVerdict: "人工判定", finalVerdict: "最终结论", manualSaved: "人工判定已保存",
    activationSequence: "激活序列", semanticAudit: "执行审计", settingsTitle: "设置", settingsSubtitle: "存储、模型与界面偏好。",
    exportConfig: "导出配置", importConfig: "导入配置", storage: "数据存储",
    storageHint: "方案运行结果保存在各自目录；兼容目录用于未关联方案", projectLocation: "方案存储目录", resultLocation: "兼容结果目录",
    saveSettings: "应用设置", interface: "界面偏好", interfaceHint: "设置会在下次访问时自动恢复",
    language: "语言", appearance: "外观", light: "白天", dark: "黑夜", llmSettings: "模型连接",
    llmHint: "任务执行与 AI 方案生成共用当前配置", profile: "配置", profileName: "配置名称",
    model: "模型", thinkingMode: "推理模式", thinkingAuto: "服务商默认", thinkingDisabled: "关闭", thinkingEnabled: "开启",
    saveProfile: "应用配置", loadModels: "获取模型", testConnection: "连接与工具测试",
  },
  en: {
    productLabel: "Automated evaluation", navPrepare: "Plan", navRun: "Run",
    navResults: "Review", navSettings: "Settings", stepOne: "Plan", prepareTitle: "Plan",
    prepareSubtitle: "Manage plans, test cases, and evaluation rules.",
    savedProjects: "Plans", sourceMethod: "Plan source", changeLocation: "Location", open: "Open", newProject: "New", renameProject: "Rename",
    importProject: "Import", exportProject: "Export", clearRuns: "Clear runs", deleteProject: "Delete", fromFile: "File",
    fromManual: "Edit", fromAi: "AI", dropFile: "Drop or choose an Excel file",
    dropFileHint: ".xlsx", downloadTemplate: "Download template",
    manualReady: "The editor is ready", manualHint: "Add experiments and prompts; IDs and ordering are automatic.",
    aiDesigner: "AI plan generation", aiUsesProfile: "Uses the active LLM profile",
    aiEmpty: "Describe the experiment goal and coverage.", aiPlaceholder: "Describe the goal, scope, and repetition count",
    send: "Send", draft: "Plan status", noDraft: "Ready to generate", draftHint: "Generated cases are loaded into the editor and remain editable before submission.",
    projectName: "Plan name", addExperiment: "Add case", exportExcel: "Export sheet", applyAllRepeats: "Set all repeats",
    saveAndRun: "Submit plan", editorHelp: "Case IDs, turns, and groups are maintained automatically.",
    stepTwo: "Run", runTitle: "Run", noRunProject: "Select a plan first.",
    editProject: "Back to plan", followupReply: "Default follow-up response", configLabel: "Run label",
    advancedRun: "Runtime parameters", concurrency: "Concurrent tasks", timeout: "Task timeout (seconds)", start: "Start run",
    pause: "Pause", stop: "Terminate", downloadResults: "Export results", activeRuns: "Active tasks",
    runLogs: "Run log", logLimit: "Latest 400 entries", stepThree: "Review", resultsTitle: "Results review",
    experimentResults: "Run records", allStatuses: "All statuses", statusPassed: "Passed", statusFailed: "Failed",
    statusReview: "Review", statusError: "Run error", experimentPrompt: "Input prompt", criteria: "Evaluation criteria",
    manualReview: "Manual review", manualUnreviewed: "Not set", markPassed: "Mark passed", markFailed: "Mark failed", clearManualReview: "Clear",
    automaticVerdict: "Automatic verdict", manualVerdict: "Manual verdict", finalVerdict: "Final verdict", manualSaved: "Manual verdict saved",
    activationSequence: "Activation sequence", semanticAudit: "Execution audit", settingsTitle: "Settings", settingsSubtitle: "Storage, model, and interface preferences.",
    exportConfig: "Export config", importConfig: "Import config", storage: "Data storage",
    storageHint: "Plan runs stay inside each plan; the fallback is for unlinked runs", projectLocation: "Plan directory", resultLocation: "Fallback results directory",
    saveSettings: "Apply settings", interface: "Interface preferences", interfaceHint: "Preferences are restored automatically",
    language: "Language", appearance: "Appearance", light: "Light", dark: "Dark", llmSettings: "Model connection",
    llmHint: "Task execution and AI plan generation share the active profile", profile: "Profile", profileName: "Profile name",
    model: "Model", thinkingMode: "Reasoning mode", thinkingAuto: "Provider default", thinkingDisabled: "Off", thinkingEnabled: "On",
    saveProfile: "Apply profile", loadModels: "Load models", testConnection: "Test connection and tools",
  },
  es: {
    productLabel: "Evaluación automatizada", navPrepare: "Plan", navRun: "Ejecución",
    navResults: "Revisión", navSettings: "Ajustes", stepOne: "Plan", prepareTitle: "Diseño del plan",
    prepareSubtitle: "Gestiona planes, casos y reglas de evaluación.",
    savedProjects: "Planes", sourceMethod: "Origen", changeLocation: "Ubicación", open: "Abrir", newProject: "Nuevo", renameProject: "Renombrar",
    importProject: "Importar", exportProject: "Exportar", clearRuns: "Borrar ejec.", deleteProject: "Eliminar", fromFile: "Archivo",
    fromManual: "Editar", fromAi: "IA", dropFile: "Arrastra o elige un archivo Excel",
    dropFileHint: ".xlsx", downloadTemplate: "Descargar plantilla",
    manualReady: "El editor está listo", manualHint: "Los identificadores y el orden se generan automáticamente.",
    aiDesigner: "Generación con IA", aiUsesProfile: "Usa el perfil LLM activo",
    aiEmpty: "Describe el objetivo y la cobertura del experimento.", aiPlaceholder: "Describe el objetivo, el alcance y las repeticiones",
    send: "Enviar", draft: "Estado", noDraft: "Listo", draftHint: "El último plan generado sustituye al borrador anterior.",
    projectName: "Nombre del plan", addExperiment: "Añadir caso", exportExcel: "Exportar tabla", applyAllRepeats: "Igualar repeticiones",
    saveAndRun: "Confirmar plan", editorHelp: "Los identificadores, turnos y grupos se mantienen automáticamente.",
    stepTwo: "Ejecución", runTitle: "Ejecución", noRunProject: "Selecciona primero un plan.",
    editProject: "Volver al plan", followupReply: "Respuesta predeterminada", configLabel: "Etiqueta de ejecución",
    advancedRun: "Parámetros", concurrency: "Tareas simultáneas", timeout: "Tiempo límite (segundos)", start: "Iniciar",
    pause: "Pausar", stop: "Detener", downloadResults: "Exportar resultados", activeRuns: "Tareas activas",
    runLogs: "Registro", logLimit: "Últimas 400 entradas", stepThree: "Revisión", resultsTitle: "Revisión de resultados",
    experimentResults: "Ejecuciones", allStatuses: "Todos los estados", statusPassed: "Correcto", statusFailed: "Fallido",
    statusReview: "Revisar", statusError: "Error", experimentPrompt: "Prompt", criteria: "Reglas de evaluación",
    manualReview: "Revisión manual", manualUnreviewed: "Sin definir", markPassed: "Marcar correcto", markFailed: "Marcar fallido", clearManualReview: "Deshacer",
    automaticVerdict: "Veredicto automático", manualVerdict: "Veredicto manual", finalVerdict: "Veredicto final", manualSaved: "Veredicto manual guardado",
    activationSequence: "Secuencia de activación", semanticAudit: "Auditoría", settingsTitle: "Ajustes", settingsSubtitle: "Almacenamiento, modelo e interfaz.",
    exportConfig: "Exportar configuración", importConfig: "Importar configuración", storage: "Almacenamiento",
    storageHint: "Las ejecuciones se guardan dentro de cada plan", projectLocation: "Directorio de planes", resultLocation: "Directorio alternativo",
    saveSettings: "Aplicar", interface: "Interfaz", interfaceHint: "Las preferencias se restauran automáticamente",
    language: "Idioma", appearance: "Apariencia", light: "Claro", dark: "Oscuro", llmSettings: "Conexión del modelo",
    llmHint: "La ejecución y la generación usan el perfil activo", profile: "Perfil", profileName: "Nombre del perfil",
    model: "Modelo", thinkingMode: "Modo de razonamiento", thinkingAuto: "Predeterminado", thinkingDisabled: "Desactivado", thinkingEnabled: "Activado",
    saveProfile: "Aplicar perfil", loadModels: "Cargar modelos", testConnection: "Probar conexión y herramientas",
  },
};

function t(key, fallback = key) {
  return translations[state.language]?.[key] || translations.zh[key] || fallback;
}

function applyLanguage() {
  document.documentElement.lang = state.language === "en" ? "en" : state.language === "es" ? "es" : "zh-CN";
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    if (!element.childElementCount) element.textContent = t(element.dataset.i18n, element.textContent);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.placeholder = t(element.dataset.i18nPlaceholder, element.placeholder);
  });
  const localizedActions = [
    ["newProjectButton", localized("新建方案", "New plan", "Nuevo plan")],
    ["loadProjectButton", localized("打开方案", "Open plan", "Abrir plan")],
    ["renameProjectButton", localized("重命名方案", "Rename plan", "Renombrar plan")],
    ["resetProjectRunsButton", localized("清除运行结果", "Clear run data", "Eliminar ejecuciones")],
    ["deleteProjectButton", localized("删除方案", "Delete plan", "Eliminar plan")],
    ["aiSendButton", t("send")],
  ];
  localizedActions.forEach(([id, label]) => {
    const element = $(id);
    if (!element) return;
    element.title = label;
    element.setAttribute("aria-label", label);
  });
  const newProfileOption = $("llmProfileSelect")?.querySelector('option[value="__new__"]');
  if (newProfileOption) newProfileOption.textContent = localized("新建配置", "New profile", "Nuevo perfil");
  if ($("creationPaneHost")) setSourceCollapsed(state.sourceCollapsed);
  if ($("resultsLayout")) applyResultsLayout();
  if ($("backendStatus")) renderBackendStatus();
  renderIcons();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  if (state.steps.length) drawStep();
}

function currentPage() {
  const page = window.location.hash.slice(1);
  if (page === "editor" || page === "experiment") return page === "editor" ? "prepare" : "run";
  return ["prepare", "run", "results", "settings"].includes(page) ? page : "prepare";
}

function showPage(page, { updateHash = false } = {}) {
  const selected = ["prepare", "run", "results", "settings"].includes(page) ? page : "prepare";
  ["prepare", "run", "results", "settings"].forEach((name) => {
    $(`${name}Page`).hidden = name !== selected;
  });
  document.querySelectorAll("[data-page-target]").forEach((link) => {
    const active = link.dataset.pageTarget === selected;
    link.classList.toggle("active", active);
    active ? link.setAttribute("aria-current", "page") : link.removeAttribute("aria-current");
  });
  if (updateHash && window.location.hash !== `#${selected}`) window.location.hash = selected;
  if (selected === "results") drawStep();
  if (selected === "settings" && !state.settings) loadSettings();
}

function setNotice(id, message, type = "") {
  $(id).textContent = message || "";
  $(id).className = `notice ${type}`.trim();
}

const showNotice = (message, type = "") => setNotice("notice", message, type);
const showEditorNotice = (message, type = "") => setNotice("editorNotice", message, type);
const showPrepareNotice = (message, type = "") => setNotice("prepareNotice", message, type);
const showSettingsNotice = (message, type = "") => setNotice("settingsNotice", message, type);
const showResultsNotice = (message, type = "") => setNotice("resultsNotice", message, type);

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function blankStep() {
  return { uid: uid(), prompt: "", expectedOperation: "", expectedParameters: "", notes: "" };
}

function blankExperiment() {
  return { uid: uid(), enabled: true, category: "", repeats: 1, allowFollowup: false, notes: "", steps: [blankStep()] };
}

function experimentType(experiment) {
  if (experiment.steps.length > 1) return "多流程";
  return experiment.allowFollowup ? "缺省" : "完整";
}

function experimentTypeLabel(experimentOrType) {
  const type = typeof experimentOrType === "string" ? experimentOrType : experimentType(experimentOrType);
  const labels = state.language === "en"
    ? { 完整: "Single-turn", 缺省: "Parameter completion", 多流程: "Multi-turn" }
    : state.language === "es"
      ? { 完整: "Un turno", 缺省: "Completar parámetros", 多流程: "Varios turnos" }
      : { 完整: "单轮", 缺省: "参数补全", 多流程: "多轮" };
  return labels[type] || type;
}

function experimentCategory(experiment) {
  const category = String(experiment.category || "").trim();
  if (category) return category;
  const operation = experiment.steps.map((step) => step.expectedOperation.trim()).find(Boolean);
  return operation ? operation.split("+")[0].trim() : localized("未分组", "Uncategorized", "Sin categoría");
}

function categoryLabel(value) {
  return !value || ["未分组", "Uncategorized", "Sin categoría"].includes(value)
    ? localized("默认分组", "Default group", "Grupo predeterminado")
    : value;
}

function rowsFromEditor() {
  return state.editorExperiments.flatMap((experiment, experimentIndex) => {
    const id = `E${String(experimentIndex + 1).padStart(3, "0")}`;
    const type = experimentType(experiment);
    const category = experimentCategory(experiment);
    return experiment.steps.map((step, stepIndex) => ({
      enabled: experiment.enabled,
      category,
      id,
      type,
      repeats: Number(experiment.repeats) || 1,
      order: stepIndex + 1,
      prompt: step.prompt.trim(),
      expectedOperation: step.expectedOperation.trim(),
      expectedParameters: step.expectedParameters.trim(),
      notes: step.notes.trim() || experiment.notes.trim(),
    }));
  });
}

function editorPayload(extra = {}) {
  return {
    experimentName: $("editorExperimentName").value.trim() || `${todayStamp()}-未命名方案`,
    rows: rowsFromEditor(),
    source: state.source,
    projectId: state.project?.id || "",
    aiMessages: state.aiMessages,
    ...extra,
  };
}

function editorFromRows(rows) {
  const grouped = new Map();
  (rows || []).forEach((row) => {
    const key = String(row.id || grouped.size + 1);
    if (!grouped.has(key)) {
      grouped.set(key, {
        uid: uid(), enabled: row.enabled !== false, category: row.category || "", repeats: Number(row.repeats) || 1,
        allowFollowup: row.type === "缺省", notes: "", steps: [],
      });
    }
    grouped.get(key).steps.push({
      uid: uid(), prompt: row.prompt || "", expectedOperation: row.expectedOperation || "",
      expectedParameters: row.expectedParameters || "", notes: row.notes || "", order: Number(row.order) || 1,
    });
  });
  const experiments = [...grouped.values()];
  experiments.forEach((experiment) => {
    experiment.steps.sort((a, b) => a.order - b.order);
    experiment.steps.forEach((step) => delete step.order);
  });
  return experiments.length ? experiments : [blankExperiment()];
}

function rowsFromSuite(suite) {
  if (Array.isArray(suite?.editorRows) && suite.editorRows.length) return suite.editorRows.map((row) => ({ ...row }));
  return (suite?.experiments || []).flatMap((experiment) => experiment.steps.map((step) => ({
    enabled: experiment.enabled, category: experiment.category, id: experiment.id, type: experiment.type,
    repeats: experiment.repeats, order: step.order, prompt: step.prompt,
    expectedOperation: (step.expectedCalls || []).map((call) => operationLabels[call.tool] || call.tool).join(" + "),
    expectedParameters: (step.expectedCalls || []).map((call) => JSON.stringify(call.args || {})).join(" || "),
    notes: step.notes || experiment.notes || "",
  })));
}

function inputField(label, value, onInput, options = {}) {
  const wrapper = document.createElement("label");
  wrapper.className = options.full ? "editor-field full-field" : "editor-field";
  const caption = document.createElement("span");
  caption.textContent = label;
  const control = options.textarea ? document.createElement("textarea") : document.createElement("input");
  if (options.textarea) control.rows = options.rows || 2;
  if (options.type) control.type = options.type;
  if (options.min) control.min = options.min;
  if (options.max) control.max = options.max;
  if (options.list) control.setAttribute("list", options.list);
  control.value = value ?? "";
  control.addEventListener("input", () => onInput(control.value));
  if (options.onChange) control.addEventListener("change", options.onChange);
  wrapper.append(caption, control);
  return wrapper;
}

function renderEditor() {
  const root = $("editorExperiments");
  root.replaceChildren();
  const tableHeader = document.createElement("div");
  tableHeader.className = "editor-table-header";
  [
    localized("用例", "Test case", "Caso"),
    localized("分组", "Group", "Grupo"),
    "Prompt",
    localized("次数", "Repeats", "Repeticiones"),
    localized("补全", "Completion", "Completar"),
    localized("操作", "Actions", "Acciones"),
  ].forEach((value) => {
    const cell = document.createElement("span");
    cell.textContent = value;
    tableHeader.append(cell);
  });
  root.append(tableHeader);
  state.editorExperiments.forEach((experiment, experimentIndex) => {
    const card = document.createElement("article");
    card.className = "experiment-card";
    const header = document.createElement("div");
    header.className = "experiment-header";
    const identity = document.createElement("div");
    identity.className = "experiment-identity";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = experiment.enabled;
    enabled.addEventListener("change", () => { experiment.enabled = enabled.checked; });
    const title = document.createElement("strong");
    title.textContent = `E${String(experimentIndex + 1).padStart(3, "0")}`;
    identity.append(enabled, title);
    header.append(identity);

    const group = inputField("", experiment.category || "", (value) => { experiment.category = value; });
    group.classList.add("experiment-group");

    const repeats = inputField("", experiment.repeats, (value) => { experiment.repeats = Number(value); }, { type: "number", min: "1", max: "100" });
    repeats.classList.add("experiment-repeat");

    const followup = document.createElement("label");
    followup.className = "toggle-field experiment-followup";
    const followupCheck = document.createElement("input");
    followupCheck.type = "checkbox"; followupCheck.checked = experiment.allowFollowup;
    followupCheck.disabled = experiment.steps.length > 1;
    followupCheck.title = localized("允许参数补全对话", "Allow parameter-completion dialogue", "Permitir diálogo para completar parámetros");
    followupCheck.addEventListener("change", () => { experiment.allowFollowup = followupCheck.checked; renderEditor(); });
    const followupText = document.createElement("span");
    followupText.textContent = localized("允许", "Allow", "Permitir");
    followup.append(followupCheck, followupText);

    const actions = document.createElement("div");
    actions.className = "editor-row-actions";
    const duplicate = iconAction("copy", localized("复制用例", "Duplicate test case", "Duplicar caso"));
    duplicate.addEventListener("click", () => {
      const copy = JSON.parse(JSON.stringify(experiment));
      copy.uid = uid(); copy.steps.forEach((step) => { step.uid = uid(); });
      state.editorExperiments.splice(experimentIndex + 1, 0, copy); renderEditor();
    });
    const remove = iconAction("trash-2", localized("删除用例", "Delete test case", "Eliminar caso"), "icon-button danger-text");
    remove.addEventListener("click", () => {
      state.editorExperiments.splice(experimentIndex, 1);
      if (!state.editorExperiments.length) state.editorExperiments.push(blankExperiment());
      renderEditor();
    });
    actions.append(duplicate, remove);

    const steps = document.createElement("div");
    steps.className = "conversation-steps";
    experiment.steps.forEach((step, stepIndex) => {
      const row = document.createElement("section");
      row.className = "conversation-step";
      if (experiment.steps.length === 1) row.classList.add("single-step");
      const stepHead = document.createElement("div");
      stepHead.className = "step-head";
      const number = document.createElement("span");
      number.className = "step-number"; number.textContent = String(stepIndex + 1);
      const label = document.createElement("strong");
      label.textContent = `${localized("对话轮次", "Conversation turn", "Turno")} ${stepIndex + 1}`;
      const removeStep = iconAction("x", localized("移除步骤", "Remove step", "Eliminar turno"), "icon-button compact-icon danger-text");
      removeStep.disabled = experiment.steps.length === 1;
      removeStep.addEventListener("click", () => { experiment.steps.splice(stepIndex, 1); renderEditor(); });
      stepHead.append(number, label, removeStep);
      const fields = document.createElement("div");
      fields.className = "step-fields";
      fields.append(inputField("", step.prompt, (value) => { step.prompt = value; }, { textarea: experiment.steps.length > 1, rows: 1 }));
      const advanced = document.createElement("details");
      advanced.className = "step-advanced";
      const advancedSummary = document.createElement("summary");
      const hasAdvancedValues = Boolean(step.expectedOperation || step.expectedParameters);
      advancedSummary.textContent = localized(
        `自动判定规则${hasAdvancedValues ? " · 已配置" : " · 留空则人工复核"}`,
        `Automatic evaluation${hasAdvancedValues ? " · Configured" : " · Manual review"}`,
        `Evaluación automática${hasAdvancedValues ? " · Configurada" : " · Revisión manual"}`
      );
      const advancedHint = document.createElement("p");
      advancedHint.className = "evaluation-hint";
      advancedHint.textContent = localized(
        "这些内容不会发送给被测模型，也不会改变正式网页的执行。它们只用于比较实际调用；留空仍可运行，但结果需要人工复核。",
        "These fields are never sent to the tested model. They only compare observed tool calls with the expected result; leave them blank for manual review.",
        "Estos campos no se envían al modelo. Solo comparan las llamadas observadas con el resultado esperado; déjalos vacíos para revisión manual."
      );
      const advancedFields = document.createElement("div");
      advancedFields.className = "advanced-step-fields";
      advancedFields.append(
        inputField(localized("预期调用（可选）", "Expected operation", "Operación esperada"), step.expectedOperation, (value) => {
          step.expectedOperation = value;
        }, { list: "operationOptions" }),
        inputField(localized("需要核对的参数（可选）", "Expected arguments", "Argumentos esperados"), step.expectedParameters, (value) => { step.expectedParameters = value; }, { textarea: true, rows: 2 }),
        inputField(localized("复核备注（可选）", "Review note (optional)", "Nota de revisión (opcional)"), step.notes, (value) => { step.notes = value; })
      );
      advanced.append(advancedSummary, advancedHint, advancedFields);
      fields.append(advanced);
      row.append(stepHead, fields);
      steps.append(row);
    });
    const addStep = document.createElement("button");
    addStep.type = "button"; addStep.className = "add-step-button";
    addStep.append(icon("plus"), document.createTextNode(localized("添加轮次", "Add turn", "Añadir turno")));
    addStep.addEventListener("click", () => {
      if (experiment.steps.length >= 100) {
        showEditorNotice(localized("单个用例最多包含 100 个对话轮次", "A test case can contain at most 100 turns", "Un caso puede contener hasta 100 turnos"), "error");
        return;
      }
      experiment.steps.push(blankStep()); experiment.allowFollowup = false; renderEditor();
    });
    steps.append(addStep);
    card.append(header, group, steps, repeats, followup, actions);
    root.append(card);
  });
  renderIcons();
}

function setSource(source) {
  state.source = ["file", "manual", "ai"].includes(source) ? source : "manual";
  document.querySelectorAll("[data-source]").forEach((button) => {
    const active = button.dataset.source === state.source;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("fileSourcePane").hidden = state.source !== "file";
  $("manualSourcePane").hidden = state.source !== "manual";
  $("aiSourcePane").hidden = state.source !== "ai";
}

function setSourceCollapsed(collapsed) {
  state.sourceCollapsed = Boolean(collapsed);
  $("creationPaneHost").classList.toggle("collapsed", state.sourceCollapsed);
  const label = state.sourceCollapsed
    ? localized("展开来源", "Show source", "Mostrar origen")
    : localized("收起来源", "Hide source", "Ocultar origen");
  const button = $("toggleSourcePanel");
  button.title = label;
  button.setAttribute("aria-label", label);
  $("sourcePanelLabel").textContent = label;
  $("sourcePanelIcon").dataset.lucide = state.sourceCollapsed ? "chevrons-down" : "chevrons-up";
  renderIcons();
}

function applyResultsLayout() {
  $("resultsLayout").classList.toggle("sidebar-collapsed", state.resultsSidebarCollapsed);
  $("resultsLayout").classList.toggle("evidence-collapsed", state.evidenceCollapsed);
  const sidebarLabel = state.resultsSidebarCollapsed
    ? localized("展开运行记录", "Show run list", "Mostrar ejecuciones")
    : localized("收起运行记录", "Hide run list", "Ocultar ejecuciones");
  const evidenceLabel = state.evidenceCollapsed
    ? localized("展开审计信息", "Show audit details", "Mostrar auditoría")
    : localized("收起审计信息", "Hide audit details", "Ocultar auditoría");
  const sidebarButton = $("toggleResultsSidebar");
  const evidenceButton = $("toggleEvidencePanel");
  sidebarButton.title = sidebarLabel;
  sidebarButton.setAttribute("aria-label", sidebarLabel);
  evidenceButton.title = evidenceLabel;
  evidenceButton.setAttribute("aria-label", evidenceLabel);
  sidebarButton.classList.toggle("active", state.resultsSidebarCollapsed);
  evidenceButton.classList.toggle("active", state.evidenceCollapsed);
  $("resultsSidebarIcon").dataset.lucide = state.resultsSidebarCollapsed ? "panel-left-open" : "panel-left-close";
  $("evidencePanelIcon").dataset.lucide = state.evidenceCollapsed ? "panel-right-open" : "panel-right-close";
  renderIcons();
}

const operationLabels = { squeeze: "挤出生成", move: "移动", rotate_mix: "混匀", merge: "合并", generate_array: "阵列生成" };
const statusLabels = {
  zh: { passed: "通过", failed: "失败", review: "待复核", error: "运行错误", stopped: "已停止" },
  en: { passed: "Passed", failed: "Failed", review: "Review", error: "Run error", stopped: "Stopped" },
  es: { passed: "Correcto", failed: "Fallido", review: "Revisar", error: "Error", stopped: "Detenido" },
};
const statusLabel = (value) => statusLabels[state.language]?.[value] || value;
const effectiveResultStatus = (result) => result?.manualReview?.verdict || result?.status;

function applySuite(suite, project = null) {
  state.suite = suite;
  if (project) state.project = project;
  $("defaultReplyInput").value = suite.config.defaultFollowupReply;
  $("concurrencyInput").value = suite.config.concurrency;
  $("timeoutInput").value = suite.config.timeoutSeconds;
  $("configLabelInput").value = suite.config.configLabel;
  const enabled = suite.experiments.filter((experiment) => experiment.enabled);
  const stepCount = enabled.reduce((sum, experiment) => sum + experiment.steps.length, 0);
  $("runProjectSummary").textContent = `${suite.config.experimentName} · ${enabled.length} ${localized("个用例", "test cases", "casos")} · ${stepCount} Prompt · ${suite.totalRuns} ${localized("次运行", "runs", "ejecuciones")}`;
  $("startButtonLabel").textContent = localized(`启动 ${suite.totalRuns} 次运行`, `Start ${suite.totalRuns} runs`, `Iniciar ${suite.totalRuns} ejecuciones`);
  $("startButton").disabled = !state.suiteId || suite.totalRuns < 1;
  renderSuitePreview(enabled, stepCount);
  updateProgress({ status: "idle", total: suite.totalRuns, completed: 0, counts: {} });
}

function renderSuitePreview(experiments, stepCount) {
  $("suitePreviewSummary").textContent = localized(
    `${experiments.length} 个用例 · ${stepCount} 条 Prompt`,
    `${experiments.length} test cases · ${stepCount} prompts`,
    `${experiments.length} casos · ${stepCount} prompts`
  );
  const list = $("suitePreviewList");
  list.replaceChildren();
  experiments.forEach((experiment) => {
    const item = document.createElement("article"); item.className = "suite-preview-item";
    const title = document.createElement("div"); title.className = "suite-preview-title";
    const strong = document.createElement("strong"); strong.textContent = `${experiment.id} · ${categoryLabel(experiment.category)}`;
    const meta = document.createElement("span"); meta.textContent = `${experimentTypeLabel(experiment.type)} · ${experiment.repeats} ${localized("次", "runs", "veces")}`;
    title.append(strong, meta);
    const ordered = document.createElement("ol");
    experiment.steps.forEach((step) => { const li = document.createElement("li"); li.textContent = step.prompt; ordered.append(li); });
    item.append(title, ordered); list.append(item);
  });
}

function renderBackendStatus() {
  const status = $("backendStatus");
  const snapshot = state.backendSnapshot;
  const profile = snapshot?.profile || {};
  const dot = document.createElement("span"); dot.className = "status-dot";
  const text = document.createElement("span"); text.className = "backend-status-label";
  const model = document.createElement("span"); model.className = "backend-status-model";
  if (!snapshot) {
    text.textContent = localized("后端不可用", "Backend unavailable", "Backend no disponible");
    status.replaceChildren(dot, text);
    status.title = state.modelConnectionError || "";
    status.className = "backend-status error";
    return;
  }
  const labels = {
    verified: localized("模型已连接", "Model connected", "Modelo conectado"),
    failed: localized("模型连接失败", "Model connection failed", "Falló la conexión"),
    testing: localized("正在测试模型", "Testing model", "Probando el modelo"),
    configured: localized("模型待验证", "Model not tested", "Modelo sin probar"),
    unknown: localized("模型待验证", "Model not tested", "Modelo sin probar"),
  };
  text.textContent = labels[state.modelConnectionState] || labels.unknown;
  model.textContent = profile.model || "—";
  status.replaceChildren(dot, text, model);
  status.title = [profile.name, profile.model, state.modelConnectionError].filter(Boolean).join(" · ");
  status.className = `backend-status ${state.modelConnectionState === "failed" ? "error" : state.modelConnectionState === "testing" || state.modelConnectionState === "configured" || state.modelConnectionState === "unknown" ? "warning" : "ok"}`;
}

function setModelConnectionState(connectionState, error = "") {
  state.modelConnectionState = connectionState;
  state.modelConnectionError = error;
  renderBackendStatus();
}

async function checkBackend() {
  try {
    const payload = await jsonRequest("/api/health");
    state.backendSnapshot = payload;
    if (state.modelConnectionState === "unknown") state.modelConnectionState = "configured";
    renderBackendStatus();
    if (!state.suite) $("configLabelInput").value = payload.profile?.name || "基准配置";
  } catch (error) {
    state.backendSnapshot = null;
    state.modelConnectionError = error.message;
    renderBackendStatus();
  }
}

function refreshProjectControls() {
  const project = state.projects.find((item) => item.id === $("projectSelect").value) || state.project;
  const enabled = Boolean(project?.id);
  ["renameProjectButton", "resetProjectRunsButton", "deleteProjectButton"].forEach((id) => { $(id).disabled = !enabled; });
  const exportLink = $("exportProjectButton");
  exportLink.classList.toggle("disabled-link", !enabled);
  exportLink.href = enabled ? `/api/projects/${encodeURIComponent(project.id)}/export` : "#";
  $("projectLocation").textContent = project?.directory || state.settings?.batch?.projectRoot || (state.language === "en" ? "Stored locally" : state.language === "es" ? "Guardado localmente" : "方案保存在本机");
}

async function loadProjects() {
  try {
    state.projects = (await jsonRequest("/api/projects")).projects || [];
    const select = $("projectSelect");
    const selected = state.project?.id || select.value;
    select.replaceChildren();
    const empty = document.createElement("option"); empty.value = "";
    empty.textContent = state.projects.length ? localized("选择实验方案", "Select a plan", "Selecciona un plan") : localized("暂无已保存方案", "No saved plans", "No hay planes guardados");
    select.append(empty);
    state.projects.forEach((project) => {
      const option = document.createElement("option"); option.value = project.id;
      option.textContent = `${project.name} · ${project.experimentCount} · ${new Date(project.updatedAt).toLocaleDateString()}`;
      select.append(option);
    });
    if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    refreshProjectControls();
  } catch (error) { showPrepareNotice(error.message, "error"); }
}

async function loadProject(projectId) {
  if (!projectId) return;
  showPrepareNotice(localized("正在载入实验方案…", "Opening plan…", "Abriendo el plan…"));
  try {
    const payload = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`);
    state.suiteId = payload.id; state.project = payload.project;
    state.editorExperiments = editorFromRows(rowsFromSuite(payload.suite));
    state.aiMessages = Array.isArray(payload.project.aiMessages) ? payload.project.aiMessages : [];
    state.aiEditingIndex = null;
    $("editorExperimentName").value = payload.suite.config.experimentName;
    renderEditor(); renderAiMessages(); applySuite(payload.suite, payload.project); refreshProjectControls(); await loadProjectHistory(payload.project.id);
    setSourceCollapsed(true);
    showPrepareNotice(localized("实验方案已载入", "Plan loaded", "Plan cargado"), "success");
  } catch (error) { showPrepareNotice(error.message, "error"); }
}

function clearResultView() {
  stopPlayback(); state.job = null; state.filteredResults = []; state.selectedKey = ""; state.selectedPayload = null; state.steps = []; state.stepIndex = 0;
  $("resultsNavCount").textContent = "0"; $("downloadResults").classList.add("hidden"); $("downloadResultsViewer").classList.add("hidden");
  $("viewerTitle").textContent = localized("尚未选择记录", "No run selected", "Ninguna ejecución seleccionada"); $("viewerSubtitle").textContent = ""; $("resultStatus").textContent = "—"; $("resultStatus").className = "result-status"; $("manualReviewState").textContent = t("manualUnreviewed"); ["manualPassButton", "manualFailButton", "clearManualReviewButton"].forEach((id) => { $(id).disabled = true; $(id).classList.remove("active"); }); $("resultFacts").replaceChildren(); $("resultPrompt").textContent = "—"; $("resultCriteria").replaceChildren(); $("stepDetailList").replaceChildren(); renderResultList(); drawStep();
}

async function loadProjectHistory(projectId) {
  try { const payload = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/history/latest`); state.suite = payload.suite; applyJob(payload.job); }
  catch (_error) { clearResultView(); }
}

function activeProjectId() {
  return $("projectSelect").value || state.project?.id || "";
}

async function renameCurrentProject() {
  const projectId = activeProjectId(); if (!projectId) return;
  const current = state.projects.find((item) => item.id === projectId) || state.project;
  const value = window.prompt(state.language === "en" ? "Plan name" : state.language === "es" ? "Nombre del plan" : "方案名称", current?.name || "");
  if (value === null || !value.trim()) return;
  try {
    const payload = await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: value.trim() }) });
    state.project = payload.project; $("editorExperimentName").value = payload.project.name; await loadProjects();
    showPrepareNotice(state.language === "en" ? "Plan renamed" : state.language === "es" ? "Plan renombrado" : "方案已重命名", "success");
  } catch (error) { showPrepareNotice(error.message, "error"); }
}

async function deleteCurrentProject() {
  const projectId = activeProjectId(); if (!projectId) return;
  if (!window.confirm(state.language === "en" ? "Delete this plan and all of its runs?" : state.language === "es" ? "¿Eliminar este plan y todas sus ejecuciones?" : "删除此方案及其全部运行结果？此操作无法撤销。")) return;
  try {
    await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }); resetProject(); await loadProjects();
    showPrepareNotice(state.language === "en" ? "Plan deleted" : state.language === "es" ? "Plan eliminado" : "方案已删除", "success");
  } catch (error) { showPrepareNotice(error.message, "error"); }
}

async function resetCurrentProjectRuns() {
  const projectId = activeProjectId(); if (!projectId) return;
  if (!window.confirm(state.language === "en" ? "Delete all run logs and results for this plan? The plan and AI conversation will be kept." : state.language === "es" ? "¿Eliminar registros y resultados? El plan y la conversación se conservarán." : "清除此方案的运行日志和结果？实验方案与 AI 对话会保留。")) return;
  try {
    await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/reset-runs`, { method: "POST" });
    clearResultView();
    showPrepareNotice(state.language === "en" ? "Run data cleared" : state.language === "es" ? "Ejecuciones eliminadas" : "运行结果已清除", "success");
  } catch (error) { showPrepareNotice(error.message, "error"); }
}

async function importProjectFile(file) {
  const payload = await jsonRequest("/api/projects/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: await file.text() });
  state.suiteId = payload.id; state.project = payload.project; state.editorExperiments = editorFromRows(rowsFromSuite(payload.suite));
  state.aiMessages = Array.isArray(payload.project.aiMessages) ? payload.project.aiMessages : [];
  state.aiEditingIndex = null;
  $("editorExperimentName").value = payload.project.name; renderEditor(); renderAiMessages(); applySuite(payload.suite, payload.project); await loadProjects(); setSourceCollapsed(true);
  showPrepareNotice(state.language === "en" ? "Complete plan imported" : state.language === "es" ? "Plan completo importado" : "完整方案已导入", "success");
}

function resetProject() {
  state.suiteId = ""; state.suite = null; state.project = null;
  state.editorExperiments = [blankExperiment()]; state.aiMessages = []; state.aiEditingIndex = null;
  $("editorExperimentName").value = `${todayStamp()}-新方案`;
  $("projectSelect").value = ""; $("runProjectSummary").textContent = t("noRunProject");
  $("startButton").disabled = true; renderEditor(); renderAiMessages(); setSource("manual"); refreshProjectControls();
  setSourceCollapsed(false);
  showPrepareNotice(localized("已创建空白实验方案", "Blank plan created", "Plan vacío creado"), "success");
}

async function importWorkbook(file) {
  showPrepareNotice(localized("正在读取表格…", "Reading workbook…", "Leyendo el archivo…"));
  const response = await fetch("/api/import", { method: "POST", headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, body: await file.arrayBuffer() });
  const raw = await response.text(); let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch (_error) { payload = {}; }
  if (!response.ok) throw new Error(payload.error || "表格导入失败");
  state.suiteId = payload.id; state.project = payload.project;
  state.editorExperiments = editorFromRows(rowsFromSuite(payload.suite));
  state.aiMessages = []; state.aiEditingIndex = null;
  $("editorExperimentName").value = payload.suite.config.experimentName;
  renderEditor(); renderAiMessages(); applySuite(payload.suite, payload.project); await loadProjects();
  setSourceCollapsed(true);
  showPrepareNotice(localized("表格已导入并保存为本地方案", "Workbook imported as a local plan", "Archivo importado como plan local"), "success");
}

async function saveEditorProject() {
  showEditorNotice(localized("正在校验实验方案…", "Validating plan…", "Validando el plan…"));
  try {
    const payload = await jsonRequest("/api/editor/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editorPayload()) });
    state.suiteId = payload.id; state.project = payload.project;
    state.editorExperiments = editorFromRows(rowsFromSuite(payload.suite));
    if (payload.project?.name) $("editorExperimentName").value = payload.project.name;
    renderEditor(); applySuite(payload.suite, payload.project); await loadProjects();
    showEditorNotice(localized("实验方案已校验并保存", "Plan validated and saved", "Plan validado y guardado"), "success");
    showPage("run", { updateHash: true });
  } catch (error) { showEditorNotice(error.message, "error"); }
}

async function exportEditorWorkbook() {
  showEditorNotice(localized("正在生成 Excel…", "Creating Excel…", "Creando Excel…"));
  try {
    const response = await fetch("/api/editor/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editorPayload()) });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error || `导出失败：${response.status}`); }
    const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a");
    link.href = url; link.download = "DMF-Tester-experiments.xlsx"; link.click(); URL.revokeObjectURL(url);
    showEditorNotice(localized("Excel 已导出", "Excel exported", "Excel exportado"), "success");
  } catch (error) { showEditorNotice(error.message, "error"); }
}

function renderAiMessages() {
  const root = $("aiMessages"); root.replaceChildren();
  if (!state.aiMessages.length && !state.aiBusy) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = t("aiEmpty"); root.append(empty); renderIcons(); return; }
  state.aiMessages.forEach((message, index) => {
    const bubble = document.createElement("div"); bubble.className = `ai-message ${message.role}`;
    const content = document.createElement("div"); content.className = "ai-message-content"; content.textContent = message.content; bubble.append(content);
    if (message.role === "user") {
      const actions = document.createElement("div"); actions.className = "ai-message-actions";
      const edit = iconAction("pencil", localized("编辑并从这里重新生成", "Edit and regenerate from here", "Editar y regenerar desde aquí"));
      edit.disabled = state.aiBusy;
      edit.addEventListener("click", () => beginAiMessageEdit(index));
      const regenerate = iconAction("refresh-cw", localized("从这里重新生成", "Regenerate from here", "Regenerar desde aquí"));
      regenerate.disabled = state.aiBusy;
      regenerate.addEventListener("click", () => regenerateAiMessage(index));
      actions.append(edit, regenerate); bubble.append(actions);
    }
    root.append(bubble);
  });
  if (state.aiBusy) {
    const thinking = document.createElement("div"); thinking.className = "ai-message assistant thinking";
    const spinner = document.createElement("span"); spinner.className = "thinking-spinner";
    const label = document.createElement("span"); label.textContent = state.language === "en" ? "Designing the plan…" : state.language === "es" ? "Diseñando el plan…" : "正在设计方案…";
    thinking.append(spinner, label); root.append(thinking);
  }
  root.scrollTop = root.scrollHeight;
  renderIcons();
}

function currentDesignerDraft() {
  const rows = rowsFromEditor().filter((row) => row.prompt);
  return {
    projectName: $("editorExperimentName").value.trim(),
    gridRows: Number(state.suite?.config?.rows) || 120,
    gridCols: Number(state.suite?.config?.cols) || 140,
    rows,
  };
}

function beginAiMessageEdit(index) {
  const message = state.aiMessages[index];
  if (state.aiBusy || message?.role !== "user") return;
  state.aiEditingIndex = index;
  $("aiInput").value = message.content;
  resizeAiInput(); $("aiInput").focus();
  showPrepareNotice(localized("编辑后发送，将从这条消息重新生成", "Send the edit to regenerate from this message", "Envía la edición para regenerar desde este mensaje"));
}

async function regenerateAiMessage(index) {
  const message = state.aiMessages[index];
  if (state.aiBusy || message?.role !== "user") return;
  state.aiEditingIndex = null;
  state.aiMessages = state.aiMessages.slice(0, index + 1);
  renderAiMessages();
  await requestAiDesign({ includeCurrentDraft: false });
}

function resizeAiInput() {
  const input = $("aiInput");
  input.style.height = "auto";
  input.style.height = `${Math.min(132, Math.max(42, input.scrollHeight))}px`;
  input.style.overflowY = input.scrollHeight > 132 ? "auto" : "hidden";
}

async function requestAiDesign({ includeCurrentDraft = true } = {}) {
  state.aiBusy = true; renderAiMessages();
  $("aiSendButton").disabled = true; showPrepareNotice(state.language === "en" ? "Generating plan…" : state.language === "es" ? "Generando el plan…" : "正在生成方案…");
  let modelRequestPending = false;
  try {
    if (!state.project?.id) {
      const draft = await jsonRequest("/api/projects/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("editorExperimentName").value, aiMessages: state.aiMessages }) });
      state.project = draft.project; $("editorExperimentName").value = draft.project.name; await loadProjects();
    }
    modelRequestPending = true;
    const designerContext = currentDesignerDraft();
    if (!includeCurrentDraft) designerContext.rows = [];
    const payload = await jsonRequest("/api/ai/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: state.aiMessages, currentDraft: designerContext, projectId: state.project?.id || "" }) });
    modelRequestPending = false;
    setModelConnectionState("verified");
    state.aiMessages.push({ role: "assistant", content: payload.assistantReply || "" }); renderAiMessages();
    const usage = payload.tokenUsage || {};
    $("aiTokenUsage").textContent = usage.available ? `${usage.totalTokens} tokens` : "";
    if (payload.project) {
      $("editorExperimentName").value = payload.project.projectName || `${todayStamp()}-AI-方案`;
      state.editorExperiments = (payload.project.experiments || []).map((experiment) => ({
        uid: uid(), enabled: true, category: experiment.category || "", repeats: Number(experiment.repeats) || 1,
        allowFollowup: experiment.mode === "default", notes: experiment.notes || "",
        steps: (experiment.steps || []).map((step) => ({ uid: uid(), prompt: step.prompt || "", expectedOperation: step.expectedOperation || "", expectedParameters: step.expectedParameters || "", notes: step.notes || "" })),
      })).filter((experiment) => experiment.steps.length);
      if (!state.editorExperiments.length) state.editorExperiments = [blankExperiment()];
      state.source = "ai"; renderEditor();
      const saved = await jsonRequest("/api/editor/validate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editorPayload()) });
      state.suiteId = saved.id; state.project = saved.project; applySuite(saved.suite, saved.project); await loadProjects();
    }
    showPrepareNotice(payload.needsInput ? localized("请补充所需信息", "Additional information required", "Se necesita más información") : localized("实验方案已生成", "Plan generated", "Plan generado"), payload.needsInput ? "" : "success");
  } catch (error) { if (modelRequestPending) setModelConnectionState("failed", error.message); showPrepareNotice(error.message, "error"); }
  finally { state.aiBusy = false; $("aiSendButton").disabled = false; renderAiMessages(); }
}

async function sendAiMessage() {
  const content = $("aiInput").value.trim();
  if (!content) return;
  const editing = Number.isInteger(state.aiEditingIndex);
  if (editing) state.aiMessages = state.aiMessages.slice(0, state.aiEditingIndex);
  state.aiMessages.push({ role: "user", content });
  state.aiEditingIndex = null; $("aiInput").value = ""; resizeAiInput(); renderAiMessages();
  await requestAiDesign({ includeCurrentDraft: !editing });
}

function updateProgress(job) {
  const total = Number(job.total || 0); const completed = Number(job.completed || 0);
  const counts = job.effectiveCounts || job.counts || {};
  $("progressText").textContent = `${completed} / ${total}`;
  $("progressFill").style.width = `${total ? Math.min(100, completed / total * 100) : 0}%`;
  $("passedCount").textContent = counts.passed || 0; $("failedCount").textContent = counts.failed || 0;
  $("reviewCount").textContent = counts.review || 0; $("errorCount").textContent = counts.error || 0;
  $("resultsNavCount").textContent = completed;
  const accuracy = completed ? `${((Number(counts.passed || 0) / completed) * 100).toFixed(1)}%` : "—";
  $("resultsSummary").textContent = total ? localized(`已完成 ${completed} / ${total} 次运行，当前通过率 ${accuracy}。`, `${completed} / ${total} complete · pass rate ${accuracy}`, `${completed} / ${total} completadas · tasa de éxito ${accuracy}`) : localized("运行结果、评测结论与执行记录将在此汇总。", "Run results and evaluation records appear here.", "Aquí aparecerán los resultados y las evaluaciones.");
  const current = job.current;
  $("currentText").textContent = current ? `${current.experimentId} · ${current.repeatIndex} · S${current.stepOrder || "—"} · ${current.phase || ""}` : ({ idle: "等待启动", queued: "任务排队中", paused: "已暂停", completed: "运行完成", stopped: "已终止", error: "任务异常" }[job.status] || "运行中");
  $("runPhaseText").textContent = job.phase || "等待启动"; renderActiveRuns(job.activeRuns || []); renderRunLogs(job.logs || []);
}

function renderActiveRuns(runs) {
  const root = $("activeRunList"); root.replaceChildren();
  if (!runs.length) { const empty = document.createElement("div"); empty.className = "empty compact-empty"; empty.textContent = localized("暂无活动任务", "No active tasks", "No hay tareas activas"); root.append(empty); return; }
  runs.forEach((run) => { const item = document.createElement("div"); item.className = "active-run-item"; const title = document.createElement("strong"); title.textContent = `${run.experimentId} · ${run.repeatIndex}`; const detail = document.createElement("span"); detail.textContent = `S${run.stepOrder || "—"} · ${run.phase || ""}`; item.append(title, detail); root.append(item); });
}

function renderRunLogs(logs) {
  const root = $("runLogList"); const shouldStick = root.scrollHeight - root.scrollTop - root.clientHeight < 36; root.replaceChildren();
  if (!logs.length) { const empty = document.createElement("div"); empty.className = "empty compact-empty"; empty.textContent = localized("运行事件将在此记录", "Run events appear here", "Los eventos aparecerán aquí"); root.append(empty); return; }
  logs.slice(-160).forEach((log) => { const item = document.createElement("div"); item.className = `run-log-item ${log.level || "info"}`; const time = document.createElement("time"); time.textContent = new Date(log.at).toLocaleTimeString(state.language === "en" ? "en" : "zh-CN", { hour12: false }); const scope = document.createElement("span"); scope.className = "run-log-scope"; scope.textContent = log.experimentId ? `${log.experimentId} · ${log.repeatIndex}${log.stepOrder ? ` · S${log.stepOrder}` : ""}` : (state.language === "en" ? "Job" : "任务"); const message = document.createElement("span"); message.textContent = log.message; item.append(time, scope, message); root.append(item); });
  if (shouldStick) root.scrollTop = root.scrollHeight;
}

function filteredResults() {
  const filter = $("statusFilter").value; const results = Array.isArray(state.job?.results) ? [...state.job.results] : [];
  return results
    .filter((result) => !filter || effectiveResultStatus(result) === filter)
    .filter((result) => result.experimentType !== "多流程" || result.isOutputGroupRepresentative !== false)
    .sort((a, b) => a.experimentOrder - b.experimentOrder || a.repeatIndex - b.repeatIndex);
}

function renderResultList() {
  state.filteredResults = filteredResults(); const list = $("resultList"); list.replaceChildren();
  if (!state.filteredResults.length) { const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = localized("没有符合筛选条件的运行记录", "No matching run records", "No hay ejecuciones coincidentes"); list.append(empty); return; }
  const selected = state.job?.results?.find((result) => result.key === state.selectedKey);
  if (selected?.outputGroupRepresentativeKey && !state.filteredResults.some((result) => result.key === state.selectedKey)) {
    state.selectedKey = selected.outputGroupRepresentativeKey;
  }
  state.filteredResults.forEach((result) => { const button = document.createElement("button"); button.type = "button"; button.className = `result-item ${result.key === state.selectedKey ? "active" : ""}`; const title = document.createElement("strong"); const groupSuffix = result.outputGroupSize > 1 ? localized(` · 相同输出 ×${result.outputGroupSize}`, ` · identical output ×${result.outputGroupSize}`, ` · salida idéntica ×${result.outputGroupSize}`) : ""; title.textContent = `${result.experimentId} · ${result.repeatIndex}${groupSuffix}`; const meta = document.createElement("span"); const finalStatus = effectiveResultStatus(result); const statusText = result.manualReview?.verdict ? `${localized("人工", "Manual", "Manual")} ${statusLabel(finalStatus)}` : statusLabel(finalStatus); const repeats = result.outputGroupSize > 1 ? localized(` · 重复 ${result.outputGroupRepeatIndexes.join("、")}`, ` · runs ${result.outputGroupRepeatIndexes.join(", ")}`, ` · ejecuciones ${result.outputGroupRepeatIndexes.join(", ")}`) : ""; meta.textContent = `${statusText} · ${result.sequenceSteps} ${localized("个激活步骤", "activation steps", "pasos de activación")}${repeats}`; button.dataset.status = finalStatus; button.append(title, meta); button.addEventListener("click", () => selectResult(result.key)); list.append(button); });
}

function drawStep() {
  const canvas = $("resultCanvas"); const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = state.theme === "dark" ? "#111827" : "#ffffff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state.steps.length) { ctx.fillStyle = state.theme === "dark" ? "#94a3b8" : "#64748b"; ctx.font = "16px system-ui"; ctx.textAlign = "center"; ctx.fillText(localized("该实验没有可显示的激活步骤", "No activation steps to display", "No hay pasos de activación"), canvas.width / 2, canvas.height / 2); $("stepText").textContent = "0 / 0"; ["firstStep", "previousStep", "playSteps", "nextStep", "lastStep"].forEach((id) => { $(id).disabled = true; }); $("stepSlider").disabled = true; $("stepSlider").style.setProperty("--range-progress", "0%"); renderWorkspaceSteps(); return; }
  $("stepSlider").disabled = false; const rows = state.suite?.config.rows || 120; const cols = state.suite?.config.cols || 140; const cellSize = Math.min((canvas.width - 1) / cols, (canvas.height - 1) / rows);
  drawGridAndDroplets({ ctx, rows, cols, cellSize, step: state.steps[state.stepIndex], showLabels: false, majorGridEvery: 32, secondaryGridEvery: 16, viewportScale: 1, theme: state.theme });
  $("stepSlider").max = String(Math.max(0, state.steps.length - 1)); $("stepSlider").value = String(state.stepIndex); $("stepSlider").style.setProperty("--range-progress", `${state.steps.length <= 1 ? 100 : state.stepIndex / (state.steps.length - 1) * 100}%`); $("stepText").textContent = `${state.stepIndex + 1} / ${state.steps.length}`; $("firstStep").disabled = state.stepIndex <= 0; $("previousStep").disabled = state.stepIndex <= 0; $("playSteps").disabled = state.steps.length <= 1; $("nextStep").disabled = state.stepIndex >= state.steps.length - 1; $("lastStep").disabled = state.stepIndex >= state.steps.length - 1; renderWorkspaceSteps();
}

function renderWorkspaceSteps() {
  const root = $("workspaceStepList"); root.replaceChildren(); $("workspaceStepCount").textContent = String(state.steps.length);
  if (!state.steps.length) { const empty = document.createElement("div"); empty.className = "empty compact-empty"; empty.textContent = localized("暂无步骤", "No steps", "Sin pasos"); root.append(empty); return; }
  state.steps.forEach((_step, index) => { const button = document.createElement("button"); button.type = "button"; button.className = `workspace-step ${index === state.stepIndex ? "active" : ""}`; button.textContent = String(index + 1); button.title = `${t("activationSequence")} ${index + 1}`; button.addEventListener("click", () => { stopPlayback(); state.stepIndex = index; drawStep(); }); root.append(button); });
}

function stopPlayback() {
  if (state.playbackTimer) clearInterval(state.playbackTimer);
  state.playbackTimer = null;
  $("playStepsIcon").dataset.lucide = "play";
  $("playSteps").setAttribute("aria-label", state.language === "en" ? "Play" : state.language === "es" ? "Reproducir" : "自动播放");
  renderIcons();
}

function togglePlayback() {
  if (state.playbackTimer) { stopPlayback(); return; }
  if (state.steps.length <= 1) return;
  if (state.stepIndex >= state.steps.length - 1) state.stepIndex = 0;
  $("playStepsIcon").dataset.lucide = "pause";
  $("playSteps").setAttribute("aria-label", state.language === "en" ? "Pause" : state.language === "es" ? "Pausar" : "暂停播放");
  renderIcons(); drawStep();
  state.playbackTimer = setInterval(() => {
    if (state.stepIndex >= state.steps.length - 1) { stopPlayback(); return; }
    state.stepIndex += 1; drawStep();
  }, Number($("playbackSpeed").value) || 1000);
}

function renderEvidence(payload) {
  const result = payload.result; const finalStatus = effectiveResultStatus(result); const manualVerdict = result.manualReview?.verdict || "";
  const groupText = result.outputGroupSize > 1 ? localized(` · 代表 ${result.outputGroupSize} 次相同输出`, ` · represents ${result.outputGroupSize} identical runs`, ` · representa ${result.outputGroupSize} ejecuciones idénticas`) : "";
  $("viewerTitle").textContent = `${result.experimentId} · ${result.repeatIndex}`; $("viewerSubtitle").textContent = `${categoryLabel(result.category)} · ${experimentTypeLabel(result.experimentType)}${groupText}`; $("resultStatus").textContent = statusLabel(finalStatus); $("resultStatus").className = `result-status ${finalStatus}`;
  $("manualReviewState").textContent = manualVerdict
    ? `${statusLabel(manualVerdict)}${result.manualReview.reviewedAt ? ` · ${new Date(result.manualReview.reviewedAt).toLocaleString()}` : ""}`
    : t("manualUnreviewed");
  $("manualPassButton").classList.toggle("active", manualVerdict === "passed");
  $("manualFailButton").classList.toggle("active", manualVerdict === "failed");
  $("clearManualReviewButton").disabled = !manualVerdict;
  $("manualPassButton").disabled = false; $("manualFailButton").disabled = false;
  const facts = $("resultFacts"); facts.replaceChildren();
  [[t("automaticVerdict"), statusLabel(result.status)], [t("manualVerdict"), manualVerdict ? statusLabel(manualVerdict) : t("manualUnreviewed")], [t("finalVerdict"), statusLabel(finalStatus)], [localized("相同输出", "Identical outputs", "Salidas idénticas"), result.outputGroupSize > 1 ? localized(`${result.outputGroupSize} 次，重复序号 ${result.outputGroupRepeatIndexes.join("、")}`, `${result.outputGroupSize} runs: ${result.outputGroupRepeatIndexes.join(", ")}`, `${result.outputGroupSize} ejecuciones: ${result.outputGroupRepeatIndexes.join(", ")}`) : localized("仅本次", "This run only", "Solo esta ejecución")], [localized("评测说明", "Evaluation", "Evaluación"), result.reason], [localized("异常轮次", "Failed turn", "Turno fallido"), result.failedStep || "—"], [localized("对话轮次", "Turns", "Turnos"), result.conversationRounds], [localized("自动补全", "Auto replies", "Respuestas automáticas"), result.autoReplyCount], [localized("激活步骤", "Activations", "Activaciones"), result.sequenceSteps], [localized("Token 用量", "Tokens", "Tokens"), result.tokenUsage.totalTokens], [localized("运行耗时", "Duration", "Duración"), `${Number(result.elapsedSeconds || 0).toFixed(2)} s`]].forEach(([label, value]) => { const dt = document.createElement("dt"); const dd = document.createElement("dd"); dt.textContent = label; dd.textContent = String(value ?? ""); facts.append(dt, dd); });
  const prompts = result.stepResults.map((step) => `${localized("轮次", "Turn", "Turno")} ${step.order}\n${step.prompt}`); $("resultPrompt").textContent = prompts.length ? prompts.join("\n\n") : "—";
  const criteria = $("resultCriteria"); criteria.replaceChildren();
  result.stepResults.forEach((step) => { const item = document.createElement("article"); item.className = "criteria-item"; const title = document.createElement("strong"); title.textContent = `${localized("轮次", "Turn", "Turno")} ${step.order}`; const expected = document.createElement("p"); const calls = step.expectedCalls || []; expected.textContent = calls.length ? `${localized("目标操作", "Target operation", "Operación esperada")}：${calls.map((call) => operationLabels[call.tool] || call.tool).join(" + ")}` : localized("未配置自动评测规则，需要人工复核", "Manual review required", "Se requiere revisión manual"); const parameters = document.createElement("code"); parameters.textContent = calls.length ? `${localized("参数约束", "Expected arguments", "Argumentos esperados")}：${calls.map((call) => JSON.stringify(call.args || {})).join(" | ")}` : ""; item.append(title, expected, parameters); criteria.append(item); });
  const detailsRoot = $("stepDetailList"); detailsRoot.replaceChildren();
  result.stepResults.forEach((step) => { const details = document.createElement("details"); details.className = "step-detail"; const summary = document.createElement("summary"); summary.textContent = `${localized("轮次", "Turn", "Turno")} ${step.order} · ${statusLabel(step.status)}`; const prompt = document.createElement("p"); prompt.textContent = step.prompt; const reply = document.createElement("p"); reply.textContent = `${localized("模型响应", "Assistant", "Modelo")}：${step.assistantReply || "—"}`; const audit = document.createElement("p"); audit.textContent = `${localized("评测说明", "Evaluation", "Evaluación")}：${step.reason}`; const checks = document.createElement("div"); checks.className = "audit-check-list"; [[localized("操作", "Operation", "Operación"), step.checks?.operationCorrect], [localized("参数", "Arguments", "Argumentos"), step.checks?.parametersCorrect], [localized("执行序列", "Sequence", "Secuencia"), step.checks?.projectSequenceCorrect], [localized("网格边界", "Bounds", "Límites"), step.checks?.boundsCorrect]].forEach(([label, value]) => { const check = document.createElement("span"); check.className = `audit-check ${value === true ? "pass" : value === false ? "fail" : ""}`; check.textContent = `${label} · ${value === true ? localized("通过", "Passed", "Correcto") : value === false ? localized("失败", "Failed", "Fallido") : localized("未检查", "Not checked", "Sin revisar")}`; checks.append(check); }); const calls = document.createElement("pre"); calls.textContent = localized(`预期调用\n${JSON.stringify(step.expectedCalls, null, 2)}\n\n实际调用\n${JSON.stringify(step.actualCalls, null, 2)}`, `Expected\n${JSON.stringify(step.expectedCalls, null, 2)}\n\nActual\n${JSON.stringify(step.actualCalls, null, 2)}`, `Esperado\n${JSON.stringify(step.expectedCalls, null, 2)}\n\nReal\n${JSON.stringify(step.actualCalls, null, 2)}`); details.append(summary, prompt, reply, audit, checks, calls); detailsRoot.append(details); });
}

async function selectResult(key) {
  if (!state.job || !key) return; stopPlayback(); state.selectedKey = key; renderResultList();
  try { const payload = await jsonRequest(`/api/jobs/${encodeURIComponent(state.job.id)}/results/${encodeURIComponent(key)}`); state.selectedPayload = payload; state.steps = parseStepsTxt(payload.stepsText || ""); state.stepIndex = Math.max(0, state.steps.length - 1); renderEvidence(payload); drawStep(); updateResultNavigation(); }
  catch (error) { showResultsNotice(error.message, "error"); }
}

async function updateManualReview(verdict) {
  if (!state.job || !state.selectedKey) return;
  const key = state.selectedKey;
  ["manualPassButton", "manualFailButton", "clearManualReviewButton"].forEach((id) => { $(id).disabled = true; });
  try {
    const payload = await jsonRequest(`/api/jobs/${encodeURIComponent(state.job.id)}/results/${encodeURIComponent(key)}/manual-review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verdict }),
    });
    applyJob(payload.job);
    await selectResult(key);
    const reviewed = payload.job.results?.find((result) => result.key === key);
    const appliedCount = reviewed?.outputGroupSize || 1;
    showResultsNotice(appliedCount > 1
      ? localized(`人工判定已应用到 ${appliedCount} 次相同输出`, `Manual verdict applied to ${appliedCount} identical runs`, `Veredicto aplicado a ${appliedCount} ejecuciones idénticas`)
      : t("manualSaved"), "success");
  } catch (error) {
    showResultsNotice(error.message, "error");
    if (state.selectedPayload) renderEvidence(state.selectedPayload);
  }
}

function updateResultNavigation() { const index = state.filteredResults.findIndex((result) => result.key === state.selectedKey); $("previousResult").disabled = index <= 0; $("nextResult").disabled = index < 0 || index >= state.filteredResults.length - 1; }

function applyJob(job) {
  state.job = job; updateProgress(job); renderResultList(); updateResultNavigation(); const active = ["queued", "running", "paused", "stopping"].includes(job.status);
  $("startButton").disabled = active || !state.suiteId; $("pauseButton").disabled = !["running", "paused"].includes(job.status); $("pauseButtonLabel").textContent = job.status === "paused" ? (state.language === "en" ? "Resume" : "继续") : t("pause"); $("stopButton").disabled = !active;
  if (job.resultsWorkbook) { const href = `/api/jobs/${encodeURIComponent(job.id)}/artifact?path=${encodeURIComponent(job.resultsWorkbook)}`; [$("downloadResults"), $("downloadResultsViewer")].forEach((link) => { link.href = href; link.classList.remove("hidden"); }); }
  if (!state.selectedKey && state.filteredResults.length) selectResult(state.filteredResults[0].key);
  if (active) schedulePoll(); else if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
}

function schedulePoll() {
  if (state.pollTimer || !state.job) return;
  state.pollTimer = setTimeout(async () => { state.pollTimer = null; try { applyJob(await jsonRequest(`/api/jobs/${encodeURIComponent(state.job.id)}`)); } catch (error) { showNotice(error.message, "error"); schedulePoll(); } }, 700);
}

async function startJob() {
  if (!state.suiteId) return; $("progressPanel").hidden = false; showNotice(localized("正在锁定正式后端和 LLM 配置…", "Locking the backend and model profile…", "Bloqueando el backend y el perfil del modelo…"));
  try { const job = await jsonRequest("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suiteId: state.suiteId, defaultFollowupReply: $("defaultReplyInput").value, concurrency: Number($("concurrencyInput").value), timeoutSeconds: Number($("timeoutInput").value), configLabel: $("configLabelInput").value }) }); state.selectedKey = ""; state.selectedPayload = null; state.steps = []; $("downloadResults").classList.add("hidden"); $("downloadResultsViewer").classList.add("hidden"); applyJob(job); showNotice(`${localized("结果目录", "Results directory", "Directorio de resultados")}：${job.outputPath}`, "success"); }
  catch (error) { showNotice(error.message, "error"); }
}

async function loadLatestHistory() {
  try { const payload = await jsonRequest("/api/history/latest"); if (state.job || state.suiteId) return; state.suite = payload.suite; applyJob(payload.job); }
  catch (_error) { /* No history is normal on first use. */ }
}

function populateLlmSettings(llm) {
  const select = $("llmProfileSelect"); const selected = llm.activeProfileId || "__new__"; select.replaceChildren();
  (llm.profiles || []).forEach((profile) => { const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name; select.append(option); });
  const add = document.createElement("option"); add.value = "__new__"; add.textContent = localized("＋ 新建配置", "+ New profile", "+ Nuevo perfil"); select.append(add);
  select.value = [...select.options].some((option) => option.value === selected) ? selected : "__new__"; fillSelectedProfile();
}

function fillSelectedProfile() {
  const id = $("llmProfileSelect").value; const profile = state.settings?.llm?.profiles?.find((item) => item.id === id);
  $("llmProfileName").value = profile?.name || ""; $("llmBaseUrl").value = profile?.baseUrl || ""; $("llmModel").value = profile?.model || ""; $("llmThinkingMode").value = profile?.thinkingMode || "auto"; $("llmApiKey").value = "";
  $("llmApiKey").placeholder = profile?.hasApiKey ? localized("已保存 · 留空则保留", "Saved · leave blank to keep", "Guardada · deja vacío para conservar") : "API Key";
}

async function loadSettings() {
  try {
    state.settings = await jsonRequest("/api/settings"); const batch = state.settings.batch;
    state.language = batch.language || state.language; state.theme = batch.theme || state.theme;
    localStorage.setItem("llm-dmf-batch-language", state.language); localStorage.setItem("llm-dmf-batch-theme", state.theme);
    $("projectRootInput").value = batch.projectRoot || ""; $("outputRootInput").value = batch.outputRoot || ""; $("languageSelect").value = state.language; $("themeSelect").value = state.theme;
    populateLlmSettings(state.settings.llm || { profiles: [] }); applyLanguage(); applyTheme(); renderEditor();
  } catch (error) { showSettingsNotice(error.message, "error"); }
}

async function saveBatchSettings(showConfirmation = true) {
  try {
    const payload = await jsonRequest("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ batch: { projectRoot: $("projectRootInput").value, outputRoot: $("outputRootInput").value, language: state.language, theme: state.theme } }) });
    state.settings.batch = payload.batch; if (showConfirmation) showSettingsNotice(localized("设置已应用", "Settings applied", "Ajustes aplicados"), "success"); await loadProjects();
  } catch (error) { showSettingsNotice(error.message, "error"); }
}

async function saveLlmProfile({ silent = false } = {}) {
  const profile = { id: $("llmProfileSelect").value === "__new__" ? "" : $("llmProfileSelect").value, name: $("llmProfileName").value.trim(), baseUrl: $("llmBaseUrl").value.trim(), model: $("llmModel").value.trim(), thinkingMode: $("llmThinkingMode").value, apiKey: $("llmApiKey").value.trim() };
  if (!profile.name) throw new Error(localized("请输入配置名称", "Enter a profile name", "Introduce un nombre de perfil"));
  const payload = await jsonRequest("/api/settings/llm-profile", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile }) });
  state.settings.llm = payload; populateLlmSettings(payload); state.modelConnectionState = "configured"; state.modelConnectionError = ""; await checkBackend(); if (!silent) showSettingsNotice(localized("模型配置已应用", "Model profile applied", "Perfil aplicado"), "success"); return payload;
}

async function loadLlmModels() {
  const button = $("loadLlmModelsButton");
  const originalDisabled = button.disabled;
  button.disabled = true;
  showSettingsNotice(localized("正在获取可用模型…", "Loading available models…", "Cargando modelos disponibles…"));
  try {
    const result = await jsonRequest("/api/settings/llm-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llmConfig: {
          baseUrl: $("llmBaseUrl").value.trim(),
          apiKey: $("llmApiKey").value.trim(),
        },
      }),
    });
    const options = $("llmModelOptions");
    options.replaceChildren(...result.models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      return option;
    }));
    showSettingsNotice(
      localized(
        `已获取 ${result.models.length} 个模型，请在模型输入框中选择`,
        `Loaded ${result.models.length} models; choose one in the model field`,
        `Se cargaron ${result.models.length} modelos; elige uno en el campo de modelo`
      ),
      "success"
    );
    $("llmModel").focus();
  } catch (error) {
    showSettingsNotice(error.message, "error");
  } finally {
    button.disabled = originalDisabled;
  }
}

async function testLlm() {
  showSettingsNotice(localized("正在验证连接与工具调用…", "Testing connection and tool calls…", "Probando la conexión y las herramientas…"));
  let profileSaved = false;
  try {
    await saveLlmProfile({ silent: true }); profileSaved = true; setModelConnectionState("testing");
    const result = await jsonRequest("/api/settings/test-llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ llmConfig: {} }) });
    setModelConnectionState("verified");
    showSettingsNotice(`${state.language === "en" ? "Connection and tools available" : state.language === "es" ? "Conexión y herramientas disponibles" : "连接与工具调用可用"} · ${result.model || "—"} · ${result.latencyMs || 0} ms`, "success");
  } catch (error) {
    if (profileSaved) setModelConnectionState("failed", error.message);
    showSettingsNotice(error.message, "error");
  }
}

$("workbookInput").addEventListener("change", async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { await importWorkbook(file); } catch (error) { showPrepareNotice(error.message, "error"); } });
const dropzone = $("importDropzone");
["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.add("dragging"); }));
["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); }));
dropzone.addEventListener("drop", async (event) => { const file = event.dataTransfer?.files?.[0]; if (!file) return; try { await importWorkbook(file); } catch (error) { showPrepareNotice(error.message, "error"); } });

document.querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", () => { setSource(button.dataset.source); setSourceCollapsed(false); }));
$("toggleSourcePanel").addEventListener("click", () => setSourceCollapsed(!state.sourceCollapsed));
$("projectSelect").addEventListener("change", refreshProjectControls);
$("openStorageSettings").addEventListener("click", () => showPage("settings", { updateHash: true }));
$("renameProjectButton").addEventListener("click", renameCurrentProject);
$("deleteProjectButton").addEventListener("click", deleteCurrentProject);
$("resetProjectRunsButton").addEventListener("click", resetCurrentProjectRuns);
$("exportProjectButton").addEventListener("click", (event) => { if (!activeProjectId()) event.preventDefault(); });
$("projectImportInput").addEventListener("change", async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { await importProjectFile(file); } catch (error) { showPrepareNotice(error.message, "error"); } });
$("applyBulkRepeats").addEventListener("click", () => {
  const repeats = Number($("bulkRepeatsInput").value);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) { showEditorNotice(state.language === "en" ? "Repeats must be between 1 and 100" : "重复次数必须为 1 到 100", "error"); return; }
  state.editorExperiments.forEach((experiment) => { experiment.repeats = repeats; }); renderEditor();
  showEditorNotice(state.language === "en" ? "Repetition count applied to all cases" : state.language === "es" ? "Repeticiones aplicadas a todos los casos" : "已统一全部用例的重复次数", "success");
});
$("addExperimentButton").addEventListener("click", () => {
  if (state.editorExperiments.length >= 200) {
    showEditorNotice(state.language === "en" ? "A plan can contain at most 200 test cases" : "单个方案最多包含 200 个测试用例", "error");
    return;
  }
  state.editorExperiments.push(blankExperiment()); renderEditor();
});
$("newProjectButton").addEventListener("click", resetProject);
$("loadProjectButton").addEventListener("click", () => loadProject($("projectSelect").value));
$("saveProjectButton").addEventListener("click", saveEditorProject);
$("exportEditorWorkbook").addEventListener("click", exportEditorWorkbook);
$("aiSendButton").addEventListener("click", sendAiMessage);
$("aiInput").addEventListener("input", resizeAiInput);
$("aiInput").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendAiMessage(); } });
$("backToPrepare").addEventListener("click", () => showPage("prepare", { updateHash: true }));
$("startButton").addEventListener("click", startJob);
$("pauseButton").addEventListener("click", async () => { if (!state.job) return; const action = state.job.status === "paused" ? "resume" : "pause"; try { applyJob(await jsonRequest(`/api/jobs/${state.job.id}/${action}`, { method: "POST" })); } catch (error) { showNotice(error.message, "error"); } });
$("stopButton").addEventListener("click", async () => { if (!state.job) return; try { applyJob(await jsonRequest(`/api/jobs/${state.job.id}/stop`, { method: "POST" })); } catch (error) { showNotice(error.message, "error"); } });
$("statusFilter").addEventListener("change", () => { renderResultList(); updateResultNavigation(); });
$("toggleResultsSidebar").addEventListener("click", () => { state.resultsSidebarCollapsed = !state.resultsSidebarCollapsed; applyResultsLayout(); });
$("toggleEvidencePanel").addEventListener("click", () => { state.evidenceCollapsed = !state.evidenceCollapsed; applyResultsLayout(); });
$("previousResult").addEventListener("click", () => { const index = state.filteredResults.findIndex((result) => result.key === state.selectedKey); if (index > 0) selectResult(state.filteredResults[index - 1].key); });
$("nextResult").addEventListener("click", () => { const index = state.filteredResults.findIndex((result) => result.key === state.selectedKey); if (index >= 0 && index < state.filteredResults.length - 1) selectResult(state.filteredResults[index + 1].key); });
$("manualPassButton").addEventListener("click", () => updateManualReview("passed"));
$("manualFailButton").addEventListener("click", () => updateManualReview("failed"));
$("clearManualReviewButton").addEventListener("click", () => updateManualReview(null));
$("previousStep").addEventListener("click", () => { stopPlayback(); state.stepIndex = Math.max(0, state.stepIndex - 1); drawStep(); });
$("nextStep").addEventListener("click", () => { stopPlayback(); state.stepIndex = Math.min(state.steps.length - 1, state.stepIndex + 1); drawStep(); });
$("firstStep").addEventListener("click", () => { stopPlayback(); state.stepIndex = 0; drawStep(); });
$("lastStep").addEventListener("click", () => { stopPlayback(); state.stepIndex = Math.max(0, state.steps.length - 1); drawStep(); });
$("playSteps").addEventListener("click", togglePlayback);
$("stepSlider").addEventListener("input", (event) => { stopPlayback(); state.stepIndex = Number(event.target.value); drawStep(); });
$("playbackSpeed").addEventListener("change", () => { if (state.playbackTimer) { stopPlayback(); togglePlayback(); } });
$("saveStorageButton").addEventListener("click", () => saveBatchSettings(true));
$("languageSelect").addEventListener("change", async (event) => { state.language = event.target.value; localStorage.setItem("llm-dmf-batch-language", state.language); applyLanguage(); renderEditor(); renderAiMessages(); fillSelectedProfile(); await saveBatchSettings(false); checkBackend(); });
$("themeSelect").addEventListener("change", async (event) => { state.theme = event.target.value; localStorage.setItem("llm-dmf-batch-theme", state.theme); applyTheme(); await saveBatchSettings(false); });
$("llmProfileSelect").addEventListener("change", fillSelectedProfile);
$("saveLlmButton").addEventListener("click", async () => { try { await saveLlmProfile(); } catch (error) { showSettingsNotice(error.message, "error"); } });
$("loadLlmModelsButton").addEventListener("click", loadLlmModels);
$("testLlmButton").addEventListener("click", testLlm);
$("settingsImportInput").addEventListener("change", async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; try { const config = JSON.parse(await file.text()); await jsonRequest("/api/settings/import", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config) }); state.settings = null; await loadSettings(); showSettingsNotice(state.language === "en" ? "Configuration imported" : "配置已导入", "success"); } catch (error) { showSettingsNotice(error.message, "error"); } });

document.querySelectorAll("[data-page-target]").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); showPage(link.dataset.pageTarget, { updateHash: true }); }));
window.addEventListener("hashchange", () => showPage(currentPage()));

state.editorExperiments = [blankExperiment()];
$("editorExperimentName").value = `${todayStamp()}-新方案`;
applyLanguage(); applyTheme(); renderEditor(); renderAiMessages(); setSource("file"); setSourceCollapsed(false); applyResultsLayout(); refreshProjectControls(); showPage(currentPage()); drawStep(); checkBackend(); loadProjects(); loadLatestHistory(); loadSettings();
