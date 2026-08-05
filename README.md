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

The LLM backend currently exposes these operations:

### `move`

Move one droplet or many droplets step by step.

Input sources:

- explicit single-droplet coordinates `(x, y, w, h)`
- current UI-selected droplets from session context

Typical prompt:

```text
现在在（10，8）有一个液滴尺寸为（1，1），向右移动8步。
```

### `squeeze`

Generate droplets from the squeezing template.

Typical prompt:

```text
在（20，20）向右生成3个液滴。
```

Notes:

- Supports `size=1` and non-uniform sizes such as `3*2`
- Returned result is standard step text and can be rendered directly on the grid

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

#### Array input

The same `rotate_mix` operation can arrange and mix many droplets in parallel.

Implementation note:

- first generate the array droplet coordinates
- then call the multi-droplet `rotate_mix` path

Behavior:

- generate array coordinates from the requested origin and droplet size
- compute the module envelope size from its full activation sequence
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
