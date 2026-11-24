import type { Plugin } from "@itztli/plugin-api";

const STYLES = `
.itztli-tasks { padding: 0 8px 12px; }
.itztli-tasks h3 { margin: 10px 4px 2px; font-size: 12px; font-weight: 600; color: var(--fg); cursor: default; }
.itztli-tasks h3:hover { color: var(--link); }
.itztli-tasks label { display: flex; gap: 8px; padding: 3px 6px; border-radius: 6px; font-size: 12.5px; color: var(--fg-muted); }
.itztli-tasks label:hover { background: var(--bg-hover); color: var(--fg); }
.itztli-tasks input { margin: 2px 0 0; accent-color: var(--accent); flex-shrink: 0; }
.itztli-tasks span { flex: 1; min-width: 0; overflow-wrap: break-word; }
.itztli-tasks .done span { text-decoration: line-through; color: var(--fg-subtle); }
.itztli-tasks p { padding: 10px 8px; color: var(--fg-subtle); font-size: 12.5px; }
`;

/** More than anyone reads, and few enough to draw at once. */
const MAX_SHOWN = 1000;
const TASK = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/;

/** A note's text with a task checked or unchecked, wherever it is by now. */
export function toggle(text: string, line: number, said: string, done: boolean): string {
  const lines = text.split("\n");
  const start = said.slice(0, 24);
  const matches = (l: string | undefined) => !!l && TASK.test(l) && l.replace(/[*_=`~[\]]/g, "").includes(start.replace(/[*_=`~[\]]/g, ""));
  const at = matches(lines[line]) ? line : lines.findIndex(matches);
  if (at < 0) return text;
  lines[at] = lines[at]!.replace(TASK, `$1${done ? "x" : " "}$3`);
  return lines.join("\n");
}

const plugin: Plugin = {
  activate(ctx) {
    ctx.ui.addStyles(STYLES);
    const draw = new Set<() => void>();
    let timer = 0;

    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const open = (await ctx.notes.tasks()).filter((t) => !t.done).length;
        toolWindow.setBadge(open > 0 ? (open > 99 ? "99+" : String(open)) : null);
        for (const redraw of draw) redraw();
      }, 150);
    };

    const toolWindow = ctx.toolWindows.register({
      id: "list",
      title: "Tasks",
      icon: "list-checks",
      side: "right",
      mount(element) {
        element.classList.add("itztli-tasks");
        let current = 0;
        const render = async () => {
          const mine = ++current;
          const showDone = ctx.settings.get<boolean>("showDone");
          const tasks = (await ctx.notes.tasks()).filter((t) => showDone || !t.done).slice(0, MAX_SHOWN);
          if (mine !== current) return;
          const groups = new Map<string, typeof tasks>();
          for (const task of tasks) groups.set(task.path, [...(groups.get(task.path) ?? []), task]);
          element.replaceChildren();
          if (tasks.length === 0) {
            const empty = document.createElement("p");
            empty.textContent = "Nothing left to do. Write “- [ ] something” in a note to have a task.";
            element.append(empty);
          }
          for (const [path, list] of groups) {
            const heading = document.createElement("h3");
            heading.textContent = path.replace(/\.md$/, "");
            heading.addEventListener("click", () => ctx.workspace.open(path));
            element.append(heading);
            for (const task of list) {
              const row = document.createElement("label");
              row.classList.toggle("done", task.done);
              const box = document.createElement("input");
              box.type = "checkbox";
              box.checked = task.done;
              const text = document.createElement("span");
              text.textContent = task.text;
              // The box checks; the text goes to it.
              text.addEventListener("click", (e) => {
                e.preventDefault();
                ctx.workspace.open(path, { line: task.line });
              });
              box.addEventListener("change", () => {
                ctx.vault.modify(path, (note) => toggle(note, task.line, task.text, box.checked)).catch((e) => {
                  box.checked = task.done;
                  ctx.ui.notify(String(e?.message ?? e), { kind: "error" });
                });
              });
              row.append(box, text);
              element.append(row);
            }
          }
        };
        const redraw = () => void render();
        draw.add(redraw);
        redraw();
        return () => void draw.delete(redraw);
      },
    });

    ctx.commands.register({ id: "show", title: "Show Tasks", keywords: ["todo"], run: () => toolWindow.show() });
    ctx.vault.onChange(refresh);
    ctx.settings.onChange(refresh);
    ctx.onDispose(() => window.clearTimeout(timer));
    refresh();
  },
};

export default plugin;
