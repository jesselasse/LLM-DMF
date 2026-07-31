import { render, screen } from "@testing-library/react";
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
});
