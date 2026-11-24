import { describe, expect, it } from "vitest";
import type { Command } from "../commands/registry";
import { buildMenuModel, menuAccelerator, toAccelerator, type MenuEntry, type MenuSpec } from "./menuModel";

const command = (id: string, category: string, extra: Partial<Command> = {}): Command => ({
  id,
  title: id,
  category,
  run: () => {},
  ...extra,
});

const menu = (menus: MenuSpec[], title: string) => menus.find((m) => m.title === title);
const commandIds = (spec: MenuSpec | undefined) =>
  spec?.items.flatMap((i: MenuEntry) => (i.kind === "command" ? [i.commandId] : [])) ?? [];

describe("toAccelerator", () => {
  it.each([
    ["$mod+KeyO", "CmdOrCtrl+O"],
    ["$mod+Shift+KeyA", "CmdOrCtrl+Shift+A"],
    ["$mod+Digit1", "CmdOrCtrl+1"],
    ["$mod+Comma", "CmdOrCtrl+Comma"],
    ["$mod+F12", "CmdOrCtrl+F12"],
    ["Shift+F6", "Shift+F6"],
    ["Control+KeyG", "Ctrl+G"],
  ])("%s → %s", (binding, accelerator) => {
    expect(toAccelerator(binding)).toBe(accelerator);
  });

  it("rejects sequences, unknown modifiers and odd keys", () => {
    expect(toAccelerator("$mod+KeyK $mod+KeyC")).toBeNull();
    expect(toAccelerator("Hyper+KeyA")).toBeNull();
    expect(toAccelerator("$mod+a")).toBeNull();
  });
});

describe("menuAccelerator", () => {
  it("accelerates only unambiguous, global, non-reserved bindings, as the user set them", () => {
    const all = [
      command("navigate.note", "Navigate", { keybinding: "$mod+KeyO" }),
      command("app.run", "Tools", { keybinding: "$mod+Enter" }),
      command("edit.task", "Edit", { keybinding: "$mod+Enter", context: "editor" }),
      command("navigate.declaration", "Navigate", { keybinding: "$mod+KeyB", context: "editor" }),
      command("search.find", "Find", { keybinding: "$mod+KeyF" }),
    ];
    const byId = (id: string, overrides = {}) => menuAccelerator(all.find((c) => c.id === id)!, all, overrides);
    expect(byId("navigate.note")).toBe("CmdOrCtrl+O");
    expect(byId("navigate.note", { "navigate.note": "$mod+KeyP" })).toBe("CmdOrCtrl+P");
    expect(byId("navigate.note", { "navigate.note": null })).toBeNull();
    expect(byId("app.run")).toBeNull(); // shared with the editor
    expect(byId("edit.task")).toBeNull(); // bound to a context
    expect(byId("search.find")).toBeNull(); // ⌘F belongs to the editor
  });
});

describe("buildMenuModel", () => {
  const commands = [
    command("file.newNote", "File", { keybinding: "$mod+KeyN" }),
    command("vault.open", "Vault"),
    command("edit.duplicate", "Edit"),
    command("search.find", "Find"),
    command("view.toolWindow.vault", "Tool Windows", { keybinding: "$mod+Digit1" }),
    command("refactor.rename", "Refactor", { keybinding: "Shift+F6" }),
    command("demo.hello", "My Plugin", { plugin: "demo" }),
    command("app.quit", "Application", { keybinding: "$mod+KeyQ" }),
  ];
  const menus = buildMenuModel(commands);

  it("orders the bar like an IDE's", () => {
    expect(menus.map((m) => m.title)).toEqual(["Itztli", "File", "Edit", "View", "Refactor", "Tools", "Window", "Help"]);
  });

  it("puts every registered command somewhere; plugins' in Tools", () => {
    expect(menus.flatMap(commandIds).sort()).toEqual(commands.map((c) => c.id).sort());
    expect(commandIds(menu(menus, "Tools"))).toEqual(["demo.hello"]);
  });

  it("keeps the standard Edit items first so text fields keep ⌘C/⌘V", () => {
    const edit = menu(menus, "Edit")!.items;
    expect(edit.slice(0, 7).map((i) => (i.kind === "predefined" ? i.name : i.kind))).toEqual([
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "selectAll",
    ]);
  });

  it("replaces the predefined Quit, which would not wait for notes to be saved", () => {
    expect(menu(menus, "Itztli")!.items.at(-1)).toMatchObject({ kind: "command", commandId: "app.quit", accelerator: "CmdOrCtrl+Q" });
    expect(buildMenuModel([])[0]!.items.at(-1)).toEqual({ kind: "predefined", name: "quit" });
  });
});
