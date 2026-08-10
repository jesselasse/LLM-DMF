# LLM-DMF operation parameters

The product exposes six user-facing methods backed by five actual LLM tools. `阵列生成` is a helper tool used to create reusable droplet groups.

All experiment Prompts must be self-contained unless the experiment mode is intentionally `default`. Batch experiments must not rely on droplets selected in the web UI.

The current application context supplies `gridRows` and `gridCols`. Coordinates use columns on the x-axis and rows on the y-axis. Every explicit rectangle must satisfy `x + w <= gridCols` and `y + h <= gridRows`, including all members of generated arrays.

## Six user-facing methods

| Method | Backend tool chain | Required information in a complete Prompt | Expected audit form |
| --- | --- | --- | --- |
| 挤出式生成 | `squeeze` | output count `1`, source `x,y`, source `w,h`, direction | `挤出生成` / `数量=1；位置=x,y；方向=方向；尺寸=wxh` |
| 挤出式生成 x 个液滴 | `squeeze` | output count greater than `1`, source `x,y`, source `w,h`, direction | `多挤出式生成` / `数量=n；位置=x,y；方向=方向；尺寸=wxh` |
| 移动 | `move` | direction, integer distance, and every source droplet's position and size | single droplet: `移动` / `方向=方向；距离=t；位置=x,y；尺寸=wxh` |
| x 圈混合 | `rotate_mix` | integer rotation count, source `x,y`, source `w,h` | `混合` / `圈数=n；位置=x,y；尺寸=wxh` |
| x 圈阵列混合 | `generate_array` then `rotate_mix` | array count, array source `x,y`, droplet `w,h`, gap, and rotation count | `阵列生成 + 阵列混合` / `数量=n；位置=x,y；尺寸=wxh；间距=g || 圈数=r` |
| merge | `merge`, optionally after two `generate_array` calls | the two equally sized droplet groups; each droplet needs `x,y,w,h`. For generated arrays, each array also needs count, source, size, and gap | pair: `合并` / `液滴组1=x,y,w,h；液滴组2=x,y,w,h`; arrays: `阵列生成 + 阵列生成 + 合并` / `array 1 args || array 2 args ||` |

These names are exact Prompt vocabulary. Replace `x` with a concrete integer. Do not write `合并`, `多挤出式生成`, `混匀`, or `阵列混匀` in a user-facing Prompt. Internal expected-operation labels remain unchanged because the batch validator uses them for auditing.

An array movement should use `阵列生成 + 移动` with `数量=n；位置=x,y；尺寸=wxh；间距=g || 方向=方向；距离=t`. The generated array is passed to `move` through a workspace reference.

## Actual backend tools

- `squeeze(count, direction, droplet)`: `count >= 1`; direction is up, down, left, or right; exactly one source droplet per call; no gap parameter. Source coordinates are not guaranteed final output coordinates.
- `move(direction, t, droplets)`: `t >= 0`; accepts one or more explicit droplets or a generated-array reference.
- `rotate_mix(duration, droplets)`: `duration >= 1`; accepts one or more explicit droplets or a generated-array reference. Each droplet's width and height define its loop dimensions.
- `merge(droplets1, droplets2)`: both lists must have equal length and merge pairwise by index. Each pair must overlap on one axis and be separated on the other so the droplets can move together.
- `generate_array(outputName, count, x, y, w, h, gap)`: `count >= 1`, `w > 0`, `h > 0`, and `gap >= 0`. The backend chooses a compact near-square row-major layout and stores it under an internal workspace name.

The experiment designer does not put internal `outputName` values into user Prompts or friendly expected parameters. The production LLM chooses safe workspace names when it calls tools.

## Missing and varied parameters

- Generate values without a follow-up only when the user has delegated that experimental choice, such as asking for different positions or counts across a stated range. Keep them within the grid and explain the chosen design rule in the assistant reply.
- Ask the user when an unresolved value changes the experimental meaning, such as droplet size, whether a count applies to each array or both arrays combined, or whether several Prompts are independent or state-dependent.
- If proposing defaults, list their exact values and ask for confirmation before submitting a project that uses them.
- Never silently reinterpret malformed dimensions. `22`, `2*2`, and `2×2` are not interchangeable unless the intended meaning has been established; prefer the unambiguous `2×2` form in generated Prompts.

## Merge design checks

- A two-droplet merge is one complete experiment with one Prompt and explicit rectangles for both droplets.
- Ten distinct two-droplet merge Prompts are ten independent experiments in the same category.
- A multi-droplet merge may be one complete Prompt that describes two arrays. Its expected tool chain is `阵列生成 + 阵列生成 + 合并`.
- Array counts must match because merge pairs items by index.
- Choose array origins, dimensions, and gap so corresponding pairs align on one axis and remain separated on the other. Do not describe impossible or overlapping starting layouts.
