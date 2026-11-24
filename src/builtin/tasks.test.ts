import { describe, expect, it } from "vitest";
import { toggle } from "./tasks";

describe("toggling a task", () => {
  it("changes its box and nothing else", () => {
    expect(toggle("a\n- [ ] one\n- [ ] two", 2, "two", true)).toBe("a\n- [ ] one\n- [x] two");
    expect(toggle("  1. [X] one", 0, "one", false)).toBe("  1. [ ] one");
    expect(toggle("> - [ ] quoted", 0, "quoted", true)).toBe("> - [x] quoted");
  });
  it("finds it where it moved to, minding formatting", () => {
    expect(toggle("new line\n- [ ] buy **milk** now", 0, "buy milk now", true)).toBe("new line\n- [x] buy **milk** now");
  });
  it("does nothing if it is gone", () => {
    expect(toggle("- [ ] other", 0, "gone", true)).toBe("- [ ] other");
  });
});
