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
  const [cellSize, setCellSize] = useState(16);
  const [scale, setScale] = useState(1);

  // Feature 2 + 3 + 4 shared state
  const [steps, setSteps] = useState([]);
  const [currentStep, setCurrentStep] = useState(-1);
  const [warningText, setWarningText] = useState("");
  const [backendMessage, setBackendMessage] = useState("");
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

  // Feature 1
  useEffect(() => {
    resizeCanvas();
    requestAnimationFrame(redrawCanvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, cols, cellSize]);

  useEffect(() => {
    requestAnimationFrame(redrawCanvas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStep, steps]);

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
    setBackendMessage("");
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
        throw new Error("后端输出中没有找到可解析序列。");
      }

      setBackendResultText(txt);
      const parsedSteps = parseStepsTxt(txt);
      const totalRects = parsedSteps.reduce((sum, step) => sum + step.rects.length, 0);
      if (!parsedSteps.length || totalRects === 0) {
        throw new Error(
          `返回文本无法解析为可绘制液滴。steps=${parsedSteps.length}, rects=${totalRects}`
        );
      }

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

  return (
    <div className="app">
      <section className="panel controls-panel">
        <h1>Digital Microfluidics Grid Basics</h1>
        <p className="muted">Only core features are kept in this base project.</p>
        <p className="hint">Session: <code>{sessionId}</code></p>
        <button
          type="button"
          onClick={() => {
            setSessionId(createSessionId());
            setSteps([]);
            setCurrentStep(-1);
            setChatMessages([]);
            setBackendRawOutput("");
            setBackendResultText("");
          }}
        >
          New Session (Clear Context)
        </button>

        <label htmlFor="rowsInput">Rows</label>
        <input
          id="rowsInput"
          type="number"
          min="1"
          value={rows}
          onChange={(e) => setRows(Math.max(1, Number(e.target.value) || 1))}
        />

        <label htmlFor="colsInput">Columns</label>
        <input
          id="colsInput"
          type="number"
          min="1"
          value={cols}
          onChange={(e) => setCols(Math.max(1, Number(e.target.value) || 1))}
        />

        <label htmlFor="cellSizeInput">Cell Size (px)</label>
        <input
          id="cellSizeInput"
          type="number"
          min="4"
          max="60"
          value={cellSize}
          onChange={(e) =>
            setCellSize(clamp(Number(e.target.value) || 4, 4, 60))
          }
        />

        <button type="button" onClick={fitToView}>
          Fit To View
        </button>

        <label htmlFor="fileInput">Load TXT Step File</label>
        <input id="fileInput" type="file" accept=".txt" onChange={handleFileChange} />
        <p className="hint">
          Example: <code>(98,57)(8,4);(98,63)(8,4)-5000</code>
        </p>

        <label htmlFor="backendMessageInput">Send Natural Language To Backend (LLM + Move)</label>
        <textarea
          id="backendMessageInput"
          rows={3}
          value={backendMessage}
          onChange={(e) => setBackendMessage(e.target.value)}
          placeholder="示例：现在在(10,12)有一个液滴(6,4)，它向上移动5格"
        />
        <button type="button" onClick={handleGenerateFromBackend} disabled={backendLoading}>
          {backendLoading ? "Generating..." : "Generate Steps (LLM)"}
        </button>

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
            {backendLoading ? (
              <div className="chat-bubble assistant">正在请求 LLM...</div>
            ) : null}
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
      </section>

      <section className="panel stage-panel">
        <div className="status-bar">
          <span>{statusText}</span>
          <span>Scale: {Math.round(scale * 100)}%</span>
          <span className="warning">{warningText}</span>
        </div>
        <div className="canvas-container" ref={canvasContainerRef}>
          <canvas
            ref={canvasRef}
            style={{ transform: `scale(${scale})`, transformOrigin: "0 0" }}
          />
        </div>
      </section>

      <section className="panel steps-panel">
        <h2>Steps</h2>
        <StepList
          steps={steps}
          currentStep={currentStep}
          onSelectStep={(index) => setCurrentStep(index)}
        />
      </section>
    </div>
  );
}
