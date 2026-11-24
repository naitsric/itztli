import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronLeft, ChevronRight, Moon, Search, Settings, Sun, SunMoon } from "lucide-react";
import { useEffect, useState } from "react";
import { run } from "../actions";
import { api, type RecentVault } from "../backend/api";
import { host } from "../backend/host";
import { executeCommand } from "../commands/registry";
import { useSearchEverywhere } from "../search/searchState";
import { updateSettings, useSettings } from "../settings/store";
import { IconButton, Kbd } from "../ui/primitives";
import { useVault } from "../vault/store";
import { openRecentVault } from "../vault/session";
import { goBack, goForward, useEditorArea } from "./editorArea";

const NEXT_THEME: Record<string, string> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON: Record<string, typeof Sun> = { system: SunMoon, light: Sun, dark: Moon };

/**
 * Custom title bar drawn under the overlay-style native one: the macOS
 * traffic lights sit on the left and the whole bar drags the window.
 */
export function TitleBar() {
  const show = useSearchEverywhere((s) => s.show);
  const theme = useSettings((s) => s.appearance.theme);
  const { canGoBack, canGoForward } = useEditorArea();
  const open = useVault((s) => !!s.info);
  const ThemeIcon = THEME_ICON[theme] ?? SunMoon;
  const inset = host.desktop && /Mac/.test(navigator.platform) ? "pl-[var(--traffic-lights-inset)]" : "pl-3";

  return (
    <header
      data-tauri-drag-region
      className={`flex h-[var(--titlebar-height)] shrink-0 items-center gap-3 bg-frame pr-2 ${inset}`}
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1">
        <VaultWidget />
        {open && (
          <>
            <IconButton label="Back" shortcut="$mod+BracketLeft" disabled={!canGoBack} onClick={goBack}>
              <ChevronLeft className="size-4" />
            </IconButton>
            <IconButton label="Forward" shortcut="$mod+BracketRight" disabled={!canGoForward} onClick={goForward}>
              <ChevronRight className="size-4" />
            </IconButton>
          </>
        )}
      </div>

      {open && (
        <button
          type="button"
          onClick={() => show("all")}
          className="flex h-[26px] w-[min(360px,38vw)] items-center gap-2 rounded-md border border-border bg-panel px-2 text-[12px] text-subtle transition-colors hover:border-border-strong hover:text-muted"
        >
          <Search className="size-3.5" />
          Search Everywhere
          <span className="ml-auto">
            <Kbd>⇧⇧</Kbd>
          </span>
        </button>
      )}

      <div data-tauri-drag-region className="flex flex-1 justify-end gap-0.5">
        <IconButton
          label={`Theme: ${theme}`}
          onClick={() => updateSettings({ appearance: { theme: NEXT_THEME[theme] ?? "system" } })}
        >
          <ThemeIcon className="size-4" />
        </IconButton>
        <IconButton label="Settings" shortcut="$mod+Comma" onClick={() => executeCommand("app.settings")}>
          <Settings className="size-4" />
        </IconButton>
      </div>
    </header>
  );
}

const itemClass =
  "flex h-8 items-center gap-2 rounded px-2 text-[12.5px] text-fg outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg data-[disabled]:opacity-40 [&[data-highlighted]_.muted]:text-accent-fg/75";

/** A square with the vault's initials, in a color of its own. */
export function VaultBadge({ name }: { name: string }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const words = name.split(/[\s_-]+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
  return (
    <span
      className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[9px] font-bold text-white"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 55% 50%), hsl(${(hue + 40) % 360} 60% 40%))` }}
    >
      {initials}
    </span>
  );
}

function VaultWidget() {
  const info = useVault((s) => s.info);
  const [recents, setRecents] = useState<RecentVault[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (open) run(api.vaultRecents().then(setRecents));
  }, [open]);

  if (!info) {
    return (
      <span data-tauri-drag-region className="text-[12.5px] font-semibold text-fg">
        Itztli
      </span>
    );
  }
  const others = recents.filter((r) => r.id !== info.id).slice(0, 8);
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-[12.5px] font-semibold text-fg hover:bg-hover data-[state=open]:bg-hover">
        <VaultBadge name={info.name} />
        <span className="truncate">{info.name}</span>
        <ChevronDown className="size-3.5 shrink-0 text-subtle" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-[280px] rounded-lg border border-border-strong bg-elevated p-1 shadow-popover outline-none"
        >
          <Menu.Item className={itemClass} onSelect={() => executeCommand("vault.open")}>
            Open Folder as Vault…
          </Menu.Item>
          <Menu.Item className={itemClass} onSelect={() => executeCommand("vault.reveal")}>
            Show in Folder
          </Menu.Item>
          {others.length > 0 && (
            <>
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Label className="px-2 pt-1 pb-0.5 text-[11px] text-subtle">Recent vaults</Menu.Label>
              {others.map((r) => (
                <Menu.Item key={r.id} className={itemClass} disabled={!r.exists} onSelect={() => run(openRecentVault(r.id))}>
                  <VaultBadge name={r.name} />
                  <span className="min-w-0">
                    <span className="block truncate leading-tight">{r.name}</span>
                    <span className="muted block max-w-[300px] truncate text-[10.5px] leading-tight text-subtle">{r.path}</span>
                  </span>
                </Menu.Item>
              ))}
            </>
          )}
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item className={itemClass} onSelect={() => executeCommand("vault.close")}>
            Close Vault
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
