import React from "react";

export default function StepList({ steps, currentStep, onSelectStep }) {
  if (!steps.length) {
    return <div className="empty-steps">No steps loaded</div>;
  }

  return (
    <div className="step-list" role="listbox" aria-label="Step List">
      {steps.map((step, index) => (
        <button
          key={`${index}-${step.raw}`}
          type="button"
          className={`step-item ${index === currentStep ? "active" : ""}`}
          onClick={() => onSelectStep(index)}
        >
          <span>#{index + 1}</span>
          <span>{step.duration}ms</span>
        </button>
      ))}
    </div>
  );
}
