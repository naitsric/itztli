import { describe, expect, it } from "vitest";
import { bindingOf, isEnabled, pickCommand, type Command } from "./registry";

const command = (id: string, extra: Partial<Command> = {}): Command => ({ id, title: id, category: "Test", run: () => {}, ...extra });

describe("pickCommand", () => {
  const global = command("global");
  const editor = command("editor", { context: "editor" });

  it("prefers what is bound to where focus is", () => {
    expect(pickCommand([global, editor], "editor")).toBe(editor);
    expect(pickCommand([global, editor], "vault")).toBe(global);
    expect(pickCommand([editor], undefined)).toBeUndefined();
  });

  it("falls back when the preferred one is disabled", () => {
    const off = command("off", { context: "editor", enabled: () => false });
    expect(pickCommand([off, global], "editor")).toBe(global);
  });

  it("never lets a plugin take a key the app uses", () => {
    const plugin = command("plugin", { plugin: "demo" });
    expect(pickCommand([plugin, global], undefined)).toBe(global);
    expect(pickCommand([plugin, command("off", { enabled: () => false })], undefined)).toBe(plugin);
  });
});

describe("bindings", () => {
  it("are the user's, or the command's own", () => {
    const c = command("a", { keybinding: "$mod+KeyA" });
    expect(bindingOf(c, {})).toBe("$mod+KeyA");
    expect(bindingOf(c, { a: "$mod+KeyB" })).toBe("$mod+KeyB");
    expect(bindingOf(c, { a: null })).toBeUndefined();
  });
});

describe("isEnabled", () => {
  it("takes a failing check as no", () => {
    expect(isEnabled(command("bad", { enabled: () => { throw new Error("x"); } }))).toBe(false);
  });
});
