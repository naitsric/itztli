import { RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { bindingFromEvent, formatKeybinding } from "../commands/keymap";
import { bindingOf, useCommands, type Command } from "../commands/registry";
import { inputClass } from "../ui/Modal";
import { cx, IconButton, Kbd } from "../ui/primitives";
import { matchCommand } from "../search/actionSearch";
import { Page } from "./rows";
import { setKeybinding } from "./store";

/** Commands whose keys clash with a binding: same key, and places that overlap. */
export function conflicts(command: Command, binding: string, all: readonly Command[], overrides: Record<string, string | null>): Command[] {
  return all.filter(
    (other) =>
      other.id !== command.id &&
      bindingOf(other, overrides) === binding &&
      (other.context === undefined || command.context === undefined || other.context === command.context),
  );
}

export function KeymapPage() {
  const commands = useCommands((s) => s.commands);
  const overrides = useCommands((s) => s.overrides);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const all = useMemo(() => Object.values(commands), [commands]);

  const groups = useMemo(() => {
    const byCategory = new Map<string, Command[]>();
    for (const command of all) {
      const binding = bindingOf(command, overrides);
      const keys = binding ? formatKeybinding(binding).toLowerCase() : "";
      if (query && matchCommand(command, query) === 0 && !keys.includes(query.toLowerCase())) continue;
      byCategory.set(command.category, [...(byCategory.get(command.category) ?? []), command]);
    }
    return [...byCategory].sort(([a], [b]) => a.localeCompare(b));
  }, [all, overrides, query]);

  // Heard on the window, before anyone else: what is pressed is the answer,
  // whatever has focus and whatever the keys do elsewhere.
  useEffect(() => {
    const command = recording ? useCommands.getState().commands[recording] : undefined;
    if (!command) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) return setRecording(null);
      const binding = bindingFromEvent(e);
      if (!binding) return;
      setKeybinding(command.id, binding === command.keybinding ? undefined : binding);
      setRecording(null);
    };
    const cancel = () => setRecording(null);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", cancel, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", cancel, true);
    };
  }, [recording]);

  return (
    <Page title="Keymap">
      <input
        aria-label="Search actions or keys"
        className={cx(inputClass, "mb-4 h-8")}
        placeholder="Search by action, or by keys: ⌘B"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />
      {groups.map(([category, list]) => (
        <section key={category} className="mb-4">
          <h3 className="mb-1 text-[12px] font-semibold text-muted">{category}</h3>
          {list.map((command) => {
            const binding = bindingOf(command, overrides);
            const changed = command.id in overrides;
            const clashing = binding ? conflicts(command, binding, all, overrides) : [];
            return (
              <div key={command.id} className="group flex h-8 items-center gap-2 rounded-md px-2 hover:bg-hover">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
                  {command.title}
                  {command.context && <span className="ml-2 text-[11px] text-subtle">in the {command.context === "vault" ? "vault tree" : command.context}</span>}
                </span>
                {clashing.length > 0 && (
                  <span className="truncate text-[11px] text-warning" title={clashing.map((c) => c.title).join(", ")}>
                    also {clashing[0]!.title}
                  </span>
                )}
                {recording === command.id ? (
                  <span role="status" className="flex h-6 items-center rounded-md border border-accent bg-inset px-2 text-[11.5px] text-accent">
                    Press the new keys… Esc cancels
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Change keys of ${command.title}`}
                    className="flex h-6 min-w-16 items-center justify-end rounded-md px-1 hover:bg-active"
                    onClick={() => setRecording(command.id)}
                  >
                    {binding ? <Kbd binding={binding} /> : <span className="text-[11.5px] text-subtle opacity-0 group-hover:opacity-100">Set keys</span>}
                  </button>
                )}
                <span className="flex w-12 justify-end">
                  {changed && (
                    <IconButton label="Back to its own keys" className="size-5" onClick={() => setKeybinding(command.id, undefined)}>
                      <RotateCcw className="size-3" />
                    </IconButton>
                  )}
                  {binding && (
                    <IconButton label="Take its keys off" className="size-5 opacity-0 group-hover:opacity-100" onClick={() => setKeybinding(command.id, command.keybinding ? null : undefined)}>
                      <X className="size-3" />
                    </IconButton>
                  )}
                </span>
              </div>
            );
          })}
        </section>
      ))}
    </Page>
  );
}
