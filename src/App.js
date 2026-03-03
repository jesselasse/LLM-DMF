import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { parseStepsTxt } from "./features/parseStepsTxt";
import { drawGridAndDroplets } from "./features/drawGridAndDroplets";
import StepList from "./components/StepList";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

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

  const canvasRef = useRef(null);
  const canvasContainerRef = useRef(null);

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

  // Feature 2: parse TXT file
  async function handleFileChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const text = await file.text();
    const parsedSteps = parseStepsTxt(text);
    setSteps(parsedSteps);
    setCurrentStep(parsedSteps.length ? 0 : -1);
  }

  return (
    <div className="app">
      <section className="panel controls-panel">
        <h1>Digital Microfluidics Grid Basics</h1>
        <p className="muted">Only core features are kept in this base project.</p>

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
