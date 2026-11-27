import { Activity, Ban, Bot, Folder, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type RecentVault } from "../backend/api";
import { input } from "../dialogs/ask";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/ContextMenu";
import { Notice } from "../ui/Notice";
import { Button, cx, IconButton, Segmented, StatusDot, Switch } from "../ui/primitives";
import { useNow } from "../ui/useNow";
import { useVault } from "../vault/store";
import type { McpClient } from "./api";
import { accessOf, grantLevel, vaultRows, type GrantLevel, type VaultRow } from "./grants";
import { clientInfoLabel, formatDay, isOnline, presenceLabel, presenceShort } from "./presence";
import { SnippetPicker } from "./SnippetPicker";
import { TOKEN_PLACEHOLDER } from "./snippets";
import {
  deleteClient,
  openNewClient,
  renameClient,
  replaceToken,
  revokeClient,
  selectClient,
  setAccess,
  setApproval,
  showClientActivity,
  useMcp,
} from "./store";
import { EmptyState, LoadErrorBanner, ServerBanner } from "./TabParts";

/** How often presence ("Online", "5 min ago") is worked out again. */
const PRESENCE_TICK_MS = 15_000;

/** The MCP clients, and what the selected one may do in each vault. */
export function ClientsTab() {
  const clients = useMcp((s) => s.clients);
  const loaded = useMcp((s) => s.loaded);
  const selectedId = useMcp((s) => s.selectedClientId);
  const now = useNow(PRESENCE_TICK_MS);
  const selected = clients.find((c) => c.id === selectedId) ?? clients[0];

  let body: ReactNode = null;
  if (loaded && clients.length === 0) {
    body = (
      <EmptyState icon={Bot} title="No MCP clients yet">
        Create one for each app that should reach your notes through Itztli, like Claude Code or Cursor. Each gets its
        own token, and only the access you give it.
        <Button variant="primary" className="mt-3" onClick={openNewClient}>
          <Plus className="size-3.5" /> Connect a Client
        </Button>
      </EmptyState>
    );
  } else if (loaded) {
    body = (
      <div className="flex min-h-0 flex-1">
        <ClientList clients={clients} selected={selected} now={now} />
        {selected && <ClientDetail client={selected} now={now} />}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LoadErrorBanner />
      <ServerBanner />
      {body}
    </div>
  );
}

async function rename(client: McpClient) {
  const name = await input({ title: "Rename Client", value: client.name, action: "Rename" });
  if (name) await renameClient(client, name);
}

function ClientList({ clients, selected, now }: { clients: McpClient[]; selected?: McpClient; now: number }) {
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    list.current?.querySelector(`[data-client="${selected.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: KeyboardEvent) => {
    const index = clients.findIndex((c) => c.id === selected?.id);
    const go = (i: number) => {
      e.preventDefault();
      selectClient(clients[Math.max(0, Math.min(clients.length - 1, i))]!.id);
    };
    if (e.key === "ArrowDown") go(index + 1);
    else if (e.key === "ArrowUp") go(index - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(clients.length - 1);
    else if (selected && e.key === "F6" && e.shiftKey) {
      e.preventDefault();
      void rename(selected);
    } else if (selected && (e.key === "Backspace" || e.key === "Delete")) {
      e.preventDefault();
      void deleteClient(selected);
    }
  };

  return (
    <div className="flex w-[clamp(11rem,32%,16rem)] shrink-0 flex-col border-r border-border">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        <IconButton label="Connect a Client" onClick={openNewClient}>
          <Plus className="size-4" />
        </IconButton>
        <span className="ml-auto px-1.5 text-[11px] text-subtle tabular-nums">
          {clients.length} {clients.length === 1 ? "client" : "clients"}
        </span>
      </div>
      <div
        ref={list}
        role="listbox"
        aria-label="MCP clients"
        tabIndex={0}
        aria-activedescendant={selected ? `mcp-client-${selected.id}` : undefined}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        {clients.map((client) => (
          <ClientRow key={client.id} client={client} selected={client.id === selected?.id} now={now} />
        ))}
      </div>
    </div>
  );
}

function ClientRow({ client, selected, now }: { client: McpClient; selected: boolean; now: number }) {
  const revoked = !!client.revokedAt;
  const online = !revoked && isOnline(client.lastSeenAt, now);
  const info = clientInfoLabel(client.lastClientName, client.lastClientVersion);

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <div
          id={`mcp-client-${client.id}`}
          data-client={client.id}
          role="option"
          aria-selected={selected}
          onMouseDown={() => selectClient(client.id)}
          onContextMenu={() => selectClient(client.id)}
          onDoubleClick={() => void rename(client)}
          className={cx(
            "mx-1 flex items-center gap-2 rounded-md px-2 py-1.5",
            selected ? "bg-accent-soft" : "hover:bg-hover",
          )}
        >
          {revoked ? (
            <Ban className="size-2.5 shrink-0 text-danger" />
          ) : (
            <StatusDot tone={online ? "success" : "idle"} />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className={cx("truncate text-[12.5px]", revoked ? "text-muted" : "text-fg")}>{client.name}</span>
              <span
                className={cx(
                  "ml-auto shrink-0 text-[11px]",
                  revoked ? "text-danger" : online ? "text-success" : "text-subtle",
                )}
                title={revoked ? undefined : presenceLabel(client.lastSeenAt, now)}
              >
                {revoked ? "Revoked" : presenceShort(client.lastSeenAt, now)}
              </span>
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5 text-[11px] text-subtle">
              <span className="shrink-0 font-mono">{client.tokenPrefix}…</span>
              {info && (
                <span className="truncate" title={`${info}, as reported by the client`}>
                  · {info}
                </span>
              )}
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem label="Show Activity" onSelect={() => showClientActivity(client.id)} />
        <ContextMenuSeparator />
        <ContextMenuItem label="Rename…" onSelect={() => void rename(client)} />
        <ContextMenuItem label="New Token…" disabled={revoked} onSelect={() => void replaceToken(client)} />
        <ContextMenuSeparator />
        <ContextMenuItem label="Revoke…" disabled={revoked} onSelect={() => void revokeClient(client)} />
        <ContextMenuItem label="Delete…" onSelect={() => void deleteClient(client)} />
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}

function ClientDetail({ client, now }: { client: McpClient; now: number }) {
  const port = useMcp((s) => s.status.port ?? s.settings?.port ?? null);
  const revoked = !!client.revokedAt;
  const online = !revoked && isOnline(client.lastSeenAt, now);
  const info = clientInfoLabel(client.lastClientName, client.lastClientVersion);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 items-start gap-3 border-b border-border px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="selectable truncate text-[13px] font-semibold text-fg">{client.name}</h2>
            <span className={cx("shrink-0 text-[11.5px]", revoked ? "text-danger" : online ? "text-success" : "text-subtle")}>
              {revoked ? "Revoked" : presenceLabel(client.lastSeenAt, now)}
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-[11.5px] text-subtle">
            <span>
              Token <span className="font-mono text-muted">{client.tokenPrefix}…</span>
            </span>
            <span>Created {formatDay(client.createdAt, now)}</span>
            {info && (
              <span title="What the client said about itself. Itztli only verifies the token.">
                Reported as <span className="text-muted">{info}</span>
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="Show Activity" onClick={() => showClientActivity(client.id)}>
            <Activity className="size-3.5" />
          </IconButton>
          <IconButton label="Rename…" onClick={() => void rename(client)}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton label="New Token…" disabled={revoked} onClick={() => void replaceToken(client)}>
            <RotateCw className="size-3.5" />
          </IconButton>
          <IconButton label="Revoke…" disabled={revoked} onClick={() => void revokeClient(client)}>
            <Ban className="size-3.5" />
          </IconButton>
          <IconButton label="Delete…" className="hover:text-danger" onClick={() => void deleteClient(client)}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3">
        {revoked && (
          <Notice tone="danger" icon={Ban}>
            Revoked {formatDay(client.revokedAt!, now)}: its token no longer works. Delete it to remove it from the
            list; its activity stays in the log.
          </Notice>
        )}
        <section className="flex flex-col gap-2">
          <SectionTitle title="Access" hint="Clients use the vault that is open, and change notes only where they may write." />
          <GrantsMatrix client={client} />
          <ApprovalSetting client={client} />
        </section>
        {!revoked && port !== null && (
          <section className="flex flex-col gap-2">
            <SectionTitle
              title="Connect"
              hint={`Paste into the client with ${TOKEN_PLACEHOLDER} replaced by its token. Lost it? Make a new one.`}
            />
            <SnippetPicker port={port} />
          </section>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h3 className="text-[12px] font-semibold text-fg">{title}</h3>
      <p className="text-[11.5px] text-subtle">{hint}</p>
    </div>
  );
}

const LEVEL_LABEL: Record<GrantLevel, string> = { none: "None", read: "Read", write: "Write" };
const levelTitle = (level: GrantLevel, client: McpClient): string =>
  ({
    none: "No access: the client doesn't see this vault",
    read: "Read: search and read every note",
    write: client.changesNeedApproval
      ? "Write: read, and propose changes you approve one by one"
      : "Write: read, and change notes without asking you",
  })[level];

/** Whether each change of the client waits for the user's approval. */
function ApprovalSetting({ client }: { client: McpClient }) {
  const [busy, setBusy] = useState(false);
  const asks = client.changesNeedApproval;
  const change = async (ask: boolean) => {
    setBusy(true);
    await setApproval(client.id, ask);
    setBusy(false);
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-fg">Ask before each change</div>
        <p className={cx("text-[11.5px]", asks ? "text-subtle" : "text-warning")}>
          {asks
            ? "Each change it proposes waits for you to approve it, with the difference in front."
            : "Its changes are made at once, without asking you. Each one is still in the activity log, and what it replaced in Local History."}
        </p>
      </div>
      <Switch
        label="Ask before each change"
        checked={asks}
        // A revoked client may go back to asking, never stop.
        disabled={busy || (!!client.revokedAt && asks)}
        onCheckedChange={(ask) => void change(ask)}
      />
    </div>
  );
}

/** The vaults the user opened, and how to hear about new ones: opening another puts it here. */
function useRecents(): RecentVault[] {
  const open = useVault((s) => s.info?.id);
  const [recents, setRecents] = useState<RecentVault[]>([]);
  useEffect(() => {
    let stale = false;
    api.vaultRecents().then(
      (list) => !stale && setRecents(list),
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [open]);
  return recents;
}

/** One row per vault: the client's access. */
function GrantsMatrix({ client }: { client: McpClient }) {
  const open = useVault((s) => s.info);
  const rows = vaultRows(client, open, useRecents());
  return (
    <div role="table" aria-label={`Access of ${client.name}`} className="rounded-md border border-border">
      {rows.map((row) => (
        <GrantRow key={row.id} client={client} vault={row} />
      ))}
      {rows.length === 0 && <p className="px-3 py-2 text-[12px] text-subtle">Open a vault to give access to it.</p>}
    </div>
  );
}

function GrantRow({ client, vault }: { client: McpClient; vault: VaultRow }) {
  const [busy, setBusy] = useState(false);
  const current = grantLevel(client, vault.id);
  const change = async (level: GrantLevel) => {
    setBusy(true);
    await setAccess(client.id, vault.id, accessOf(level));
    setBusy(false);
  };

  return (
    <div
      role="row"
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0"
    >
      <div role="cell" className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
          <Folder className="size-3.5 shrink-0 text-subtle" />
          <span className="truncate text-fg">{vault.name}</span>
          {vault.open && <span className="shrink-0 text-[11px] text-success">Open</span>}
        </div>
        <div className="truncate pl-5 text-[11px] text-subtle" title={vault.path}>
          {vault.path}
        </div>
      </div>
      <div role="cell">
        <Segmented
          label={`Access to ${vault.name}`}
          value={current}
          disabled={busy}
          onChange={(level) => void change(level)}
          options={(["none", "read", "write"] as const).map((level) => ({
            value: level,
            label: LEVEL_LABEL[level],
            title: levelTitle(level, client),
            // A revoked client may lose access, never gain any.
            blocked: client.revokedAt && level !== "none" ? "Its token was revoked" : null,
            selectedClassName: level === "write" ? "text-warning" : level === "none" ? "text-muted" : undefined,
          }))}
        />
      </div>
    </div>
  );
}
