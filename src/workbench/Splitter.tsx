import { useRef, type PointerEvent } from "react";
import { cx } from "../ui/primitives";

/** The gap between two islands, to drag. Reports the size of the one it belongs to. */
export function Splitter({
  orientation,
  size,
  min,
  max,
  /** Which way dragging makes it bigger. */
  grows,
  onResize,
  label,
}: {
  orientation: "vertical" | "horizontal";
  size: number;
  min: number;
  max: () => number;
  grows: 1 | -1;
  onResize: (size: number) => void;
  label: string;
}) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const vertical = orientation === "vertical";
  const clamp = (value: number) => Math.round(Math.min(Math.max(value, min), max()));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { at: vertical ? e.clientX : e.clientY, size };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const moved = (vertical ? e.clientX : e.clientY) - start.current.at;
    onResize(clamp(start.current.size + moved * grows));
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={size}
      tabIndex={-1}
      className={cx(
        "group relative z-10 shrink-0",
        vertical ? "w-[var(--island-gap)] cursor-col-resize" : "h-[var(--island-gap)] cursor-row-resize",
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    >
      <div
        className={cx(
          "absolute rounded-full bg-accent opacity-0 transition-opacity delay-150 group-hover:opacity-100",
          vertical ? "inset-y-2 left-1/2 w-[2px] -translate-x-1/2" : "inset-x-2 top-1/2 h-[2px] -translate-y-1/2",
        )}
      />
    </div>
  );
}
