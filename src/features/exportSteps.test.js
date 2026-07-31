import {
  createExportFilename,
  contextToJson,
  encodeStepsGif,
  saveBlob,
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

test("creates a stable default export filename", () => {
  const now = new Date(2026, 6, 28, 9, 8, 7);

  expect(createExportFilename("steps", "txt", now)).toBe("20260728-dmf-steps.txt");
  expect(createExportFilename("context", "json", now)).toBe("20260728-dmf-context.json");
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

test("falls back to browser download when file picker is unavailable", async () => {
  const blob = new Blob(["hello"], { type: "text/plain" });
  const anchor = { click: jest.fn() };
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:test");
  URL.revokeObjectURL = jest.fn();
  const createElementSpy = jest
    .spyOn(document, "createElement")
    .mockReturnValue(anchor);
  const originalPicker = globalThis.showSaveFilePicker;
  delete globalThis.showSaveFilePicker;

  await saveBlob(blob, {
    suggestedName: "test.txt",
    description: "Text",
    accept: { "text/plain": [".txt"] },
  });

  expect(anchor.download).toBe("test.txt");
  expect(anchor.click).toHaveBeenCalled();

  createElementSpy.mockRestore();
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
  if (originalPicker) {
    globalThis.showSaveFilePicker = originalPicker;
  }
});
