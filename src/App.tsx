import { useCallback, useEffect, useState } from "react";
import { openLink, run } from "./actions";
import { loadAppInfo, setRemoteImages, useApp } from "./appInfo";
import { errorMessage } from "./backend/api";
import { host } from "./backend/host";
import { registerAppCommands } from "./commands/appCommands";
import { useKeymap } from "./commands/keymap";
import { setFocusFallback } from "./commands/keymapHold";
import { CompareDialog } from "./dialogs/CompareDialog";
import { LocalHistoryDialog } from "./dialogs/LocalHistoryDialog";
import { Prompts } from "./dialogs/Prompts";
import { saveAll } from "./editor/documents";
import { useNativeMenu } from "./menu/nativeMenu";
import { listenToPlugins } from "./plugins/host";
import { setPreviewDefaults } from "./preview/render";
import { Popups } from "./search/Popups";
import { SearchEverywhere } from "./search/SearchEverywhere";
import { useSearchEverywhere } from "./search/searchState";
import { SettingsDialog } from "./settings/SettingsDialog";
import { loadSettings } from "./settings/store";
import { listenToBookmarks } from "./toolwindows/bookmarks";
import { registerToolWindows } from "./toolwindows/register";
import { showTag } from "./toolwindows/tagSelection";
import { Notifications } from "./ui/notifications";
import { prepareToQuit, resumeVault } from "./vault/session";
import { listenToVault, useVault } from "./vault/store";
import { focusEditor, useEditorArea } from "./workbench/editorArea";
import { StatusBar } from "./workbench/StatusBar";
import { TitleBar } from "./workbench/TitleBar";
import { WelcomeScreen } from "./workbench/WelcomeScreen";
import { Workbench } from "./workbench/Workbench";

setFocusFallback(focusEditor);
setPreviewDefaults({
  onOpen: (link) => run(openLink(useEditorArea.getState().activePath ?? "", link)),
  onTag: showTag,
  remoteImages: () => useApp.getState().remoteImages,
  allowRemoteImages: () => run(setRemoteImages(true)),
});

/** Closing the window waits for every note to be saved. */
function guardClosing(): () => void {
  const onHide = () => void saveAll();
  window.addEventListener("blur", onHide);
  document.addEventListener("visibilitychange", onHide);
  let stop = () => {};
  if (host.desktop) {
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      stop = await current.onCloseRequested(async (event) => {
        event.preventDefault();
        if (await prepareToQuit()) await current.destroy();
      });
    });
  }
  return () => {
    window.removeEventListener("blur", onHide);
    document.removeEventListener("visibilitychange", onHide);
    stop();
  };
}

export default function App() {
  const vaultId = useVault((s) => s.info?.id);
  const [ready, setReady] = useState<true | { failed: string } | null>(null);
  const openSearch = useCallback(() => useVault.getState().info && useSearchEverywhere.getState().show("all"), []);
  useKeymap(openSearch);
  useNativeMenu();

  useEffect(registerAppCommands, []);
  useEffect(registerToolWindows, []);
  useEffect(listenToVault, []);
  useEffect(listenToBookmarks, []);
  useEffect(listenToPlugins, []);
  useEffect(guardClosing, []);
  useEffect(() => {
    Promise.all([loadAppInfo(), loadSettings()])
      .then(() => resumeVault().catch((e) => console.error("the last vault was not reopened", e)))
      .then(() => setReady(true))
      .catch((e) => setReady({ failed: errorMessage(e) }));
  }, []);

  return (
    <div className="flex h-full flex-col bg-frame">
      <TitleBar />
      <main className="min-h-0 flex-1">
        {ready === true && (vaultId ? <Workbench key={vaultId} /> : <WelcomeScreen />)}
        {ready && ready !== true && (
          <div className="flex h-full items-center justify-center text-danger">Itztli could not start: {ready.failed}</div>
        )}
      </main>
      <StatusBar />
      <SearchEverywhere />
      <Popups />
      <SettingsDialog />
      <LocalHistoryDialog />
      <CompareDialog />
      <Prompts />
      <Notifications />
    </div>
  );
}
