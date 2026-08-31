#!/usr/bin/env python3
"""Run the first eight missing-parameter cases through the unchanged TXT baseline."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = Path(__file__).resolve().parent
INPUT_FILE = ROOT / "missing-benchmark/missing-sample-english.txt"
BASELINE_FILE = ROOT / "llm_txt_baseline.py"
AUTH_FILE = Path("/Users/dyh/.local/share/opencode/auth.json")
MODEL = "deepseek-v4-flash"
BASE_URL = "https://api.deepseek.com/"
THINKING = "enabled"
TIMEOUT_SECONDS = 240
REPEATS = 5
CASE_COUNT = 8


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_cases() -> list[dict[str, Any]]:
    text = INPUT_FILE.read_text(encoding="utf-8")
    blocks = [block.strip() for block in text.split("\n# ")[1:]]
    parsed: list[dict[str, Any]] = []
    operation_counts: dict[str, int] = {}
    for block in blocks:
        lines = block.splitlines()
        heading = lines[0].strip()
        body = "\n".join(lines[1:])
        if not all(marker in body for marker in (
            "System clarification:", "Turn2:", "Final (ground truth):"
        )):
            continue
        turn1_part, rest = body.split("System clarification:", 1)
        expected_question, rest = rest.split("Turn2:", 1)
        turn2, final = rest.split("Final (ground truth):", 1)
        operation = heading.split(" - case", 1)[0].strip()
        operation_counts[operation] = operation_counts.get(operation, 0) + 1
        operation_index = operation_counts[operation]
        parsed.append({
            "sourceIndex": len(parsed) + 1,
            "heading": heading,
            "operation": operation,
            "operationIndex": operation_index,
            "turn1": turn1_part.replace("Turn1:", "", 1).strip().replace("\n", " "),
            "expectedClarification": expected_question.strip(),
            "turn2": turn2.strip(),
            "finalGroundTruth": final.strip(),
            "expectedStepsFile": str(
                ROOT / "missing-benchmark" / operation / f"{operation}-case{operation_index}.txt"
            ),
        })
    return parsed[:CASE_COUNT]


def load_api_key() -> str:
    payload = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    key = str(payload.get("deepseek", {}).get("key", "")).strip()
    if not key:
        raise RuntimeError("DeepSeek API key is unavailable")
    return key


def invoke(message: str, env: dict[str, str]) -> dict[str, Any]:
    last_error = ""
    for attempt in range(1, 4):
        try:
            process = subprocess.run(
                [str(ROOT / ".venv/bin/python"), str(BASELINE_FILE)],
                input=json.dumps({"message": message}, ensure_ascii=False),
                text=True,
                capture_output=True,
                env=env,
                timeout=TIMEOUT_SECONDS,
                cwd=ROOT,
            )
            if process.returncode == 0:
                return json.loads(process.stdout)
            last_error = process.stderr.strip() or f"baseline exited {process.returncode}"
        except subprocess.TimeoutExpired:
            last_error = f"timeout after {TIMEOUT_SECONDS} seconds"
        except (json.JSONDecodeError, OSError) as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        if attempt < 3:
            time.sleep(attempt * 2)
    raise RuntimeError(last_error)


def normalized_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip()]


def compare_steps(actual: str, expected: str) -> tuple[bool, str]:
    actual_lines = normalized_lines(actual)
    expected_lines = normalized_lines(expected)
    if actual_lines == expected_lines:
        return True, "exact"
    if len(actual_lines) == len(expected_lines) and actual_lines[1:] == expected_lines[1:]:
        return True, "ignore-first-frame"
    return False, "different"


def token_sum(first: dict[str, Any], second: dict[str, Any]) -> dict[str, int]:
    first_usage = first.get("tokenUsage", {})
    second_usage = second.get("tokenUsage", {})
    return {
        name: int(first_usage.get(name, 0)) + int(second_usage.get(name, 0))
        for name in ("inputTokens", "outputTokens", "totalTokens")
    }


def run_session(case: dict[str, Any], repeat: int, env: dict[str, str]) -> tuple[str, str]:
    safe_operation = case["operation"].replace(" ", "-")
    stem = f"{safe_operation}-case{case['operationIndex']}-{repeat}"
    record_path = OUTPUT_DIR / "records" / f"{stem}.json"
    steps_path = OUTPUT_DIR / "steps" / f"{stem}.txt"
    record: dict[str, Any] = {**case, "repeatIndex": repeat, "stem": stem}
    try:
        first = invoke(case["turn1"], env)
        transcript = (
            "Continue this conversation using all information from both user turns.\n"
            f"User Turn 1: {case['turn1']}\n"
            f"Assistant Turn 1: {first.get('assistantReply', '')}\n"
            f"User Turn 2: {case['turn2']}\n"
            "Now complete the requested operation."
        )
        second = invoke(transcript, env)
        expected = Path(case["expectedStepsFile"]).read_text(encoding="utf-8")
        success, match_type = compare_steps(second.get("stepsText", ""), expected)
        detected = (
            not second_or_empty(first.get("stepsText"))
            and bool(str(first.get("assistantReply", "")).strip())
        )
        record.update({
            "ok": True,
            "turn1Result": first,
            "turn2Message": transcript,
            "turn2Result": second,
            "detected": detected,
            "taskSuccess": success,
            "matchType": match_type,
            "actualFrameCount": len(normalized_lines(second.get("stepsText", ""))),
            "expectedFrameCount": len(normalized_lines(expected)),
            "tokenUsageTotal": token_sum(first, second),
        })
        steps_text = str(second.get("stepsText", "")).rstrip()
        steps_path.write_text(steps_text + ("\n" if steps_text else ""), encoding="utf-8")
        state = f"detected={detected} success={success}"
    except Exception as exc:  # noqa: BLE001
        record.update({
            "ok": False,
            "detected": False,
            "taskSuccess": False,
            "error": f"{type(exc).__name__}: {exc}",
        })
        steps_path.write_text("", encoding="utf-8")
        state = f"ERROR {type(exc).__name__}"
    record_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return stem, state


def second_or_empty(value: Any) -> str:
    return str(value or "").strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=20)
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers must be positive")

    (OUTPUT_DIR / "records").mkdir(exist_ok=True)
    (OUTPUT_DIR / "steps").mkdir(exist_ok=True)
    cases = load_cases()
    if len(cases) != CASE_COUNT:
        raise RuntimeError(f"expected {CASE_COUNT} cases, got {len(cases)}")

    env = os.environ.copy()
    env.update({
        "OPENAI_API_KEY": load_api_key(),
        "OPENAI_BASE_URL": BASE_URL,
        "OPENAI_MODEL": MODEL,
        "OPENAI_THINKING": THINKING,
    })
    started_at = datetime.now(timezone.utc).isoformat()
    jobs = [(case, repeat) for case in cases for repeat in range(1, REPEATS + 1)]
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(run_session, case, repeat, env) for case, repeat in jobs]
        for completed, future in enumerate(as_completed(futures), 1):
            stem, state = future.result()
            print(f"[{completed}/{len(jobs)}] {stem} {state}", flush=True)

    manifest = {
        "startedAt": started_at,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "inputFile": str(INPUT_FILE),
        "inputSha256": sha256(INPUT_FILE),
        "baselineFile": str(BASELINE_FILE),
        "baselineSha256": sha256(BASELINE_FILE),
        "model": MODEL,
        "baseUrl": BASE_URL,
        "thinking": THINKING,
        "caseCount": CASE_COUNT,
        "repeats": REPEATS,
        "requestedSessions": len(jobs),
        "requestedCalls": len(jobs) * 2,
        "workers": args.workers,
        "timeoutSeconds": TIMEOUT_SECONDS,
        "conversationMode": "transcript replay through unchanged single-message baseline",
    }
    (OUTPUT_DIR / "run-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
