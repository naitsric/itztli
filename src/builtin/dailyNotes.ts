import type { Plugin, PluginContext } from "@itztli/plugin-api";

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day a path is the note of, if it is one. */
export function dateOfPath(path: string, folder: string): Date | null {
  const match = new RegExp(`^${folder ? `${escape(folder)}/` : ""}(\\d{4})-(\\d{2})-(\\d{2})\\.md$`).exec(path);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return isoDate(date) === `${match[1]}-${match[2]}-${match[3]}` ? date : null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

async function openDay(ctx: PluginContext, date: Date) {
  const folder = folderOf(ctx);
  const name = isoDate(date);
  const path = folder ? `${folder}/${name}.md` : `${name}.md`;
  if (!ctx.vault.get(path)) {
    const template = String(ctx.settings.get("template") ?? "").trim();
    let text = "";
    if (template) {
      const source = await ctx.notes.resolve(template, "");
      if (!source) ctx.ui.notify(`The template “${template}” does not exist`, { kind: "warning" });
      else {
        text = (await ctx.vault.read(source))
          .replace(/\{\{\s*(date|title)\s*\}\}/g, name)
          .replace(/\{\{\s*time\s*\}\}/g, `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`)
          .replace(/\{\{\s*cursor\s*\}\}/g, "");
      }
    }
    await ctx.vault.create(path, text);
  }
  ctx.workspace.open(path);
}

const folderOf = (ctx: PluginContext) => String(ctx.settings.get("folder") ?? "").replace(/^\/+|\/+$/g, "");

/** The nearest day that has a note, before or after the one that is open. */
function neighbor(ctx: PluginContext, direction: -1 | 1): string | null {
  const folder = folderOf(ctx);
  const current = ctx.workspace.activePath();
  const from = (current && dateOfPath(current, folder)) || new Date();
  const days = ctx.vault
    .list(folder)
    .filter((e) => dateOfPath(e.path, folder))
    .map((e) => e.path)
    .sort();
  const here = isoDate(from);
  const dayOf = (path: string) => path.slice(-13, -3);
  return (direction < 0 ? days.findLast((p) => dayOf(p) < here) : days.find((p) => dayOf(p) > here)) ?? null;
}

const plugin: Plugin = {
  async activate(ctx) {
    ctx.commands.register({
      id: "today",
      title: "Open Today's Note",
      keybinding: "$mod+Shift+KeyD",
      keywords: ["daily", "journal"],
      run: () => openDay(ctx, new Date()),
    });
    ctx.commands.register({
      id: "tomorrow",
      title: "Open Tomorrow's Note",
      keywords: ["daily", "journal"],
      run: () => openDay(ctx, addDays(new Date(), 1)),
    });
    for (const [id, title, direction] of [
      ["previous", "Previous Daily Note", -1],
      ["next", "Next Daily Note", 1],
    ] as const) {
      ctx.commands.register({
        id,
        title,
        keywords: ["daily", "journal"],
        enabled: () => neighbor(ctx, direction) !== null,
        run() {
          const path = neighbor(ctx, direction);
          if (path) ctx.workspace.open(path);
        },
      });
    }
    if (ctx.settings.get<boolean>("openOnStart") && ctx.workspace.openPaths().length === 0) await openDay(ctx, new Date());
  },
};

export default plugin;
