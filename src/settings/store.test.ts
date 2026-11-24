// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("../backend/host", () => ({ host: { listen: () => () => {}, call: vi.fn(), ask: vi.fn(), desktop: false } }));
const { DEFAULTS, mergeSettings } = await import("./store");

describe("mergeSettings", () => {
  it("starts from the defaults", () => {
    for (const nothing of [null, undefined, 3, "x", [], {}]) expect(mergeSettings(nothing)).toEqual(DEFAULTS);
  });

  it("keeps what is valid and drops what is not", () => {
    const merged = mergeSettings({
      editor: { size: 18, font: 7, unknown: true },
      files: "broken",
      keymap: { "file.newNote": null, "file.x": "$mod+KeyX", bad: 3 },
    });
    expect(merged.editor).toEqual({ ...DEFAULTS.editor, size: 18 });
    expect(merged.files).toEqual(DEFAULTS.files);
    expect(merged.keymap).toEqual({ "file.newNote": null, "file.x": "$mod+KeyX" });
  });
});
