"""Replay recorded tool calls with the project's authoritative DMF operations."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, List, Tuple

SERVER_ROOT = Path(__file__).resolve().parents[1] / "server"
sys.path.insert(0, str(SERVER_ROOT))

from move_backend import (  # noqa: E402
    GenerateDropletArray,
    Merge,
    Move,
    RotateMix,
    Squeeze,
    SplitToArray,
    merge_sequences_by_step,
    normalize_droplets_input,
)

Rect = Tuple[int, int, int, int]


def _rect_key(rect: Rect) -> str:
    return ",".join(str(value) for value in rect)


def _size(value: Any) -> Tuple[int, int]:
    if isinstance(value, int):
        return value, value
    if isinstance(value, (list, tuple)) and len(value) == 2:
        return int(value[0]), int(value[1])
    parts = re.split(r"[x×*]", str(value or "").strip().lower())
    if len(parts) != 2:
        raise ValueError("size must be written as width x height")
    return int(parts[0]), int(parts[1])


def _resolved(call: dict[str, Any]) -> List[Rect]:
    resolved = call.get("resolvedDroplets")
    if isinstance(resolved, list) and resolved:
        return normalize_droplets_input(resolved)
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    droplets = args.get("droplets")
    if isinstance(droplets, list) and droplets:
        return normalize_droplets_input(droplets)
    if all(args.get(key) is not None for key in ("x", "y")):
        if args.get("w") is not None and args.get("h") is not None:
            w, h = int(args["w"]), int(args["h"])
        else:
            w, h = _size(args.get("size"))
        return [(int(args["x"]), int(args["y"]), w, h)]
    raise ValueError("recorded call does not contain resolved droplet geometry")


def _squeeze_outputs(generated: list[Any], source: Rect, count: int, direction: str) -> List[Rect]:
    if not generated:
        return []
    x, y, w, h = source
    key = str(direction or "").strip().lower()
    aliases = {
        "right": "right", "r": "right", "east": "right", "右": "right",
        "left": "left", "l": "left", "west": "left", "左": "left",
        "up": "up", "u": "up", "north": "up", "上": "up",
        "down": "down", "d": "down", "south": "down", "下": "down",
    }
    normalized_direction = aliases.get(key)
    if normalized_direction is None:
        raise ValueError(f"unsupported squeeze direction: {direction}")
    candidates = []
    for value in generated[-1][1]:
        rect = tuple(int(item) for item in value)
        rx, ry, rw, rh = rect
        if (rw, rh) != (w, h):
            continue
        ahead = {
            "right": rx > x,
            "left": rx < x,
            "up": ry < y,
            "down": ry > y,
        }[normalized_direction]
        if ahead:
            candidates.append(rect)
    if len(candidates) != count:
        raise ValueError(
            f"squeeze output detection expected {count} droplets, found {len(candidates)}"
        )
    return candidates


def replay_with_outputs(calls: list[dict[str, Any]]) -> tuple[list[Any], List[Rect]]:
    sequence: list[Any] = []
    squeeze_sequences: list[Any] = []
    sequence_tool_names: list[str] = []
    live_outputs: dict[str, Rect] = {}
    for call in calls:
        tool = str(call.get("tool") or "")
        args = call.get("args") if isinstance(call.get("args"), dict) else {}
        if tool == "generate_array":
            generated_outputs = GenerateDropletArray(
                int(args["count"]) if args.get("count") is not None else None,
                int(args["x"]), int(args["y"]), int(args["w"]), int(args["h"]),
                int(args["gap"]) if args.get("gap") is not None else None,
                rows=int(args["rows"]) if args.get("rows") is not None else None,
                columns=int(args["columns"]) if args.get("columns") is not None else None,
                gap_x=int(args["gapX"]) if args.get("gapX") is not None else None,
                gap_y=int(args["gapY"]) if args.get("gapY") is not None else None,
            )
            resolved_inputs: List[Rect] = []
            generated = []
        elif tool == "initialize_droplets":
            resolved_inputs = _resolved(call)
            generated = [(0, resolved_inputs)]
            sequence.extend(generated)
            generated_outputs = resolved_inputs
        elif tool == "squeeze":
            resolved_inputs = _resolved(call)
            generated = Squeeze(resolved_inputs, int(args["count"]), args["direction"])
            squeeze_sequences.append(generated)
            generated_outputs = _squeeze_outputs(
                generated, resolved_inputs[0], int(args["count"]), args["direction"]
            )
        elif tool == "move":
            resolved_inputs = _resolved(call)
            generated = Move(resolved_inputs, args["direction"], int(args["t"]))
            sequence.extend(generated)
            generated_outputs = list(generated[-1][1]) if generated else resolved_inputs
        elif tool == "rotate_mix":
            resolved_inputs = _resolved(call)
            generated = RotateMix(resolved_inputs, int(args["cycles"]))
            sequence.extend(generated)
            generated_outputs = list(generated[-1][1]) if generated else resolved_inputs
        elif tool == "split_to_array":
            resolved_inputs = [(
                int(args["x"]), int(args["y"]),
                int(args["childW"]) * int(args["columns"]),
                int(args["childH"]) * int(args["rows"]),
            )]
            generated = SplitToArray(
                int(args["x"]), int(args["y"]),
                int(args["childW"]),
                int(args["childH"]),
                int(args["columns"]),
                int(args["rows"]),
                int(args["gapX"]),
                int(args["gapY"]),
            )
            sequence.extend(generated)
            generated_outputs = list(generated[-1][1]) if generated else []
        elif tool == "merge":
            resolved_inputs = _resolved(call)
            if len(resolved_inputs) < 2 or len(resolved_inputs) % 2:
                raise ValueError("merge replay requires two equally sized resolved arrays")
            midpoint = len(resolved_inputs) // 2
            generated = Merge(resolved_inputs[:midpoint], resolved_inputs[midpoint:])
            sequence.extend(generated)
            generated_outputs = list(generated[-1][1]) if generated else []
        else:
            raise ValueError(f"unsupported project tool: {tool}")
        for rect in resolved_inputs:
            live_outputs.pop(_rect_key(rect), None)
        for value in generated_outputs:
            rect = tuple(int(item) for item in value)
            live_outputs[_rect_key(rect)] = rect
        sequence_tool_names.append(tool)

    if squeeze_sequences:
        combined = merge_sequences_by_step(squeeze_sequences)
        if sequence_tool_names and all(name == "squeeze" for name in sequence_tool_names):
            sequence = combined
        else:
            sequence.extend(combined)
    return sequence, list(live_outputs.values())


def replay(calls: list[dict[str, Any]]) -> list[Any]:
    return replay_with_outputs(calls)[0]


def main() -> int:
    payload = json.load(sys.stdin)
    calls = payload.get("calls") if isinstance(payload, dict) else None
    if not isinstance(calls, list):
        raise ValueError("calls must be a list")
    sequence, outputs = replay_with_outputs(calls)
    print(json.dumps({"sequence": sequence, "outputs": outputs}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        raise SystemExit(1)
