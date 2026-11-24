import { describe, expect, it } from "vitest";
import { menuTarget, withMenuTarget } from "./menuTarget";

describe("menu target", () => {
  it("is there only while the action runs, even if it fails", () => {
    expect(withMenuTarget("a.md", menuTarget)).toBe("a.md");
    expect(menuTarget()).toBeNull();
    expect(() => withMenuTarget("a.md", () => { throw new Error("no"); })).toThrow("no");
    expect(menuTarget()).toBeNull();
  });

  it("is none in a menu that is about no file", () => {
    expect(withMenuTarget(undefined, menuTarget)).toBeNull();
  });
});
