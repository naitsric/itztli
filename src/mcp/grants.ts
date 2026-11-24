import type { Access, McpClient } from "./api";

/** What a client may do in a vault, as the UI shows it. */
export type GrantLevel = "none" | Access;

export interface VaultRow {
  id: string;
  name: string;
  path: string;
  /** The one open now, the only one clients can use. */
  open: boolean;
}

export function grantLevel(client: Pick<McpClient, "grants">, vaultId: string): GrantLevel {
  return client.grants.find((g) => g.vaultId === vaultId)?.access ?? "none";
}

export const accessOf = (level: GrantLevel): Access | null => (level === "none" ? null : level);

/**
 * The vaults to show a client's access to: the open one first, then those
 * it has access to, then the rest of the recent ones. A vault that is no
 * longer in the recent ones still shows while the client has access to it.
 */
export function vaultRows(
  client: Pick<McpClient, "grants">,
  open: { id: string; name: string; path: string } | null,
  recents: readonly { id: string; name: string; path: string }[],
): VaultRow[] {
  const rows = new Map<string, VaultRow>();
  const add = (vault: { id: string; name: string; path: string }) => {
    if (!rows.has(vault.id)) rows.set(vault.id, { id: vault.id, name: vault.name, path: vault.path, open: vault.id === open?.id });
  };
  if (open) add(open);
  for (const g of client.grants) add({ id: g.vaultId, name: g.vaultName, path: g.vaultPath });
  for (const recent of recents) add(recent);
  return [...rows.values()];
}
