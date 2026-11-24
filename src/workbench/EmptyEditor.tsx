import { bindingOf, executeCommand, useCommands } from "../commands/registry";
import { Kbd } from "../ui/primitives";

const SHOWN = [
  ["search.everywhere", "Search Everywhere", "⇧⇧"],
  ["navigate.note", "Go to Note", null],
  ["navigate.recent", "Recent Files", null],
  ["file.newNote", "New Note", null],
  ["search.findInFiles", "Find in Files", null],
  ["search.findAction", "Find Action", null],
] as const;

/** What the editor area shows with nothing open, as IntelliJ's. */
export function EmptyEditor() {
  const commands = useCommands((s) => s.commands);
  const overrides = useCommands((s) => s.overrides);
  return (
    <div className="flex h-full items-center justify-center">
      <ul className="flex flex-col gap-1">
        {SHOWN.map(([id, title, keys]) => {
          const command = commands[id];
          const binding = command && bindingOf(command, overrides);
          return (
            <li key={id}>
              <button
                type="button"
                className="flex w-64 items-center justify-between rounded-md px-3 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg"
                onClick={() => executeCommand(id)}
              >
                {title}
                {keys ? <Kbd>{keys}</Kbd> : binding && <Kbd binding={binding} />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
