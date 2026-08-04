import { drawGridAndDroplets } from "./drawGridAndDroplets";

function createContext() {
  return {
    clearRect: jest.fn(),
    fillRect: jest.fn(),
    strokeRect: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    stroke: jest.fn(),
    fillText: jest.fn(),
  };
}

test("live grid draws minor, secondary, and major line passes", () => {
  const ctx = createContext();

  drawGridAndDroplets({
    ctx,
    rows: 32,
    cols: 32,
    cellSize: 16,
    majorGridEvery: 32,
    secondaryGridEvery: 16,
    viewportScale: 0.5,
  });

  expect(ctx.stroke).toHaveBeenCalledTimes(3);
  expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
  expect(ctx.lineWidth).toBe(2);
});

test("live grid keeps every cell visible across zoom levels", () => {
  const zoomedOutContext = createContext();
  const zoomedInContext = createContext();

  drawGridAndDroplets({
    ctx: zoomedOutContext,
    rows: 16,
    cols: 16,
    cellSize: 16,
    majorGridEvery: 32,
    secondaryGridEvery: 16,
    viewportScale: 0.1,
  });
  drawGridAndDroplets({
    ctx: zoomedInContext,
    rows: 16,
    cols: 16,
    cellSize: 16,
    majorGridEvery: 32,
    secondaryGridEvery: 16,
    viewportScale: 1,
  });

  expect(zoomedOutContext.moveTo).toHaveBeenCalledTimes(34);
  expect(zoomedInContext.moveTo).toHaveBeenCalledTimes(34);
});

test("default grid keeps the single-weight export drawing path", () => {
  const ctx = createContext();

  drawGridAndDroplets({
    ctx,
    rows: 32,
    cols: 32,
    cellSize: 8,
  });

  expect(ctx.stroke).toHaveBeenCalledTimes(1);
  expect(ctx.strokeRect).not.toHaveBeenCalled();
  expect(ctx.lineWidth).toBe(1);
});

test("regular droplets render without labels or dark outlines", () => {
  const ctx = createContext();

  drawGridAndDroplets({
    ctx,
    rows: 32,
    cols: 32,
    cellSize: 16,
    step: { rects: [{ x: 2, y: 3, w: 1, h: 1 }] },
    showLabels: false,
  });

  expect(ctx.fillText).not.toHaveBeenCalled();
  expect(ctx.fillRect).toHaveBeenLastCalledWith(32, 48, 16, 16);
  expect(ctx.strokeRect).not.toHaveBeenCalled();
});

test("selected and out-of-bounds droplets keep their status outlines", () => {
  const selectedContext = createContext();
  const outOfBoundsContext = createContext();
  const selectedRect = { x: 2, y: 3, w: 1, h: 1 };

  drawGridAndDroplets({
    ctx: selectedContext,
    rows: 32,
    cols: 32,
    cellSize: 16,
    step: { rects: [selectedRect] },
    selectedRects: [selectedRect],
    showLabels: false,
  });
  drawGridAndDroplets({
    ctx: outOfBoundsContext,
    rows: 4,
    cols: 4,
    cellSize: 16,
    step: { rects: [{ x: 4, y: 3, w: 1, h: 1 }] },
    showLabels: false,
  });

  expect(selectedContext.strokeRect).toHaveBeenCalledTimes(1);
  expect(outOfBoundsContext.strokeRect).toHaveBeenCalledTimes(1);
});
