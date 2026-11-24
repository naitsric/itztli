import { useEffect, useState } from "react";
import { EditorPane } from "./EditorPane";
import { Splitter } from "./Splitter";
import { Stripe } from "./Stripe";
import { ToolWindowPane } from "./ToolWindowPane";
import { resizeToolWindow, useToolWindows, type Side } from "./toolWindows";

const MIN: Record<Side, number> = { left: 180, right: 200, bottom: 120 };

/** Stripes, tool windows and the editor area: an IDE's window. */
export function Workbench() {
  const all = useToolWindows((s) => s.all);
  const open = useToolWindows((s) => s.open);
  const size = useToolWindows((s) => s.size);
  const [area, setArea] = useState({ width: window.innerWidth, height: window.innerHeight });

  useEffect(() => {
    const onResize = () => setArea({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const shows = (side: Side) => {
    const id = open[side];
    return !!id && all[id]?.side === side;
  };
  // A window never takes so much that there is no room left to write.
  const limit: Record<Side, number> = {
    left: Math.max(MIN.left, area.width * 0.4),
    right: Math.max(MIN.right, area.width * 0.4),
    bottom: Math.max(MIN.bottom, area.height * 0.6),
  };
  const px = (side: Side) => Math.min(Math.max(size[side], MIN[side]), limit[side]);

  return (
    <div className="flex h-full">
      <Stripe edge="left" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          {shows("left") && (
            <>
              <div style={{ width: px("left") }} className="min-h-0 shrink-0">
                <ToolWindowPane side="left" />
              </div>
              <Splitter
                orientation="vertical"
                label="Resize left tool window"
                size={px("left")}
                min={MIN.left}
                max={() => limit.left}
                grows={1}
                onResize={(v) => resizeToolWindow("left", v)}
              />
            </>
          )}
          <div className="island min-w-0 flex-1">
            <EditorPane />
          </div>
          {shows("right") && (
            <>
              <Splitter
                orientation="vertical"
                label="Resize right tool window"
                size={px("right")}
                min={MIN.right}
                max={() => limit.right}
                grows={-1}
                onResize={(v) => resizeToolWindow("right", v)}
              />
              <div style={{ width: px("right") }} className="min-h-0 shrink-0">
                <ToolWindowPane side="right" />
              </div>
            </>
          )}
        </div>
        {shows("bottom") && (
          <>
            <Splitter
              orientation="horizontal"
              label="Resize bottom tool window"
              size={px("bottom")}
              min={MIN.bottom}
              max={() => limit.bottom}
              grows={-1}
              onResize={(v) => resizeToolWindow("bottom", v)}
            />
            <div style={{ height: px("bottom") }} className="min-h-0 shrink-0">
              <ToolWindowPane side="bottom" />
            </div>
          </>
        )}
      </div>
      <Stripe edge="right" />
    </div>
  );
}
