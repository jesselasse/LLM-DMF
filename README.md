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
- Supports local OpenAI-compatible LLM profiles, model discovery, connection testing, and
  automatic/enabled/disabled reasoning modes
- Shows per-turn and retained-session token usage when the configured model reports it
- Supports editing an earlier chat turn and restoring the sequence/session state from before it

## Project Structure

- `src/`: frontend UI, canvas rendering, step parsing, playback controls
- `server/index.js`: Express backend entry
- `server/llm_move_agent.py`: LLM tool router
- `server/move_backend.py`: backend operations and shared droplet layout helpers
- `server/backend_test_samples.txt`: natural-language backend test samples
- `batch-tool/`: independent batch experiment design, execution, replay, and review interface

## Requirements

- Node.js with `npm`
- Python available on the machine; the project-managed `.venv` is prepared automatically

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

## Batch Experiment Tool

Run the independent batch experiment interface with:

```bash
npm run batch
```

Then open `http://localhost:3003`. The tool imports its own Excel template, runs complete,
default-completion, and multi-flow experiments through the official backend, and writes local
auditable outputs under `.local/experiments`. See `batch-tool/README.md` for the workbook format.

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
- internal droplet records with workspace-only IDs and their current rectangle content
- operation transitions from consumed droplets to produced droplets
- immediate current-droplet updates between dependent tool rounds in one natural-language request
- TXT parsing at import boundaries and TXT serialization at response boundaries

The workspace also exposes typed variables to the LLM tool environment:

- `sequence`: the complete structured sequence
- `currentFrameDroplets`: droplets in the latest frame
- `selectedDroplets`: the current UI selection
- `droplets`: internal droplet records used to associate logical droplets with their activation
  rectangles; these IDs are workspace implementation details and are not user-facing inputs

Tool arguments can explicitly reference a compatible value with a structured reference such
as `{ "workspaceVariable": "selectedDroplets" }`. The backend resolves the reference and
validates the resulting value before invoking the deterministic computation function.

The LLM does not compose TXT activation lines. It only decides which registered function to
call and supplies schema-validated arguments. Server restart currently clears all workspaces.

Each sequence-producing operation reports its consumed and produced rectangles. The workspace
uses those transitions to maintain current droplets while keeping the compact activation sequence
format unchanged. This allows dependent operations such as array coordinates → merge → mix to
run within one request. Explicit coordinates that are not already in the workspace can serve as
initial droplets for the first operation. `selectedDroplets` remains the pre-operation UI/LLM
selection and is updated separately from operation consumption.

The workspace current-droplet content corresponds to the final activation frame produced by the
latest completed operation. Sequence frames remain compact lists of `(x, y, w, h)` rectangles;
workspace-only IDs are maintained alongside that representation and never appear in TXT output.

`generate_array` is a coordinate-layout tool rather than a sequence operation. Its named result
becomes a reusable coordinate variable and does not create activation frames by itself.

When a request begins with an empty workspace but refers to droplets that already exist, the LLM
may first use `initialize_droplets` to record one initial frame. This is used for pre-existing
explicit droplets or generated arrays before they are moved, merged, mixed, or split; squeeze
sources are not initialized.

## LLM Configuration

The settings panel stores multiple local LLM profiles under `.local/settings.json`. A profile can
contain an OpenAI-compatible API URL, API key, model name, and reasoning mode. The application can
test the active connection and load model IDs from the compatible `/models` endpoint.

Configuration export omits API keys unless secret export is explicitly requested. Saved API keys
remain local and are not included in ordinary chat/context exports. Blank request-level settings
use the active local profile and then the server environment configuration.

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
  "tokenUsage": {
    "available": true,
    "inputTokens": 120,
    "outputTokens": 30,
    "totalTokens": 150
  },
  "sessionTokenUsage": {
    "available": true,
    "inputTokens": 120,
    "outputTokens": 30,
    "totalTokens": 150
  },
  "stepsTextDelta": "(10,9)(1,1)-1000\n(10,10)(1,1)-1000",
  "stepsText": "...",
  "moveCalls": [],
  "selectedDroplets": [],
  "currentFrameRects": [],
  "dropletRecords": []
}
```

The API also accepts `editTurnIndex` to regenerate an earlier conversation turn from its saved
pre-turn sequence and selection state.

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

Apply the squeezing/extrusion template to generate multiple droplets from one source droplet.
Each tool call describes one source. A natural-language request may invoke multiple independent
squeeze calls with different positions, sizes, directions, and counts; their paths run in parallel
and are merged by time step. No array gap is required. `count` controls the squeeze progression and
output count.

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

操作完成后，workspace 会自动把操作产生的最后一帧液滴作为当前液滴集合，供下一步
操作继续使用。用户不需要为这些结果命名；`generate_array` 保存的只是坐标集合，只有
后续操作实际引用这些坐标时才会将其作为液滴输入。

Each source droplet's width and height control template scaling.

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

Selected-droplet prompt:

```text
对当前选中的液滴做3圈旋转混匀。
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

`merge` 支持显式的两个液滴数组和两个工作空间坐标变量。单对合并使用两个长度为 1 的
数组；批量合并要求两个数组长度相同并按索引对应。

### `split`

沿液滴的长边将其等分为两个相同尺寸的液滴，并使两个部分沿相反方向移动。长边长度必须
为偶数；方形液滴默认沿水平方向分裂。支持显式坐标、当前选中液滴和 workspace 变量。

#### Array input

Array layout is operation-independent. First generate a named droplet array, then pass the
workspace variable to `move`, `merge`, or `rotate_mix`. This applies only to an independent
positional array. A squeeze call accepts one source coordinate and generates its own output
droplets, so a multi-coordinate array is not a squeeze input.

Behavior:

- generate array coordinates from the requested origin and droplet size
- treat `gap` as the distance between neighboring droplet origins
- require `gap` to be greater than the droplet width
- compute layout from the requested parallel count using a near-square grid

Layout rule:

- `cols = ceil(sqrt(count))`
- `rows = ceil(count / cols)`
- `x = originX + col * gap`
- `y = originY + row * gap`
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

## Tests

```bash
npm run test:python
npm run test:server
npm test -- --watchAll=false --runInBand
npm run test:batch
```

## Standalone TXT Baseline

`llm_txt_baseline.py` is an independent LangChain baseline for comparison. It does not use
the frontend, Express API, operation functions, or `SequenceWorkspace`; the LLM directly emits
the complete TXT activation sequence through one structured tool call.

Run it with the project Python environment and a JSON request on stdin:

```bash
echo '{"message":"在（1，0）有一个2×1液滴，将它分裂"}' \\
  | .venv/bin/python llm_txt_baseline.py
```

The JSON response contains `stepsText`, `assistantReply`, and `tokenUsage`.

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
