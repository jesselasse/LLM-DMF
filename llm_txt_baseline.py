"""Standalone LLM TXT baseline for DMF sequence generation.

This intentionally does not import the application backend or SequenceWorkspace.
Input is one JSON object on stdin: {"message": "..."}.
Output is one JSON object containing the model-generated ``stepsText``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field


class TxtSequenceOutput(BaseModel):
    stepsText: str = Field(
        description=(
            "The complete DMF activation sequence as plain TXT. One frame per line; "
            "each rectangle is (x,y)(w,h), rectangles are separated by semicolons, "
            "and each line ends with -durationMs."
        )
    )
    assistantReply: str = Field(description="A concise Chinese description of the generated result.")


@tool("emit_txt_sequence", args_schema=TxtSequenceOutput)
def emit_txt_sequence(stepsText: str, assistantReply: str) -> Dict[str, str]:
    """Return the final TXT sequence selected by the model."""
    return {"stepsText": stepsText, "assistantReply": assistantReply}


SYSTEM_PROMPT = """You are a standalone DMF activation-sequence baseline.
Generate the requested droplet operation directly as TXT. Do not call or assume any
external workspace, application API, deterministic backend, or hidden state.

Output format:
- One activation frame per line, in chronological order.
- A rectangle is written as (x,y)(w,h), with integer x/y coordinates and positive integer w/h.
- Multiple rectangles on one frame are separated by semicolons.
- Every line ends with -duration in milliseconds, normally -1000 unless the user explicitly
  requests another duration.
- Example: (1,0)(2,1)-1000\n(0,0)(1,1);(2,0)(1,1)-1000
- Do not output markdown fences, explanations, JSON, or blank lines in stepsText.

Use the user's stated initial positions and dimensions. Movement changes positions one grid
cell per frame. A split replaces one droplet with two equal-area halves moved apart along the
long side; the long side must be even, and a square may use either axis. If required information
is missing or geometrically impossible, ask a concise Chinese clarification in assistantReply and
leave stepsText empty. Decide sufficiency and all operation details yourself.

You must finish by calling emit_txt_sequence exactly once. The tool arguments are the final answer.
"""


def _runtime_model_options() -> Dict[str, Any]:
    thinking_mode = os.getenv("OPENAI_THINKING_MODE", "").strip()
    if thinking_mode in {"enabled", "disabled"}:
        return {"extra_body": {"thinking": {"type": thinking_mode}}}
    return {}


def _token_usage(message: Any) -> Dict[str, Any]:
    usage = getattr(message, "usage_metadata", None)
    if not isinstance(usage, dict):
        metadata = getattr(message, "response_metadata", None)
        usage = metadata.get("token_usage", {}) if isinstance(metadata, dict) else {}
    if not isinstance(usage, dict):
        usage = {}

    def integer(*names: str) -> int:
        for name in names:
            value = usage.get(name)
            if isinstance(value, (int, float)) and value >= 0:
                return int(value)
        return 0

    input_tokens = integer("input_tokens", "prompt_tokens")
    output_tokens = integer("output_tokens", "completion_tokens")
    return {
        "available": bool(usage),
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": integer("total_tokens") or input_tokens + output_tokens,
    }


def generate(message: str) -> Dict[str, Any]:
    base_url = os.getenv("OPENAI_BASE_URL")
    api_key = os.getenv("OPENAI_API_KEY")
    if not base_url or not api_key:
        raise RuntimeError("OPENAI_BASE_URL and OPENAI_API_KEY are required")
    model = os.getenv("OPENAI_MODEL") or "gpt-5.4"
    llm = ChatOpenAI(
        model=model,
        api_key=api_key,
        base_url=base_url,
        **_runtime_model_options(),
    )
    response = llm.bind_tools([emit_txt_sequence]).invoke(
        [SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=message.strip())]
    )
    calls = getattr(response, "tool_calls", None) or []
    if len(calls) != 1 or calls[0].get("name") != "emit_txt_sequence":
        raise RuntimeError("model did not return the required TXT sequence tool call")
    args = calls[0].get("args") or {}
    result = emit_txt_sequence.invoke(args)
    return {**result, "tokenUsage": _token_usage(response), "model": model}


def _single_request(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("stdin JSON must be an object")
    message = str(payload.get("message") or "").strip()
    if not message:
        raise ValueError("message is required")
    return generate(message)


def _file_requests(path: Path) -> list[Dict[str, Any]]:
    section = "unsectioned"
    section_index = 0
    results = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        message = raw_line.strip()
        if not message:
            continue
        if message.startswith("#"):
            section = message[1:].strip() or "unsectioned"
            section_index = 0
            continue
        section_index += 1
        try:
            result = generate(message)
            results.append({
                "section": section,
                "index": section_index,
                "message": message,
                "ok": True,
                "result": result,
            })
        except Exception as exc:  # noqa: BLE001
            results.append({
                "section": section,
                "index": section_index,
                "message": message,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            })
    return {"inputFile": str(path), "results": results}


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate direct TXT DMF baseline outputs.")
    parser.add_argument(
        "--input-file",
        type=Path,
        help="A UTF-8 prompt file; headings beginning with # group individual prompts.",
    )
    args = parser.parse_args()
    try:
        if args.input_file:
            output = _file_requests(args.input_file)
            exit_code = 1 if any(not item["ok"] for item in output["results"]) else 0
        else:
            output = _single_request(json.load(sys.stdin))
            exit_code = 0
    except (json.JSONDecodeError, ValueError, RuntimeError) as exc:
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        return 2
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"{type(exc).__name__}: {exc}\n")
        return 1
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
