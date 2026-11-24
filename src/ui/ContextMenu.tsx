import * as Menu from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import { withMenuTarget } from "../commands/menuTarget";
import { bindingOf, executeCommand, isEnabled, useCommands } from "../commands/registry";
import { Kbd } from "./primitives";

export const ContextMenuRoot = Menu.Root;
export const ContextMenuTrigger = Menu.Trigger;

export function ContextMenuContent({ children }: { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Content className="z-50 min-w-[200px] rounded-md border border-border-strong bg-elevated p-1 text-[12.5px] shadow-popover outline-none">
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

const itemClass =
  "flex h-7 items-center justify-between gap-6 rounded px-2 text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg [&[data-highlighted]_kbd]:border-transparent [&[data-highlighted]_kbd]:bg-white/20 [&[data-highlighted]_kbd]:text-accent-fg";

/** A menu item for an action that is not a registered command. */
export function ContextMenuItem({
  label,
  onSelect,
  disabled,
}: {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <Menu.Item disabled={disabled} onSelect={onSelect} className={itemClass}>
      <span>{label}</span>
    </Menu.Item>
  );
}

/**
 * A menu item bound to a registered command: same title, shortcut and
 * enablement everywhere. `on` is the file the menu is about.
 */
export function CommandItem({ id, label, on }: { id: string; label?: string; on?: string }) {
  const command = useCommands((s) => s.commands[id]);
  const binding = useCommands((s) => (command ? bindingOf(command, s.overrides) : undefined));
  if (!command) return null;
  return (
    <Menu.Item
      disabled={!withMenuTarget(on, () => isEnabled(command))}
      onSelect={() => withMenuTarget(on, () => executeCommand(id))}
      className={itemClass}
    >
      <span>{label ?? command.title}</span>
      {binding && <Kbd binding={binding} />}
    </Menu.Item>
  );
}

export function ContextMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-border" />;
}
