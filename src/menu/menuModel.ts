import { bindingOf, type Command } from "../commands/registry";

/**
 * The native menu bar, derived from the command registry: every registered
 * command lands in a menu by its category, so new commands show up without
 * touching this file. Rust only materializes the model (src-tauri/src/menu.rs).
 */

export type PredefinedItem =
  | "about"
  | "services"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "minimize"
  | "zoom"
  | "fullscreen";

export type MenuEntry =
  | { kind: "command"; commandId: string; title: string; accelerator: string | null }
  | { kind: "predefined"; name: PredefinedItem }
  | { kind: "link"; title: string; url: string }
  | { kind: "separator" };

export interface MenuSpec {
  title: string;
  items: MenuEntry[];
}

export const REPOSITORY_URL = "https://github.com/naitsric/itztli";

type MenuId = "file" | "edit" | "format" | "view" | "navigate" | "refactor" | "tools";

/** Top-level menus in bar order, after the app menu. Window and Help are fixed. */
const MENUS: { id: MenuId; title: string }[] = [
  { id: "file", title: "File" },
  { id: "edit", title: "Edit" },
  { id: "format", title: "Format" },
  { id: "view", title: "View" },
  { id: "navigate", title: "Navigate" },
  { id: "refactor", title: "Refactor" },
  { id: "tools", title: "Tools" },
];

/**
 * Where each command category goes, in section order within its menu.
 * Categories not listed fall into Tools, so nothing registered is ever
 * missing from the menu bar; a plugin's commands land there under its name.
 */
const CATEGORY_MENU: [category: string, menu: MenuId][] = [
  ["File", "file"],
  ["Vault", "file"],
  ["Find", "edit"],
  ["Edit", "edit"],
  ["Format", "format"],
  ["View", "view"],
  ["Tool Windows", "view"],
  ["Tabs", "view"],
  ["Appearance", "view"],
  ["Navigate", "navigate"],
  ["Refactor", "refactor"],
];

/**
 * Commands of this category go to the app menu, in place of the predefined
 * Quit: Itztli's saves every note first, and the predefined item ends the
 * app without waiting for anyone.
 */
const APP_CATEGORY = "Application";

/**
 * Keys the webview itself must receive. AppKit gives menu key equivalents
 * priority, so an accelerator on these would stop them from reaching inputs,
 * or CodeMirror.
 */
const RESERVED_KEYS = new Set([
  "$mod+KeyA",
  "$mod+KeyB",
  "$mod+KeyC",
  "$mod+KeyV",
  "$mod+KeyX",
  "$mod+KeyZ",
  "$mod+Shift+KeyZ",
  "$mod+KeyF",
  "$mod+KeyG",
  "$mod+Shift+KeyG",
  "$mod+KeyD",
  "$mod+Slash",
  "$mod+Backspace",
  "$mod+ArrowUp",
  "$mod+ArrowDown",
  "$mod+ArrowLeft",
  "$mod+ArrowRight",
  "Control+KeyG",
  "Alt+Shift+ArrowUp",
  "Alt+Shift+ArrowDown",
]);

const MODIFIERS: Record<string, string> = {
  $mod: "CmdOrCtrl",
  Meta: "Cmd",
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
};

/**
 * tinykeys syntax (`$mod+Shift+KeyA`) as a Tauri accelerator
 * (`CmdOrCtrl+Shift+A`), or `null` for chords and keys it cannot express.
 */
export function toAccelerator(binding: string): string | null {
  if (binding.includes(" ")) return null; // multi-press sequences
  const parts = binding.split("+");
  const key = parts.pop();
  if (!key) return null;
  const modifiers: string[] = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part];
    if (!modifier) return null;
    modifiers.push(modifier);
  }
  const keyName = /^Key[A-Z]$/.test(key)
    ? key.slice(3)
    : /^Digit\d$/.test(key)
      ? key.slice(5)
      : /^([A-Z][a-z]+)+$|^F\d{1,2}$/.test(key)
        ? key
        : null;
  return keyName ? [...modifiers, keyName].join("+") : null;
}

/**
 * The accelerator a command's menu item shows, if any. Only bindings that
 * mean the same thing everywhere get one: no focus context, not shared with
 * another command, not a key the editors and fields need. Everything else
 * stays with the JS keymap, which resolves context.
 */
export function menuAccelerator(
  command: Command,
  all: readonly Command[],
  overrides: Record<string, string | null> = {},
): string | null {
  const binding = bindingOf(command, overrides);
  if (!binding || command.context || RESERVED_KEYS.has(binding)) return null;
  const shared = all.some((other) => other.id !== command.id && bindingOf(other, overrides) === binding);
  return shared ? null : toAccelerator(binding);
}

export function buildMenuModel(
  commands: readonly Command[],
  overrides: Record<string, string | null> = {},
): MenuSpec[] {
  const menuOf = new Map(CATEGORY_MENU);
  const categoryOrder = new Map(CATEGORY_MENU.map(([category], i) => [category, i]));

  // menu → category → commands, keeping registration order within a category.
  const sections = new Map<MenuId, Map<string, Command[]>>();
  const appCommands: Command[] = [];
  for (const command of commands) {
    if (command.category === APP_CATEGORY) {
      appCommands.push(command);
      continue;
    }
    const menu = menuOf.get(command.category) ?? "tools";
    const byCategory = sections.get(menu) ?? new Map<string, Command[]>();
    byCategory.set(command.category, [...(byCategory.get(command.category) ?? []), command]);
    sections.set(menu, byCategory);
  }

  const commandItems = (menu: MenuId): MenuEntry[] => {
    const byCategory = sections.get(menu);
    if (!byCategory) return [];
    const ordered = [...byCategory].sort(
      ([a], [b]) => (categoryOrder.get(a) ?? Infinity) - (categoryOrder.get(b) ?? Infinity),
    );
    return ordered.flatMap(([, items], i) => [
      ...(i > 0 ? [{ kind: "separator" } as const] : []),
      ...items.map(
        (c): MenuEntry => ({ kind: "command", commandId: c.id, title: c.title, accelerator: menuAccelerator(c, commands, overrides) }),
      ),
    ]);
  };

  const predefined = (...names: PredefinedItem[]): MenuEntry[] => names.map((name) => ({ kind: "predefined", name }));
  const separator: MenuEntry = { kind: "separator" };
  const appItems: MenuEntry[] = appCommands.map((c) => ({
    kind: "command",
    commandId: c.id,
    title: c.title,
    accelerator: menuAccelerator(c, commands, overrides),
  }));

  const app: MenuSpec = {
    title: "Itztli",
    items: [
      ...predefined("about"),
      separator,
      ...predefined("services"),
      separator,
      ...predefined("hide", "hideOthers", "showAll"),
      separator,
      ...(appItems.length > 0 ? appItems : predefined("quit")),
    ],
  };

  const menus: MenuSpec[] = [app];
  for (const { id, title } of MENUS) {
    const items = commandItems(id);
    if (id === "edit") {
      const standard = [...predefined("undo", "redo"), separator, ...predefined("cut", "copy", "paste", "selectAll")];
      menus.push({ title, items: items.length ? [...standard, separator, ...items] : standard });
    } else if (items.length) {
      menus.push({ title, items });
    }
  }
  menus.push({ title: "Window", items: predefined("minimize", "zoom", "fullscreen") });
  menus.push({ title: "Help", items: [{ kind: "link", title: "Itztli on GitHub", url: REPOSITORY_URL }] });
  return menus;
}
