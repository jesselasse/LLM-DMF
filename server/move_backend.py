"""
Backend helpers for moving one droplet step-by-step.

This module follows the same activation-sequence shape used in Acxel_format.py:
    activation_sequence = [(time_step, [(x, y, w, h), ...]), ...]

For Move(), each time_step contains exactly one moved droplet rectangle.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Tuple, Union

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


if __name__ == "__main__":
    # quick demo
    demo_sequence = Move((10, 12, 6, 4), "right", 3)
    print("activation_sequence =", demo_sequence)
    print("txt:\n" + Move_as_txt((10, 12, 6, 4), "right", 3))
