import { describe, expect, it } from "vitest";
import { paragraphAround } from "./focusMode";

describe("paragraphAround", () => {
  it("is bounded by blank lines", () => {
    const lines = ["a", "b", "", "c", "d", "", ""];
    const around = (n: number) => paragraphAround((i) => lines[i - 1]!, lines.length, n);
    expect(around(1)).toEqual({ first: 1, last: 2 });
    expect(around(5)).toEqual({ first: 4, last: 5 });
    expect(around(3)).toEqual({ first: 3, last: 3 });
    expect(around(7)).toEqual({ first: 7, last: 7 });
  });
});
