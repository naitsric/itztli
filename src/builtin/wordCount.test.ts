import { describe, expect, it } from "vitest";
import { countWords } from "./wordCount";

describe("countWords", () => {
  it("counts words, not marks", () => {
    expect(countWords("# One two — three-four, it's **five** [[six]]")).toBe(6);
    expect(countWords("Canción número 2")).toBe(3);
    expect(countWords("")).toBe(0);
  });
});
