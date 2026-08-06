# React Digital DMF Viewer

A React + Express project for visualizing DMF step text on a grid and generating new steps through an LLM backend.

## What This Project Does

- Draws a grid canvas with configurable rows and columns
- Loads and parses TXT step files
- Visualizes droplets step by step on the grid
- Lets the user select one or more active droplets on the canvas as session memory
- Marks out-of-bound droplets in red and shows warnings
- Shows a clickable step list for frame navigation
- Sends natural-language requests to the backend and renders returned step text

## Project Structure

- `src/`: frontend UI, canvas rendering, step parsing, playback controls
- `server/index.js`: Express backend entry
- `server/llm_move_agent.py`: LLM tool router
- `server/move_backend.py`: backend operations and shared droplet layout helpers
- `server/backend_test_samples.txt`: natural-language backend test samples

## Requirements

- Node.js with `npm`
- Python environment with the required LLM dependencies installed
- Recommended Python environment: `conda` env `rag`

## Install

```bash
npm install
```

## Run

### Start frontend and backend together

```bash
npm start
```

On the first run, this creates `.venv` from `uv.lock` when needed. The same command then
starts the React frontend and Node/Python backend. Press `Ctrl+C` once to stop both.

Addresses:

```text
http://localhost:3000
http://localhost:3001/api/health
```

To prepare only the Python environment, run `npm run setup:python`. For separate debugging
terminals, use `npm run start:frontend` and `npm run server`.

## Backend Sequence Workspace

The frontend calls the application API, not the LLM directly. The backend request flow is:

```text
Frontend
  -> Node application API
  -> LLM selects a typed computation tool and arguments
  -> deterministic Python function returns a structured sequence delta
  -> per-session SequenceWorkspace processes and appends the delta
  -> API serializes the processed sequence to TXT for the frontend
```

The in-memory workspace is the authoritative sequence state for a session. It owns:

- the complete structured activation sequence
- current-frame lookup
- delta concatenation and time-step reindexing
- preservation of unselected static droplets across generated frames
- TXT parsing at import boundaries and TXT serialization at response boundaries

The workspace also exposes typed variables to the LLM tool environment:

- `sequence`: the complete structured sequence
- `currentFrameDroplets`: droplets in the latest frame
- `selectedDroplets`: the current UI selection

Tool arguments can explicitly reference a compatible value with a structured reference such
as `{ "workspaceVariable": "selectedDroplets" }`. The backend resolves the reference and
validates the resulting value before invoking the deterministic computation function.

The LLM does not compose TXT activation lines. It only decides which registered function to
call and supplies schema-validated arguments. Server restart currently clears all workspaces.

## Backend API

### `POST /api/steps-from-message`

Request body:

```json
{
  "message": "在（10，8）有一个液滴尺寸为（1，1），向下移动2步",
  "sessionId": "demo-session",
  "selectedDroplets": [
    { "x": 10, "y": 8, "w": 1, "h": 1 }
  ]
}
```

Response body:

```json
{
  "sessionId": "demo-session",
  "assistantReply": "...",
  "stepsTextDelta": "(10,9)(1,1)-1000\n(10,10)(1,1)-1000",
  "stepsText": "...",
  "moveCalls": []
}
```

## Supported Backend Operations

The LLM backend currently exposes these tools:

### `generate_array`

Generate a reusable near-square, row-major droplet layout and store it under an explicit
workspace variable name. The tool only creates droplet positions; it does not perform a
movement, squeeze, or mixing operation.

Any operation can then consume the result through a workspace reference:

```json
{ "workspaceVariable": "assayArray" }
```

### `move`

Move one droplet or many droplets step by step.

Input sources:

- explicit single-droplet coordinates `(x, y, w, h)`
- an explicit list of droplets
- current UI-selected droplets from session context
- a named workspace variable such as an array generated earlier

Typical prompt:

```text
现在在（10，8）有一个液滴尺寸为（1，1），向右移动8步。
```

### `squeeze`

Apply the squeezing/extrusion template to generate multiple droplets from a source droplet.
This operation already contains its own generation path; do not call `generate_array` first.
Droplet positions and dimensions can be supplied explicitly, selected in the UI, or referenced
from a workspace variable. `count` controls the requested squeeze progression/output count.

Typical prompt:

```text
对位于（20，20）、尺寸为（3，2）的液滴执行一次向右挤压。
```

挤出多个液滴时只需要给出源位置、尺寸、方向和数量，不需要提供液滴间隔：

```text
在（20，20）向右生成 3 个 2×2 液滴，在（60，60）向左生成 3 个一样大的液滴。
```

这类请求直接使用挤出操作；只有用户明确要求独立的阵列位置布局时才使用
`generate_array`。

Notes:

- Each droplet's own width and height control template scaling
- Multiple droplets are merged by time step into one structured sequence

### `rotate_mix`

Rotate-mix one droplet or many droplets from their current positions.

Behavior of one round:

- move down by droplet height
- move right by droplet width
- move up by droplet height
- move left by droplet width

Typical prompt:

```text
对处于位置（20，30）尺寸为（3，2）的液滴做3圈旋转混匀。
```

### `merge`

合并两组相邻或近邻液滴。输入是两个等长数组，后端按索引配对：
`droplets1[i]` 与 `droplets2[i]` 合并。每一对会先沿分离方向对向移动，直到边界相邻，
再形变为一个紧凑、尽可能接近正方形的大矩形。矩形面积按该对液滴的面积总和计算；
无法精确分解时会向上取整。每一对液滴必须在另一坐标轴上有投影重叠。

典型提示：

```text
把当前选中的两个液滴合并。
```

`merge` 与其他操作一样支持显式液滴列表、当前选中液滴，以及工作空间变量。

Selected-droplet prompt:

```text
对当前选中的液滴做3圈旋转混匀。
```

#### Array input

Array layout is operation-independent. First generate a named droplet array, then pass the
workspace variable to `move`, `merge`, `squeeze`, or `rotate_mix`. This applies only to an
independent positional array; squeeze/extrusion itself generates its multiple droplets directly.

Behavior:

- generate array coordinates from the requested origin and droplet size
- arrange droplets with the standard gap `4` when the user confirms the default layout
- compute layout from the requested parallel count using a near-square grid

Layout rule:

- `cols = ceil(sqrt(count))`
- `rows = ceil(count / cols)`
- fill positions row by row
- if the last row is not full, the remaining slots are left unused

Examples:

- `11 -> 4x3`
- `12 -> 4x3`
- `16 -> 4x4`
- `25 -> 5x5`

Typical prompt:

```text
对处于位置（20，30）尺寸为（3，2）的16个液滴做3圈旋转混匀。使用默认阵列排布。
```

## Step Text Format

Each line is one frame:

```text
(x,y)(w,h)-1000
```

Multiple active rectangles in one frame:

```text
(x1,y1)(w1,h1);(x2,y2)(w2,h2)-1000
```

## Frontend Usage

- Load a TXT file from the file picker
- Click droplets on the canvas to select or unselect them for later operations
- Use the playback controls below the canvas
- Click a step in the step list to jump to that frame
- Use the right-side chat/input panel to send natural-language requests to the backend
- Use the preset buttons above the input box for quick examples

## Test Samples

Natural-language backend samples are stored in:

- `server/backend_test_samples.txt`

## Notes

- If frontend shows `backend error`, first confirm that the correct backend is running on `3001`
- If Python reports missing `langchain_*` packages, the backend is likely using the wrong interpreter
- `server/llm_config.py` controls the default LLM model and API settings
