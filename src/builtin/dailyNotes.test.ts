import { describe, expect, it } from "vitest";
import { dateOfPath, isoDate } from "./dailyNotes";

describe("daily notes", () => {
  it("know the day a note is for", () => {
    expect(isoDate(dateOfPath("Daily/2026-11-24.md", "Daily")!)).toBe("2026-11-24");
    expect(isoDate(dateOfPath("2026-01-05.md", "")!)).toBe("2026-01-05");
    for (const path of ["Daily/2026-13-01.md", "Daily/2026-02-30.md", "Other/2026-11-24.md", "Daily/x/2026-11-24.md", "Daily/2026-11-24 b.md"]) {
      expect(dateOfPath(path, "Daily"), path).toBeNull();
    }
    expect(dateOfPath("a+b/2026-11-24.md", "a+b")).not.toBeNull();
  });
});
