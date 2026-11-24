import { FolderOpen, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import { run } from "../actions";
import { useApp } from "../appInfo";
import { api, type RecentVault } from "../backend/api";
import { openRecentVault, pickVault } from "../vault/session";
import { Button } from "../ui/primitives";
import { VaultBadge } from "./TitleBar";

/** What shows with no vault open. */
export function WelcomeScreen() {
  const [recents, setRecents] = useState<RecentVault[]>([]);
  const version = useApp((s) => s.info?.version);
  useEffect(() => run(api.vaultRecents().then(setRecents)), []);

  return (
    <div className="flex h-full items-center justify-center p-[var(--island-gap)] pt-0">
      <div className="island flex size-full items-center justify-center">
        <div className="w-[440px]">
          <h1 className="text-[26px] font-bold tracking-tight text-fg">Itztli</h1>
          <p className="mt-1 text-[13px] text-muted">Notes in plain Markdown, at the speed of your keyboard.</p>
          <div className="mt-6 flex gap-2">
            <Button variant="primary" className="h-8 px-3" onClick={() => run(pickVault())}>
              <FolderOpen className="size-4" /> Open Folder as Vault…
            </Button>
            <Button className="h-8 px-3" onClick={() => run(pickVault(true))}>
              <Sparkles className="size-4" /> New Vault with a Tour…
            </Button>
          </div>
          {recents.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-1 text-[11.5px] font-medium text-subtle">Recent vaults</h2>
              <ul>
                {recents.slice(0, 8).map((r) => (
                  <li key={r.id} className="group flex items-center">
                    <button
                      type="button"
                      disabled={!r.exists}
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover disabled:opacity-40"
                      onClick={() => run(openRecentVault(r.id))}
                    >
                      <VaultBadge name={r.name} />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-fg">{r.name}</span>
                        <span className="block truncate text-[11.5px] text-subtle">{r.exists ? r.path : `${r.path} (not found)`}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Forget ${r.name}`}
                      className="flex size-6 items-center justify-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-fg"
                      onClick={() => run(api.vaultForget(r.id).then(() => setRecents((all) => all.filter((x) => x !== r))))}
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {version && <p className="mt-8 text-[11.5px] text-subtle">Version {version}</p>}
        </div>
      </div>
    </div>
  );
}
