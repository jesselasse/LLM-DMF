"""
Backend helpers for moving one droplet step-by-step.

This module follows the same activation-sequence shape used in Acxel_format.py:
    activation_sequence = [(time_step, [(x, y, w, h), ...]), ...]

For Move(), each time_step contains exactly one moved droplet rectangle.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

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


def _normalize_direction(direction: str) -> Tuple[int, int]:
    if not isinstance(direction, str):
        raise TypeError("direction must be a string.")
    key = direction.strip().lower()
    if key not in _DIRECTION_DELTAS:
        raise ValueError(
            f"Unsupported direction '{direction}'. Use up/down/left/right."
        )
    return _DIRECTION_DELTAS[key]


def _validate_rect(rect: Rect) -> None:
    if not isinstance(rect, (tuple, list)) or len(rect) != 4:
        raise ValueError("droplet must be (x, y, w, h).")
    x, y, w, h = rect
    if not all(isinstance(v, int) for v in (x, y, w, h)):
        raise ValueError("x, y, w, h must all be int.")
    if w <= 0 or h <= 0:
        raise ValueError(f"w and h must be > 0, got w={w}, h={h}.")


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


if __name__ == "__main__":
    # quick demo
    demo_sequence = Move((10, 12, 6, 4), "right", 3)
    print("activation_sequence =", demo_sequence)
    print("txt:\n" + Move_as_txt((10, 12, 6, 4), "right", 3))
