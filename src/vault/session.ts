import { api, type VaultInfo } from "../backend/api";
import { closeAllDocuments, saveAll, warnUnsaved } from "../editor/documents";
import { startPlugins, stopPlugins } from "../plugins/host";
import { loadBookmarks } from "../toolwindows/bookmarks";
import { notifyError } from "../ui/notifications";
import { forgetPlaces, openPath } from "../workbench/editorArea";
import { restoreToolWindows } from "../workbench/toolWindows";
import { entryAt, loadVault, unloadVault, useVault } from "./store";
import { forgetWorkspaceState, loadWorkspaceState, saveWorkspaceState, workspaceState } from "./workspaceState";

/** Opening and closing vaults. */

async function show(info: VaultInfo) {
  await loadWorkspaceState(info.id);
  restoreToolWindows(workspaceState().toolWindows);
  await loadVault(info);
  await loadBookmarks();
  // Notes don't wait for plugins.
  void startPlugins().catch((e) => notifyError(e, "Plugins could not start"));
}

/** Saves and lets go of everything of the vault. `false` if something can't be saved. */
async function leave(): Promise<boolean> {
  if (!useVault.getState().info) return true;
  await saveAll();
  if (!warnUnsaved()) return false;
  await stopPlugins();
  await saveWorkspaceState();
  unloadVault();
  closeAllDocuments();
  forgetWorkspaceState();
  forgetPlaces();
  return true;
}

export async function openRecentVault(id: string): Promise<void> {
  if (!(await leave())) return;
  await show(await api.vaultOpen(id));
}

/** Asks for a folder and opens it. With `welcome`, it gets some notes to start with. */
export async function pickVault(welcome = false): Promise<void> {
  await saveAll();
  if (!warnUnsaved()) return;
  const before = useVault.getState().info;
  const info = await api.vaultPick(welcome);
  if (!info) return;
  // The backend already switched; what is here is the one before.
  if (before) {
    await stopPlugins();
    await saveWorkspaceState();
    unloadVault();
    closeAllDocuments();
    forgetWorkspaceState();
    forgetPlaces();
  }
  await show(info);
  if (welcome && entryAt("Welcome.md")) window.setTimeout(() => openPath("Welcome.md"), 100);
}

export async function closeVault(): Promise<void> {
  if (!(await leave())) return;
  await api.vaultClose();
}

/** On starting: the vault that is open already (after a reload), or the last one. */
export async function resumeVault(): Promise<void> {
  const current = await api.vaultCurrent();
  if (current) return show(current);
  const [last] = await api.vaultRecents();
  if (last?.exists) await openRecentVault(last.id);
}

/** Saves everything; tells whether the app may close. */
export async function prepareToQuit(): Promise<boolean> {
  await saveAll();
  if (!warnUnsaved()) return false;
  await saveWorkspaceState();
  return true;
}
