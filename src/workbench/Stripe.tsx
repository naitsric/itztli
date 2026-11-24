import { bindingOf, useCommands } from "../commands/registry";
import { formatKeybinding } from "../commands/keymap";
import { Icon } from "../ui/icons";
import { cx } from "../ui/primitives";
import { clickToolWindow, useToolWindows, type ToolWindow } from "./toolWindows";

/** The buttons on the window's edge: left and bottom windows on the left, right ones on the right. */
export function Stripe({ edge }: { edge: "left" | "right" }) {
  const all = useToolWindows((s) => s.all);
  const sorted = Object.values(all).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  const top = sorted.filter((w) => w.side === edge);
  const bottom = edge === "left" ? sorted.filter((w) => w.side === "bottom") : [];
  return (
    <nav aria-label={`Tool windows, ${edge}`} className="flex w-[var(--stripe-width)] shrink-0 flex-col items-center gap-1 py-1">
      {top.map((w) => (
        <StripeButton key={w.id} window={w} />
      ))}
      <div className="flex-1" />
      {bottom.map((w) => (
        <StripeButton key={w.id} window={w} />
      ))}
    </nav>
  );
}

function StripeButton({ window }: { window: ToolWindow }) {
  const open = useToolWindows((s) => s.open[window.side] === window.id);
  const badge = useToolWindows((s) => s.badges[window.id]);
  const binding = useCommands((s) => {
    const command = window.commandId ? s.commands[window.commandId] : undefined;
    return command && bindingOf(command, s.overrides);
  });
  const title = binding ? `${window.title}  ${formatKeybinding(binding)}` : window.title;
  return (
    <button
      type="button"
      title={title}
      aria-label={window.title}
      aria-pressed={open}
      onClick={() => clickToolWindow(window.id)}
      className={cx(
        "relative flex size-[30px] items-center justify-center rounded-lg text-muted transition-colors",
        open ? "bg-accent text-accent-fg" : "hover:bg-hover hover:text-fg",
      )}
    >
      <Icon icon={window.icon} className="size-[17px]" />
      {badge && (
        <span className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full bg-accent px-1 text-center text-[9px] leading-[14px] font-semibold text-accent-fg ring-2 ring-[var(--bg)]">
          {badge}
        </span>
      )}
    </button>
  );
}
