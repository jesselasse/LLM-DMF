import React, { useEffect, useRef } from "react";

export default function StepList({ steps, currentStep, onSelectStep, compact = false }) {
  const listRef = useRef(null);

  useEffect(() => {
    if (!listRef.current || currentStep < 0) return;
    const activeItem = listRef.current.querySelector(".step-item.active");
    if (!activeItem) return;
    activeItem.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentStep, steps.length]);

  if (!steps.length) {
    return <div className="empty-steps">No steps loaded</div>;
  }

  return (
    <div
      ref={listRef}
      className={`step-list ${compact ? "compact" : ""}`}
      role="listbox"
      aria-label="Step List"
    >
      {steps.map((step, index) => (
        <button
          key={`${index}-${step.raw}`}
          type="button"
          className={`step-item ${compact ? "compact" : ""} ${
            index === currentStep ? "active" : ""
          }`}
          onClick={() => onSelectStep(index)}
          title={compact ? `Step ${index + 1}` : undefined}
        >
          {compact ? (
            <span>{index + 1}</span>
          ) : (
            <>
              <span>#{index + 1}</span>
              <span>{step.duration}ms</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
