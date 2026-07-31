import {
  createExportBaseName,
  contextToJson,
  encodeStepsGif,
  stepToTxtLine,
  stepsToTxt,
} from "./exportSteps";

test("serializes every step in order", () => {
  const steps = [
    { rects: [{ x: 1, y: 2, w: 3, h: 4 }], duration: 500 },
    { raw: "(2,2)(1,1);(4,4)(2,2)-1000", rects: [], duration: 1000 },
  ];

  expect(stepsToTxt(steps)).toBe(
    "(1,2)(3,4)-500\n(2,2)(1,1);(4,4)(2,2)-1000\n"
  );
});

test("keeps an empty activation step and its duration", () => {
  expect(stepToTxtLine({ rects: [], duration: 750 })).toBe("-750");
});

test("uses the user-selected export file number", () => {
  const now = new Date(2026, 6, 28, 9, 8, 7);

  expect(createExportBaseName(1, now)).toBe("20260728-dmf_steps-1");
  expect(createExportBaseName(25, now)).toBe("20260728-dmf_steps-25");
});

test("preserves messages and raw API exchanges in the context export", () => {
  const raw = contextToJson({
    sessionId: "dmf-test",
    messages: [
      { role: "user", text: "move right" },
      { role: "assistant", text: "done" },
    ],
    exchanges: [{ requestRaw: "{\"message\":\"move right\"}", responseRaw: "{}" }],
    exportedAt: new Date("2026-07-28T00:00:00.000Z"),
  });
  const parsed = JSON.parse(raw);

  expect(parsed.sessionId).toBe("dmf-test");
  expect(parsed.messages).toHaveLength(2);
  expect(parsed.exchanges[0].requestRaw).toBe("{\"message\":\"move right\"}");
});

test("encodes the complete sequence as a GIF blob", () => {
  const rgba = new Uint8ClampedArray(8 * 8 * 4).fill(255);
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      strokeRect: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      stroke: jest.fn(),
      fillText: jest.fn(() => {
        throw new Error("GIF export must not draw labels");
      }),
      getImageData: () => ({ data: rgba }),
    }),
  });

  const blob = encodeStepsGif({
    steps: [
      { rects: [{ x: 0, y: 0, w: 1, h: 1 }], duration: 100 },
      { rects: [{ x: 1, y: 1, w: 1, h: 1 }], duration: 200 },
    ],
    rows: 1,
    cols: 1,
  });

  expect(blob.type).toBe("image/gif");
  expect(blob.size).toBeGreaterThan(6);
});
