import { ChevronRight, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./primitives";
import { useElementSize } from "./useElementSize";

export interface TreeRow<T> {
  id: string;
  depth: number;
  /** Whether it can be opened; `undefined` for leaves. */
  expanded?: boolean;
  /** What speed search looks at. */
  label: string;
  data: T;
}

interface TreeViewProps<T> {
  rows: readonly TreeRow<T>[];
  selected: string | null;
  onSelect: (row: TreeRow<T>) => void;
  /** Enter or a double click; also a click, with `activateOnClick`. */
  onActivate: (row: TreeRow<T>, how: "click" | "double" | "key") => void;
  onToggle?: (row: TreeRow<T>, expand: boolean) => void;
  children: (row: TreeRow<T>, state: { selected: boolean; query: string }) => ReactNode;
  label: string;
  /** Speed search, as in IntelliJ: typing filters. Whoever makes the rows applies it. */
  query?: string;
  onQuery?: (query: string) => void;
  rowProps?: (row: TreeRow<T>) => {
    draggable?: boolean;
    onDragStart?: (e: DragEvent) => void;
    onDragOver?: (e: DragEvent) => void;
    onDragLeave?: (e: DragEvent) => void;
    onDrop?: (e: DragEvent) => void;
    className?: string;
    title?: string;
  };
  onContextMenu?: (row: TreeRow<T> | null) => void;
  activateOnClick?: boolean;
  /** The selection looks focused though the keyboard is elsewhere, e.g. in a field above. */
  driven?: boolean;
  empty?: ReactNode;
  focusContext?: string;
}

export const ROW_HEIGHT = 25;
const OVERSCAN = 8;

/**
 * A tree, or a list, that only draws the rows on screen: a vault with fifty
 * thousand notes scrolls like one with fifty.
 */
export function TreeView<T>({
  rows,
  selected,
  onSelect,
  onActivate,
  onToggle,
  children,
  label,
  query = "",
  onQuery,
  rowProps,
  onContextMenu,
  activateOnClick,
  driven,
  empty,
  focusContext,
}: TreeViewProps<T>) {
  const { ref: sizeRef, height } = useElementSize<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const at = rows.findIndex((r) => r.id === selected);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  // What gets selected comes into view, by the keyboard or by anyone else.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || at < 0 || height === 0) return;
    const top = at * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + height) el.scrollTop = top + ROW_HEIGHT - height;
    // Only when the selection changes: scrolling away from it is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, height > 0]);

  // What is searched for is selected: a folder that only leads to it is not it.
  useEffect(() => {
    if (!query || rows.length === 0) return;
    const matches = (row: TreeRow<T> | undefined) => !!row?.label.toLowerCase().includes(query.toLowerCase());
    if (!matches(rows[at])) onSelect(rows.find(matches) ?? rows[0]!);
    // Only as it is typed: arrows may then go anywhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, rows]);

  const select = (index: number) => {
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (row) onSelect(row);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const row = rows[at];
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (!bare) return;
    switch (e.key) {
      case "ArrowDown":
        consume();
        return select(at + 1);
      case "ArrowUp":
        consume();
        return select(at < 0 ? 0 : at - 1);
      case "Home":
        consume();
        return select(0);
      case "End":
        consume();
        return select(rows.length - 1);
      case "PageDown":
      case "PageUp": {
        consume();
        const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
        return select(at + (e.key === "PageDown" ? page : -page));
      }
      case "ArrowRight":
        if (!row) return;
        consume();
        if (row.expanded === false) onToggle?.(row, true);
        else if (row.expanded) select(at + 1);
        return;
      case "ArrowLeft": {
        if (!row) return;
        consume();
        if (row.expanded) return onToggle?.(row, false);
        for (let i = at - 1; i >= 0; i--) if (rows[i]!.depth < row.depth) return select(i);
        return;
      }
      case "Enter":
        if (!row) return;
        consume();
        return onActivate(row, "key");
      case "Escape":
        if (!query) return;
        consume();
        return onQuery?.("");
      case "Backspace":
        if (!query) return;
        consume();
        return onQuery?.(query.slice(0, -1));
    }
    if (onQuery && e.key.length === 1 && (query || e.key !== " ")) {
      consume();
      onQuery(query + e.key);
    }
  };

  return (
    <div
      ref={sizeRef}
      className="relative min-h-0 flex-1"
      data-focus-context={focusContext}
      data-speed-search={query ? "" : undefined}
      // A row says so itself, and lets the event on: the menu opens further up.
      onContextMenu={(e) => {
        if (!(e.target as Element).closest("[role=treeitem]")) onContextMenu?.(null);
      }}
    >
      {query && (
        <div className="absolute top-1.5 right-2 z-10 flex items-center gap-1.5 rounded-md border border-accent bg-elevated px-2 py-0.5 text-[12px] text-fg shadow-popover">
          <Search className="size-3 text-subtle" />
          {query}
        </div>
      )}
      <div
        ref={scroller}
        role="tree"
        tabIndex={0}
        aria-label={label}
        aria-activedescendant={at >= 0 ? rowDomId(label, rows[at]!.id) : undefined}
        className="group/tree h-full overflow-x-hidden overflow-y-auto outline-none"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        {rows.length === 0 && empty}
        <div style={{ height: rows.length * ROW_HEIGHT + (rows.length ? 8 : 0) }} className="relative">
          {rows.slice(first, last).map((row, i) => {
            const isSelected = row.id === selected;
            const { className, ...props } = rowProps?.(row) ?? {};
            return (
              <div
                key={row.id}
                id={rowDomId(label, row.id)}
                role="treeitem"
                aria-selected={isSelected}
                aria-expanded={row.expanded}
                aria-level={row.depth + 1}
                style={{ top: (first + i) * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 6 + row.depth * 16 }}
                className={cx(
                  "absolute inset-x-1.5 flex items-center gap-1.5 rounded-md pr-2 text-[12.5px] whitespace-nowrap text-fg",
                  isSelected ? (driven ? "bg-accent-soft" : "bg-active group-focus/tree:bg-accent-soft") : "hover:bg-hover",
                  className,
                )}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  onSelect(row);
                }}
                onClick={(e) => {
                  if (activateOnClick && e.detail === 1) onActivate(row, "click");
                }}
                onDoubleClick={() => onActivate(row, "double")}
                onContextMenu={() => {
                  onSelect(row);
                  onContextMenu?.(row);
                }}
                {...props}
              >
                <span
                  className={cx("flex size-4 shrink-0 items-center justify-center text-subtle", row.expanded === undefined && "invisible")}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle?.(row, !row.expanded);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <ChevronRight className={cx("size-3.5 transition-transform", row.expanded && "rotate-90")} />
                </span>
                {children(row, { selected: isSelected, query })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function rowDomId(label: string, id: string): string {
  return `${label}-${id}`.replace(/\s+/g, "_");
}
