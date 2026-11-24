import type { IDockviewPanelProps } from "dockview-react";
import { ExternalLink, FolderOpen } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { openExternally, revealInFileManager, run } from "../actions";
import { host } from "../backend/host";
import { NoteEditor } from "../editor/NoteEditor";
import { Button } from "../ui/primitives";
import { isImage, isNote, nameOf } from "../vault/paths";
import { useVault } from "../vault/store";
import type { PanelParams } from "./editorArea";
import { isText, useFileViewers, viewerFor, type FileViewer } from "./fileViewers";

/** A tab of the editor area: a note, or whatever shows its file. */
export function FilePanel({ api, params }: IDockviewPanelProps<PanelParams>) {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    const listener = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => listener.dispose();
  }, [api]);

  const { path } = params;
  const viewers = useFileViewers((s) => s.viewers);
  const viewer = viewerFor(path, viewers);
  if (viewer) return <PluginViewer key={`${viewer.id}:${path}`} viewer={viewer} path={path} />;
  if (isNote(path) || isText(path)) return <NoteEditor path={path} panelId={api.id} visible={visible} />;
  if (isImage(path)) return <ImageViewer path={path} />;
  return <UnknownFile path={path} />;
}

function PluginViewer({ viewer, path }: { viewer: FileViewer; path: string }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = document.createElement("div");
    element.className = "h-full";
    container.current!.append(element);
    let dispose: (() => void) | void;
    try {
      dispose = viewer.mount(element, path);
    } catch (e) {
      element.className = "cm-block-error m-4";
      element.textContent = e instanceof Error ? e.message : String(e);
    }
    return () => {
      try {
        dispose?.();
      } catch (e) {
        console.error(`${viewer.id} failed to clean up`, e);
      }
      element.remove();
    };
  }, [viewer, path]);
  return <div ref={container} className="h-full overflow-auto" />;
}

function ImageViewer({ path }: { path: string }) {
  const modified = useVault((s) => s.entries.get(path)?.modified);
  const [size, setSize] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto p-8">
      <img
        key={modified}
        src={host.vaultUrl(path)}
        alt={nameOf(path)}
        className="max-h-full min-h-0 max-w-full rounded-md object-contain"
        onLoad={(e) => setSize(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
      />
      <span className="text-[11.5px] text-subtle">{[nameOf(path), size].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

function UnknownFile({ path }: { path: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
      <p>Itztli doesn't show this kind of file.</p>
      <div className="flex gap-2">
        <Button onClick={() => run(openExternally(path))}>
          <ExternalLink className="size-3.5" /> Open with its app
        </Button>
        <Button onClick={() => run(revealInFileManager(path))}>
          <FolderOpen className="size-3.5" /> Show in folder
        </Button>
      </div>
    </div>
  );
}
