import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { parseStepsTxt } from "./features/parseStepsTxt";
import { drawGridAndDroplets } from "./features/drawGridAndDroplets";
import {
  createContextBlob,
  createExportFilename,
  createStepsTxtBlob,
  encodeStepsGif,
  saveBlob,
} from "./features/exportSteps";
import StepList from "./components/StepList";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const STEP_LINE_REGEX =
  /\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*-\s*(\d+)/;
const createSessionId = () =>
  `dmf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DEFAULT_BACKEND_MESSAGE = "在（20，20）向右生成3个液滴";
const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8];
const GRID_MAJOR_INTERVAL = 32;
const GRID_SECONDARY_INTERVAL = 16;
const GRID_VIEWPORT_PADDING = 28;
const GRID_MIN_SCALE = 0.1;
const GRID_MAX_SCALE = 2.5;
const GRID_ZOOM_FACTOR = 1.25;
const DEFAULT_INPUT_PRESETS = [
  {
    id: "pcr",
    labels: { zh: "PCR", en: "PCR" },
    text: "PCR示例：在（20，20）向右生成3个液滴，再向下移动6步。",
  },
  {
    id: "mixing",
    labels: { zh: "混匀操作", en: "Mixing" },
    text: "对处于位置（20，30）尺寸为（3，2）的液滴做3圈旋转混匀。",
  },
  {
    id: "example-3",
    labels: { zh: "示例 3", en: "Example 3" },
    text: "现在在(10,8)有一个液滴尺寸为(1,1)，向右移动8步。",
  },
  {
    id: "extrude-one",
    labels: { zh: "挤出生成", en: "Extrude" },
    text: "在（20，20）向右挤出式生成 1 个尺寸为 1×1 的液滴",
  },
  {
    id: "extrude-many",
    labels: { zh: "多挤出生成", en: "Multi-extrude" },
    text: "在（20，24）向右挤出生成 3 个尺寸为 1×1 的液滴",
  },
  {
    id: "move",
    labels: { zh: "移动", en: "Move" },
    text: "将位于（20，20）的 1 个尺寸为 1×1 的液滴向右移动 20 格",
  },
  {
    id: "rotate-mix",
    labels: { zh: "混合", en: "Mix" },
    text: "对位于（20，20）的 1 个尺寸为 1×1 的液滴做 3 圈旋转混匀",
  },
  {
    id: "array-mix",
    labels: { zh: "阵列混合", en: "Array mix" },
    text: "对 3 个尺寸为 1×1 的液滴并行做 3 圈阵列混匀",
  },
];
const PRESET_STORAGE_KEY = "dmf-chat-presets-v1";
const EMPTY_LLM_CONFIG = { baseUrl: "", apiKey: "", model: "" };

function cloneDefaultPresets() {
  return DEFAULT_INPUT_PRESETS.map((preset) => ({
    ...preset,
    labels: { ...preset.labels },
  }));
}

function readChatPresets() {
  try {
    const stored = window.localStorage.getItem(PRESET_STORAGE_KEY);
    if (stored === null) return cloneDefaultPresets();
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.length > 32) {
      return cloneDefaultPresets();
    }
    const valid = parsed.every(
      (preset) =>
        preset &&
        typeof preset.id === "string" &&
        preset.labels &&
        typeof preset.labels.zh === "string" &&
        typeof preset.labels.en === "string" &&
        typeof preset.text === "string"
    );
    return valid ? parsed : cloneDefaultPresets();
  } catch (_error) {
    return cloneDefaultPresets();
  }
}

function compactLlmConfig(config) {
  return Object.fromEntries(
    Object.entries(config)
      .map(([key, value]) => [key, value.trim()])
      .filter(([, value]) => value)
  );
}

const UI_COPY = {
  zh: {
    gridSize: "网格尺寸",
    rows: "行数",
    columns: "列数",
    stepFile: "步骤文件",
    loadTxt: "加载 TXT 步骤文件",
    importSteps: "导入步骤",
    noFileSelected: "尚未选择文件",
    exportSteps: "导出步骤",
    exportingSteps: "正在导出步骤…",
    example: "格式示例",
    selectedDroplets: "已选液滴",
    selectionHint: "点击画布中的液滴可选中或取消选中，并作为当前会话的上下文。",
    noDroplets: "尚未选择液滴",
    clearDroplets: "清除已选液滴",
    exportLog: "导出日志",
    exporting: "正在导出…",
    exportAllTitle: "导出 TXT、GIF 与 JSON 上下文",
    interfaceSettings: "界面设置",
    language: "语言",
    appearance: "外观",
    chinese: "中文",
    english: "English",
    light: "浅色",
    dark: "深色",
    llmConnection: "LLM 连接",
    apiBaseUrl: "API 地址",
    apiBaseUrlPlaceholder: "留空使用服务器配置",
    apiKey: "API Key",
    apiKeyPlaceholder: "仅当前页面有效",
    model: "模型",
    modelPlaceholder: "留空使用服务器配置",
    showApiKey: "显示 API Key",
    hideApiKey: "隐藏 API Key",
    llmConfigHint: "留空使用服务器配置；API Key 不会保存或导出。",
    saveLlmConfig: "保存设置",
    testLlmConfig: "测试连接",
    testingLlmConfig: "正在测试…",
    llmConfigSaved: "已确认，将用于后续请求，仅当前页面有效。",
    llmConfigUnsaved: "内容有变化，保存后才会用于聊天请求。",
    llmTestSuccess: (latency) => `连接成功，耗时 ${latency} ms。`,
    llmTestFailed: "测试失败",
    noStepSelected: "未选择步骤",
    stepProgress: (current, total) => `步骤 ${current} / ${total}`,
    scale: "缩放",
    zoomControls: "网格缩放控制",
    zoomOut: "缩小",
    fitView: "适应",
    zoomIn: "放大",
    steps: "步骤",
    noSteps: "尚未加载步骤",
    stepList: "步骤列表",
    stepLabel: "步骤",
    playbackControls: "播放控制",
    stepProgressControl: "步骤进度",
    back10: "后退 10 步",
    back1: "后退 1 步",
    pause: "暂停",
    play: "播放",
    forward1: "前进 1 步",
    forward10: "前进 10 步",
    playbackSpeed: "播放速度",
    exportGif: "导出 GIF",
    assistantSubtitle: "液滴操作与步骤生成",
    export: "导出",
    exportContext: "导出 JSON 上下文",
    newConversation: "新建对话",
    new: "新建",
    chat: "LLM 对话",
    emptyChatTitle: "开始一段 DMF 对话",
    emptyChatDescription: "描述液滴的位置、尺寸和操作，助手会生成对应步骤。",
    requesting: "正在请求 LLM…",
    rawOutput: "原始后端输出",
    generatedSteps: "生成的步骤",
    presets: "预设对话",
    managePresets: "管理预设",
    closePresetManager: "关闭",
    newPreset: "新增预设",
    presetName: "名称",
    presetPrompt: "内容",
    savePreset: "保存预设",
    resetPreset: "恢复默认",
    deletePreset: "删除预设",
    composerLabel: "对话输入",
    composerPlaceholder: "描述需要执行的液滴操作…",
    send: "发送消息",
    editMessage: "编辑这条消息",
    editingMessage: (turn) => `正在编辑第 ${turn} 轮；发送后将替换这一轮及其后的回复。`,
    cancelEdit: "取消编辑",
    resend: "重新生成",
    composerHint: "示例：在（20，20）向右生成 3 个液滴",
    outOfBounds: "部分液滴超出网格范围，以红色显示。",
  },
  en: {
    gridSize: "Grid size",
    rows: "Rows",
    columns: "Columns",
    stepFile: "Step file",
    loadTxt: "Load TXT step file",
    importSteps: "Import steps",
    noFileSelected: "No file selected",
    exportSteps: "Export steps",
    exportingSteps: "Exporting steps…",
    example: "Format example",
    selectedDroplets: "Selected droplets",
    selectionHint: "Select droplets on the canvas to include them in the current conversation context.",
    noDroplets: "No droplets selected",
    clearDroplets: "Clear selected droplets",
    exportLog: "Export log",
    exporting: "Exporting…",
    exportAllTitle: "Export TXT, GIF, and JSON context",
    interfaceSettings: "Interface settings",
    language: "Language",
    appearance: "Appearance",
    chinese: "中文",
    english: "English",
    light: "Light",
    dark: "Dark",
    llmConnection: "LLM connection",
    apiBaseUrl: "API URL",
    apiBaseUrlPlaceholder: "Use server configuration when blank",
    apiKey: "API Key",
    apiKeyPlaceholder: "Current page only",
    model: "Model",
    modelPlaceholder: "Use server configuration when blank",
    showApiKey: "Show API Key",
    hideApiKey: "Hide API Key",
    llmConfigHint: "Blank fields use server settings. The API Key is not saved or exported.",
    saveLlmConfig: "Save settings",
    testLlmConfig: "Test connection",
    testingLlmConfig: "Testing…",
    llmConfigSaved: "Confirmed for later requests on this page only.",
    llmConfigUnsaved: "Changes must be saved before chat requests use them.",
    llmTestSuccess: (latency) => `Connection succeeded in ${latency} ms.`,
    llmTestFailed: "Test failed",
    noStepSelected: "No step selected",
    stepProgress: (current, total) => `Step ${current} / ${total}`,
    scale: "Scale",
    zoomControls: "Grid zoom controls",
    zoomOut: "Zoom out",
    fitView: "Fit",
    zoomIn: "Zoom in",
    steps: "Steps",
    noSteps: "No steps loaded",
    stepList: "Step list",
    stepLabel: "Step",
    playbackControls: "Playback controls",
    stepProgressControl: "Step progress",
    back10: "Back 10",
    back1: "Back 1",
    pause: "Pause",
    play: "Play",
    forward1: "Forward 1",
    forward10: "Forward 10",
    playbackSpeed: "Playback speed",
    exportGif: "Export GIF",
    assistantSubtitle: "Droplet operations and step generation",
    export: "Export",
    exportContext: "Export JSON context",
    newConversation: "New conversation",
    new: "New",
    chat: "LLM chat",
    emptyChatTitle: "Start a DMF conversation",
    emptyChatDescription: "Describe droplet positions, dimensions, and operations to generate steps.",
    requesting: "Requesting LLM…",
    rawOutput: "Raw backend output",
    generatedSteps: "Generated steps",
    presets: "Conversation presets",
    managePresets: "Manage presets",
    closePresetManager: "Close",
    newPreset: "New preset",
    presetName: "Name",
    presetPrompt: "Prompt",
    savePreset: "Save preset",
    resetPreset: "Restore default",
    deletePreset: "Delete preset",
    composerLabel: "Chat input",
    composerPlaceholder: "Describe the droplet operation…",
    send: "Send message",
    editMessage: "Edit this message",
    editingMessage: (turn) => `Editing turn ${turn}. Sending replaces this turn and later replies.`,
    cancelEdit: "Cancel edit",
    resend: "Regenerate",
    composerHint: "Example: generate 3 droplets to the right at (20, 20)",
    outOfBounds: "Some droplets are outside the grid and are shown in red.",
  },
};

function readPreference(key, allowed, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch (_error) {
    return fallback;
  }
}

function getRulerInterval(scale, cellSize) {
  const minimumLabelSpacing = 72;
  const intervals = [1, 2, 4, 8, 16, 32, 64];
  return (
    intervals.find(
      (interval) => interval * cellSize * scale >= minimumLabelSpacing
    ) || intervals[intervals.length - 1]
  );
}

function createVisibleAxisTicks({ size, scale, cellSize, origin, viewportSize }) {
  const interval = getRulerInterval(scale, cellSize);
  const ticks = [];
  const pixelsPerUnit = cellSize * scale;
  const firstVisibleValue = clamp(
    Math.floor(-origin / pixelsPerUnit),
    0,
    size
  );
  const lastVisibleValue = clamp(
    Math.ceil((viewportSize - origin) / pixelsPerUnit),
    0,
    size
  );
  const firstTick = Math.ceil(firstVisibleValue / interval) * interval;

  for (let value = firstTick; value <= lastVisibleValue; value += interval) {
    ticks.push({ value, position: origin + value * pixelsPerUnit });
  }

  const terminalPosition = origin + size * pixelsPerUnit;
  if (
    size >= firstVisibleValue &&
    size <= lastVisibleValue &&
    !ticks.some((tick) => tick.value === size)
  ) {
    ticks.push({ value: size, position: terminalPosition });
  }
  return ticks;
}

function dropletKey(rect) {
  return `${rect.x},${rect.y},${rect.w},${rect.h}`;
}

function normalizeDroplet(rect) {
  return {
    x: Number(rect.x),
    y: Number(rect.y),
    w: Number(rect.w),
    h: Number(rect.h),
  };
}

function rectContainsCell(rect, col, row) {
  return (
    col >= rect.x &&
    col < rect.x + rect.w &&
    row >= rect.y &&
    row < rect.y + rect.h
  );
}

function extractStepsTextFromRaw(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.stepsText === "string" && parsed.stepsText.trim()) {
      return parsed.stepsText.trim();
    }
  } catch (_err) {
    // Ignore JSON parse failure and fallback to regex extraction from raw text.
  }

  const matchedLines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => STEP_LINE_REGEX.test(line));

  return matchedLines.join("\n");
}

export default function App() {
  const [locale, setLocale] = useState(() =>
    readPreference("dmf-ui-locale", ["zh", "en"], "zh")
  );
  const [theme, setTheme] = useState(() =>
    readPreference("dmf-ui-theme", ["light", "dark"], "light")
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [llmConfigDraft, setLlmConfigDraft] = useState(EMPTY_LLM_CONFIG);
  const [llmConfig, setLlmConfig] = useState(EMPTY_LLM_CONFIG);
  const [llmConfigConfirmed, setLlmConfigConfirmed] = useState(false);
  const [llmConfigStatus, setLlmConfigStatus] = useState({ state: "idle" });
  const t = UI_COPY[locale];

  // Feature 1: grid settings + fit-to-view scale
  const [rows, setRows] = useState(120);
  const [cols, setCols] = useState(140);
  const cellSize = 16;
  const [scale, setScale] = useState(1);
  const [axisViewport, setAxisViewport] = useState({
    width: 0,
    height: 0,
    originX: 0,
    originY: 0,
  });

  // Feature 2 + 3 + 4 shared state
  const [steps, setSteps] = useState([]);
  const [stepFileName, setStepFileName] = useState("");
  const [currentStep, setCurrentStep] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [hoverCell, setHoverCell] = useState(null);
  const [warningText, setWarningText] = useState("");
  const [backendMessage, setBackendMessage] = useState(DEFAULT_BACKEND_MESSAGE);
  const [backendRawOutput, setBackendRawOutput] = useState("");
  const [backendResultText, setBackendResultText] = useState("");
  const [backendLoading, setBackendLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [rawContextEntries, setRawContextEntries] = useState([]);
  const [editingTurnIndex, setEditingTurnIndex] = useState(null);
  const [draftBeforeEdit, setDraftBeforeEdit] = useState("");
  const [requestInputHeight, setRequestInputHeight] = useState(null);
  const [chatPresets, setChatPresets] = useState(readChatPresets);
  const [presetManagerOpen, setPresetManagerOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState("");
  const [presetDraft, setPresetDraft] = useState({ label: "", text: "" });
  const [sessionId, setSessionId] = useState(createSessionId);
  const [selectedDroplets, setSelectedDroplets] = useState([]);

  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const chatListRef = useRef(null);
  const backendInputRef = useRef(null);
  const fitScaleRef = useRef(GRID_MIN_SCALE);
  const isFitModeRef = useRef(true);
  const zoomFocusRef = useRef(null);

  const displayGridWidth = cols * cellSize * scale;
  const displayGridHeight = rows * cellSize * scale;
  const xAxisTicks = useMemo(
    () =>
      createVisibleAxisTicks({
        size: cols,
        scale,
        cellSize,
        origin: axisViewport.originX,
        viewportSize: axisViewport.width,
      }),
    [cols, scale, cellSize, axisViewport.originX, axisViewport.width]
  );
  const yAxisTicks = useMemo(
    () =>
      createVisibleAxisTicks({
        size: rows,
        scale,
        cellSize,
        origin: axisViewport.originY,
        viewportSize: axisViewport.height,
      }),
    [rows, scale, cellSize, axisViewport.originY, axisViewport.height]
  );
  const llmConfigDirty = ["baseUrl", "apiKey", "model"].some(
    (key) => llmConfigDraft[key] !== llmConfig[key]
  );

  const statusText = useMemo(() => {
    if (!steps.length || currentStep < 0) return t.noStepSelected;
    return t.stepProgress(currentStep + 1, steps.length);
  }, [steps.length, currentStep, t]);
  const activeStep = useMemo(
    () => (currentStep >= 0 && currentStep < steps.length ? steps[currentStep] : null),
    [currentStep, steps]
  );
  const latestStep = useMemo(
    () => (steps.length ? steps[steps.length - 1] : null),
    [steps]
  );
  const latestFrameRects = useMemo(() => latestStep?.rects || [], [latestStep]);
  const stepProgressPercent =
    steps.length > 1 && currentStep >= 0
      ? (currentStep / (steps.length - 1)) * 100
      : 0;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    try {
      window.localStorage.setItem("dmf-ui-theme", theme);
      window.localStorage.setItem("dmf-ui-locale", locale);
    } catch (_error) {
      // Preferences are optional when storage is unavailable.
    }
  }, [theme, locale]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(chatPresets));
    } catch (_error) {
      // Custom presets remain available for this page when storage is unavailable.
    }
  }, [chatPresets]);

  function resizeCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const logicalWidth = cols * cellSize + 1;
    const logicalHeight = rows * cellSize + 1;

    canvas.width = Math.ceil(logicalWidth * dpr);
    canvas.height = Math.ceil(logicalHeight * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function calculateFitScale() {
    const container = canvasContainerRef.current;
    if (!container) return GRID_MIN_SCALE;
    const availableW = container.clientWidth - GRID_VIEWPORT_PADDING;
    const availableH = container.clientHeight - GRID_VIEWPORT_PADDING;
    const scaleX = availableW / (cols * cellSize);
    const scaleY = availableH / (rows * cellSize);
    return clamp(Math.min(scaleX, scaleY), GRID_MIN_SCALE, GRID_MAX_SCALE);
  }

  function syncRulers() {
    const container = canvasContainerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    setAxisViewport({
      width: container.clientWidth,
      height: container.clientHeight,
      originX: canvasRect.left - containerRect.left,
      originY: canvasRect.top - containerRect.top,
    });
  }

  function fitToView() {
    const nextScale = calculateFitScale();
    fitScaleRef.current = nextScale;
    isFitModeRef.current = true;
    zoomFocusRef.current = null;
    const container = canvasContainerRef.current;
    if (container) {
      container.scrollLeft = 0;
      container.scrollTop = 0;
    }
    setScale(nextScale);
  }

  function zoomGrid(factor) {
    const container = canvasContainerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const nextScale = clamp(
      scale * factor,
      fitScaleRef.current,
      GRID_MAX_SCALE
    );
    if (Math.abs(nextScale - scale) < 0.0001) return;

    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const viewportCenterX = containerRect.left + container.clientWidth / 2;
    const viewportCenterY = containerRect.top + container.clientHeight / 2;
    zoomFocusRef.current = {
      gridX: clamp((viewportCenterX - canvasRect.left) / scale, 0, cols * cellSize),
      gridY: clamp((viewportCenterY - canvasRect.top) / scale, 0, rows * cellSize),
    };
    isFitModeRef.current = Math.abs(nextScale - fitScaleRef.current) < 0.0001;
    setScale(nextScale);
  }

  function redrawCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const { warning } = drawGridAndDroplets({
      ctx,
      rows,
      cols,
      cellSize,
      step: activeStep,
      selectedRects: selectedDroplets,
      showLabels: false,
      majorGridEvery: GRID_MAJOR_INTERVAL,
      secondaryGridEvery: GRID_SECONDARY_INTERVAL,
      viewportScale: scale,
      theme,
    });

    setWarningText(warning);
  }

  function selectStep(index) {
    if (!steps.length) return;
    setIsPlaying(false);
    setCurrentStep(clamp(index, 0, steps.length - 1));
  }

  function jumpBy(delta) {
    if (!steps.length) return;
    setIsPlaying(false);
    const base = currentStep < 0 ? 0 : currentStep;
    setCurrentStep(clamp(base + delta, 0, steps.length - 1));
  }

  function togglePlayPause() {
    if (!steps.length) return;
    if (currentStep < 0) {
      setCurrentStep(0);
    }
    setIsPlaying((prev) => !prev);
  }

  function getGridCellFromPointer(event) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < 0 || py < 0 || px >= rect.width || py >= rect.height) {
      return null;
    }

    const col = Math.floor((px / rect.width) * cols);
    const row = Math.floor((py / rect.height) * rows);
    if (col < 0 || row < 0 || col >= cols || row >= rows) {
      return null;
    }
    return { x: col, y: row };
  }

  function handleCanvasMouseMove(event) {
    const cell = getGridCellFromPointer(event);
    if (!cell) {
      setHoverCell(null);
      return;
    }
    setHoverCell(cell);
  }

  function handleCanvasClick(event) {
    const cell = getGridCellFromPointer(event);
    if (currentStep !== steps.length - 1) {
      return;
    }
    const activeStep =
      currentStep >= 0 && currentStep < steps.length ? steps[currentStep] : null;
    if (!cell || !activeStep || !Array.isArray(activeStep.rects)) {
      return;
    }

    const hit = [...activeStep.rects]
      .reverse()
      .find((rect) => rectContainsCell(rect, cell.x, cell.y));
    if (!hit) {
      return;
    }

    const normalized = normalizeDroplet(hit);
    const key = dropletKey(normalized);
    setSelectedDroplets((prev) => {
      const exists = prev.some((rect) => dropletKey(rect) === key);
      if (exists) {
        return prev.filter((rect) => dropletKey(rect) !== key);
      }
      return [...prev, normalized];
    });
  }

  function handleCanvasMouseLeave() {
    setHoverCell(null);
  }

  function cyclePlaybackRate() {
    setPlaybackRate((prev) => {
      const index = PLAYBACK_SPEEDS.indexOf(prev);
      const nextIndex = index < 0 ? 1 : (index + 1) % PLAYBACK_SPEEDS.length;
      return PLAYBACK_SPEEDS[nextIndex];
    });
  }

  // Feature 1
  useEffect(() => {
    resizeCanvas();
    fitToView();
    requestAnimationFrame(redrawCanvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols]);

  useEffect(() => {
    requestAnimationFrame(redrawCanvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, steps, selectedDroplets, scale, theme]);

  useLayoutEffect(() => {
    const focus = zoomFocusRef.current;
    const container = canvasContainerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    if (!focus) {
      syncRulers();
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const viewportCenterX = containerRect.left + container.clientWidth / 2;
    const viewportCenterY = containerRect.top + container.clientHeight / 2;
    const focusClientX = canvasRect.left + focus.gridX * scale;
    const focusClientY = canvasRect.top + focus.gridY * scale;
    container.scrollLeft += focusClientX - viewportCenterX;
    container.scrollTop += focusClientY - viewportCenterY;
    zoomFocusRef.current = null;
    requestAnimationFrame(syncRulers);
  }, [scale]);

  useEffect(() => {
    const currentKeys = new Set(latestFrameRects.map((rect) => dropletKey(rect)));
    setSelectedDroplets((prev) => {
      const next = prev.filter((rect) => currentKeys.has(dropletKey(rect)));
      return next.length === prev.length ? prev : next;
    });
  }, [latestFrameRects]);

  useEffect(() => {
    const controller = new AbortController();

    async function syncSessionState() {
      try {
        const response = await fetch("/api/session-state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            selectedDroplets,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          return;
        }
        await response.json();
      } catch (error) {
        if (error.name !== "AbortError") return;
      }
    }

    syncSessionState();
    return () => controller.abort();
  }, [sessionId, selectedDroplets]);

  useEffect(() => {
    if (!isPlaying || !steps.length) return undefined;
    if (currentStep < 0) return undefined;
    if (currentStep >= steps.length - 1) {
      setIsPlaying(false);
      return undefined;
    }

    const baseDelay = Math.max(80, steps[currentStep]?.duration || 300);
    const delay = Math.max(30, Math.round(baseDelay / playbackRate));
    const timer = window.setTimeout(() => {
      setCurrentStep((prev) => {
        const next = prev + 1;
        if (next >= steps.length) {
          setIsPlaying(false);
          return steps.length - 1;
        }
        return next;
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [isPlaying, currentStep, steps, playbackRate]);

  useEffect(() => {
    fitToView();
    const onResize = () => {
      const nextFitScale = calculateFitScale();
      fitScaleRef.current = nextFitScale;
      if (isFitModeRef.current) {
        setScale(nextFitScale);
      } else {
        setScale((currentScale) =>
          clamp(currentScale, nextFitScale, GRID_MAX_SCALE)
        );
      }
      requestAnimationFrame(syncRulers);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chatListRef.current) {
      chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
    }
  }, [chatMessages, backendLoading]);

  useLayoutEffect(() => {
    const input = backendInputRef.current;
    if (!input) return;

    const minHeight = 48;
    const maxHeight = 160;
    if (backendLoading && requestInputHeight) {
      input.style.height = `${requestInputHeight}px`;
      input.style.overflowY = "hidden";
      return;
    }
    input.style.height = "auto";
    const contentHeight = input.scrollHeight + 2;
    input.style.height = `${clamp(contentHeight, minHeight, maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [backendMessage, backendLoading, requestInputHeight]);

  // Feature 2: parse TXT file
  async function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setStepFileName(file.name);
    const text = await file.text();
    const parsedSteps = parseStepsTxt(text);
    setIsPlaying(false);
    setSteps(parsedSteps);
    setCurrentStep(parsedSteps.length ? 0 : -1);
    setSelectedDroplets([]);
    await fetch("/api/session-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, sequenceText: text, selectedDroplets: [] }),
    });
  }

  function updateLlmConfigDraft(field, value) {
    setLlmConfigDraft((current) => ({ ...current, [field]: value }));
    setLlmConfigStatus({ state: "idle" });
  }

  function handleSaveLlmConfig() {
    const confirmed = {
      baseUrl: llmConfigDraft.baseUrl.trim(),
      apiKey: llmConfigDraft.apiKey.trim(),
      model: llmConfigDraft.model.trim(),
    };
    setLlmConfigDraft(confirmed);
    setLlmConfig(confirmed);
    setLlmConfigConfirmed(true);
    setLlmConfigStatus({ state: "saved" });
  }

  async function handleTestLlmConfig() {
    setLlmConfigStatus({ state: "testing" });
    try {
      const response = await fetch("/api/llm-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llmConfig: compactLlmConfig(llmConfigDraft) }),
      });
      const responseRaw = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(responseRaw);
      } catch (_error) {
        payload = {};
      }
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || `Backend error: ${response.status}`);
      }
      setLlmConfigStatus({
        state: "success",
        latencyMs: Math.max(0, Number(payload.latencyMs) || 0),
      });
    } catch (error) {
      setLlmConfigStatus({
        state: "error",
        error: String(error.message || error),
      });
    }
  }

  // New: send message to backend and parse returned TXT content
  async function handleGenerateFromBackend() {
    const message = backendMessage.trim();
    if (!message) {
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", text: "错误：输入不能为空。", error: true },
      ]);
      return;
    }

    const requestedEditTurn = editingTurnIndex;
    const chatMessagesBeforeRequest = chatMessages;
    const rawContextBeforeRequest = rawContextEntries;
    const rawOutputBeforeRequest = backendRawOutput;
    const resultTextBeforeRequest = backendResultText;
    const successfulTurnCount = chatMessages.filter(
      (entry) => entry.role === "assistant" && !entry.error && Number.isInteger(entry.turnIndex)
    ).length;
    const provisionalTurnIndex = requestedEditTurn ?? successfulTurnCount;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setChatMessages((prev) => {
      const editedMessageIndex = prev.findIndex(
        (entry) => entry.role === "user" && entry.turnIndex === requestedEditTurn
      );
      const retained =
        Number.isInteger(requestedEditTurn) && editedMessageIndex >= 0
          ? prev.slice(0, editedMessageIndex)
          : prev;
      return [
        ...retained,
        { role: "user", text: message, turnIndex: provisionalTurnIndex, requestId },
      ];
    });
    if (Number.isInteger(requestedEditTurn)) {
      setRawContextEntries((prev) =>
        prev.filter(
          (entry) => !Number.isInteger(entry.turnIndex) || entry.turnIndex < requestedEditTurn
        )
      );
    }
    setBackendMessage("");
    setRequestInputHeight(backendInputRef.current?.offsetHeight || 48);
    setBackendLoading(true);
    setBackendRawOutput("");
    setBackendResultText("");
    const baseSteps = steps;
    const selectedDropletSnapshot = selectedDroplets.map(normalizeDroplet);

    const requestBody = {
      message,
      sessionId,
      selectedDroplets: selectedDropletSnapshot,
      ...(Number.isInteger(requestedEditTurn)
        ? { editTurnIndex: requestedEditTurn }
        : {}),
    };
    const configuredLlmValues = compactLlmConfig(llmConfig);
    const transportBody = Object.keys(configuredLlmValues).length
      ? { ...requestBody, llmConfig: configuredLlmValues }
      : requestBody;
    const requestRaw = JSON.stringify(requestBody);
    const requestedAt = new Date().toISOString();
    let rawEntryRecorded = false;

    try {
      const response = await fetch("/api/steps-from-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transportBody),
      });

      const responseRaw = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(responseRaw);
      } catch (_error) {
        payload = {};
      }
      const rawOutput = responseRaw || "{}";
      setRawContextEntries((prev) => [
        ...prev,
        {
          requestedAt,
          respondedAt: new Date().toISOString(),
          requestRaw,
          turnIndex: Number.isInteger(payload.turnIndex)
            ? payload.turnIndex
            : provisionalTurnIndex,
          responseStatus: response.status,
          responseRaw,
        },
      ]);
      rawEntryRecorded = true;
      if (!response.ok) {
        throw new Error(payload.error || `Backend error: ${response.status}`);
      }
      setBackendRawOutput(rawOutput);

      const resolvedTurnIndex = Number.isInteger(payload.turnIndex)
        ? payload.turnIndex
        : provisionalTurnIndex;
      setChatMessages((prev) =>
        prev.map((entry) =>
          entry.requestId === requestId
            ? { ...entry, turnIndex: resolvedTurnIndex }
            : entry
        )
      );

      const reply =
        typeof payload.assistantReply === "string" ? payload.assistantReply : "";
      if (reply.trim()) {
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", text: reply, turnIndex: resolvedTurnIndex },
        ]);
      } else {
        setChatMessages((prev) => [
          ...prev,
          { role: "assistant", text: rawOutput, turnIndex: resolvedTurnIndex },
        ]);
      }
      setEditingTurnIndex(null);
      setDraftBeforeEdit("");

      const completeText = extractStepsTextFromRaw(
        typeof payload.stepsText === "string" ? payload.stepsText : ""
      );
      const deltaText = extractStepsTextFromRaw(
        typeof payload.stepsTextDelta === "string" ? payload.stepsTextDelta : ""
      );
      if (!completeText.trim() && !deltaText.trim()) {
        // Interactive mode: assistant may ask follow-up questions without steps.
        return;
      }

      const authoritativeSteps = completeText.trim()
        ? parseStepsTxt(completeText)
        : [...baseSteps, ...parseStepsTxt(deltaText)];
      const totalRects = authoritativeSteps.reduce(
        (sum, step) => sum + step.rects.length,
        0
      );
      if (!authoritativeSteps.length || totalRects === 0) {
        // Keep chat running even when returned text is not drawable.
        return;
      }

      setBackendResultText(deltaText.trim() || completeText);
      setIsPlaying(false);
      setSteps(authoritativeSteps);
      setCurrentStep(
        authoritativeSteps.length
          ? Math.min(
              Number.isInteger(payload.baseStepCount)
                ? payload.baseStepCount
                : baseSteps.length,
              authoritativeSteps.length - 1
            )
          : -1
      );
      if (Array.isArray(payload.selectedDroplets)) {
        setSelectedDroplets(payload.selectedDroplets.map(normalizeDroplet));
      }
      requestAnimationFrame(() => redrawCanvas());
    } catch (error) {
      const errorText = String(error.message || error);
      if (Number.isInteger(requestedEditTurn)) {
        setRawContextEntries([
          ...rawContextBeforeRequest,
          {
            requestedAt,
            failedAt: new Date().toISOString(),
            requestRaw,
            turnIndex: provisionalTurnIndex,
            errorRaw: errorText,
          },
        ]);
      } else if (!rawEntryRecorded) {
        setRawContextEntries((prev) => [
          ...prev,
          {
            requestedAt,
            failedAt: new Date().toISOString(),
            requestRaw,
            turnIndex: provisionalTurnIndex,
            errorRaw: errorText,
          },
        ]);
      }
      setChatMessages((prev) => [
        ...(Number.isInteger(requestedEditTurn)
          ? chatMessagesBeforeRequest
          : prev.map((entry) =>
              entry.requestId === requestId ? { ...entry, turnIndex: null } : entry
            )),
        {
          role: "assistant",
          text: `错误：${errorText || "Request failed."}`,
          error: true,
        },
      ]);
      if (Number.isInteger(requestedEditTurn)) {
        setBackendRawOutput(rawOutputBeforeRequest);
        setBackendResultText(resultTextBeforeRequest);
      }
      setBackendMessage(message);
    } finally {
      setBackendLoading(false);
      setRequestInputHeight(null);
    }
  }

  function beginEditingMessage(message) {
    if (backendLoading || !Number.isInteger(message.turnIndex)) return;
    setDraftBeforeEdit(backendMessage);
    setEditingTurnIndex(message.turnIndex);
    setBackendMessage(message.text);
    requestAnimationFrame(() => backendInputRef.current?.focus());
  }

  function cancelEditingMessage() {
    setEditingTurnIndex(null);
    setBackendMessage(draftBeforeEdit);
    setDraftBeforeEdit("");
    setRequestInputHeight(null);
    requestAnimationFrame(() => backendInputRef.current?.focus());
  }

  function editPreset(preset) {
    setEditingPresetId(preset.id);
    setPresetDraft({ label: preset.labels[locale], text: preset.text });
  }

  function openPresetManager() {
    setPresetManagerOpen(true);
    if (chatPresets.length) editPreset(chatPresets[0]);
    else startNewPreset();
  }

  function startNewPreset() {
    setEditingPresetId("");
    setPresetDraft({ label: "", text: backendMessage.trim() });
  }

  function savePreset() {
    const label = presetDraft.label.trim();
    const text = presetDraft.text.trim();
    if (!label || !text) return;
    if (editingPresetId) {
      setChatPresets((current) =>
        current.map((preset) =>
          preset.id === editingPresetId
            ? {
                ...preset,
                labels: { ...preset.labels, [locale]: label },
                text,
              }
            : preset
        )
      );
      return;
    }
    if (chatPresets.length >= 32) return;
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const created = { id, labels: { zh: label, en: label }, text };
    setChatPresets((current) => [...current, created]);
    setEditingPresetId(id);
  }

  function resetPreset() {
    const defaultPreset = DEFAULT_INPUT_PRESETS.find(
      (preset) => preset.id === editingPresetId
    );
    if (!defaultPreset) return;
    setChatPresets((current) =>
      current.map((preset) =>
        preset.id === editingPresetId
          ? { ...defaultPreset, labels: { ...defaultPreset.labels } }
          : preset
      )
    );
    setPresetDraft({
      label: defaultPreset.labels[locale],
      text: defaultPreset.text,
    });
  }

  function deletePreset() {
    const remaining = chatPresets.filter((preset) => preset.id !== editingPresetId);
    setChatPresets(remaining);
    if (remaining.length) editPreset(remaining[0]);
    else startNewPreset();
  }

  function handleBackendInputKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    event.preventDefault();
    if (!backendLoading) {
      handleGenerateFromBackend();
    }
  }

  async function runExport({ includeSteps = false, includeGif = false, includeContext = false, errorLabel }) {
    const requiresSteps = includeSteps || includeGif;
    if ((requiresSteps && !steps.length) || isExporting) return;
    setIsExporting(true);

    try {
      if (includeSteps) {
        await saveBlob(createStepsTxtBlob(steps), {
          suggestedName: createExportFilename("steps", "txt"),
          description: "DMF Steps Text",
          accept: { "text/plain": [".txt"] },
        });
      }
      if (includeGif) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        await saveBlob(encodeStepsGif({ steps, rows, cols }), {
          suggestedName: createExportFilename("animation", "gif"),
          description: "GIF Animation",
          accept: { "image/gif": [".gif"] },
        });
      }
      if (includeContext) {
        await saveBlob(
          createContextBlob({
            sessionId,
            messages: chatMessages,
            exchanges: rawContextEntries,
          }),
          {
            suggestedName: createExportFilename("context", "json"),
            description: "JSON Context",
            accept: { "application/json": [".json"] },
          }
        );
      }
    } catch (error) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `${errorLabel}：${error.message || "无法生成导出文件。"}`,
          error: true,
        },
      ]);
    } finally {
      setIsExporting(false);
    }
  }

  function handleExportAllSteps() {
    return runExport({
      includeSteps: true,
      errorLabel: "导出失败",
    });
  }

  function handleExportGif() {
    return runExport({
      includeGif: true,
      errorLabel: "GIF 导出失败",
    });
  }

  function handleExportJsonContext() {
    return runExport({
      includeContext: true,
      errorLabel: "JSON 导出失败",
    });
  }

  function handleExportLog() {
    return runExport({
      includeSteps: true,
      includeGif: true,
      includeContext: true,
      errorLabel: "整体导出失败",
    });
  }

  function handleNewConversation() {
    setIsPlaying(false);
    setSessionId(createSessionId());
    setSteps([]);
    setCurrentStep(-1);
    setChatMessages([]);
    setRawContextEntries([]);
    setEditingTurnIndex(null);
    setDraftBeforeEdit("");
    setRequestInputHeight(null);
    setBackendRawOutput("");
    setBackendResultText("");
    setBackendMessage(DEFAULT_BACKEND_MESSAGE);
    setSelectedDroplets([]);
  }

  return (
    <div className="app">
      <section className="panel controls-panel">
        <div className="control-section">
          <div className="control-section-title">{t.gridSize}</div>
          <div className="grid-dim-inputs">
            <label className="dimension-field" htmlFor="rowsInput">
              <span>{t.rows}</span>
              <input id="rowsInput" aria-label={t.rows} type="number" min="1" value={rows}
                onChange={(e) => setRows(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <span className="dim-separator">×</span>
            <label className="dimension-field" htmlFor="colsInput">
              <span>{t.columns}</span>
              <input id="colsInput" aria-label={t.columns} type="number" min="1" value={cols}
                onChange={(e) => setCols(Math.max(1, Number(e.target.value) || 1))} />
            </label>
          </div>
        </div>

        <div className="control-section file-section">
          <div className="control-section-title">{t.stepFile}</div>
          <input className="file-input" id="fileInput" aria-label={t.loadTxt}
            type="file" accept=".txt" onChange={handleFileChange} />
          <label className="file-import-btn" htmlFor="fileInput">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
            </svg>
            {t.importSteps}
          </label>
          <span className="selected-file-name" title={stepFileName || t.noFileSelected}>
            {stepFileName || t.noFileSelected}
          </span>
          <button type="button" className="secondary-action-btn"
            onClick={handleExportAllSteps} disabled={!steps.length || isExporting}>
            {isExporting ? t.exportingSteps : t.exportSteps}
          </button>
          <p className="hint format-hint">
            <span>{t.example}</span>
            <code>(98,57)(8,4);(98,63)(8,4)-5000</code>
          </p>
        </div>

        <div className="control-section selection-panel">
          <div className="selection-panel-header">
            <strong>{t.selectedDroplets}</strong>
            <span className="count-badge">{selectedDroplets.length}</span>
          </div>
          <p className="hint">{t.selectionHint}</p>
          <div className="selection-list" aria-label={t.selectedDroplets}>
            {selectedDroplets.length ? (
              selectedDroplets.map((rect) => (
                <button
                  key={dropletKey(rect)}
                  type="button"
                  className="selection-chip"
                  onClick={() =>
                    setSelectedDroplets((prev) =>
                      prev.filter((item) => dropletKey(item) !== dropletKey(rect))
                    )
                  }
                >
                  {`(${rect.x},${rect.y})(${rect.w},${rect.h})`}
                </button>
              ))
            ) : (
              <div className="empty-selection">{t.noDroplets}</div>
            )}
          </div>
          <button
            type="button"
            className="secondary-action-btn"
            onClick={() => setSelectedDroplets([])}
            disabled={!selectedDroplets.length}
          >
            {t.clearDroplets}
          </button>
        </div>

        <div className="controls-footer">
          <button type="button" className="footer-export-btn" onClick={handleExportLog}
            disabled={!steps.length || isExporting} title={t.exportAllTitle}>
            {isExporting ? t.exporting : t.exportLog}
          </button>
        </div>
      </section>

      <section className="panel stage-panel">
        <div className="status-bar">
          <span>{statusText}</span>
          <span aria-label={t.scale}>{t.scale}: {Math.round(scale * 100)}%</span>
          <span className="warning">{warningText ? t.outOfBounds : ""}</span>
          <div className="zoom-controls" aria-label={t.zoomControls}>
            <button
              type="button"
              className="zoom-btn"
              onClick={() => zoomGrid(1 / GRID_ZOOM_FACTOR)}
              disabled={scale <= fitScaleRef.current + 0.0001}
              aria-label={t.zoomOut}
              title={t.zoomOut}
            >
              −
            </button>
            <button
              type="button"
              className="zoom-fit-btn"
              onClick={fitToView}
              aria-label={t.fitView}
              title={t.fitView}
            >
              {t.fitView}
            </button>
            <button
              type="button"
              className="zoom-btn"
              onClick={() => zoomGrid(GRID_ZOOM_FACTOR)}
              disabled={scale >= GRID_MAX_SCALE - 0.0001}
              aria-label={t.zoomIn}
              title={t.zoomIn}
            >
              ＋
            </button>
          </div>
        </div>
        <div className="stage-workspace">
          <aside className="steps-dock">
            <div className="steps-dock-header">
              <h2>{t.steps}</h2>
              <span>{steps.length}</span>
            </div>
            <StepList
              steps={steps}
              currentStep={currentStep}
              onSelectStep={(index) => selectStep(index)}
              compact
              emptyText={t.noSteps}
              ariaLabel={t.stepList}
              stepLabel={t.stepLabel}
            />
          </aside>
          <div className="grid-viewport">
            {hoverCell ? (
              <div className="mouse-coord-overlay">{`(${hoverCell.x}, ${hoverCell.y})`}</div>
            ) : null}
            <div className="axis-corner" aria-hidden="true" />
            <div className="grid-axis grid-axis-x" aria-label="X axis">
              {xAxisTicks.map(({ value, position }) => (
                <span
                  key={value}
                  className="axis-tick"
                  style={{ left: `${position}px` }}
                >
                  {value}
                </span>
              ))}
            </div>
            <div className="grid-axis grid-axis-y" aria-label="Y axis">
              {yAxisTicks.map(({ value, position }) => (
                <span
                  key={value}
                  className="axis-tick"
                  style={{ top: `${position}px` }}
                >
                  {value}
                </span>
              ))}
            </div>
            <div
              className="canvas-container"
              ref={canvasContainerRef}
              onScroll={syncRulers}
              onMouseMove={handleCanvasMouseMove}
              onMouseLeave={handleCanvasMouseLeave}
              onClick={handleCanvasClick}
            >
              <div
                className="canvas-stage"
                style={{
                  width: `${displayGridWidth}px`,
                  height: `${displayGridHeight}px`,
                }}
              >
                <canvas
                  ref={canvasRef}
                  style={{
                    width: `${displayGridWidth}px`,
                    height: `${displayGridHeight}px`,
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="playback-area">
          <div className="step-progress-row">
            <span>{t.stepProgressControl}</span>
            <strong>{currentStep >= 0 ? currentStep + 1 : 0} / {steps.length}</strong>
          </div>
          <input
            className="step-progress-range"
            type="range"
            min="0"
            max={Math.max(steps.length - 1, 0)}
            step="1"
            value={Math.max(currentStep, 0)}
            onChange={(event) => selectStep(Number(event.target.value))}
            disabled={!steps.length}
            aria-label={t.stepProgressControl}
            style={{ "--step-progress": `${stepProgressPercent}%` }}
          />
          <div className="playback-mini" aria-label={t.playbackControls}>
          <button
            type="button"
            className="icon-btn"
            title={t.back10}
            aria-label={t.back10}
            onClick={() => jumpBy(-10)}
            disabled={!steps.length}
          >
            ⏮
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t.back1}
            aria-label={t.back1}
            onClick={() => jumpBy(-1)}
            disabled={!steps.length}
          >
            ◀
          </button>
          <button
            type="button"
            className="icon-btn"
            title={isPlaying ? t.pause : t.play}
            aria-label={isPlaying ? t.pause : t.play}
            onClick={togglePlayPause}
            disabled={!steps.length}
          >
            {isPlaying ? "⏸" : "▷"}
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t.forward1}
            aria-label={t.forward1}
            onClick={() => jumpBy(1)}
            disabled={!steps.length}
          >
            ▶
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t.forward10}
            aria-label={t.forward10}
            onClick={() => jumpBy(10)}
            disabled={!steps.length}
          >
            ⏭
          </button>
          <button
            type="button"
            className="speed-btn"
            title={t.playbackSpeed}
            aria-label={t.playbackSpeed}
            onClick={cyclePlaybackRate}
            disabled={!steps.length}
          >
            {playbackRate}x
          </button>
          <button
            type="button"
            className="icon-btn export-gif-btn"
            title={t.exportGif}
            aria-label={t.exportGif}
            onClick={handleExportGif}
            disabled={!steps.length || isExporting}
          >
            ◫
          </button>
          </div>
        </div>
      </section>

      <section className="panel conversation-panel-box">
        <header className="ai-chat-header">
          <div className="settings-anchor chat-settings-anchor">
            {settingsOpen ? (
              <div className="interface-settings" role="group" aria-label={t.interfaceSettings}>
                <div className="settings-row">
                  <span>{t.language}</span>
                  <div className="settings-options">
                    <button type="button" aria-pressed={locale === "zh"}
                      className={locale === "zh" ? "active" : ""} onClick={() => setLocale("zh")}>
                      {t.chinese}
                    </button>
                    <button type="button" aria-pressed={locale === "en"}
                      className={locale === "en" ? "active" : ""} onClick={() => setLocale("en")}>
                      {t.english}
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <span>{t.appearance}</span>
                  <div className="settings-options">
                    <button type="button" aria-pressed={theme === "light"}
                      className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>
                      {t.light}
                    </button>
                    <button type="button" aria-pressed={theme === "dark"}
                      className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
                      {t.dark}
                    </button>
                  </div>
                </div>
                <div className="settings-divider" />
                <fieldset className="llm-settings">
                  <legend>{t.llmConnection}</legend>
                  <div className="llm-setting-field">
                    <label htmlFor="llmBaseUrl">{t.apiBaseUrl}</label>
                    <input id="llmBaseUrl" type="url" value={llmConfigDraft.baseUrl}
                      onChange={(event) => updateLlmConfigDraft("baseUrl", event.target.value)}
                      placeholder={t.apiBaseUrlPlaceholder} autoComplete="off" spellCheck="false" />
                  </div>
                  <div className="llm-setting-field">
                    <label htmlFor="llmApiKey">{t.apiKey}</label>
                    <span className="secret-input-wrap">
                      <input id="llmApiKey" type={apiKeyVisible ? "text" : "password"}
                        value={llmConfigDraft.apiKey}
                        onChange={(event) => updateLlmConfigDraft("apiKey", event.target.value)}
                        placeholder={t.apiKeyPlaceholder} autoComplete="off" spellCheck="false" />
                      <button type="button" className="secret-visibility-btn"
                        onClick={() => setApiKeyVisible((visible) => !visible)}
                        aria-label={apiKeyVisible ? t.hideApiKey : t.showApiKey}
                        title={apiKeyVisible ? t.hideApiKey : t.showApiKey}>
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
                          <circle cx="12" cy="12" r="2.5" />
                          {apiKeyVisible ? <path d="M4 4l16 16" /> : null}
                        </svg>
                      </button>
                    </span>
                  </div>
                  <div className="llm-setting-field">
                    <label htmlFor="llmModel">{t.model}</label>
                    <input id="llmModel" type="text" value={llmConfigDraft.model}
                      onChange={(event) => updateLlmConfigDraft("model", event.target.value)}
                      placeholder={t.modelPlaceholder} autoComplete="off" spellCheck="false" />
                  </div>
                  <p>{t.llmConfigHint}</p>
                  <div className="llm-settings-actions">
                    <button type="button" onClick={handleSaveLlmConfig}>{t.saveLlmConfig}</button>
                    <button type="button" className="test-llm-btn" onClick={handleTestLlmConfig}
                      disabled={llmConfigStatus.state === "testing"}>
                      {llmConfigStatus.state === "testing" ? t.testingLlmConfig : t.testLlmConfig}
                    </button>
                  </div>
                  <p className={`llm-config-status ${llmConfigStatus.state}`} aria-live="polite">
                    {llmConfigStatus.state === "testing"
                      ? t.testingLlmConfig
                      : llmConfigStatus.state === "success"
                        ? `${t.llmTestSuccess(llmConfigStatus.latencyMs)}${llmConfigDirty ? ` ${t.llmConfigUnsaved}` : ""}`
                        : llmConfigStatus.state === "error"
                          ? `${t.llmTestFailed}：${llmConfigStatus.error}`
                          : llmConfigDirty
                            ? t.llmConfigUnsaved
                            : llmConfigStatus.state === "saved" || (llmConfigConfirmed && !llmConfigDirty)
                              ? t.llmConfigSaved
                              : ""}
                  </p>
                </fieldset>
              </div>
            ) : null}
            <button type="button" className="settings-trigger chat-settings-trigger"
              aria-expanded={settingsOpen} aria-label={t.interfaceSettings}
              title={t.interfaceSettings} onClick={() => setSettingsOpen((open) => !open)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h10m4 0h2M4 17h2m4 0h10M14 4v6M6 14v6" />
              </svg>
            </button>
          </div>
          <div className="ai-chat-identity">
            <span className="ai-chat-avatar" aria-hidden="true">AI</span>
            <div>
              <h2>DMF Assistant</h2>
              <span>{t.assistantSubtitle}</span>
            </div>
          </div>
          <div className="ai-chat-header-actions">
            <button
              type="button"
              className="chat-header-btn"
              onClick={handleExportJsonContext}
              disabled={isExporting}
              aria-label={t.exportContext}
              title={t.exportContext}
            >
              {t.export}
            </button>
            <button
              type="button"
              className="chat-header-btn new-chat-btn"
              onClick={handleNewConversation}
              disabled={backendLoading}
              aria-label={t.newConversation}
              title={t.newConversation}
            >
              <span aria-hidden="true">＋</span>
              {t.new}
            </button>
          </div>
        </header>

        <div className="conversation-content">
          <div className="chat-wrap">
            <div className="chat-list" ref={chatListRef} aria-label={t.chat}>
              {!chatMessages.length && !backendLoading ? (
                <div className="chat-empty-state">
                  <span className="chat-empty-icon" aria-hidden="true">AI</span>
                  <strong>{t.emptyChatTitle}</strong>
                  <p>{t.emptyChatDescription}</p>
                </div>
              ) : null}
              {chatMessages.map((msg, idx) => (
                <div
                  key={msg.requestId || `${idx}-${msg.role}-${msg.turnIndex ?? "notice"}`}
                  className={`chat-bubble ${msg.role} ${msg.error ? "error" : ""}`}
                >
                  <span>{msg.text}</span>
                  {msg.role === "user" && Number.isInteger(msg.turnIndex) ? (
                    <button
                      type="button"
                      className="edit-chat-message-btn"
                      onClick={() => beginEditingMessage(msg)}
                      disabled={backendLoading}
                      aria-label={t.editMessage}
                      title={t.editMessage}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="m4 16.5-.8 4.3 4.3-.8L18.8 8.7l-3.5-3.5L4 16.5Zm13-13 3.5 3.5 1-1a1.4 1.4 0 0 0 0-2l-1.5-1.5a1.4 1.4 0 0 0-2 0l-1 1Z" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              ))}
              {backendLoading ? <div className="chat-bubble assistant">{t.requesting}</div> : null}
              {backendRawOutput || backendResultText ? (
                <div className="backend-results">
                  {backendRawOutput ? (
                    <details className="backend-raw-details">
                      <summary>{t.rawOutput}</summary>
                      <pre className="backend-result" aria-label="Backend Raw Output">
                        {backendRawOutput}
                      </pre>
                    </details>
                  ) : null}

                  {backendResultText ? (
                    <details className="backend-raw-details">
                      <summary>{t.generatedSteps}</summary>
                      <pre className="backend-result" aria-label="Backend Result Text">
                        {backendResultText}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="chat-composer">
            <div className="preset-toolbar">
              <div className="preset-row" aria-label={t.presets}>
                {chatPresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="preset-btn"
                    onClick={() => setBackendMessage(preset.text)}
                    disabled={backendLoading}
                  >
                    {preset.labels[locale]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="manage-presets-btn"
                onClick={presetManagerOpen ? () => setPresetManagerOpen(false) : openPresetManager}
                aria-expanded={presetManagerOpen}
              >
                {presetManagerOpen ? t.closePresetManager : t.managePresets}
              </button>
            </div>
            {presetManagerOpen ? (
              <div className="preset-manager">
                <div className="preset-manager-topline">
                  <select
                    aria-label={t.managePresets}
                    value={editingPresetId}
                    onChange={(event) => {
                      const preset = chatPresets.find(
                        (entry) => entry.id === event.target.value
                      );
                      if (preset) editPreset(preset);
                      else startNewPreset();
                    }}
                  >
                    <option value="">＋ {t.newPreset}</option>
                    {chatPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.labels[locale]}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={startNewPreset}>
                    ＋
                  </button>
                </div>
                <input
                  aria-label={t.presetName}
                  value={presetDraft.label}
                  onChange={(event) =>
                    setPresetDraft((current) => ({
                      ...current,
                      label: event.target.value,
                    }))
                  }
                  placeholder={t.presetName}
                />
                <textarea
                  aria-label={t.presetPrompt}
                  rows={2}
                  value={presetDraft.text}
                  onChange={(event) =>
                    setPresetDraft((current) => ({
                      ...current,
                      text: event.target.value,
                    }))
                  }
                  placeholder={t.presetPrompt}
                />
                <div className="preset-manager-actions">
                  <button
                    type="button"
                    className="save-preset-btn"
                    onClick={savePreset}
                    disabled={!presetDraft.label.trim() || !presetDraft.text.trim()}
                  >
                    {t.savePreset}
                  </button>
                  {editingPresetId ? (
                    <>
                      {DEFAULT_INPUT_PRESETS.some((preset) => preset.id === editingPresetId) ? (
                        <button type="button" onClick={resetPreset}>{t.resetPreset}</button>
                      ) : null}
                      <button type="button" onClick={deletePreset}>{t.deletePreset}</button>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}
            {Number.isInteger(editingTurnIndex) ? (
              <div className="composer-edit-notice" role="status">
                <span>{t.editingMessage(editingTurnIndex + 1)}</span>
                <button type="button" onClick={cancelEditingMessage} disabled={backendLoading}>
                  {t.cancelEdit}
                </button>
              </div>
            ) : null}
            <div className="composer-input-row">
              <textarea
                ref={backendInputRef}
                className="backend-input"
                id="backendMessageInput"
                aria-label={t.composerLabel}
                rows={1}
                value={backendMessage}
                onChange={(e) => setBackendMessage(e.target.value)}
                onKeyDown={handleBackendInputKeyDown}
                disabled={backendLoading}
                placeholder={t.composerPlaceholder}
              />
              <button
                type="button"
                className="send-message-btn"
                onClick={handleGenerateFromBackend}
                disabled={backendLoading || !backendMessage.trim()}
                aria-label={Number.isInteger(editingTurnIndex) ? t.resend : t.send}
                title={Number.isInteger(editingTurnIndex) ? t.resend : t.send}
              >
                {backendLoading ? (
                  <span className="send-loading" aria-hidden="true">…</span>
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3.4 20.4 22 12 3.4 3.6l-.1 6.5L16.6 12 3.3 13.9l.1 6.5Z" />
                  </svg>
                )}
              </button>
            </div>
            {!backendMessage.trim() && !Number.isInteger(editingTurnIndex) ? (
              <p className="composer-hint">{t.composerHint}</p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
