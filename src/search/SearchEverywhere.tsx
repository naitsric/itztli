import { Command as Cmdk } from "cmdk";
import { Hash, Search } from "lucide-react";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { run } from "../actions";
import { api, type FileHit, type HeadingHit, type TextResults } from "../backend/api";
import { useKeymapHold } from "../commands/keymapHold";
import { bindingOf, executeCommand, isEnabled, useCommands, type Command } from "../commands/registry";
import { Excerpted } from "../toolwindows/UsageTree";
import { FileIcon } from "../ui/FileIcon";
import { Matched } from "../ui/Highlight";
import {
  paletteContentClass,
  paletteGroupClass,
  paletteInputClass,
  paletteItemClass,
  paletteListClass,
  paletteOverlayClass,
} from "../ui/palette";
import { cx, Kbd } from "../ui/primitives";
import { displayName, parentOf } from "../vault/paths";
import { recentFiles } from "../vault/workspaceState";
import { openPath } from "../workbench/editorArea";
import { createNote } from "../actions";
import { findCommands } from "./actionSearch";
import { useSearchEverywhere, type SearchScope } from "./searchState";

const TABS: { scope: SearchScope; title: string; placeholder: string }[] = [
  { scope: "all", title: "All", placeholder: "Search notes, headings and actions" },
  { scope: "notes", title: "Notes", placeholder: "Go to note" },
  { scope: "files", title: "Files", placeholder: "Go to file, attachments included" },
  { scope: "headings", title: "Headings", placeholder: "Go to heading" },
  { scope: "text", title: "Text", placeholder: "Search in the text of notes" },
  { scope: "actions", title: "Actions", placeholder: "Find action" },
];

interface Found {
  query: string;
  files: FileHit[];
  headings: HeadingHit[];
  text: TextResults | null;
}

const NOTHING: Found = { query: "", files: [], headings: [], text: null };

/** How many of each kind the All tab shows. */
const FEW = 6;
const MANY = 60;

async function search(query: string, scope: SearchScope): Promise<Found> {
  if (!query.trim()) return { ...NOTHING, query };
  const all = scope === "all";
  const [files, headings, text] = await Promise.all([
    all || scope === "notes" || scope === "files" ? api.findFiles(stripLine(query).name, scope === "files" ? "files" : "notes", all ? 12 : MANY) : [],
    all || scope === "headings" ? api.findHeadings(query, all ? FEW : MANY) : [],
    scope === "text" && query.trim().length > 1 ? api.searchText({ text: query, limit: 200 }) : null,
  ]);
  return { query, files, headings, text };
}

/** `note:12` goes to a line, as in IntelliJ. */
function stripLine(query: string): { name: string; line?: number } {
  const match = /^(.+?):(\d+)$/.exec(query.trim());
  return match ? { name: match[1]!, line: Number(match[2]) - 1 } : { name: query };
}

export function SearchEverywhere() {
  const open = useSearchEverywhere((s) => s.open);
  return open ? <Dialog /> : null;
}

/**
 * Search Everywhere (⇧⇧), Go to Note (⌘O), Go to Heading (⌥⌘O), Find Action
 * (⇧⌘A): one palette with tabs, which Tab goes through. Matching is the
 * backend's, so it is as fast on a big vault as on a small one.
 */
function Dialog() {
  const { scope, show, hide } = useSearchEverywhere();
  const commands = useCommands((s) => s.commands);
  const overrides = useCommands((s) => s.overrides);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found>(NOTHING);
  const [selected, setSelected] = useState("");
  const tab = TABS.find((t) => t.scope === scope)!;

  useEffect(() => {
    let stale = false;
    // Text is read from disk: let a word be typed. The rest is instant.
    const timer = window.setTimeout(
      () => {
        search(query, scope)
          .then((next) => !stale && setFound(next))
          .catch((e) => console.error("search failed", e));
      },
      scope === "text" ? 120 : 0,
    );
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [query, scope]);

  // Let the dialog unmount and focus return before the action runs.
  const go = (action: () => void) => {
    hide();
    requestAnimationFrame(action);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const at = TABS.indexOf(tab);
      show(TABS[(at + (e.shiftKey ? -1 : 1) + TABS.length) % TABS.length]!.scope);
    }
  };

  const split = (e: unknown) => e instanceof KeyboardEvent && e.metaKey;
  const typed = query.trim();
  const has = (...scopes: SearchScope[]) => scope === "all" || scopes.includes(scope);
  const actions = has("actions") && (typed || scope === "actions") ? findCommands(Object.values(commands), typed, scope === "all" ? FEW : 300) : [];
  const recents = !typed && has("notes", "files") ? recentFiles().slice(0, scope === "all" ? 8 : 20) : [];
  const files = scope === "all" ? found.files.slice(0, 12) : found.files;
  const { line } = stripLine(query);
  const exact = files.some((f) => displayName(f.path).toLowerCase() === typed.toLowerCase());
  const offerNew = typed && has("notes") && scope !== "files" && !exact && !/[\\:*?"<>|#^[\]]/.test(typed) && found.query === query;
  const empty = files.length + found.headings.length + actions.length + recents.length + (found.text?.total ?? 0) === 0;

  // Results arrive after the keys that asked for them: the first one is
  // selected each time they change, and arrows move from there.
  const match = found.text?.files[0]?.matches[0];
  const first =
    (recents[0] && `recent ${recents[0]}`) ??
    (files[0] && `file ${files[0].path}`) ??
    (found.headings[0] && `heading ${found.headings[0].path}:${found.headings[0].line}`) ??
    (match && `text ${found.text!.files[0]!.path}:${match.line}:${match.col}`) ??
    (actions[0] && `action ${actions[0].id}`) ??
    (offerNew ? "new note" : "");
  useEffect(() => setSelected(first), [first, found]);

  return (
    <Cmdk.Dialog
      open
      onOpenChange={(o) => !o && hide()}
      label="Search Everywhere"
      loop
      shouldFilter={false}
      value={selected}
      onValueChange={setSelected}
      overlayClassName={paletteOverlayClass}
      contentClassName={cx(paletteContentClass, "w-[min(720px,calc(100vw-32px))]")}
      onKeyDown={onKeyDown}
    >
      <Hold />
      <div role="tablist" className="flex items-center gap-1 px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t.scope}
            type="button"
            role="tab"
            tabIndex={-1}
            aria-selected={t.scope === scope}
            className={cx(
              "h-6 rounded-md px-2.5 text-[12px] font-medium transition-colors",
              t.scope === scope ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
            )}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => show(t.scope)}
          >
            {t.title}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 border-b border-border px-3.5">
        <Search className="size-4 text-subtle" />
        <Cmdk.Input autoFocus value={query} onValueChange={setQuery} placeholder={tab.placeholder} className={paletteInputClass} />
        <Kbd>⇥</Kbd>
      </div>
      <Cmdk.List className={cx(paletteListClass, "max-h-[min(480px,62vh)]")}>
        {empty && !offerNew && (
          <div className="px-3 py-6 text-center text-[12.5px] text-muted">{typed ? "Nothing found" : "Type to search"}</div>
        )}

        {recents.length > 0 && (
          <Group heading="Recent">
            {recents.map((path) => (
              <FileItem key={path} value={`recent ${path}`} path={path} onSelect={() => go(() => openPath(path))} />
            ))}
          </Group>
        )}

        {files.length > 0 && (
          <Group heading={scope === "files" ? "Files" : "Notes"}>
            {files.map((hit) => (
              <FileItem key={hit.path} value={`file ${hit.path}`} path={hit.path} hit={hit} onSelect={(e) => go(() => openPath(hit.path, { line, split: split(e) }))} />
            ))}
          </Group>
        )}

        {found.headings.length > 0 && (
          <Group heading="Headings">
            {found.headings.map((h) => (
              <Cmdk.Item
                key={`${h.path}:${h.line}`}
                value={`heading ${h.path}:${h.line}`}
                className={cx(paletteItemClass, "group")}
                onSelect={() => go(() => openPath(h.path, { line: h.line }))}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Hash className="size-3.5 shrink-0 text-subtle group-data-[selected=true]:text-inherit" />
                  <span className="truncate">
                    <Matched text={h.text} positions={h.positions} />
                  </span>
                </span>
                <span className="muted shrink-0 truncate text-[12px] text-subtle">{displayName(h.path)}</span>
              </Cmdk.Item>
            ))}
          </Group>
        )}

        {found.text && found.text.files.length > 0 && (
          <Group heading={`Text · ${found.text.total}${found.text.truncated ? "+" : ""}`}>
            {found.text.files.flatMap((file) =>
              file.matches.slice(0, 5).map((m, i) => (
                <Cmdk.Item
                  key={`${file.path}:${m.line}:${m.col}:${i}`}
                  value={`text ${file.path}:${m.line}:${m.col}`}
                  className={cx(paletteItemClass, "group")}
                  onSelect={() => go(() => openPath(file.path, { line: m.line, col: m.col }))}
                >
                  <span className="min-w-0 truncate">
                    <Excerpted text={m.preview} from={m.previewCol} length={m.len} />
                  </span>
                  <span className="muted shrink-0 truncate text-[12px] text-subtle">
                    {displayName(file.path)}:{m.line + 1}
                  </span>
                </Cmdk.Item>
              )),
            )}
          </Group>
        )}

        {actions.length > 0 && (
          <Group heading="Actions">
            {actions.map((command) => (
              <ActionItem key={command.id} command={command} binding={bindingOf(command, overrides)} onSelect={() => go(() => executeCommand(command.id))} />
            ))}
          </Group>
        )}

        {offerNew && (
          <Group heading="New">
            <Cmdk.Item
              value="new note"
              className={paletteItemClass}
              onSelect={() =>
                go(() => {
                  const name = typed.replace(/^\/+|\/+$/g, "");
                  run(createNote(/\.md$/i.test(name) ? name : `${name}.md`).then((path) => openPath(path)));
                })
              }
            >
              <span className="truncate">Create note “{typed}”</span>
            </Cmdk.Item>
          </Group>
        )}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}

function Hold() {
  useKeymapHold();
  return null;
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <Cmdk.Group heading={heading} className={paletteGroupClass}>
      {children}
    </Cmdk.Group>
  );
}

function FileItem({ path, value, hit, onSelect }: { path: string; value: string; hit?: FileHit; onSelect: (e?: unknown) => void }) {
  const name = displayName(path);
  const folder = parentOf(path);
  const full = folder ? `${folder}/${name}` : name;
  return (
    <Cmdk.Item value={value} onSelect={() => onSelect(window.event)} className={cx(paletteItemClass, "group")}>
      <span className="flex min-w-0 items-center gap-2">
        <FileIcon path={path} />
        <span className="truncate">
          {hit?.alias ? (
            <>
              <Matched text={hit.alias} positions={hit.positions} />
              <span className="muted text-subtle"> → {name}</span>
            </>
          ) : (
            <Matched text={name} positions={hit && !hit.inPath ? hit.positions : []} />
          )}
        </span>
      </span>
      <span className="muted min-w-0 shrink truncate text-[12px] text-subtle">
        {hit?.inPath ? <Matched text={full} positions={hit.positions} /> : folder}
      </span>
    </Cmdk.Item>
  );
}

function ActionItem({ command, binding, onSelect }: { command: Command; binding?: string; onSelect: () => void }) {
  return (
    <Cmdk.Item value={`action ${command.id}`} disabled={!isEnabled(command)} onSelect={onSelect} className={paletteItemClass}>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{command.title}</span>
        <span className="muted text-[11.5px] text-subtle">{command.category}</span>
      </span>
      {binding && <Kbd binding={binding} />}
    </Cmdk.Item>
  );
}
