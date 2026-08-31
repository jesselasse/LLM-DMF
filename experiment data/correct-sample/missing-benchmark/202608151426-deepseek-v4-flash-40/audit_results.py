#!/usr/bin/env python3
"""Independently audit records, step comparisons, annotations, and paper metrics."""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path
from statistics import mean
from typing import Any


OUTPUT_DIR = Path(__file__).resolve().parent
ROOT = OUTPUT_DIR.parents[1]
RECORDS_DIR = OUTPUT_DIR / "records"
STEPS_DIR = OUTPUT_DIR / "steps"
EXPECTED_BASELINE_SHA = "3b89b1090c4069fad0b1714c7ec1e0473394f3f3a129d58c621f85c1b3c8eee8"
EXPECTED_INPUT_SHA = "0ceb18480ae8638b1a64a22805b53c8b419dfa69cfa79bd116e30a6c545158c7"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def compare(actual: str, expected: str) -> tuple[bool, str]:
    actual_lines = lines(actual)
    expected_lines = lines(expected)
    if actual_lines == expected_lines:
        return True, "exact"
    if len(actual_lines) == len(expected_lines) and actual_lines[1:] == expected_lines[1:]:
        return True, "ignore-first-frame"
    return False, "different"


def percent(numerator: int, denominator: int) -> float:
    return round(100.0 * numerator / denominator, 1) if denominator else 0.0


def main() -> int:
    record_paths = sorted(RECORDS_DIR.glob("*.json"))
    step_paths = sorted(STEPS_DIR.glob("*.txt"))
    if len(record_paths) != 40 or len(step_paths) != 40:
        raise RuntimeError(f"expected 40 records and steps, got {len(record_paths)} and {len(step_paths)}")

    labels: dict[str, dict[str, str]] = {}
    with (OUTPUT_DIR / "clarification-review.csv").open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            labels[row["stem"]] = row

    records = [json.loads(path.read_text(encoding="utf-8")) for path in record_paths]
    if not all(record.get("ok") is True for record in records):
        raise RuntimeError("one or more sessions are not ok")
    if {record["turn1Result"]["model"] for record in records} != {"deepseek-v4-flash"}:
        raise RuntimeError("unexpected turn-1 model")
    if {record["turn2Result"]["model"] for record in records} != {"deepseek-v4-flash"}:
        raise RuntimeError("unexpected turn-2 model")
    if {record["turn1Result"]["thinking"] for record in records} != {"enabled"}:
        raise RuntimeError("unexpected turn-1 thinking mode")
    if {record["turn2Result"]["thinking"] for record in records} != {"enabled"}:
        raise RuntimeError("unexpected turn-2 thinking mode")

    detected_stems = {record["stem"] for record in records if record["detected"]}
    if detected_stems != set(labels):
        raise RuntimeError("clarification review rows do not exactly match detected sessions")

    result_rows: list[dict[str, Any]] = []
    comparison_disagreements = 0
    storage_disagreements = 0
    for record in records:
        expected_text = Path(record["expectedStepsFile"]).read_text(encoding="utf-8")
        step_path = STEPS_DIR / f"{record['stem']}.txt"
        stored_steps = step_path.read_text(encoding="utf-8")
        returned_steps = str(record["turn2Result"].get("stepsText", ""))
        if stored_steps.rstrip() != returned_steps.rstrip():
            storage_disagreements += 1
        success, match_type = compare(stored_steps, expected_text)
        if success != record["taskSuccess"] or match_type != record["matchType"]:
            comparison_disagreements += 1
        label = labels.get(record["stem"])
        clarification_correct = (
            label["clarificationCorrect"].lower() == "true" if label else None
        )
        result_rows.append({
            "stem": record["stem"],
            "operation": record["operation"],
            "case": record["operationIndex"],
            "repeat": record["repeatIndex"],
            "detected": record["detected"],
            "clarificationCorrect": "" if clarification_correct is None else clarification_correct,
            "taskSuccess": success,
            "matchType": match_type,
            "actualFrames": len(lines(stored_steps)),
            "expectedFrames": len(lines(expected_text)),
            "inputTokens": record["tokenUsageTotal"]["inputTokens"],
            "outputTokens": record["tokenUsageTotal"]["outputTokens"],
            "totalTokens": record["tokenUsageTotal"]["totalTokens"],
            "clarificationReviewReason": label["reviewReason"] if label else "",
        })
    if storage_disagreements or comparison_disagreements:
        raise RuntimeError(
            f"storage disagreements={storage_disagreements}, comparison disagreements={comparison_disagreements}"
        )

    with (OUTPUT_DIR / "results.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(result_rows[0]))
        writer.writeheader()
        writer.writerows(result_rows)

    operations = ["squeeze", "merge", "mix", "move"]
    summary_rows: list[dict[str, Any]] = []
    for operation in operations + ["overall"]:
        rows = result_rows if operation == "overall" else [
            row for row in result_rows if row["operation"] == operation
        ]
        detected = sum(bool(row["detected"]) for row in rows)
        clarification_correct = sum(row["clarificationCorrect"] is True for row in rows)
        successes = sum(bool(row["taskSuccess"]) for row in rows)
        summary_rows.append({
            "operation": operation,
            "sessions": len(rows),
            "detected": detected,
            "detectionRatePct": percent(detected, len(rows)),
            "correctClarifications": clarification_correct,
            "clarificationAccuracyPct": percent(clarification_correct, detected),
            "taskSuccesses": successes,
            "taskSuccessPct": percent(successes, len(rows)),
            "tokenSum": sum(int(row["totalTokens"]) for row in rows),
            "tokenAverage": round(mean(int(row["totalTokens"]) for row in rows)),
        })
    with (OUTPUT_DIR / "summary.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(summary_rows[0]))
        writer.writeheader()
        writer.writerows(summary_rows)

    overall = summary_rows[-1]
    run_summary = {
        "records": len(records),
        "stepFiles": len(step_paths),
        "emptyStepFiles": sum(path.stat().st_size == 0 for path in step_paths),
        "model": "deepseek-v4-flash",
        "thinking": "enabled",
        "baselineSha256": sha256(ROOT / "llm_txt_baseline.py"),
        "inputSha256": sha256(ROOT / "missing-benchmark/missing-sample-english.txt"),
        "hashesMatchRecordedInputs": (
            sha256(ROOT / "llm_txt_baseline.py") == EXPECTED_BASELINE_SHA
            and sha256(ROOT / "missing-benchmark/missing-sample-english.txt") == EXPECTED_INPUT_SHA
        ),
        "comparisonDisagreements": comparison_disagreements,
        "storedVsReturnedStepDisagreements": storage_disagreements,
        "detectionRatePct": overall["detectionRatePct"],
        "clarificationAccuracyPct": overall["clarificationAccuracyPct"],
        "clarificationAccuracyDenominator": "detected sessions",
        "taskSuccessPct": overall["taskSuccessPct"],
        "tokenSum": overall["tokenSum"],
        "tokenAveragePerTwoTurnSession": overall["tokenAverage"],
        "conversationMode": "transcript replay through unchanged single-message baseline",
    }
    (OUTPUT_DIR / "run-summary.json").write_text(
        json.dumps(run_summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    latex = rf"""\begin{{table}}[t]
\centering
\caption{{Interactive clarification evaluation on 8 missing-parameter cases (2 per
operation), compared against a no-clarification baseline.}}
\label{{tab:clarification}}
\begin{{tabular}}{{lccc}}
\toprule
Condition & Detection Rate (\%) & Clarification Acc. (\%) & Task Success (\%) \\
\midrule
Full System (w/ clarification) & 100.0 & 100.0 & 92.5 \\
No-Clarification Baseline      & {overall['detectionRatePct']:.1f} & {overall['clarificationAccuracyPct']:.1f} & {overall['taskSuccessPct']:.1f} \\
\bottomrule
\end{{tabular}}
\end{{table}}
"""
    (OUTPUT_DIR / "table-clarification.tex").write_text(latex, encoding="utf-8")

    audit = f"""# Missing-parameter baseline audit

- Sessions: {len(records)} = 8 cases × 5 repeats
- Calls: 80 = 2 calls per session
- Model: deepseek-v4-flash
- Thinking: enabled
- Timeout: 240 seconds per call
- Conversation mode: transcript replay through the unchanged single-message baseline
- Detection: {overall['detected']}/{len(records)} = {overall['detectionRatePct']:.1f}%
- Strict clarification accuracy: {overall['correctClarifications']}/{overall['detected']} detected sessions = {overall['clarificationAccuracyPct']:.1f}%
- Task success: {overall['taskSuccesses']}/{len(records)} = {overall['taskSuccessPct']:.1f}%
- Exact step matches: {sum(row['matchType'] == 'exact' for row in result_rows)}
- First-frame-ignored matches: {sum(row['matchType'] == 'ignore-first-frame' for row in result_rows)}
- Empty final step files: {sum(path.stat().st_size == 0 for path in step_paths)}; counted as task failures
- Token total: {overall['tokenSum']}; average per two-turn session: {overall['tokenAverage']}
- Stored/returned step disagreements: {storage_disagreements}
- Independent comparison disagreements: {comparison_disagreements}
- Baseline SHA-256: {run_summary['baselineSha256']}
- Input SHA-256: {run_summary['inputSha256']}

Clarification accuracy is conditional on detection. A clarification is correct only when it
requests the intentionally removed parameter without rejecting a valid case or requiring
unnecessary extra parameters. Manual decisions and reasons are in clarification-review.csv.

Important limitation: llm_txt_baseline.py accepts one HumanMessage and has no persistent chat
history. Turn 2 therefore replays Turn 1, the model's actual Turn-1 reply, and Turn 2 inside one
message. This is not a native role-preserving multi-turn conversation.
"""
    (OUTPUT_DIR / "audit-report.md").write_text(audit, encoding="utf-8")
    print(json.dumps(run_summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
