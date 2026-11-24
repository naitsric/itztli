import { ChevronsDownUp, Crosshair, FilePlus, Folder, FolderOpen, FolderPlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { moveEntry, newFolder, newNote, run } from "../actions";
import type { Entry } from "../backend/api";
import { useFileMenu } from "../plugins/fileMenu";
import { useSettings } from "../settings/store";
import { CommandItem, ContextMenuContent, ContextMenuItem, ContextMenuRoot, ContextMenuSeparator, ContextMenuTrigger } from "../ui/ContextMenu";
import { FileIcon } from "../ui/FileIcon";
import { Marked } from "../ui/Highlight";
import { IconButton } from "../ui/primitives";
import { TreeView, type TreeRow } from "../ui/TreeView";
import { displayName, joinPath, nameOf, parentOf, isWithin } from "../vault/paths";
import { useVault } from "../vault/store";
import { updateWorkspaceState, workspaceState } from "../vault/workspaceState";
import { openPath, useEditorArea } from "../workbench/editorArea";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { useVaultReveal, useVaultSelection } from "./vaultReveal";
import { filteredRows, groupByFolder, treeRows } from "./vaultTree";

export function VaultWindow() {
  const info = useVault((s) => s.info);
  const structure = useVault((s) => s.structure);
  const showAttachments = useSettings((s) => s.files.showAttachments);
  const singleClick = useSettings((s) => s.files.singleClickOpens);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(workspaceState().expandedFolders));
  const [query, setQuery] = useState("");
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menuEntry, setMenuEntry] = useState<Entry | null>(null);
  const selected = useVaultSelection((s) => s.path);
  const reveal = useVaultReveal();

  const groups = useMemo(
    () => groupByFolder(useVault.getState().entries.values(), showAttachments),
    // The entries are replaced in place; this counter is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structure, showAttachments],
  );
  const rows = useMemo(() => (query ? filteredRows(groups, query) : treeRows(groups, expanded)), [groups, expanded, query]);

  const changeExpanded = useCallback((change: (folders: Set<string>) => void) => {
    setExpanded((before) => {
      const next = new Set(before);
      change(next);
      updateWorkspaceState({ expandedFolders: [...next] });
      return next;
    });
  }, []);

  const show = useCallback(
    (path: string) => {
      setQuery("");
      changeExpanded((folders) => {
        for (let p = parentOf(path); p; p = parentOf(p)) folders.add(p);
      });
      useVaultSelection.setState({ path });
    },
    [changeExpanded],
  );

  useEffect(() => {
    if (reveal.path) show(reveal.path);
  }, [reveal, show]);

  const follow = useSettings((s) => s.files.followOpenFile);
  const activePath = useEditorArea((s) => s.activePath);
  useEffect(() => {
    if (!follow || !activePath) return;
    changeExpanded((folders) => {
      for (let p = parentOf(activePath); p; p = parentOf(p)) folders.add(p);
    });
    useVaultSelection.setState({ path: activePath });
  }, [follow, activePath, changeExpanded]);

  const open = (row: TreeRow<Entry>, how: "click" | "double" | "key") => {
    const { path, folder } = row.data;
    if (folder) return changeExpanded((f) => void (f.has(path) ? f.delete(path) : f.add(path)));
    if (how === "click") openPath(path, { preview: true, focus: false });
    else openPath(path);
    if (how === "key") setQuery("");
  };

  const onDrop = (folder: string) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const from = e.dataTransfer.getData("application/x-itztli-path");
    if (from && canDrop(from, folder)) run(moveEntry(from, joinPath(folder, nameOf(from))), "Not moved");
  };
  const onDragOver = (folder: string) => (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("application/x-itztli-path")) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(folder);
  };

  const here = menuEntry ? (menuEntry.folder ? menuEntry.path : parentOf(menuEntry.path)) : "";
  return (
    <>
      <ToolWindowHeader title={info?.name ?? "Vault"} icon="folder" onHide={() => hideToolWindow("vault")}>
        <IconButton label="New note" className="size-6" onClick={() => run(newNote(folderOfSelection()))}>
          <FilePlus className="size-3.5" />
        </IconButton>
        <IconButton label="New folder" className="size-6" onClick={() => run(newFolder(folderOfSelection()))}>
          <FolderPlus className="size-3.5" />
        </IconButton>
        <IconButton
          label="Select the open file"
          className="size-6"
          onClick={() => {
            const path = useEditorArea.getState().activePath;
            if (path) show(path);
          }}
        >
          <Crosshair className="size-3.5" />
        </IconButton>
        <IconButton label="Collapse all" className="size-6" onClick={() => changeExpanded((f) => f.clear())}>
          <ChevronsDownUp className="size-3.5" />
        </IconButton>
      </ToolWindowHeader>
      <ContextMenuRoot onOpenChange={(isOpen) => !isOpen && setMenuEntry(null)}>
        <ContextMenuTrigger asChild>
          <div
            className={`flex min-h-0 flex-1 flex-col ${dropTarget === "" ? "bg-accent-soft" : ""}`}
            onDragOver={onDragOver("")}
            onDragLeave={() => setDropTarget(null)}
            onDrop={onDrop("")}
          >
            <TreeView
              label="Vault"
              focusContext="vault"
              rows={rows}
              selected={selected}
              query={query}
              onQuery={setQuery}
              activateOnClick={singleClick}
              onSelect={(row) => useVaultSelection.setState({ path: row.id })}
              onActivate={open}
              onToggle={(row, expand) => changeExpanded((f) => void (expand ? f.add(row.id) : f.delete(row.id)))}
              onContextMenu={(row) => setMenuEntry(row?.data ?? null)}
              empty={<Empty filtered={!!query} />}
              rowProps={(row) => {
                const folder = row.data.folder ? row.id : parentOf(row.id);
                return {
                  draggable: true,
                  onDragStart: (e) => {
                    e.dataTransfer.setData("application/x-itztli-path", row.id);
                    e.dataTransfer.setData("text/plain", row.data.folder ? row.id : `[[${displayName(row.id)}]]`);
                    e.dataTransfer.effectAllowed = "copyMove";
                  },
                  onDragOver: onDragOver(folder),
                  onDrop: onDrop(folder),
                  className: dropTarget && row.id === dropTarget ? "ring-1 ring-accent ring-inset" : undefined,
                  title: row.data.folder ? undefined : row.id,
                };
              }}
            >
              {(row, { query: q }) => (
                <>
                  {row.data.folder ? (
                    row.expanded ? (
                      <FolderOpen className="size-3.5 shrink-0 text-muted" />
                    ) : (
                      <Folder className="size-3.5 shrink-0 text-muted" />
                    )
                  ) : (
                    <FileIcon path={row.id} />
                  )}
                  <span className="truncate">
                    <Marked text={row.label} query={q} />
                  </span>
                </>
              )}
            </TreeView>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem label="New Note…" onSelect={() => run(newNote(here))} />
          <ContextMenuItem label="New Folder…" onSelect={() => run(newFolder(here))} />
          {menuEntry && (
            <>
              <ContextMenuSeparator />
              {!menuEntry.folder && (
                <>
                  <ContextMenuItem label="Open" onSelect={() => openPath(menuEntry.path)} />
                  <ContextMenuItem label="Open in a Split" onSelect={() => openPath(menuEntry.path, { split: true })} />
                  <CommandItem id="navigate.findUsages" />
                  <CommandItem id="refactor.duplicate" />
                  <CommandItem id="file.localHistory" />
                  <CommandItem id="file.copyLink" />
                </>
              )}
              <CommandItem id="file.copyPath" />
              <CommandItem id="file.reveal" />
              <ContextMenuSeparator />
              <CommandItem id="refactor.rename" />
              <CommandItem id="refactor.move" />
              <CommandItem id="refactor.delete" />
              <PluginItems entry={menuEntry} />
            </>
          )}
        </ContextMenuContent>
      </ContextMenuRoot>
    </>
  );
}

function PluginItems({ entry }: { entry: Entry }) {
  const items = useFileMenu((s) => s.items).filter((i) => i.when?.(entry) ?? true);
  if (items.length === 0) return null;
  return (
    <>
      <ContextMenuSeparator />
      {items.map((item) => (
        <ContextMenuItem key={item.key} label={item.title} onSelect={() => item.run(entry)} />
      ))}
    </>
  );
}

function canDrop(from: string, folder: string): boolean {
  return parentOf(from) !== folder && !isWithin(folder, from);
}

export function folderOfSelection(): string {
  const { path } = useVaultSelection.getState();
  if (!path) return "";
  return useVault.getState().entries.get(path)?.folder ? path : parentOf(path);
}

function Empty({ filtered }: { filtered: boolean }) {
  return <p className="px-4 py-3 text-[12.5px] text-subtle">{filtered ? "Nothing matches" : "This vault is empty. Press ⌘N to write its first note."}</p>;
}
