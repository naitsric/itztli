import { describe, expect, it } from "vitest";
import type { Command } from "../commands/registry";
import { findCommands } from "./actionSearch";

const command = (title: string, extra: Partial<Command> = {}): Command => ({ id: title, title, category: "X", run: () => {}, ...extra });
const commands = [
  command("Find in Files"),
  command("Find Action"),
  command("Go to Note"),
  command("Toggle Live Preview", { keywords: ["source mode"] }),
  command("New Note"),
];
const find = (query: string) => findCommands(commands, query, 10).map((c) => c.title);

describe("findCommands", () => {
  it("ranks what starts like the query first", () => {
    expect(find("find")).toEqual(["Find Action", "Find in Files"]);
    expect(find("new note")[0]).toBe("New Note");
  });
  it("matches words in any order, initials and keywords", () => {
    expect(find("files find")).toEqual(["Find in Files"]);
    expect(find("gtn")).toEqual(["Go to Note"]);
    expect(find("source")).toEqual(["Toggle Live Preview"]);
    expect(find("zzz")).toEqual([]);
  });
  it("offers everything before typing", () => {
    expect(find("")).toHaveLength(5);
  });
});
