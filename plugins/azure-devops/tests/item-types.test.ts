import { describe, expect, it } from "vitest";
import { oneSvgIcon } from "../src/item-types.ts";

const PATH = '<path fill="#F2CB1D" d="M2 2h12v12H2z"/>';
const svg = (inner: string, attributes = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"${attributes}>${inner}</svg>`;

describe("a work item type's icon", () => {
  it("keeps one SVG of one path, without its XML declaration", () => {
    expect(oneSvgIcon(svg(PATH))).toBe(svg(PATH));
    expect(
      oneSvgIcon(`<?xml version="1.0" encoding="utf-8"?>\n${svg(PATH)}\n`),
    ).toBe(svg(PATH));
    expect(oneSvgIcon(svg('<path d="M2 2h12v12H2z"></path>'))).toBe(
      svg('<path d="M2 2h12v12H2z"></path>'),
    );
  });

  it("refuses anything else: two paths, other elements, a handler, a page, or more than 20,000 characters", () => {
    expect(oneSvgIcon(svg(PATH + PATH))).toBeUndefined();
    expect(oneSvgIcon(svg('<script>alert(1)</script>'))).toBeUndefined();
    expect(oneSvgIcon(svg(PATH, ' onload="alert(1)"'))).toBeUndefined();
    expect(oneSvgIcon("<html><body>Sign in</body></html>")).toBeUndefined();
    expect(
      oneSvgIcon(svg(`<path d="M${"1 ".repeat(10_000)}z"/>`)),
    ).toBeUndefined();
  });
});
