import { describe, expect, it } from "vitest";
import { fill } from "./templates";

describe("templates", () => {
  it("fill in what they name and say where the caret goes", () => {
    const now = new Date(2026, 10, 24, 9, 5);
    expect(fill("# {{title}} {{ date }} {{time}}\n\n{{cursor}}end", "Note", now)).toEqual({
      text: "# Note 2026-11-24 09:05\n\nend",
      cursor: 25,
    });
    expect(fill("{{unknown}}", "x", now)).toEqual({ text: "{{unknown}}", cursor: null });
    expect(fill("{{title}}", "$& $1", now).text).toBe("$& $1");
  });
});
