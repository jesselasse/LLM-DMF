"""
Backend helpers for moving one droplet step-by-step.

This module follows the same activation-sequence shape used in Acxel_format.py:
    activation_sequence = [(time_step, [(x, y, w, h), ...]), ...]

Public operations accept a normalized droplet list and return one structured sequence.
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


def _move_one(
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


def Move(
    droplets: List[Rect],
    direction: str,
    t: int,
    *,
    start_cycle: int = 0,
) -> ActivationSequence:
    normalized = normalize_droplets_input(droplets)
    sequences = [
        _move_one(droplet, direction, t, start_cycle=start_cycle)
        for droplet in normalized
    ]
    return merge_sequences_by_step(sequences)


def _near_square_dimensions(cell_count: int) -> Tuple[int, int]:
    """Choose a compact rectangle with at least ``cell_count`` cells."""
    if cell_count <= 0:
        raise ValueError("cell_count must be > 0.")
    side = int(math.ceil(math.sqrt(cell_count)))
    candidates = []
    for width in range(1, side + 1):
        height = int(math.ceil(cell_count / width))
        candidates.append((abs(width - height), width * height - cell_count, width, height))
    _, _, width, height = min(candidates)
    return width, height


def Deform(droplets: List[Rect]) -> ActivationSequence:
    """Deform two adjacent rectangles into one compact rectangle."""
    normalized = normalize_droplets_input(droplets)
    if len(normalized) != 2:
        raise ValueError("deform requires exactly two droplets.")
    first, second = normalized
    x1, y1, w1, h1 = first
    x2, y2, w2, h2 = second
    x_overlap = min(x1 + w1, x2 + w2) - max(x1, x2)
    y_overlap = min(y1 + h1, y2 + h2) - max(y1, y2)
    horizontal_gap = max(x1, x2) - min(x1 + w1, x2 + w2)
    vertical_gap = max(y1, y2) - min(y1 + h1, y2 + h2)
    if not ((x_overlap > 0 and vertical_gap == 0) or (y_overlap > 0 and horizontal_gap == 0)):
        raise ValueError("deform requires two adjacent droplets.")

    min_x = min(x1, x2)
    min_y = min(y1, y2)
    max_x = max(x1 + w1, x2 + w2)
    max_y = max(y1 + h1, y2 + h2)
    total_area = w1 * h1 + w2 * h2
    bounding_w = max_x - min_x
    bounding_h = max_y - min_y
    # If the adjacent rectangles already form a filled rectangle, preserve
    # that geometry exactly. No rotation or alternate near-square choice is
    # needed in this case.
    if bounding_w * bounding_h == total_area:
        target_w, target_h = bounding_w, bounding_h
    else:
        target_w, target_h = _near_square_dimensions(total_area)
    center_x = (min_x + max_x) / 2
    center_y = (min_y + max_y) / 2
    merged = (
        int(round(center_x - target_w / 2)),
        int(round(center_y - target_h / 2)),
        target_w,
        target_h,
    )
    return [(0, [merged])]


def _merge_pair(droplets: List[Rect]) -> ActivationSequence:
    """Move one pair of nearby droplets together and deform them into one rectangle.

    The droplets must be separated on one axis while their projections overlap
    on the other axis. They move toward one another until touching, then a final
    frame replaces both with a compact, near-square rectangle whose area is the
    sum of the two input areas (rounded up when an exact factorization is not
    possible).
    """
    normalized = normalize_droplets_input(droplets)
    if len(normalized) != 2:
        raise ValueError("merge pair requires exactly two droplets.")
    first, second = normalized
    ax, ay, aw, ah = first
    bx, by, bw, bh = second

    # Prefer horizontal joining when the y projections overlap.
    y_overlap = min(ay + ah, by + bh) - max(ay, by)
    x_overlap = min(ax + aw, bx + bw) - max(ax, bx)
    movement = None
    if y_overlap > 0 and (ax + aw <= bx or bx + bw <= ax):
        if ax <= bx:
            left, right = first, second
            gap = max(0, bx - (ax + aw))
            movement = (left, "right", right, "left", gap)
        else:
            left, right = second, first
            gap = max(0, ax - (bx + bw))
            movement = (left, "right", right, "left", gap)
    elif x_overlap > 0 and (ay + ah <= by or by + bh <= ay):
        if ay <= by:
            top, bottom = first, second
            gap = max(0, by - (ay + ah))
            movement = (top, "down", bottom, "up", gap)
        else:
            top, bottom = second, first
            gap = max(0, ay - (by + bh))
            movement = (top, "down", bottom, "up", gap)
    else:
        raise ValueError("merge requires droplets with overlapping projection and a small gap.")

    sequence: ActivationSequence = []
    left_or_top, dir_a, right_or_bottom, dir_b, gap = movement
    # Split movement between the two droplets while preserving non-overlap.
    steps_a = (gap + 1) // 2
    steps_b = gap // 2
    current_a = left_or_top
    current_b = right_or_bottom
    for step in range(max(steps_a, steps_b)):
        if step < steps_a:
            current_a = _move_one(current_a, dir_a, 1)[-1][1][0]
        if step < steps_b:
            current_b = _move_one(current_b, dir_b, 1)[-1][1][0]
        sequence.append((step, [current_a, current_b]))

    final_a = current_a
    final_b = current_b
    deformation = Deform([final_a, final_b])
    sequence.append((len(sequence), deformation[0][1]))
    return sequence


def Merge(droplets1: List[Rect], droplets2: List[Rect]) -> ActivationSequence:
    """Merge two equally sized droplet arrays pairwise in parallel.

    ``droplets1[i]`` is merged with ``droplets2[i]``. Each pair must have
    overlapping projection on one axis and a small gap on the other axis.
    """
    normalized1 = normalize_droplets_input(droplets1)
    normalized2 = normalize_droplets_input(droplets2)
    if len(normalized1) != len(normalized2):
        raise ValueError("merge droplet arrays must have the same length.")
    pair_sequences = [
        _merge_pair([first, second])
        for first, second in zip(normalized1, normalized2)
    ]
    return merge_sequences_by_step(pair_sequences)


def _squeeze_one(
    count: int,
    droplet: Rect,
    direction: Union[str, int],
) -> ActivationSequence:
    """
    Generate squeezing sequence from template with truncation and transform.

    Rules:
      - count=1 -> first 6 steps
      - count=2 -> first 11 steps
      - each additional count adds 5 template steps
      - normalize the template origin, rotate, scale to droplet size, and translate
        to the droplet position
    """
    if not isinstance(count, int):
        raise TypeError("count must be int.")
    if count <= 0:
        raise ValueError("count must be >= 1.")
    x, y, sx, sy = _coerce_rect(droplet)

    template = _load_squeezing_template()
    step_limit = 6 + (count - 1) * 5
    step_limit = max(1, min(step_limit, len(template)))

    temp_sequence = template[:step_limit]
    temp_sequence = translate_sequence(temp_sequence, -47, -33)
    rotation_deg = _normalize_rotation_deg(direction)
    temp_sequence = rotate_sequence_90(temp_sequence, rotation_deg, center=(0, 1))
    temp_sequence = scale_activation_sequence_xy(temp_sequence, sx, sy)
    return translate_sequence(temp_sequence, x, y)


def Squeeze(
    droplets: List[Rect],
    count: int,
    direction: Union[str, int],
) -> ActivationSequence:
    normalized = normalize_droplets_input(droplets)
    sequences = [_squeeze_one(count, droplet, direction) for droplet in normalized]
    return merge_sequences_by_step(sequences)


def _rotate_mix_one(
    droplet: Rect,
    duration: int,
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
    if not isinstance(duration, int):
        raise TypeError("duration must be int.")
    if duration <= 0:
        raise ValueError("duration must be >= 1.")
    if not isinstance(start_cycle, int):
        raise TypeError("start_cycle must be int.")

    current_rect = _coerce_rect(droplet)
    _, _, sx, sy = current_rect
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
            segment = _move_one(current_rect, direction, steps, start_cycle=cycle_idx)
            sequence.extend(segment)
            current_rect = segment[-1][1][0]
            cycle_idx += len(segment)

    return sequence


def RotateMix(
    droplets: List[Rect],
    duration: int,
    *,
    start_cycle: int = 0,
) -> ActivationSequence:
    normalized = normalize_droplets_input(droplets)
    sequences = [
        _rotate_mix_one(droplet, duration, start_cycle=start_cycle)
        for droplet in normalized
    ]
    return merge_sequences_by_step(sequences)


def GenerateDropletArray(
    count: int,
    x: int,
    y: int,
    w: int,
    h: int,
    gap: int,
) -> List[Rect]:
    """Generate a near-square, row-major array of droplet rectangles."""
    if not isinstance(count, int):
        raise TypeError("count must be int.")
    if count <= 0:
        raise ValueError("count must be >= 1.")
    if not isinstance(gap, int):
        raise TypeError("gap must be int.")
    if gap < 0:
        raise ValueError("gap must be >= 0.")
    _validate_rect((x, y, w, h))

    columns = int(math.ceil(math.sqrt(count)))
    return [
        (
            x + (index % columns) * (w + gap),
            y + (index // columns) * (h + gap),
            w,
            h,
        )
        for index in range(count)
    ]
