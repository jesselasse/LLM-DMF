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
  expect(screen.getByLabelText(/Export file number/i)).toHaveValue(1);
  expect(screen.getByRole("heading", { name: "Steps" })).toBeInTheDocument();
  expect(screen.getByText(/Export All Steps \+ GIF \+ JSON Context/i)).toBeInTheDocument();
});
