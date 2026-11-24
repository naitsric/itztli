import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { run } from "../actions";
import { setRemoteImages, useApp } from "../appInfo";
import { host } from "../backend/host";
import { useKeymapHold } from "../commands/keymapHold";
import { usePlugins } from "../plugins/host";
import { useTheme } from "../theme";
import { cx, IconButton } from "../ui/primitives";
import { showSettings, useSettingsDialog, type SettingsPage } from "./dialogState";
import { KeymapPage } from "./KeymapPage";
import { PluginSettingsPage, PluginsPage } from "./PluginsPage";
import { Choice, Page, Section, SelectField, TextField, Toggle } from "./rows";
import { updateSettings, useSettings } from "./store";

const PAGES: { page: SettingsPage; title: string }[] = [
  { page: "appearance", title: "Appearance" },
  { page: "editor", title: "Editor" },
  { page: "files", title: "Files & Links" },
  { page: "keymap", title: "Keymap" },
  { page: "plugins", title: "Plugins" },
];

export function SettingsDialog() {
  const { open, page } = useSettingsDialog();
  const plugins = usePlugins((s) => s.plugins);
  const configurable = plugins.filter((p) => p.enabled && (p.manifest?.settings.length ?? 0) > 0);
  return (
    <Dialog.Root open={open} onOpenChange={(o) => useSettingsDialog.setState({ open: o })}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-40 flex h-[min(720px,calc(100vh-64px))] w-[min(980px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg border border-border-strong bg-elevated shadow-popover outline-none"
        >
          <Hold />
          <nav aria-label="Settings" className="flex w-[210px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-inset p-2">
            <Dialog.Title className="px-2 pt-1 pb-2 text-[13px] font-semibold text-fg">Settings</Dialog.Title>
            {PAGES.map((p) => (
              <PageButton key={p.page} {...p} current={page} />
            ))}
            {configurable.length > 0 && <div className="px-2 pt-3 pb-1 text-[11px] font-medium text-subtle">Plugin settings</div>}
            {configurable.map((p) => (
              <PageButton key={p.id} page={`plugin:${p.id}`} title={p.manifest!.name} current={page} />
            ))}
          </nav>
          <div className="relative min-w-0 flex-1 overflow-y-auto bg-panel">
            <Dialog.Close asChild>
              <IconButton label="Close" className="absolute top-3 right-3 z-10">
                <X className="size-4" />
              </IconButton>
            </Dialog.Close>
            <Current page={page} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Hold() {
  useKeymapHold();
  return null;
}

function PageButton({ page, title, current }: { page: SettingsPage; title: string; current: SettingsPage }) {
  return (
    <button
      type="button"
      aria-current={page === current ? "page" : undefined}
      className={cx("h-7 truncate rounded-md px-2 text-left text-[12.5px]", page === current ? "bg-accent text-accent-fg" : "text-fg hover:bg-hover")}
      onClick={() => showSettings(page)}
    >
      {title}
    </button>
  );
}

function Current({ page }: { page: SettingsPage }) {
  switch (page) {
    case "appearance":
      return <AppearancePage />;
    case "editor":
      return <EditorPage />;
    case "files":
      return <FilesPage />;
    case "keymap":
      return <KeymapPage />;
    case "plugins":
      return (
        <div className="h-full pr-6">
          <PluginsPage />
        </div>
      );
    default:
      return <PluginSettingsPage key={page} id={page.slice("plugin:".length)} />;
  }
}

function AppearancePage() {
  const appearance = useSettings((s) => s.appearance);
  const themes = useTheme((s) => s.plugins);
  const mac = host.desktop && /Mac/.test(navigator.platform);
  return (
    <Page title="Appearance">
      <Section>
        <SelectField
          title="Theme"
          value={appearance.theme}
          options={[
            { value: "system", label: "Follow the system" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
            ...themes.map((t) => ({ value: t.id, label: t.name })),
          ]}
          onChange={(theme) => updateSettings({ appearance: { theme } })}
        />
        {mac && (
          <Toggle
            title="Translucent frame"
            description="Lets the desktop through the window's frame."
            value={appearance.translucent}
            onChange={(translucent) => updateSettings({ appearance: { translucent } })}
          />
        )}
      </Section>
    </Page>
  );
}

function EditorPage() {
  const editor = useSettings((s) => s.editor);
  const set = (change: Partial<typeof editor>) => updateSettings({ editor: change });
  return (
    <Page title="Editor">
      <Section title="Text">
        <Choice
          title="Font"
          value={editor.font}
          options={[
            { value: "ui", label: "Sans" },
            { value: "serif", label: "Serif" },
            { value: "mono", label: "Mono" },
          ]}
          onChange={(font) => set({ font })}
        />
        <TextField title="Size" type="number" width={80} value={String(editor.size)} onChange={(v) => set({ size: clamp(Number(v), 9, 40, 15) })} />
        <TextField
          title="Line width"
          description="In pixels. 0 is as wide as the window."
          type="number"
          width={80}
          value={String(editor.width)}
          onChange={(v) => set({ width: Number(v) === 0 ? 0 : clamp(Number(v), 320, 4000, 760) })}
        />
      </Section>
      <Section title="Writing">
        <Toggle
          title="Live preview"
          description="Shows Markdown as what it means, and its markup only where you are."
          value={editor.livePreview}
          onChange={(livePreview) => set({ livePreview })}
        />
        <Toggle
          title="Follow links with a click"
          description="Off, only ⌘-click does."
          value={editor.clickOpensLinks}
          onChange={(clickOpensLinks) => set({ clickOpensLinks })}
        />
        <Toggle title="Line numbers" value={editor.lineNumbers} onChange={(lineNumbers) => set({ lineNumbers })} />
        <Toggle title="Check spelling" value={editor.spellcheck} onChange={(spellcheck) => set({ spellcheck })} />
      </Section>
    </Page>
  );
}

function FilesPage() {
  const files = useSettings((s) => s.files);
  const remoteImages = useApp((s) => s.remoteImages);
  const set = (change: Partial<typeof files>) => updateSettings({ files: change });
  const folder = (value: string) => value.trim().replace(/^\/+|\/+$/g, "");
  return (
    <Page title="Files & Links">
      <Section title="New files">
        <Choice
          title="New notes go"
          value={files.newNoteLocation}
          options={[
            { value: "current", label: "Next to the open note" },
            { value: "root", label: "In the root" },
            { value: "folder", label: "In a folder" },
          ]}
          onChange={(newNoteLocation) => set({ newNoteLocation })}
        />
        {files.newNoteLocation === "folder" && (
          <TextField title="Folder for new notes" value={files.newNoteFolder} onChange={(v) => set({ newNoteFolder: folder(v) })} />
        )}
        <TextField
          title="Folder for attachments"
          description="Where pasted and dropped files are saved."
          value={files.attachmentsFolder}
          onChange={(v) => set({ attachmentsFolder: folder(v) })}
        />
      </Section>
      <Section title="Vault window">
        <Toggle
          title="Open files with a single click"
          description="In a preview tab, which the next one replaces."
          value={files.singleClickOpens}
          onChange={(singleClickOpens) => set({ singleClickOpens })}
        />
        <Toggle
          title="Always select the open file"
          value={files.followOpenFile}
          onChange={(followOpenFile) => set({ followOpenFile })}
        />
        <Toggle title="Show attachments" value={files.showAttachments} onChange={(showAttachments) => set({ showAttachments })} />
      </Section>
      <Section title="Privacy">
        <Toggle
          title="Load images from the web"
          description="Off, notes never connect to anything by being read."
          value={remoteImages}
          onChange={(allowed) => run(setRemoteImages(allowed))}
        />
      </Section>
    </Page>
  );
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}
