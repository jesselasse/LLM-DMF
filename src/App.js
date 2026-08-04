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
const INPUT_PRESETS = [
  {
    label: "PCR",
    text: "PCR示例：在（20，20）向右生成3个液滴，再向下移动6步。",
  },
  {
    label: "混匀操作",
    text: "对处于位置（20，30）尺寸为（3，2）的液滴做3圈旋转混匀。",
  },
  {
    label: "Example 3",
    text: "现在在(10,8)有一个液滴尺寸为(1,1)，向右移动8步。",
  },
];

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

  const statusText = useMemo(() => {
    if (!steps.length || currentStep < 0) return "No step selected";
    return `Step ${currentStep + 1} / ${steps.length}`;
  }, [steps.length, currentStep]);

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
    const activeStep =
      currentStep >= 0 && currentStep < steps.length ? steps[currentStep] : null;

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
  }, [currentStep, steps, selectedDroplets, scale]);

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
    input.style.height = "auto";
    const contentHeight = input.scrollHeight + 2;
    input.style.height = `${clamp(contentHeight, minHeight, maxHeight)}px`;
    input.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
  }, [backendMessage]);

  // Feature 2: parse TXT file
  async function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    const parsedSteps = parseStepsTxt(text);
    setIsPlaying(false);
    setSteps(parsedSteps);
    setCurrentStep(parsedSteps.length ? 0 : -1);
    setSelectedDroplets([]);
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

    setChatMessages((prev) => [...prev, { role: "user", text: message }]);
    setBackendMessage("");
    setBackendLoading(true);
    setBackendRawOutput("");
    setBackendResultText("");

    const requestBody = { message, sessionId, selectedDroplets };
    const requestRaw = JSON.stringify(requestBody);
    const requestedAt = new Date().toISOString();
    let rawEntryRecorded = false;

    try {
      const response = await fetch("/api/steps-from-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestRaw,
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
          responseStatus: response.status,
          responseRaw,
        },
      ]);
      rawEntryRecorded = true;
      if (!response.ok) {
        throw new Error(payload.error || `Backend error: ${response.status}`);
      }
      setBackendRawOutput(rawOutput);

      const reply =
        typeof payload.assistantReply === "string" ? payload.assistantReply : "";
      if (reply.trim()) {
        setChatMessages((prev) => [...prev, { role: "assistant", text: reply }]);
      } else {
        setChatMessages((prev) => [...prev, { role: "assistant", text: rawOutput }]);
      }

      const txt = extractStepsTextFromRaw(
        typeof payload.stepsText === "string" ? payload.stepsText : rawOutput
      );
      if (!txt.trim()) {
        // Interactive mode: assistant may ask follow-up questions without steps.
        return;
      }

      setBackendResultText(txt);
      const parsedSteps = parseStepsTxt(txt);
      const totalRects = parsedSteps.reduce((sum, step) => sum + step.rects.length, 0);
      if (!parsedSteps.length || totalRects === 0) {
        // Keep chat running even when returned text is not drawable.
        return;
      }

      setIsPlaying(false);
      setSteps(parsedSteps);
      setCurrentStep(parsedSteps.length ? 0 : -1);
      requestAnimationFrame(() => redrawCanvas());
    } catch (error) {
      if (!rawEntryRecorded) {
        setRawContextEntries((prev) => [
          ...prev,
          {
            requestedAt,
            failedAt: new Date().toISOString(),
            requestRaw,
            errorRaw: String(error.message || error),
          },
        ]);
      }
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", text: `错误：${error.message || "Request failed."}`, error: true },
      ]);
    } finally {
      setBackendLoading(false);
    }
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
    setBackendRawOutput("");
    setBackendResultText("");
    setBackendMessage(DEFAULT_BACKEND_MESSAGE);
    setSelectedDroplets([]);
  }

  return (
    <div className="app">
      <section className="panel controls-panel">
        <h1>Digital Microfluidics Grid Basics</h1>
        <div className="grid-dim-row">
          <label htmlFor="rowsInput">Rows / Columns</label>
          <div className="grid-dim-inputs">
            <input
              id="rowsInput"
              aria-label="Rows"
              type="number"
              min="1"
              value={rows}
              onChange={(e) => setRows(Math.max(1, Number(e.target.value) || 1))}
            />
            <span className="dim-separator">x</span>
            <input
              id="colsInput"
              aria-label="Columns"
              type="number"
              min="1"
              value={cols}
              onChange={(e) => setCols(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        </div>

        <label htmlFor="fileInput">Load TXT Step File</label>
        <input id="fileInput" type="file" accept=".txt" onChange={handleFileChange} />
        <button
          type="button"
          onClick={handleExportAllSteps}
          disabled={!steps.length || isExporting}
        >
          {isExporting ? "Exporting Steps..." : "Export Steps"}
        </button>
        <p className="hint">
          Example: <code>(98,57)(8,4);(98,63)(8,4)-5000</code>
        </p>
        <div className="selection-panel">
          <div className="selection-panel-header">
            <strong>Selected Droplets</strong>
            <span>{selectedDroplets.length}</span>
          </div>
          <p className="hint">
            点击画布中的液滴可选中或取消选中，系统会把这些液滴作为当前会话的内存输入。
          </p>
          <div className="selection-list" aria-label="Selected Droplets">
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
              <div className="empty-selection">No droplets selected</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setSelectedDroplets([])}
            disabled={!selectedDroplets.length}
          >
            Clear Selected Droplets
          </button>
        </div>
        <button
          type="button"
          className="footer-export-btn"
          onClick={handleExportLog}
          disabled={!steps.length || isExporting}
          title="Export TXT + GIF + JSON Context"
        >
          {isExporting ? "Exporting..." : "Export Log"}
        </button>
      </section>

      <section className="panel stage-panel">
        <div className="status-bar">
          <span>{statusText}</span>
          <span aria-label="Grid scale">Scale: {Math.round(scale * 100)}%</span>
          <span className="warning">{warningText}</span>
          <div className="zoom-controls" aria-label="Grid zoom controls">
            <button
              type="button"
              className="zoom-btn"
              onClick={() => zoomGrid(1 / GRID_ZOOM_FACTOR)}
              disabled={scale <= fitScaleRef.current + 0.0001}
              aria-label="Zoom Out"
              title="Zoom Out"
            >
              −
            </button>
            <button
              type="button"
              className="zoom-fit-btn"
              onClick={fitToView}
              aria-label="Fit to View"
              title="Fit to View"
            >
              适应
            </button>
            <button
              type="button"
              className="zoom-btn"
              onClick={() => zoomGrid(GRID_ZOOM_FACTOR)}
              disabled={scale >= GRID_MAX_SCALE - 0.0001}
              aria-label="Zoom In"
              title="Zoom In"
            >
              ＋
            </button>
          </div>
        </div>
        <div className="stage-workspace">
          <aside className="steps-dock">
            <div className="steps-dock-header">
              <h2>Steps</h2>
              <span>{steps.length}</span>
            </div>
            <StepList
              steps={steps}
              currentStep={currentStep}
              onSelectStep={(index) => selectStep(index)}
              compact
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

        <div className="playback-mini" aria-label="Playback Controls">
          <button
            type="button"
            className="icon-btn"
            title="Back 10"
            aria-label="Back 10"
            onClick={() => jumpBy(-10)}
            disabled={!steps.length}
          >
            ⏮
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Back 1"
            aria-label="Back 1"
            onClick={() => jumpBy(-1)}
            disabled={!steps.length}
          >
            ◀
          </button>
          <button
            type="button"
            className="icon-btn"
            title={isPlaying ? "Pause" : "Play"}
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={togglePlayPause}
            disabled={!steps.length}
          >
            {isPlaying ? "⏸" : "▷"}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Forward 1"
            aria-label="Forward 1"
            onClick={() => jumpBy(1)}
            disabled={!steps.length}
          >
            ▶
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Forward 10"
            aria-label="Forward 10"
            onClick={() => jumpBy(10)}
            disabled={!steps.length}
          >
            ⏭
          </button>
          <button
            type="button"
            className="speed-btn"
            title="Playback Speed"
            aria-label="Playback Speed"
            onClick={cyclePlaybackRate}
            disabled={!steps.length}
          >
            {playbackRate}x
          </button>
          <button
            type="button"
            className="icon-btn export-gif-btn"
            title="Export GIF"
            aria-label="Export GIF"
            onClick={handleExportGif}
            disabled={!steps.length || isExporting}
          >
            ◫
          </button>
        </div>
      </section>

      <section className="panel conversation-panel-box">
        <header className="ai-chat-header">
          <div className="ai-chat-identity">
            <span className="ai-chat-avatar" aria-hidden="true">AI</span>
            <div>
              <h2>DMF Assistant</h2>
              <span>液滴操作与步骤生成</span>
            </div>
          </div>
          <div className="ai-chat-header-actions">
            <button
              type="button"
              className="chat-header-btn"
              onClick={handleExportJsonContext}
              disabled={isExporting}
              aria-label="Export JSON Context"
              title="Export JSON Context"
            >
              导出
            </button>
            <button
              type="button"
              className="chat-header-btn new-chat-btn"
              onClick={handleNewConversation}
              aria-label="新建对话"
              title="新建对话"
            >
              <span aria-hidden="true">＋</span>
              新建
            </button>
          </div>
        </header>

        <div className="conversation-content">
          <div className="chat-wrap">
            <div className="chat-list" ref={chatListRef} aria-label="LLM Chat">
              {!chatMessages.length && !backendLoading ? (
                <div className="chat-empty-state">
                  <span className="chat-empty-icon" aria-hidden="true">AI</span>
                  <strong>开始一段 DMF 对话</strong>
                  <p>描述液滴的位置、尺寸和操作，助手会生成对应步骤。</p>
                </div>
              ) : null}
              {chatMessages.map((msg, idx) => (
                <div
                  key={`${idx}-${msg.role}`}
                  className={`chat-bubble ${msg.role} ${msg.error ? "error" : ""}`}
                >
                  {msg.text}
                </div>
              ))}
              {backendLoading ? <div className="chat-bubble assistant">正在请求 LLM...</div> : null}
              {backendRawOutput || backendResultText ? (
                <div className="backend-results">
                  {backendRawOutput ? (
                    <details className="backend-raw-details">
                      <summary>Raw backend output</summary>
                      <pre className="backend-result" aria-label="Backend Raw Output">
                        {backendRawOutput}
                      </pre>
                    </details>
                  ) : null}

                  {backendResultText ? (
                    <details className="backend-raw-details">
                      <summary>Generated steps</summary>
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
            <div className="preset-row" aria-label="预设对话">
              {INPUT_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="preset-btn"
                  onClick={() => setBackendMessage(preset.text)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="composer-input-row">
              <textarea
                ref={backendInputRef}
                className="backend-input"
                id="backendMessageInput"
                aria-label="对话输入"
                rows={1}
                value={backendMessage}
                onChange={(e) => setBackendMessage(e.target.value)}
                onKeyDown={handleBackendInputKeyDown}
                placeholder="描述需要执行的液滴操作…"
              />
              <button
                type="button"
                className="send-message-btn"
                onClick={handleGenerateFromBackend}
                disabled={backendLoading}
                aria-label="发送消息"
                title="发送消息"
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
            <p className="composer-hint">示例：在（20，20）向右生成 3 个液滴</p>
          </div>
        </div>
      </section>
    </div>
  );
}
