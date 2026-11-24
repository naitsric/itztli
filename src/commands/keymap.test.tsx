// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../backend/host", () => ({ host: { listen: () => () => {}, ask: async () => {}, call: async () => {}, desktop: false } }));
const { runMenuCommand } = await import("../menu/nativeMenu");
const { bindingFromEvent, formatKeybinding, resolveKey, useKeymap } = await import("./keymap");
const { holdKeymap, keymapHeld } = await import("./keymapHold");
const { registerCommands, useCommands } = await import("./registry");
type Command = import("./registry").Command;

// React's act() wants to know it runs in a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const command = (id: string, extra: Partial<Command> = {}): Command => ({
  id,
  title: id,
  category: "Test",
  keybinding: "$mod+Enter",
  run: () => {},
  ...extra,
});

describe("resolveKey", () => {
  const run = command("app.run");
  const task = command("edit.task", { context: "editor" });

  it("runs the command that applies", () => {
    expect(resolveKey([run, task], "editor", false)).toEqual({ action: "run", command: task });
    expect(resolveKey([run, task], undefined, false)).toEqual({ action: "run", command: run });
    expect(resolveKey([command("idle", { enabled: () => false })], undefined, false)).toEqual({ action: "pass" });
  });

  it("runs nothing while a dialog holds the keymap", () => {
    expect(resolveKey([run, task], "editor", true)).toEqual({ action: "pass" });
  });
});

describe("holding the keymap", () => {
  it("holds while any holder does", () => {
    const first = holdKeymap();
    const second = holdKeymap();
    first();
    expect(keymapHeld()).toBe(true);
    second();
    second();
    expect(keymapHeld()).toBe(false);
  });
});

describe("showing and recording keys", () => {
  it("shows them as each system writes them", () => {
    expect(formatKeybinding("$mod+Shift+KeyA", true)).toBe("⇧⌘A");
    expect(formatKeybinding("Control+Alt+BracketLeft", true)).toBe("⌃⌥[");
    expect(formatKeybinding("$mod+Shift+KeyA", false)).toBe("Shift+Ctrl+A");
    expect(formatKeybinding("F7", true)).toBe("F7");
  });

  it("records what can be bound without getting in the way of typing", () => {
    const press = (init: KeyboardEventInit) => bindingFromEvent(new KeyboardEvent("keydown", init));
    expect(press({ key: "a", code: "KeyA" })).toBeNull();
    expect(press({ key: "A", code: "KeyA", shiftKey: true })).toBeNull();
    expect(press({ key: "Meta", code: "MetaLeft", metaKey: true })).toBeNull();
    expect(press({ key: "F6", code: "F6", shiftKey: true })).toBe("Shift+F6");
    expect(press({ key: "å", code: "KeyA", altKey: true, shiftKey: true })).toBe("Alt+Shift+KeyA");
  });
});

describe("useKeymap", () => {
  const ran: string[] = [];
  const searched = vi.fn();
  let root: Root;
  let unregister: () => void;

  function Host() {
    useKeymap(searched);
    return <button type="button">focus</button>;
  }

  beforeEach(async () => {
    ran.length = 0;
    searched.mockClear();
    useCommands.setState({ overrides: {} });
    unregister = registerCommands([
      command("app.run", { run: () => void ran.push("app.run") }),
      command("view.graph", { keybinding: "$mod+Digit8", run: () => void ran.push("view.graph") }),
    ]);
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Host />));
  });

  afterEach(async () => {
    unregister();
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  /** tinykeys reads `$mod` from the platform: ⌘ on macOS, Ctrl elsewhere (happy-dom says Linux). */
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

  function press(key: string, code: string, modifiers: KeyboardEventInit = mod) {
    const event = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...modifiers });
    document.querySelector("button")!.dispatchEvent(event);
    return event;
  }

  function tapShift() {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
  }

  it("runs a command on its key and consumes the key", () => {
    const event = press("Enter", "Enter");
    expect(ran).toEqual(["app.run"]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("runs on the user's keys instead of the command's", async () => {
    await act(async () => useCommands.setState({ overrides: { "app.run": "$mod+KeyJ", "view.graph": null } }));
    press("Enter", "Enter");
    press("8", "Digit8");
    expect(ran).toEqual([]);
    press("j", "KeyJ");
    expect(ran).toEqual(["app.run"]);
  });

  it("opens search on two bare Shift taps", () => {
    tapShift();
    press("a", "KeyA", {});
    tapShift();
    expect(searched).not.toHaveBeenCalled();
    tapShift();
    expect(searched).toHaveBeenCalledOnce();
  });

  it("runs no shortcut, menu command or Shift Shift while a dialog holds it", () => {
    const release = holdKeymap();
    const enter = press("Enter", "Enter");
    runMenuCommand("view.graph");
    tapShift();
    tapShift();
    expect(ran).toEqual([]);
    expect(searched).not.toHaveBeenCalled();
    // The dialog's own keys work as usual.
    expect(enter.defaultPrevented).toBe(false);

    release();
    runMenuCommand("view.graph");
    expect(ran).toEqual(["view.graph"]);
  });
});
