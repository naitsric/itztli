import { CircleAlert, Info, KeyRound, Power } from "lucide-react";
import { useState, type FormEvent } from "react";
import { errorMessage } from "../backend/api";
import { inputClass, Modal } from "../ui/Modal";
import { Notice } from "../ui/Notice";
import { Button, cx, Segmented, Switch } from "../ui/primitives";
import { useVault } from "../vault/store";
import type { McpClient } from "./api";
import { accessOf, type GrantLevel } from "./grants";
import { CopyButton, SnippetPicker } from "./SnippetPicker";
import { DEFAULT_PORT } from "./snippets";
import { closeDialog, createClient, showMcp, toggleServer, useMcp } from "./store";

/** Names to start from, matching the snippets. */
const SUGGESTED_NAMES = ["claude-code", "claude-desktop", "cursor"];

/** The MCP dialogs: a new client, and its token (shown once). */
export function McpDialogs() {
  const dialog = useMcp((s) => s.dialog);
  if (!dialog) return null;
  if (dialog.kind === "newClient") return <NewClientDialog />;
  return <TokenDialog key={dialog.token} client={dialog.client} token={dialog.token} replaced={dialog.replaced} />;
}

const ACCESS_HINT: Record<GrantLevel, string> = {
  none: "It will not see this vault until you give it access.",
  read: "It will be able to search and read every note in this vault.",
  write: "It will also be able to propose changes. Each one waits for your approval.",
};

function NewClientDialog() {
  const clients = useMcp((s) => s.clients);
  const serverOn = useMcp((s) => s.settings?.enabled ?? false);
  const vault = useVault((s) => s.info);
  const taken = new Set(clients.map((c) => c.name));
  const suggested = SUGGESTED_NAMES.filter((name) => !taken.has(name));
  const [name, setName] = useState(suggested[0] ?? "");
  const [level, setLevel] = useState<GrantLevel>("write");
  const [turnOn, setTurnOn] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const valid = name.trim() !== "";

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!valid || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const access = accessOf(level);
      const to = vault && access ? { vaultId: vault.id, access } : null;
      const created = await createClient(name.trim(), to, turnOn && !serverOn);
      if (!created) setCreating(false);
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
    }
  };

  return (
    <Modal
      open
      onClose={closeDialog}
      title="Connect an MCP Client"
      description="One for each app or agent that should reach your notes through Itztli, each with its own token."
      width={500}
      footer={
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!valid || creating} onClick={() => void submit()}>
            Create
          </Button>
        </div>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <input
            autoFocus
            aria-label="Client name"
            placeholder="Name, e.g. claude-code"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            className={inputClass}
            value={name}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {suggested.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setName(suggestion)}
                className={cx(
                  "h-6 rounded-md border px-2 font-mono text-[11.5px] transition-colors",
                  name === suggestion
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border text-muted hover:border-border-strong hover:text-fg",
                )}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
        {vault && (
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-fg">Access to “{vault.name}”</div>
              <div className="text-[12px] text-subtle">{ACCESS_HINT[level]}</div>
            </div>
            <Segmented
              label={`Access to ${vault.name}`}
              value={level}
              onChange={setLevel}
              options={[
                { value: "none", label: "None" },
                { value: "read", label: "Read" },
                { value: "write", label: "Write" },
              ]}
            />
          </div>
        )}
        {!serverOn && (
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-fg">Turn the MCP server on</div>
              <div className="text-[12px] text-subtle">It is off. Only programs on this computer can reach it.</div>
            </div>
            <Switch label="Turn the MCP server on" checked={turnOn} onCheckedChange={setTurnOn} />
          </div>
        )}
        {error && <p className="selectable text-[12px] text-danger">{error}</p>}
        {/* Enter in the name creates it: the buttons are outside the form. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** A token just created or replaced, with what to paste into the client. Shown once. */
function TokenDialog({ client, token, replaced }: { client: McpClient; token: string; replaced: boolean }) {
  const settings = useMcp((s) => s.settings);
  const status = useMcp((s) => s.status);
  const port = status.port ?? settings?.port ?? DEFAULT_PORT;

  const done = () => {
    closeDialog();
    // Where its access is.
    if (!replaced) showMcp("clients");
  };

  return (
    <Modal
      open
      onClose={done}
      title={replaced ? `New Token for ${client.name}` : `Token for ${client.name}`}
      description="Copy it now: Itztli keeps only a hash of it and can't show it again."
      width={640}
      footer={
        <div className="ml-auto flex gap-2">
          <Button variant="primary" autoFocus onClick={done}>
            Done
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 rounded-md border border-border-strong bg-inset py-1 pr-1 pl-3">
          <KeyRound className="size-3.5 shrink-0 text-warning" />
          <code aria-label="Token" className="selectable min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={token}>
            {token}
          </code>
          <CopyButton text={token} label="Copy token" />
        </div>

        <section className="flex flex-col gap-1.5">
          <h3 className="text-[12px] font-medium text-fg">Connect {client.name}</h3>
          <SnippetPicker port={port} token={token} />
        </section>

        {!status.running && (
          <Notice tone={status.error ? "danger" : "muted"} icon={status.error ? CircleAlert : Power}>
            <span className="flex-1">
              {status.error ? `The MCP server couldn't start: ${status.error}` : "The MCP server is off, so the client can't connect yet."}
            </span>
            {!status.error && (
              <Button className="h-6" onClick={() => void toggleServer()}>
                Turn On
              </Button>
            )}
          </Notice>
        )}
        {!replaced && client.grants.length === 0 && (
          <Notice tone="muted" icon={Info}>
            It can't see any vault yet: give it access in the MCP tool window, which opens when you close this.
          </Notice>
        )}
      </div>
    </Modal>
  );
}
