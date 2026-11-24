import { Download, FolderOpen, Plus, RefreshCw, Settings, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { run } from "../actions";
import { useApp } from "../appInfo";
import { api, type PluginManifest } from "../backend/api";
import { confirm, input } from "../dialogs/ask";
import {
  pluginSettings,
  reloadPlugin,
  setPluginEnabled,
  setPluginSetting,
  usePlugins,
  type PluginEntry,
} from "../plugins/host";
import { inputClass } from "../ui/Modal";
import { notify } from "../ui/notifications";
import { Button, cx, IconButton, Switch } from "../ui/primitives";
import { Page, Row, Section, SelectField, TextField, Toggle } from "./rows";
import { showSettings, useSettingsDialog } from "./dialogState";

/** Asks for a name and creates a plugin to start from, enabled for development. */
export async function newPlugin(): Promise<void> {
  const name = await input({
    title: "New Plugin",
    placeholder: "Its name",
    action: "Create",
    validate: (value) => (idFor(value) ? (usePlugins.getState().plugins.some((p) => p.id === idFor(value)) ? "There is already a plugin with this name" : null) : "Use letters or digits"),
  });
  if (name === null) return;
  const info = await api.pluginCreate(idFor(name), name.trim(), "vault");
  useSettingsDialog.setState({ open: false });
  notify(`${name.trim()} is in ${info.folder}. Enable it for development to see your changes as you save.`, {
    actions: [
      { title: "Show in folder", run: () => run(api.pluginReveal(info.id)) },
      { title: "Enable for development", run: () => run(enableForDevelopment(info.id)) },
    ],
  });
}

async function enableForDevelopment(id: string) {
  const entry = usePlugins.getState().plugins.find((p) => p.id === id);
  if (entry) await setPluginEnabled(entry, true, true);
}

export function idFor(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export async function installPlugin(): Promise<void> {
  const info = await api.pluginInstall();
  if (!info) return;
  notify(`${info.manifest?.name ?? info.id} is installed. Enable it to run it.`, {
    actions: [{ title: "Enable", run: () => run(enableInstalled(info.id)) }],
  });
}

async function enableInstalled(id: string) {
  const entry = usePlugins.getState().plugins.find((p) => p.id === id);
  if (entry) await setPluginEnabled(entry, true);
}

export function PluginsPage() {
  const plugins = usePlugins((s) => s.plugins);
  const safeMode = useApp((s) => s.info?.safeMode);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shown = useMemo(() => {
    const wanted = query.toLowerCase();
    return plugins.filter((p) => `${p.manifest?.name ?? ""} ${p.id} ${p.manifest?.description ?? ""}`.toLowerCase().includes(wanted));
  }, [plugins, query]);
  const groups = [
    { title: "Yours", list: shown.filter((p) => !p.builtin) },
    { title: "Built in", list: shown.filter((p) => p.builtin) },
  ].filter((g) => g.list.length > 0);
  const selected = shown.find((p) => p.id === selectedId) ?? groups[0]?.list[0];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-6 pt-5 pb-3">
        <h2 className="text-[15px] font-semibold text-fg">Plugins</h2>
        <span className="flex-1" />
        <Button onClick={() => run(installPlugin())}>
          <Download className="size-3.5" /> Install from Disk…
        </Button>
        <Button onClick={() => run(newPlugin())}>
          <Plus className="size-3.5" /> New Plugin…
        </Button>
      </div>
      {safeMode && (
        <div className="mx-6 mb-3 flex items-center gap-3 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          <span className="flex-1">Safe Mode: no plugin is running.</span>
          <Button onClick={() => run(api.appRestart(false))}>Restart normally</Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 border-t border-border">
        <div className="flex w-[280px] shrink-0 flex-col border-r border-border">
          <div className="p-2">
            <input aria-label="Search plugins" className={inputClass} placeholder="Search" value={query} spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {groups.map(({ title, list }) => (
              <div key={title} className="mb-2">
                <div className="px-2 py-1 text-[11px] font-medium text-subtle">{title}</div>
                {list.map((p) => (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    className={cx("flex items-center gap-2 rounded-md px-2 py-1.5", p === selected ? "bg-accent-soft" : "hover:bg-hover")}
                    onClick={() => setSelectedId(p.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSelectedId(p.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] text-fg">{p.manifest?.name ?? p.id}</div>
                      <div className={cx("truncate text-[11px]", statusTone(p))}>{statusText(p)}</div>
                    </div>
                    <span onClick={(e) => e.stopPropagation()}>
                      <Switch
                        label={`Enable ${p.manifest?.name ?? p.id}`}
                        checked={p.enabled}
                        disabled={p.info?.status === "invalid"}
                        onCheckedChange={(on) => run(setPluginEnabled(p, on))}
                      />
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {shown.length === 0 && <p className="px-2 py-3 text-[12.5px] text-subtle">Nothing matches</p>}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">{selected && <Details key={selected.id} entry={selected} />}</div>
      </div>
    </div>
  );
}

function statusText(p: PluginEntry): string {
  if (p.info?.status === "invalid") return "Can't be loaded";
  if (p.info?.status === "needsReview") return "Changed: review it to run it";
  if (p.state === "failed") return "Stopped working";
  const version = p.manifest?.version ?? "";
  return [version, p.info?.development ? "in development" : null, p.enabled ? null : "off"].filter(Boolean).join(" · ");
}

function statusTone(p: PluginEntry): string {
  if (p.info?.status === "invalid" || p.state === "failed") return "text-danger";
  return p.info?.status === "needsReview" ? "text-warning" : "text-subtle";
}

function Details({ entry }: { entry: PluginEntry }) {
  const { manifest, info, errors } = entry;
  const invalid = info?.status === "invalid";
  return (
    <div className="px-6 py-4">
      <h3 className="text-[16px] font-semibold text-fg">{manifest?.name ?? entry.id}</h3>
      <p className="mt-0.5 text-[12px] text-subtle">
        {[manifest?.version, manifest?.author, entry.builtin ? "Built in" : info?.scope === "vault" ? "In this vault" : "In every vault"].filter(Boolean).join(" · ")}
      </p>
      {manifest?.description && <p className="selectable mt-3 text-[13px] text-muted">{manifest.description}</p>}
      {invalid && <p className="selectable mt-3 rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{info?.error}</p>}
      {info?.status === "needsReview" && (
        <p className="mt-3 rounded-md bg-warning/10 px-3 py-2 text-[12.5px] text-warning">
          Its files are not the ones you enabled. Look at them, and enable it again if you trust the change.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {!entry.builtin && !invalid && !entry.enabled && (
          <>
            <Button variant="primary" onClick={() => run(setPluginEnabled(entry, true))}>
              Enable
            </Button>
            <Button title="Trusts the folder: it reloads as its files change, without asking" onClick={() => run(setPluginEnabled(entry, true, true))}>
              Enable for development
            </Button>
          </>
        )}
        {manifest && manifest.settings.length > 0 && (
          <Button onClick={() => showSettings(`plugin:${entry.id}`)}>
            <Settings className="size-3.5" /> Settings
          </Button>
        )}
        {entry.enabled && !entry.builtin && (
          <Button onClick={() => run(reloadPlugin(entry.id))}>
            <RefreshCw className="size-3.5" /> Reload
          </Button>
        )}
        {manifest?.homepage && <Button onClick={() => run(api.urlOpen(manifest.homepage!))}>Homepage</Button>}
        {!entry.builtin && (
          <Button onClick={() => run(api.pluginReveal(entry.id))}>
            <FolderOpen className="size-3.5" /> Show in folder
          </Button>
        )}
        {info?.scope === "user" && (
          <IconButton
            label="Uninstall"
            onClick={() =>
              run(
                confirm({ title: `Uninstall “${manifest?.name ?? entry.id}”?`, message: "Its files are deleted. What it saved in your vaults stays.", action: "Uninstall", danger: true }).then(
                  (ok) => (ok ? api.pluginUninstall(entry.id) : undefined),
                ),
              )
            }
          >
            <Trash2 className="size-3.5" />
          </IconButton>
        )}
      </div>
      {manifest && manifest.network.length > 0 && (
        <div className="mt-4 text-[12.5px] text-muted">
          Connects to: <span className="selectable text-fg">{manifest.network.join(", ")}</span>
        </div>
      )}
      {errors.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-[12px] font-semibold text-muted">What went wrong</div>
          <pre className="selectable max-h-48 overflow-auto rounded-md bg-inset p-2 font-mono text-[11.5px] whitespace-pre-wrap text-danger">{errors.join("\n")}</pre>
        </div>
      )}
    </div>
  );
}

/** A plugin's own settings, made from its manifest. */
export function PluginSettingsPage({ id }: { id: string }) {
  const manifest = usePlugins((s) => s.plugins.find((p) => p.id === id)?.manifest);
  if (!manifest) return null;
  return (
    <Page title={manifest.name}>
      <PluginSettingRows manifest={manifest} />
    </Page>
  );
}

function PluginSettingRows({ manifest }: { manifest: PluginManifest }) {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  useEffect(() => run(pluginSettings(manifest.id).then(setValues)), [manifest.id]);
  if (!values) return null;
  const set = (key: string, value: unknown) => {
    setValues({ ...values, [key]: value });
    run(setPluginSetting(manifest.id, key, value));
  };
  return (
    <Section>
      {manifest.settings.map((s) => {
        const value = s.key in values ? values[s.key] : s.default;
        const shared = { title: s.title, description: s.description };
        switch (s.type) {
          case "boolean":
            return <Toggle key={s.key} {...shared} value={value === true} onChange={(v) => set(s.key, v)} />;
          case "number":
            return <TextField key={s.key} {...shared} type="number" width={90} value={String(value ?? "")} onChange={(v) => Number.isFinite(Number(v)) && set(s.key, Number(v))} />;
          case "select":
            return <SelectField key={s.key} {...shared} value={String(value ?? "")} options={s.options ?? []} onChange={(v) => set(s.key, v)} />;
          case "text":
            return (
              <Row key={s.key} {...shared}>
                <textarea aria-label={s.title} className={cx(inputClass, "h-20 w-[280px] resize-y py-1")} defaultValue={String(value ?? "")} onBlur={(e) => set(s.key, e.target.value)} />
              </Row>
            );
          default:
            return <TextField key={s.key} {...shared} value={String(value ?? "")} onChange={(v) => set(s.key, v)} />;
        }
      })}
    </Section>
  );
}
