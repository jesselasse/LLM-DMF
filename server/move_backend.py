"""
Backend helpers for moving one droplet step-by-step.

This module follows the same activation-sequence shape used in Acxel_format.py:
    activation_sequence = [(time_step, [(x, y, w, h), ...]), ...]

For Move(), each time_step contains exactly one moved droplet rectangle.
"""

from __future__ import annotations

import math
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Tuple, Union

from Acxel_format import (
    rotate_sequence_90,
    scale_activation_sequence_xy,
    translate_sequence,
)

Rect = Tuple[int, int, int, int]
ActivationSequence = List[Tuple[int, List[Rect]]]


_DIRECTION_DELTAS: Dict[str, Tuple[int, int]] = {
    "up": (0, -1),
    "down": (0, 1),
    "left": (-1, 0),
    "right": (1, 0),
    # aliases
    "u": (0, -1),
    "d": (0, 1),
    "l": (-1, 0),
    "r": (1, 0),
    "north": (0, -1),
    "south": (0, 1),
    "west": (-1, 0),
    "east": (1, 0),
    # Chinese aliases
    "上": (0, -1),
    "下": (0, 1),
    "左": (-1, 0),
    "右": (1, 0),
}

_DIRECTION_TO_ROTATION: Dict[str, int] = {
    # Template orientation is opposite to UI semantics, so squeeze directions
    # are intentionally flipped here: up<->down, left<->right.
    "right": 180,
    "r": 180,
    "east": 180,
    "右": 180,
    "down": 270,
    "d": 270,
    "south": 270,
    "下": 270,
    "left": 0,
    "l": 0,
    "west": 0,
    "左": 0,
    "up": 90,
    "u": 90,
    "north": 90,
    "上": 90,
}

_RECT_PATTERN = re.compile(
    r"\(([-+]?\d+)\s*,\s*([-+]?\d+)\)\s*\(([-+]?\d+)\s*,\s*([-+]?\d+)\)"
)


def _normalize_direction(direction: str) -> Tuple[int, int]:
    if not isinstance(direction, str):
        raise TypeError("direction must be a string.")
    key = direction.strip().lower()
    if key not in _DIRECTION_DELTAS:
        raise ValueError(
            f"Unsupported direction '{direction}'. Use up/down/left/right."
        )
    return _DIRECTION_DELTAS[key]


def _normalize_rotation_deg(direction_or_deg: Union[str, int]) -> int:
    if isinstance(direction_or_deg, int):
        return direction_or_deg % 360
    if not isinstance(direction_or_deg, str):
        raise TypeError("direction must be str or int rotation degree.")
    key = direction_or_deg.strip().lower()
    if key not in _DIRECTION_TO_ROTATION:
        raise ValueError(
            f"Unsupported direction '{direction_or_deg}'. Use up/down/left/right."
        )
    return _DIRECTION_TO_ROTATION[key] % 360


def _parse_size(size: Union[int, str, Tuple[int, int], List[int]]) -> Tuple[int, int]:
    if isinstance(size, int):
        sx, sy = size, size
    elif isinstance(size, (tuple, list)):
        if len(size) != 2:
            raise ValueError("size tuple/list must be length 2, e.g. (3, 2).")
        sx, sy = int(size[0]), int(size[1])
    elif isinstance(size, str):
        raw = size.strip().lower().replace("x", "*")
        if "*" in raw:
            parts = [p.strip() for p in raw.split("*") if p.strip()]
            if len(parts) != 2:
                raise ValueError(
                    "size string must be like '3*2' or '3x2' or single '2'."
                )
            sx, sy = int(parts[0]), int(parts[1])
        else:
            v = int(raw)
            sx, sy = v, v
    else:
        raise TypeError("size must be int | str | tuple/list of 2 ints.")

    if sx <= 0 or sy <= 0:
        raise ValueError(f"size factors must be >=1, got sx={sx}, sy={sy}.")
    return sx, sy


def _validate_rect(rect: Rect) -> None:
    if not isinstance(rect, (tuple, list)) or len(rect) != 4:
        raise ValueError("droplet must be (x, y, w, h).")
    x, y, w, h = rect
    if not all(isinstance(v, int) for v in (x, y, w, h)):
        raise ValueError("x, y, w, h must all be int.")
    if w <= 0 or h <= 0:
        raise ValueError(f"w and h must be > 0, got w={w}, h={h}.")


def _coerce_rect(value: Any) -> Rect:
    if isinstance(value, dict):
        try:
            rect = (
                int(value["x"]),
                int(value["y"]),
                int(value["w"]),
                int(value["h"]),
            )
        except KeyError as exc:
            raise ValueError(f"droplet dict is missing key: {exc.args[0]}") from exc
    elif all(hasattr(value, name) for name in ("x", "y", "w", "h")):
        rect = (int(value.x), int(value.y), int(value.w), int(value.h))
    elif isinstance(value, (tuple, list)) and len(value) == 4:
        rect = (int(value[0]), int(value[1]), int(value[2]), int(value[3]))
    else:
        raise ValueError("droplet must be (x, y, w, h) or a dict with x/y/w/h.")

    _validate_rect(rect)
    return rect


def normalize_droplets_input(values: Any) -> List[Rect]:
    if not isinstance(values, list) or not values:
        raise ValueError("droplets must be a non-empty list of droplets.")
    return [_coerce_rect(value) for value in values]


def merge_sequences_by_step(sequences: List[ActivationSequence]) -> ActivationSequence:
    if not sequences:
        return []

    max_len = max(len(sequence) for sequence in sequences)
    merged: ActivationSequence = []
    for step_idx in range(max_len):
        merged_rects: List[Rect] = []
        for sequence in sequences:
            if step_idx >= len(sequence):
                continue
            _, rects = sequence[step_idx]
            merged_rects.extend(rects)
        merged.append((step_idx, merged_rects))
    return merged


@lru_cache(maxsize=1)
def _load_squeezing_template() -> ActivationSequence:
    template_path = Path(__file__).with_name("SqueezingPath.txt")
    if not template_path.exists():
        raise FileNotFoundError(f"Squeezing template not found: {template_path}")

    sequence: ActivationSequence = []
    with template_path.open("r", encoding="utf-8") as f:
        for idx, line in enumerate(f):
            text = line.strip()
            if not text:
                sequence.append((idx, []))
                continue
            rects: List[Rect] = []
            for m in _RECT_PATTERN.finditer(text):
                x = int(m.group(1))
                y = int(m.group(2))
                w = int(m.group(3))
                h = int(m.group(4))
                rects.append((x, y, w, h))
            sequence.append((idx, rects))
    return sequence


def Move(
    droplet: Rect,
    direction: str,
    t: int,
    *,
    start_cycle: int = 0,
) -> ActivationSequence:
    """
    Move one droplet by one grid per step and return t activation steps.

    Args:
        droplet: (x, y, w, h)
        direction: one of up/down/left/right (also supports aliases)
        t: number of steps (>= 0)
        start_cycle: first cycle index in returned sequence

    Returns:
        activation_sequence:
            [
              (start_cycle + 0, [(x1, y1, w, h)]),
              (start_cycle + 1, [(x2, y2, w, h)]),
              ...
            ]
        where each step moves by exactly one grid cell from previous step.
    """
    _validate_rect(droplet)
    if not isinstance(t, int):
        raise TypeError("t must be int.")
    if t < 0:
        raise ValueError("t must be >= 0.")
    if not isinstance(start_cycle, int):
        raise TypeError("start_cycle must be int.")

    dx, dy = _normalize_direction(direction)
    x0, y0, w, h = droplet

    sequence: ActivationSequence = []
    for step in range(1, t + 1):
        moved_rect: Rect = (x0 + dx * step, y0 + dy * step, w, h)
        sequence.append((start_cycle + step - 1, [moved_rect]))

    return sequence


def MoveDroplets(
    droplets: List[Rect],
    direction: str,
    t: int,
    *,
    start_cycle: int = 0,
) -> ActivationSequence:
    normalized = normalize_droplets_input(droplets)
    sequences = [
        Move(droplet, direction, t, start_cycle=start_cycle) for droplet in normalized
    ]
    return merge_sequences_by_step(sequences)


def activation_sequence_to_txt(activation_sequence: ActivationSequence) -> str:
    """
    Convert activation_sequence to Acxel-like txt lines:
        (x,y)(w,h);...-1000
    """
    lines: List[str] = []
    for _, activations in activation_sequence:
        if not activations:
            lines.append("-1000")
            continue
        parts = [f"({x},{y})({w},{h})" for x, y, w, h in activations]
        lines.append(";".join(parts) + "-1000")
    return "\n".join(lines)


def Move_as_txt(
    droplet: Rect,
    direction: str,
    t: int,
    *,
    start_cycle: int = 0,
) -> str:
    """
    Convenience wrapper:
    - generate t activation steps with Move()
    - serialize to txt format for frontend playback
    """
    sequence = Move(droplet, direction, t, start_cycle=start_cycle)
    return activation_sequence_to_txt(sequence)


def MoveDroplets_as_txt(
    droplets: List[Rect],
    direction: str,
    t: int,
    *,
    start_cycle: int = 0,
) -> str:
    return activation_sequence_to_txt(
        MoveDroplets(droplets, direction, t, start_cycle=start_cycle)
    )


def Squeeze(
    count: int,
    px: int,
    py: int,
    direction: Union[str, int],
    size: Union[int, str, Tuple[int, int], List[int]] = 1,
) -> ActivationSequence:
    """
    Generate squeezing sequence from template with truncation and transform.

    Rules:
      - count=1 -> first 6 steps
      - count=2 -> first 11 steps
      - each extra droplet adds +5 steps
      - rotate by direction, then translate by (px, py)
      - finally apply global offset (-47, -33)
      - support droplet size scaling:
          * supports uniform size (e.g. 2) and non-uniform size (e.g. 3*2)
          * translate in base grid with (px/sx, py/sy)
          * then scale the whole sequence by (sx, sy)
    """
    if not isinstance(count, int):
        raise TypeError("count must be int.")
    if count <= 0:
        raise ValueError("count must be >= 1.")
    if not isinstance(px, int) or not isinstance(py, int):
        raise TypeError("px/py must be int.")
    sx, sy = _parse_size(size)

    template = _load_squeezing_template()
    step_limit = 6 + (count - 1) * 5
    step_limit = max(1, min(step_limit, len(template)))

    if px % sx != 0 or py % sy != 0:
        raise ValueError(
            "px/py must be divisible by size factors. "
            f"got px={px}, py={py}, size=({sx},{sy})."
        )

    base_px = px // sx
    base_py = py // sy

    temp_sequence = template[:step_limit]
    temp_sequence = translate_sequence(temp_sequence, -47, -33)
    rotation_deg = _normalize_rotation_deg(direction)
    temp_sequence = rotate_sequence_90(temp_sequence, rotation_deg, center=(0, 1))
    temp_sequence = translate_sequence(temp_sequence, base_px, base_py)
    final_sequence = scale_activation_sequence_xy(temp_sequence, sx, sy)
    return final_sequence


def Squeeze_as_txt(
    count: int,
    px: int,
    py: int,
    direction: Union[str, int],
    size: Union[int, str, Tuple[int, int], List[int]] = 1,
) -> str:
    return activation_sequence_to_txt(Squeeze(count, px, py, direction, size=size))


def RotateMix(
    x: int,
    y: int,
    duration: int,
    size: Union[int, str, Tuple[int, int], List[int]] = (1, 2),
    *,
    start_cycle: int = 0,
) -> ActivationSequence:
    """
    Generate a circulation loop by composing stepwise Move() segments.

    The droplet starts at (x, y) with size (sx, sy). One full round is:
      - move down by sy cells
      - move right by sx cells
      - move up by sy cells
      - move left by sx cells
    This returns the droplet to its starting position.
    """
    if not isinstance(x, int) or not isinstance(y, int):
        raise TypeError("x/y must be int.")
    if not isinstance(duration, int):
        raise TypeError("duration must be int.")
    if duration <= 0:
        raise ValueError("duration must be >= 1.")
    if not isinstance(start_cycle, int):
        raise TypeError("start_cycle must be int.")

    sx, sy = _parse_size(size)
    current_rect: Rect = (x, y, sx, sy)
    cycle_idx = start_cycle
    sequence: ActivationSequence = []

    segments = [
        ("down", sy),
        ("right", sx),
        ("up", sy),
        ("left", sx),
    ]

    for _ in range(duration):
        for direction, steps in segments:
            if steps <= 0:
                continue
            segment = Move(current_rect, direction, steps, start_cycle=cycle_idx)
            sequence.extend(segment)
            current_rect = segment[-1][1][0]
            cycle_idx += len(segment)

    return sequence


def RotateMixDroplets(
    droplets: List[Rect],
    duration: int,
    *,
    start_cycle: int = 0,
) -> ActivationSequence:
    normalized = normalize_droplets_input(droplets)
    sequences = [
        RotateMix(x, y, duration, size=(w, h), start_cycle=start_cycle)
        for x, y, w, h in normalized
    ]
    return merge_sequences_by_step(sequences)


def RotateMix_as_txt(
    x: int,
    y: int,
    duration: int,
    size: Union[int, str, Tuple[int, int], List[int]] = (1, 2),
    *,
    start_cycle: int = 0,
) -> str:
    return activation_sequence_to_txt(
        RotateMix(x, y, duration, size=size, start_cycle=start_cycle)
    )


def RotateMixDroplets_as_txt(
    droplets: List[Rect],
    duration: int,
    *,
    start_cycle: int = 0,
) -> str:
    return activation_sequence_to_txt(
        RotateMixDroplets(droplets, duration, start_cycle=start_cycle)
    )


def RotateMixArrayDroplets(
    count: int,
    duration: int,
    size: Union[int, str, Tuple[int, int], List[int]] = (1, 2),
    *,
    gap: int = 4,
    origin_x: int = 0,
    origin_y: int = 0,
) -> List[Rect]:
    if not isinstance(count, int):
        raise TypeError("count must be int.")
    if count <= 0:
        raise ValueError("count must be >= 1.")
    if not isinstance(gap, int):
        raise TypeError("gap must be int.")
    if gap < 0:
        raise ValueError("gap must be >= 0.")
    if not isinstance(origin_x, int) or not isinstance(origin_y, int):
        raise TypeError("origin_x/origin_y must be int.")

    sx, sy = _parse_size(size)
    module = RotateMixModule(duration, size=(sx, sy))
    bounds = module["bounds"]
    module_width = int(bounds["width"])
    module_height = int(bounds["height"])

    array_cols = int(math.ceil(math.sqrt(count)))
    array_rows = int(math.ceil(count / array_cols))
    positions = ArrayModulePositions(
        module_width,
        module_height,
        array_rows,
        array_cols,
        gap,
        gap,
        origin_x=origin_x,
        origin_y=origin_y,
    )[:count]
    return [(px, py, sx, sy) for px, py in positions]


def RotateMixModule(
    duration: int,
    size: Union[int, str, Tuple[int, int], List[int]] = (1, 2),
    *,
    start_cycle: int = 0,
) -> Dict[str, Any]:
    """Return a rotate-mix module anchored at (0, 0) with its bounds metadata."""
    sequence = RotateMix(0, 0, duration, size=size, start_cycle=start_cycle)
    min_x, min_y, width, height = ModuleBounds(sequence)
    return {
        "sequence": sequence,
        "bounds": {
            "min_x": min_x,
            "min_y": min_y,
            "width": width,
            "height": height,
        },
    }


def ModuleBounds(activation_sequence: ActivationSequence) -> Tuple[int, int, int, int]:
    """
    Return module bounds as (min_x, min_y, width, height).

    Width/height are computed from the full occupied rectangle extent over all steps.
    """
    if not activation_sequence:
        return (0, 0, 0, 0)

    min_x = None
    min_y = None
    max_x = None
    max_y = None

    for _, activations in activation_sequence:
        for x, y, w, h in activations:
            _validate_rect((x, y, w, h))
            right = x + w
            bottom = y + h
            min_x = x if min_x is None else min(min_x, x)
            min_y = y if min_y is None else min(min_y, y)
            max_x = right if max_x is None else max(max_x, right)
            max_y = bottom if max_y is None else max(max_y, bottom)

    if min_x is None or min_y is None or max_x is None or max_y is None:
        return (0, 0, 0, 0)
    return (min_x, min_y, max_x - min_x, max_y - min_y)


def ArrayModulePositions(
    module_width: int,
    module_height: int,
    array_rows: int,
    array_cols: int,
    gap_x: int,
    gap_y: int,
    *,
    origin_x: int = 0,
    origin_y: int = 0,
) -> List[Tuple[int, int]]:
    """
    Generate top-left positions for a module array.

    gap_x/gap_y are edge-to-edge gaps between neighboring modules.
    """
    for name, value in {
        "module_width": module_width,
        "module_height": module_height,
        "array_rows": array_rows,
        "array_cols": array_cols,
    }.items():
        if not isinstance(value, int):
            raise TypeError(f"{name} must be int.")
        if value <= 0:
            raise ValueError(f"{name} must be >= 1.")

    for name, value in {"gap_x": gap_x, "gap_y": gap_y, "origin_x": origin_x, "origin_y": origin_y}.items():
        if not isinstance(value, int):
            raise TypeError(f"{name} must be int.")
        if name.startswith("gap") and value < 0:
            raise ValueError(f"{name} must be >= 0.")

    step_x = module_width + gap_x
    step_y = module_height + gap_y
    positions: List[Tuple[int, int]] = []
    for row in range(array_rows):
        for col in range(array_cols):
            positions.append((origin_x + col * step_x, origin_y + row * step_y))
    return positions


def ArrayModule(
    activation_sequence: ActivationSequence,
    positions: List[Tuple[int, int]],
) -> ActivationSequence:
    """
    Replicate one module sequence to multiple positions and merge them per time step.

    The first module is treated as the reference module. Each target position refers to
    the module's top-left bound returned by ModuleBounds().
    """
    if not isinstance(positions, list) or not positions:
        raise ValueError("positions must be a non-empty list of (x, y).")

    min_x, min_y, _, _ = ModuleBounds(activation_sequence)
    if not activation_sequence:
        return []

    translated_modules: List[ActivationSequence] = []
    for pos in positions:
        if not isinstance(pos, (tuple, list)) or len(pos) != 2:
            raise ValueError("each position must be (x, y).")
        px, py = int(pos[0]), int(pos[1])
        translated_modules.append(
            translate_sequence(activation_sequence, px - min_x, py - min_y)
        )

    merged: ActivationSequence = []
    for step_idx, (time_step, _) in enumerate(activation_sequence):
        merged_rects: List[Rect] = []
        for module_seq in translated_modules:
            _, rects = module_seq[step_idx]
            merged_rects.extend(rects)
        merged.append((time_step, merged_rects))
    return merged


def ArrayModule_as_txt(
    activation_sequence: ActivationSequence,
    positions: List[Tuple[int, int]],
) -> str:
    return activation_sequence_to_txt(ArrayModule(activation_sequence, positions))


def RotateMixArray(
    count: int,
    duration: int,
    size: Union[int, str, Tuple[int, int], List[int]] = (1, 2),
    *,
    gap: int = 4,
    origin_x: int = 0,
    origin_y: int = 0,
    start_cycle: int = 0,
) -> Dict[str, Any]:
    """Build an array of rotate-mix modules.

    Layout fills row-major using a near-square grid:
      cols = ceil(sqrt(count))
      rows = ceil(count / cols)
    """
    droplets = RotateMixArrayDroplets(
        count,
        duration,
        size=size,
        gap=gap,
        origin_x=origin_x,
        origin_y=origin_y,
    )
    array_cols = int(math.ceil(math.sqrt(count)))
    array_rows = int(math.ceil(count / array_cols))
    positions = [(x, y) for x, y, _, _ in droplets]
    module = RotateMixModule(duration, size=size, start_cycle=start_cycle)

    return {
        "sequence": RotateMixDroplets(droplets, duration, start_cycle=start_cycle),
        "module": module,
        "positions": positions,
        "droplets": droplets,
        "layout": {
            "count": count,
            "rows": array_rows,
            "cols": array_cols,
            "gap": gap,
            "origin_x": origin_x,
            "origin_y": origin_y,
        },
    }


def RotateMixArray_as_txt(
    count: int,
    duration: int,
    size: Union[int, str, Tuple[int, int], List[int]] = (1, 2),
    *,
    gap: int = 4,
    origin_x: int = 0,
    origin_y: int = 0,
    start_cycle: int = 0,
) -> str:
    return activation_sequence_to_txt(
        RotateMixArray(
            count,
            duration,
            size=size,
            gap=gap,
            origin_x=origin_x,
            origin_y=origin_y,
            start_cycle=start_cycle,
        )["sequence"]
    )


if __name__ == "__main__":
    # quick demo
    demo_sequence = Move((10, 12, 6, 4), "right", 3)
    print("activation_sequence =", demo_sequence)
    print("txt:\n" + Move_as_txt((10, 12, 6, 4), "right", 3))
