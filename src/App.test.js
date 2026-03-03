import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders core sections", () => {
  render(<App />);
  expect(
    screen.getByText(/Digital Microfluidics Grid Basics/i)
  ).toBeInTheDocument();
  expect(screen.getByText(/Load TXT Step File/i)).toBeInTheDocument();
  expect(screen.getByText(/Steps/i)).toBeInTheDocument();
});
