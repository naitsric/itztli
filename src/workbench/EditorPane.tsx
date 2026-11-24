import "dockview-react/dist/styles/dockview.css";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FunctionComponent } from "react";
import { focusEditorIn } from "../editor/active";
import { useDocuments } from "../editor/documents";
import { FileIcon } from "../ui/FileIcon";
import { cx } from "../ui/primitives";
import { displayName } from "../vault/paths";
import { entryAt } from "../vault/store";
import { updateWorkspaceState, workspaceState } from "../vault/workspaceState";
import { attachDockview, keepPanel, pathOf, syncActive, WELCOME_PANEL_ID, type PanelParams } from "./editorArea";
import { EmptyEditor } from "./EmptyEditor";
import { FilePanel } from "./FilePanel";

const theme: DockviewTheme = {
  name: "itztli",
  className: "dockview-theme-itztli",
  dndOverlayMounting: "absolute",
  dndTabIndicator: "line",
};

const components: Record<string, FunctionComponent<IDockviewPanelProps<any>>> = {
  file: FilePanel,
  welcome: EmptyEditor,
};

function Tab({ api, params, containerApi }: IDockviewPanelHeaderProps<PanelParams>) {
  const [title, setTitle] = useState(api.title ?? "");
  const path = params.path as string | undefined;
  const dirty = useDocuments((s) => !!(path && s.open[path]?.dirty));
  const trouble = useDocuments((s) => !!(path && s.open[path] && s.open[path].status.state !== "ready"));
  useEffect(() => {
    const listener = api.onDidTitleChange((e) => setTitle(e.title));
    return () => listener.dispose();
  }, [api]);

  const panel = containerApi.getPanel(api.id);
  return (
    <div
      className="group/tab flex h-full items-center gap-1.5 pr-1.5 pl-3 text-[12.5px]"
      title={path}
      onDoubleClick={() => panel && keepPanel(panel)}
      onAuxClick={(e) => e.button === 1 && api.close()}
    >
      {path && <FileIcon path={path} />}
      <span className={cx("max-w-[220px] truncate", params.preview && "italic", trouble && "text-warning")}>{title}</span>
      <button
        type="button"
        aria-label="Close tab"
        className="flex size-4 items-center justify-center rounded text-subtle hover:bg-active hover:text-fg"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          api.close();
        }}
      >
        {dirty ? <span className="size-1.5 rounded-full bg-accent group-hover/tab:hidden" /> : null}
        <X className={cx("size-3", dirty ? "hidden group-hover/tab:block" : "opacity-0 group-hover/tab:opacity-100 [.dv-active-tab_&]:opacity-60")} />
      </button>
    </div>
  );
}

function addWelcome(dockview: DockviewApi) {
  if (dockview.getPanel(WELCOME_PANEL_ID)) return;
  const panel = dockview.addPanel({ id: WELCOME_PANEL_ID, component: "welcome", title: "Start" });
  panel.group.header.hidden = true;
}

const SAVE_DELAY_MS = 300;

/** Where notes are: tabs, in groups one can split. Remounts with each vault. */
export function EditorPane() {
  const own = useRef<DockviewApi | null>(null);
  useEffect(() => {
    // Again, for when React runs effects twice: dockview is only ready once.
    if (own.current) attachDockview(own.current);
    return () => attachDockview(null);
  }, []);

  const onReady = ({ api: dockview }: DockviewReadyEvent) => {
    own.current = dockview;
    attachDockview(dockview);
    const { layout } = workspaceState();
    try {
      if (layout) dockview.fromJSON(layout as Parameters<DockviewApi["fromJSON"]>[0]);
    } catch (e) {
      console.error("layout not restored", e);
      dockview.clear();
    }
    // Files may have gone while the vault was closed.
    for (const panel of [...dockview.panels]) {
      const path = pathOf(panel);
      if (path === null ? panel.id !== WELCOME_PANEL_ID : !entryAt(path)) panel.api.close();
      else if (path) panel.api.setTitle(displayName(path));
    }
    if (dockview.panels.length === 0) addWelcome(dockview);
    const welcome = dockview.getPanel(WELCOME_PANEL_ID);
    if (welcome) welcome.group.header.hidden = true;
    syncActive();
    if (dockview.activePanel) focusEditorIn(dockview.activePanel.id);

    dockview.onDidActivePanelChange(() => syncActive());
    dockview.onDidRemovePanel(() => {
      if (dockview.panels.length === 0) addWelcome(dockview);
      syncActive();
    });

    let pending = 0;
    dockview.onDidLayoutChange(() => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => updateWorkspaceState({ layout: dockview.toJSON() }), SAVE_DELAY_MS);
    });
  };

  return (
    <DockviewReact
      className="h-full"
      theme={theme}
      components={components}
      defaultTabComponent={Tab}
      onReady={onReady}
      singleTabMode="default"
    />
  );
}
