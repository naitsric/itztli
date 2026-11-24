import { Minus } from "lucide-react";
import { Component, Suspense, useLayoutEffect, useRef, type ReactNode } from "react";
import { Icon } from "../ui/icons";
import { IconButton } from "../ui/primitives";
import { hideToolWindow, useToolWindows, type Side, type ToolWindow } from "./toolWindows";

/** What a tool window puts in its header, next to the title. */
export function ToolWindowHeader({ title, icon, children, onHide }: { title: string; icon: string; children?: ReactNode; onHide: () => void }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 pr-1.5 pl-3">
      <Icon icon={icon} className="size-3.5 shrink-0 text-subtle" />
      <span className="truncate text-[12.5px] font-semibold text-fg">{title}</span>
      <div className="ml-auto flex items-center">
        {children}
        <IconButton label="Hide" className="size-6" onClick={onHide}>
          <Minus className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

/** One window's failure is not the workbench's. */
class Contained extends Component<{ title: string; children: ReactNode }, { error: string | null }> {
  override state = { error: null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  override render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="p-4 text-[12.5px] text-muted">
        {this.props.title} stopped working: <span className="selectable text-danger">{this.state.error}</span>
      </div>
    );
  }
}

export function ToolWindowPane({ side }: { side: Side }) {
  const id = useToolWindows((s) => s.open[side]);
  const window = useToolWindows((s) => (id ? s.all[id] : undefined));
  if (!window || window.side !== side) return null;
  return (
    <section
      key={window.id}
      data-tool-window={window.id}
      aria-label={window.title}
      className="island flex size-full min-h-0 flex-col outline-none"
      tabIndex={-1}
    >
      <Contained title={window.title}>
        <Suspense>{window.component ? <window.component /> : <Mounted window={window} />}</Suspense>
      </Contained>
    </section>
  );
}

/** A plugin's window: an element it fills. */
function Mounted({ window }: { window: ToolWindow }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = document.createElement("div");
    element.className = "min-h-full";
    host.current!.append(element);
    let dispose: (() => void) | void;
    try {
      dispose = window.mount?.(element);
    } catch (e) {
      element.className = "cm-block-error m-3";
      element.textContent = e instanceof Error ? e.message : String(e);
    }
    return () => {
      try {
        dispose?.();
      } catch (e) {
        console.error(`${window.id} failed to clean up`, e);
      }
      element.remove();
    };
  }, [window]);
  return (
    <>
      <ToolWindowHeader title={window.title} icon={window.icon} onHide={() => hideToolWindow(window.id)} />
      <div ref={host} className="min-h-0 flex-1 overflow-auto" />
    </>
  );
}
