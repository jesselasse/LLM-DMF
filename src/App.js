import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { parseStepsTxt } from "./features/parseStepsTxt";
import { drawGridAndDroplets } from "./features/drawGridAndDroplets";
import StepList from "./components/StepList";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const STEP_LINE_REGEX =
  /\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*-\s*(\d+)/;
const createSessionId = () =>
  `dmf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const DEFAULT_BACKEND_MESSAGE = "在（20，20）向右生成3个液滴";
const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8];
const INPUT_PRESETS = [
  {
    label: "PCR",
    text: "PCR示例：在（20，20）向右生成3个液滴，再向下移动6步。",
  },
  {
    label: "Example 2",
    text: "在（30，18）向上生成2个液滴。",
  },
  {
    label: "Example 3",
    text: "现在在(10,8)有一个液滴尺寸为(1,1)，向右移动8步。",
  },
];

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

function stepToTxtLine(step) {
  if (!step) return "";
  if (typeof step.raw === "string" && step.raw.trim()) {
    return step.raw.trim();
  }
  const rects = Array.isArray(step.rects) ? step.rects : [];
  const rectText = rects
    .map((r) => `(${r.x},${r.y})(${r.w},${r.h})`)
    .join(";");
  const duration = Math.max(0, Number(step.duration) || 0);
  return rectText ? `${rectText}-${duration}` : `-1000`;
}

export default function App() {
  // Feature 1: grid settings + fit-to-view scale
  const [rows, setRows] = useState(120);
  const [cols, setCols] = useState(140);
  const cellSize = 16;
  const [scale, setScale] = useState(1);

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
  const [chatMessages, setChatMessages] = useState([]);
  const [sessionId, setSessionId] = useState(createSessionId);

  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);
  const chatListRef = useRef(null);

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
    canvas.style.width = `${logicalWidth}px`;
    canvas.style.height = `${logicalHeight}px`;

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function fitToView() {
    const container = canvasContainerRef.current;
    if (!container) return;
    const pad = 16;
    const availableW = container.clientWidth - pad;
    const availableH = container.clientHeight - pad;
    const scaleX = availableW / (cols * cellSize);
    const scaleY = availableH / (rows * cellSize);
    setScale(clamp(Math.min(scaleX, scaleY), 0.2, 6));
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

  function handleCanvasMouseMove(event) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    if (px < 0 || py < 0 || px >= rect.width || py >= rect.height) {
      setHoverCell(null);
      return;
    }

    const col = Math.floor((px / rect.width) * cols);
    const row = Math.floor((py / rect.height) * rows);
    if (col < 0 || row < 0 || col >= cols || row >= rows) {
      setHoverCell(null);
      return;
    }
    setHoverCell({ x: col, y: row });
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
  }, [currentStep, steps]);

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
    const onResize = () => fitToView();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (chatListRef.current) {
      chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
    }
  }, [chatMessages, backendLoading]);

  // Feature 2: parse TXT file
  async function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    const parsedSteps = parseStepsTxt(text);
    setIsPlaying(false);
    setSteps(parsedSteps);
    setCurrentStep(parsedSteps.length ? 0 : -1);
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
    setBackendLoading(true);
    setBackendRawOutput("");
    setBackendResultText("");

    try {
      const response = await fetch("/api/steps-from-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
      });

      const payload = await response.json().catch(() => ({}));
      const rawOutput = JSON.stringify(payload, null, 2);
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
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", text: `错误：${error.message || "Request failed."}`, error: true },
      ]);
    } finally {
      setBackendLoading(false);
    }
  }

  function handleExportCurrentStep() {
    if (!steps.length || currentStep < 0 || currentStep >= steps.length) return;
    const line = stepToTxtLine(steps[currentStep]);
    const blob = new Blob([`${line}\n`], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `step-${currentStep + 1}.txt`;
    link.click();
    URL.revokeObjectURL(href);
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
          onClick={handleExportCurrentStep}
          disabled={!steps.length || currentStep < 0}
        >
          Export Current Step
        </button>
        <p className="hint">
          Example: <code>(98,57)(8,4);(98,63)(8,4)-5000</code>
        </p>
      </section>

      <section className="panel stage-panel">
        <div className="status-bar">
          <span>{statusText}</span>
          <span>Scale: {Math.round(scale * 100)}%</span>
          <span className="warning">{warningText}</span>
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
          <div
            className="canvas-container"
            ref={canvasContainerRef}
            onMouseMove={handleCanvasMouseMove}
            onMouseLeave={handleCanvasMouseLeave}
          >
            {hoverCell ? (
              <div className="mouse-coord-overlay">{`(${hoverCell.x}, ${hoverCell.y})`}</div>
            ) : null}
            <div
              className="canvas-stage"
              style={{ transform: `scale(${scale})`, transformOrigin: "top center" }}
            >
              <canvas ref={canvasRef} />
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
        </div>
      </section>

      <section className="panel conversation-panel-box">
        <div className="conversation-content">
          <p className="hint">示例：在（20，20）向右生成3个液滴</p>
          <div className="preset-row">
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
          <textarea
            className="backend-input"
            id="backendMessageInput"
            rows={3}
            value={backendMessage}
            onChange={(e) => setBackendMessage(e.target.value)}
            placeholder="在（20，20）向右生成3个液滴"
          />

          <div className="conversation-actions">
            <button type="button" onClick={handleGenerateFromBackend} disabled={backendLoading}>
              {backendLoading ? "Generating..." : "Generate Steps"}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsPlaying(false);
                setSessionId(createSessionId());
                setSteps([]);
                setCurrentStep(-1);
                setChatMessages([]);
                setBackendRawOutput("");
                setBackendResultText("");
                setBackendMessage(DEFAULT_BACKEND_MESSAGE);
              }}
            >
              Clear Context
            </button>
          </div>

          <div className="chat-wrap">
            <div className="chat-list" ref={chatListRef} aria-label="LLM Chat">
              {chatMessages.map((msg, idx) => (
                <div
                  key={`${idx}-${msg.role}`}
                  className={`chat-bubble ${msg.role} ${msg.error ? "error" : ""}`}
                >
                  {msg.text}
                </div>
              ))}
              {backendLoading ? <div className="chat-bubble assistant">正在请求 LLM...</div> : null}
            </div>
          </div>

          {backendRawOutput ? (
            <pre className="backend-result" aria-label="Backend Raw Output">
              {`raw backend output:\n${backendRawOutput}`}
            </pre>
          ) : null}

          {backendResultText ? (
            <pre className="backend-result" aria-label="Backend Result Text">
              {backendResultText}
            </pre>
          ) : null}
        </div>
      </section>
    </div>
  );
}
