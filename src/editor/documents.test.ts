// @vitest-environment happy-dom
import { Text } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Map<string, { text: string; revision: string }>();
let writes = 0;

vi.mock("../backend/host", () => ({ host: { listen: () => () => {}, call: vi.fn(), ask: vi.fn(), desktop: false } }));
vi.mock("../backend/api", async (original) => {
  const actual = await original<typeof import("../backend/api")>();
  return {
    ...actual,
    api: {
      noteRead: async (path: string) => {
        const file = disk.get(path);
        if (!file) throw { code: "notFound", message: path };
        return file;
      },
      noteWrite: async (path: string, text: string, base?: string) => {
        const file = disk.get(path);
        if (base !== undefined && !file) throw { code: "notFound", message: path };
        if (base !== undefined && file!.revision !== base) throw { code: "conflict", message: path };
        const revision = `r${++writes}`;
        disk.set(path, { text, revision });
        return revision;
      },
    },
  };
});

const { closeAllDocuments, difference, documentAt, modifyNote, openDocument, readNote, useDocuments } = await import("./documents");

const put = (path: string, text: string) => disk.set(path, { text, revision: `r${++writes}` });

beforeEach(() => {
  closeAllDocuments();
  disk.clear();
});

describe("difference", () => {
  const apply = (a: string, b: string) => {
    const from = Text.of(a.split("\n"));
    const change = difference(from, Text.of(b.split("\n"))) as { from: number; to: number; insert: string } | null;
    return change && { ...change, result: a.slice(0, change.from) + change.insert + a.slice(change.to) };
  };

  it("is the smallest single change", () => {
    expect(apply("hello world", "hello brave world")).toMatchObject({ from: 6, to: 6, insert: "brave " });
    expect(apply("aaa", "aaaa")).toMatchObject({ from: 3, to: 3, insert: "a" });
    expect(apply("abc", "abc")).toBeNull();
  });

  it("always gives the other text, and never splits a character", () => {
    for (const [a, b] of [["", "x"], ["x", ""], ["a\nb", "a\nc\nb"], ["😀", "😁"], ["a😀b", "a😁b"], ["abab", "ab"]] as const) {
      const change = apply(a, b)!;
      expect(change.result).toBe(b);
      expect(change.insert).not.toMatch(/^[\udc00-\udfff]/);
    }
  });
});

describe("documents", () => {
  it("are one per path", async () => {
    put("a.md", "x");
    const [one, two] = await Promise.all([openDocument("a.md"), openDocument("a.md")]);
    expect(one).toBe(two);
    expect(documentAt("a.md")).toBe(one);
  });

  it("save with the line breaks they had", async () => {
    put("a.md", "one\r\ntwo");
    const doc = await openDocument("a.md");
    await doc.edit((t) => t.replace("two", "2"));
    expect(disk.get("a.md")!.text).toBe("one\r\n2");
    expect(useDocuments.getState().open["a.md"]).toEqual({ dirty: false, status: { state: "ready" } });
  });

  it("take changes from disk when there is nothing to lose", async () => {
    put("a.md", "old");
    const doc = await openDocument("a.md");
    put("a.md", "new");
    await doc.refresh();
    expect(doc.text.toString()).toBe("new");
    expect(doc.dirty).toBe(false);
  });

  it("never overwrite a change they have not seen", async () => {
    put("a.md", "old");
    const doc = await openDocument("a.md");
    put("a.md", "theirs");
    await doc.edit(() => "mine");
    expect(disk.get("a.md")!.text).toBe("theirs");
    expect(doc.status).toEqual({ state: "conflict" });

    await doc.keepMine();
    expect(disk.get("a.md")!.text).toBe("mine");
    expect(doc.dirty).toBe(false);
  });

  it("can settle a conflict with what is on disk", async () => {
    put("a.md", "old");
    const doc = await openDocument("a.md");
    put("a.md", "theirs");
    await doc.edit(() => "mine");
    await doc.takeDisk();
    expect(doc.text.toString()).toBe("theirs");
    expect(doc.status).toEqual({ state: "ready" });
  });

  it("see no conflict when both made the same change", async () => {
    put("a.md", "old");
    const doc = await openDocument("a.md");
    put("a.md", "same");
    await doc.edit(() => "same");
    await doc.refresh();
    expect(doc.status).toEqual({ state: "ready" });
  });

  it("keep what was typed in a note someone deleted", async () => {
    put("a.md", "old");
    const doc = await openDocument("a.md");
    disk.delete("a.md");
    await doc.edit(() => "mine");
    expect(doc.status).toEqual({ state: "deleted" });
    await doc.keepMine();
    expect(disk.get("a.md")!.text).toBe("mine");
  });
});

describe("modifyNote", () => {
  it("changes closed notes on disk and open ones where they are open", async () => {
    put("a.md", "x");
    await modifyNote("a.md", (t) => `${t}y`);
    expect(disk.get("a.md")!.text).toBe("xy");
    const doc = await openDocument("a.md");
    await modifyNote("a.md", (t) => `${t}z`);
    expect(doc.text.toString()).toBe("xyz");
    expect(await readNote("a.md")).toBe("xyz");
  });

  it("tries again when someone else wrote in between", async () => {
    put("a.md", "x");
    let first = true;
    await modifyNote("a.md", (t) => {
      if (first) put("a.md", "theirs ");
      first = false;
      return `${t}+mine`;
    });
    expect(disk.get("a.md")!.text).toBe("theirs +mine");
  });
});
