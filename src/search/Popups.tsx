import { Command as Cmdk } from "cmdk";
import { useEffect, useState, type ReactNode } from "react";
import { run } from "../actions";
import { useKeymapHold } from "../commands/keymapHold";
import { activeView, useActiveEditor } from "../editor/active";
import { contextActions, type ContextAction } from "../editor/contextActions";
import { goToHeading, useOutline } from "../toolwindows/StructureWindow";
import { useToolWindows, showToolWindow } from "../workbench/toolWindows";
import { FileIcon } from "../ui/FileIcon";
import { Icon } from "../ui/icons";
import { paletteContentClass, paletteInputClass, paletteItemClass, paletteListClass, paletteOverlayClass } from "../ui/palette";
import { cx } from "../ui/primitives";
import { displayName, parentOf } from "../vault/paths";
import { recentFiles } from "../vault/workspaceState";
import { openPath, useEditorArea } from "../workbench/editorArea";
import { FindInFiles } from "./FindInFiles";
import { showPopup, usePopup } from "./popupState";

export function Popups() {
  const popup = usePopup((s) => s.popup);
  switch (popup) {
    case "recentFiles":
      return <RecentFiles />;
    case "structure":
      return <FileStructure />;
    case "contextActions":
      return <ContextActions />;
    case "findInFiles":
      return <FindInFiles />;
    default:
      return null;
  }
}

const hide = () => showPopup(null);

/** Lets the popup go and focus return before acting. */
function after(action: () => void) {
  hide();
  requestAnimationFrame(action);
}

function Hold() {
  useKeymapHold();
  return null;
}

function Palette({ label, placeholder, children, width = 520, value, onValueChange }: { label: string; placeholder: string; children: ReactNode; width?: number; value?: string; onValueChange?: (v: string) => void }) {
  return (
    <Cmdk.Dialog
      open
      onOpenChange={(open) => !open && hide()}
      label={label}
      loop
      value={value}
      onValueChange={onValueChange}
      overlayClassName={paletteOverlayClass}
      contentClassName={cx(paletteContentClass, `w-[min(${width}px,calc(100vw-32px))]`)}
    >
      <Hold />
      <div className="flex items-center gap-2 border-b border-border px-3.5">
        <span className="shrink-0 text-[12px] font-medium text-muted">{label}</span>
        <Cmdk.Input autoFocus placeholder={placeholder} className={paletteInputClass} />
      </div>
      <Cmdk.List className={paletteListClass}>
        <Cmdk.Empty className="px-3 py-6 text-center text-[12.5px] text-muted">Nothing found</Cmdk.Empty>
        {children}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}

/** Recent Files (⌘E), with the tool windows too, as in IntelliJ. */
function RecentFiles() {
  const active = useEditorArea((s) => s.activePath);
  const windows = Object.values(useToolWindows((s) => s.all)).sort((a, b) => a.order - b.order);
  const files = recentFiles().filter((p) => p !== active);
  return (
    <Palette label="Recent Files" placeholder="">
      {files.map((path) => (
        <Cmdk.Item key={path} value={path} className={paletteItemClass} onSelect={() => after(() => openPath(path))}>
          <span className="flex min-w-0 items-center gap-2">
            <FileIcon path={path} />
            <span className="truncate">{displayName(path)}</span>
          </span>
          <span className="muted truncate text-[12px] text-subtle">{parentOf(path)}</span>
        </Cmdk.Item>
      ))}
      {files.length > 0 && <Cmdk.Separator className="my-1 h-px bg-border" />}
      {windows.map((w) => (
        <Cmdk.Item key={w.id} value={`window ${w.title}`} className={paletteItemClass} onSelect={() => after(() => showToolWindow(w.id))}>
          <span className="flex items-center gap-2">
            <Icon icon={w.icon} className="size-3.5 text-subtle" />
            {w.title}
          </span>
          <span className="muted text-[12px] text-subtle">Tool window</span>
        </Cmdk.Item>
      ))}
    </Palette>
  );
}

/** File Structure (⌘F12): the headings of the note, to jump to. */
function FileStructure() {
  const editor = useActiveEditor((s) => s.editor);
  const { items, current } = useOutline(editor);
  const [value, setValue] = useState("");
  useEffect(() => {
    const item = items[current];
    if (item) setValue(`${item.text} ${item.from}`.toLowerCase());
    // Where the caret was on opening; from then on it is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length > 0]);
  return (
    <Palette label="Structure" placeholder="" value={value || undefined} onValueChange={setValue}>
      {items.map((item) => (
        <Cmdk.Item
          key={item.from}
          value={`${item.text} ${item.from}`.toLowerCase()}
          className={paletteItemClass}
          onSelect={() => after(() => editor && goToHeading(editor, item, true))}
        >
          <span className="truncate" style={{ paddingLeft: (item.level - 1) * 14 }}>
            {item.text || "(empty)"}
          </span>
          <span className="muted text-[11px] text-subtle">H{item.level}</span>
        </Cmdk.Item>
      ))}
    </Palette>
  );
}

/** Show Context Actions (⌥⏎): what can be done here, by the caret. */
function ContextActions() {
  const [actions, setActions] = useState<ContextAction[] | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const view = activeView();
    if (!view) return hide();
    const at = view.coordsAtPos(view.state.selection.main.head);
    setPlace(at ? { left: at.left, top: at.bottom + 4 } : { left: 200, top: 200 });
    contextActions(view)
      .then(setActions)
      .catch((e) => {
        console.error("context actions failed", e);
        setActions([]);
      });
  }, []);

  if (!actions || !place) return null;
  const width = 300;
  const height = Math.min(320, 48 + actions.length * 30);
  const style = {
    left: Math.max(8, Math.min(place.left, window.innerWidth - width - 8)),
    top: place.top + height > window.innerHeight ? Math.max(8, place.top - height - 28) : place.top,
    width,
  };
  return (
    <Cmdk.Dialog
      open
      onOpenChange={(open) => !open && hide()}
      label="Context Actions"
      loop
      overlayClassName="fixed inset-0 z-50"
      contentClassName="fixed z-50 overflow-hidden rounded-lg border border-border-strong bg-elevated shadow-popover"
      // cmdk passes this to the dialog's content.
      {...{ style: undefined }}
    >
      <PlacedContent style={style} />
      <Hold />
      <Cmdk.Input autoFocus className="sr-only" aria-label="Filter actions" />
      <Cmdk.List className="max-h-[300px] overflow-y-auto p-1">
        <Cmdk.Empty className="px-3 py-2 text-[12.5px] text-muted">No actions here</Cmdk.Empty>
        {actions.map((action) => (
          <Cmdk.Item
            key={action.title}
            value={action.title}
            className={paletteItemClass}
            onSelect={() => after(() => run(Promise.resolve().then(action.run), action.title))}
          >
            <span className="truncate">{action.title}</span>
          </Cmdk.Item>
        ))}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}

/** cmdk has no way to style the dialog's content: this finds it and does. */
function PlacedContent({ style }: { style: { left: number; top: number; width: number } }) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const content = element?.closest<HTMLElement>("[role=dialog]");
    if (!content) return;
    Object.assign(content.style, { left: `${style.left}px`, top: `${style.top}px`, width: `${style.width}px` });
  }, [element, style.left, style.top, style.width]);
  return <span ref={setElement} hidden />;
}
