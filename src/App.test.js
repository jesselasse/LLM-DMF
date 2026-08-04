import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

beforeEach(() => {
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
      fillText: jest.fn(),
      setTransform: jest.fn(),
    }),
  });
});

test("renders core sections", () => {
  render(<App />);
  expect(
    screen.getByText(/Digital Microfluidics Grid Basics/i)
  ).toBeInTheDocument();
  expect(screen.getByText(/Load TXT Step File/i)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Steps" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export Log" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export Steps" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export JSON Context" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "发送消息" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "新建对话" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Zoom Out" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Fit to View" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Zoom In" })).toBeInTheDocument();
  expect(screen.getByLabelText("X axis")).toBeInTheDocument();
  expect(screen.getByLabelText("Y axis")).toBeInTheDocument();
});

test("grid zoom controls change scale and fit restores the global view", () => {
  render(<App />);
  const scaleIndicator = screen.getByLabelText("Grid scale");

  expect(scaleIndicator).toHaveTextContent("10%");
  fireEvent.click(screen.getByRole("button", { name: "Zoom In" }));
  expect(scaleIndicator).toHaveTextContent("13%");
  fireEvent.click(screen.getByRole("button", { name: "Fit to View" }));
  expect(scaleIndicator).toHaveTextContent("10%");
});

test("grid pointer coordinates remain aligned with the canvas", () => {
  const { container } = render(<App />);
  const canvas = container.querySelector("canvas");
  canvas.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    right: 1500,
    bottom: 1250,
    width: 1400,
    height: 1200,
  });

  fireEvent.mouseMove(canvas, { clientX: 265, clientY: 375 });
  expect(screen.getByText("(16, 32)")).toBeInTheDocument();
});

test("presets still fill the composer and new conversation restores the initial prompt", () => {
  render(<App />);
  const input = screen.getByRole("textbox", { name: "对话输入" });

  fireEvent.click(screen.getByRole("button", { name: "PCR" }));
  expect(input).toHaveValue("PCR示例：在（20，20）向右生成3个液滴，再向下移动6步。");

  fireEvent.click(screen.getByRole("button", { name: "新建对话" }));
  expect(input).toHaveValue("在（20，20）向右生成3个液滴");
});

test("send button keeps the existing backend request contract", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ assistantReply: "收到", stepsText: "" }),
  });

  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, options] = fetchMock.mock.calls[0];
  const body = JSON.parse(options.body);
  expect(url).toBe("/api/steps-from-message");
  expect(options.method).toBe("POST");
  expect(body.message).toBe("在（20，20）向右生成3个液滴");
  expect(body.sessionId).toMatch(/^dmf-/);
  expect(body.selectedDroplets).toEqual([]);
  expect(screen.getByRole("textbox", { name: "对话输入" })).toHaveValue("");

  fetchMock.mockRestore();
});

test("enter sends and clears while shift enter keeps editing", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ assistantReply: "收到", stepsText: "" }),
  });

  render(<App />);
  const input = screen.getByRole("textbox", { name: "对话输入" });
  fireEvent.change(input, { target: { value: "测试 Enter 发送" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toBe("测试 Enter 发送");
  expect(input).toHaveValue("");

  fireEvent.change(input, { target: { value: "继续编辑" } });
  fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue("继续编辑");

  fetchMock.mockRestore();
});

test("composer grows with multiline input and caps its height", () => {
  render(<App />);
  const input = screen.getByRole("textbox", { name: "对话输入" });

  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 118,
  });
  fireEvent.change(input, { target: { value: "第一行\n第二行\n第三行\n第四行" } });
  expect(input).toHaveStyle({ height: "120px", overflowY: "hidden" });

  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    value: 220,
  });
  fireEvent.change(input, { target: { value: "更多内容\n".repeat(12) } });
  expect(input).toHaveStyle({ height: "160px", overflowY: "auto" });
});
