const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  getLastStepRectsFromSequenceText,
  mergeDeltaWithCurrentFrame,
  parseStepsText,
} = require("./index");
const {
  appendSequence,
  getLastStepRects,
  mergeDeltaWithCurrentFrame: mergeSequenceDeltaWithCurrentFrame,
  parseSequenceText,
  SequenceWorkspace,
  sequenceToText,
} = require("./sequence_workspace");

const currentFrame = [0, 8, 16, 24].flatMap((y) =>
  [0, 10, 20, 30].map((x) => ({ x, y, w: 3, h: 2 }))
);
const selected = currentFrame.filter((rect) => rect.x === 30);

describe("static droplet background", () => {
  test("derives the generation frame from the stored sequence last step", () => {
    const first = "(1,1)(1,1)-1000";
    const last = currentFrame
      .map((rect) => `(${rect.x},${rect.y})(${rect.w},${rect.h})`)
      .join(";");

    assert.deepEqual(
      getLastStepRectsFromSequenceText(`${first}\n${last}-1000`),
      currentFrame
    );
  });

  test("keeps 12 unselected droplets while the rightmost 4 move", () => {
    const rawDelta = [31, 32]
      .map((x) =>
        selected
          .map((rect) => `(${x},${rect.y})(${rect.w},${rect.h})`)
          .join(";")
      )
      .map((line) => `${line}-1000`)
      .join("\n");

    const merged = parseStepsText(
      mergeDeltaWithCurrentFrame(rawDelta, currentFrame, selected)
    );

    assert.equal(merged.length, 2);
    assert.equal(merged.every((step) => step.rects.length === 16), true);
    assert.equal(merged[0].rects.filter((rect) => rect.x === 30).length, 0);
    assert.equal(merged[0].rects.filter((rect) => rect.x === 31).length, 4);
  });

  test("treats every current droplet as static when selection is empty", () => {
    const merged = parseStepsText(
      mergeDeltaWithCurrentFrame("(50,50)(1,1)-1000", currentFrame, [])
    );

    assert.equal(merged[0].rects.length, 17);
    currentFrame.forEach((rect) => {
      assert.equal(
        merged[0].rects.some(
          (candidate) =>
            candidate.x === rect.x &&
            candidate.y === rect.y &&
            candidate.w === rect.w &&
            candidate.h === rect.h
        ),
        true
      );
    });
  });
});

describe("structured sequence workspace", () => {
  test("stores and appends structured steps before TXT serialization", () => {
    const first = parseSequenceText("(1,1)(2,2)-500");
    const second = [[0, [[2, 1, 2, 2]]]];
    const complete = appendSequence(first, second);

    assert.deepEqual(complete, [
      {
        timeStep: 0,
        duration: 500,
        rects: [{ x: 1, y: 1, w: 2, h: 2 }],
      },
      {
        timeStep: 1,
        duration: 1000,
        rects: [{ x: 2, y: 1, w: 2, h: 2 }],
      },
    ]);
    assert.equal(sequenceToText(complete), "(1,1)(2,2)-500\n(2,1)(2,2)-1000");
  });

  test("merges generated steps with the current frame as structured data", () => {
    const delta = [[0, [[31, 0, 3, 2]]]];
    const frame = [
      { x: 20, y: 0, w: 3, h: 2 },
      { x: 30, y: 0, w: 3, h: 2 },
    ];
    const merged = mergeSequenceDeltaWithCurrentFrame(delta, frame, [frame[1]]);

    assert.deepEqual(merged[0].rects, [
      { x: 31, y: 0, w: 3, h: 2 },
      { x: 20, y: 0, w: 3, h: 2 },
    ]);
    assert.deepEqual(getLastStepRects(merged), merged[0].rects);
  });

  test("buffers the complete sequence and applies deltas before serialization", () => {
    const workspace = new SequenceWorkspace(
      parseSequenceText("(10,0)(2,2);(20,0)(2,2)-1000")
    );
    const processed = workspace.applyDelta([[0, [[11, 0, 2, 2]]]], [
      { x: 10, y: 0, w: 2, h: 2 },
    ]);

    assert.deepEqual(processed[0].rects, [
      { x: 11, y: 0, w: 2, h: 2 },
      { x: 20, y: 0, w: 2, h: 2 },
    ]);
    assert.equal(
      workspace.toText(),
      "(10,0)(2,2);(20,0)(2,2)-1000\n(11,0)(2,2);(20,0)(2,2)-1000"
    );
  });

  test("exposes typed values that LLM tool arguments can reference", () => {
    const workspace = new SequenceWorkspace(
      parseSequenceText("(4,5)(2,3);(20,5)(1,1)-1000")
    );
    const selectedDroplets = [{ x: 4, y: 5, w: 2, h: 3 }];
    const variables = workspace.variables(selectedDroplets);

    assert.deepEqual(variables.currentFrameDroplets, [
      { x: 4, y: 5, w: 2, h: 3 },
      { x: 20, y: 5, w: 1, h: 1 },
    ]);
    assert.deepEqual(variables.selectedDroplets, selectedDroplets);
    assert.deepEqual(variables.sequence, workspace.snapshot());
  });
});
