// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import guide from "../../docs/plugins.md?raw";
import { ICONS } from "./icons";

describe("icons plugins can name", () => {
  it("are the ones the guide lists", () => {
    const list = /or one of: ([\s\S]*?)\.\n/.exec(guide)![1]!.split(/,\s+/).map((name) => name.trim());
    expect(list.toSorted()).toEqual(Object.keys(ICONS).toSorted());
  });
});
