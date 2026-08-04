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

test("live grid draws separate minor and major line passes", () => {
  const ctx = createContext();

  drawGridAndDroplets({
    ctx,
    rows: 32,
    cols: 32,
    cellSize: 16,
    majorGridEvery: 16,
    viewportScale: 0.5,
  });

  expect(ctx.stroke).toHaveBeenCalledTimes(2);
  expect(ctx.strokeRect).toHaveBeenCalledTimes(1);
  expect(ctx.lineWidth).toBe(2);
});

test("live grid reveals finer lines as the viewport zooms in", () => {
  const zoomedOutContext = createContext();
  const zoomedInContext = createContext();

  drawGridAndDroplets({
    ctx: zoomedOutContext,
    rows: 16,
    cols: 16,
    cellSize: 16,
    majorGridEvery: 16,
    viewportScale: 0.1,
  });
  drawGridAndDroplets({
    ctx: zoomedInContext,
    rows: 16,
    cols: 16,
    cellSize: 16,
    majorGridEvery: 16,
    viewportScale: 1,
  });

  expect(zoomedOutContext.moveTo).toHaveBeenCalledTimes(6);
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

test("droplet labels can be hidden without changing droplet rendering", () => {
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
  expect(ctx.fillRect).toHaveBeenCalled();
  expect(ctx.strokeRect).toHaveBeenCalled();
});
