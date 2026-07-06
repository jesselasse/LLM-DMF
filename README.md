# React Digital DMF Viewer

A React + Express project for visualizing DMF step text on a grid and generating new steps through an LLM backend.

## What This Project Does

- Draws a grid canvas with configurable rows and columns
- Loads and parses TXT step files
- Visualizes droplets step by step on the grid
- Marks out-of-bound droplets in red and shows warnings
- Shows a clickable step list for frame navigation
- Sends natural-language requests to the backend and renders returned step text

## Project Structure

- `src/`: frontend UI, canvas rendering, step parsing, playback controls
- `server/index.js`: Express backend entry
- `server/llm_move_agent.py`: LLM tool router
- `server/move_backend.py`: backend operations such as `move`, `squeeze`, `rotate_mix`, `rotate_mix_array`
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

### 1. Start backend

If you use the `rag` conda environment, start the backend with its Python interpreter:

```bash
env PYTHON_BIN=/research/d2/gds/cjiang24/jiazq/anaconda3/envs/rag/bin/python npm run server:once
```

For auto-reload during backend development:

```bash
env PYTHON_BIN=/research/d2/gds/cjiang24/jiazq/anaconda3/envs/rag/bin/python npm run server
```

Backend address:

```text
http://localhost:3001
```

Health check:

```bash
curl http://localhost:3001/api/health
```

### 2. Start frontend

```bash
npm start
```

Frontend address:

```text
http://localhost:3000
```

The frontend proxies backend requests to `http://localhost:3001`.

## Backend API

### `POST /api/steps-from-message`

Request body:

```json
{
  "message": "在（10，8）有一个液滴尺寸为（1，1），向下移动2步",
  "sessionId": "demo-session"
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

Move one droplet step by step.

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

Rotate-mix one droplet from an explicit initial position.

Behavior of one round:

- move down by droplet height
- move right by droplet width
- move up by droplet height
- move left by droplet width

Typical prompt:

```text
对处于位置（20，30）尺寸为（3，2）的液滴做3圈旋转混匀。
```

### `rotate_mix_array`

Run many rotate-mix modules in parallel using automatic array layout.

Behavior:

- build one base rotate-mix module anchored at `(0,0)`
- compute the module envelope size from its full activation sequence
- replicate the module into an array with default gap `4`
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
对16个尺寸为（3，2）的液滴并行做3圈旋转混匀。
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
