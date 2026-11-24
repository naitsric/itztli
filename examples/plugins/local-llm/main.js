// @ts-check
/// <reference path="../../../packages/plugin-api/index.d.ts" />

const TASKS = {
  summarize: { title: "Summarize Selection", ask: "Summarize this text in a few bullet points.", replace: false },
  improve: { title: "Improve Selection", ask: "Rewrite this text so it is clearer and shorter. Keep its meaning, tone and Markdown.", replace: true },
  continue: { title: "Continue Writing", ask: "Continue this text with one more paragraph, in the same voice.", replace: false },
};

/** @type {import("@itztli/plugin-api").Plugin} */
const plugin = {
  activate(ctx) {
    const status = ctx.ui.statusBar({ side: "right" });
    let busy = false;

    async function generate(ask, text) {
      const language = ctx.settings.get("language");
      const response = await ctx.net.fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: ctx.settings.get("model"),
          prompt: `${ask}${language ? ` Answer in ${language}.` : " Answer in the language of the text."} Answer with the text only.\n\n${text}`,
          stream: false,
        }),
      });
      if (!response.ok) throw new Error(`Ollama answered ${response.status}: ${response.text().slice(0, 200)}`);
      return response.json().response.trim();
    }

    async function run(task) {
      const editor = ctx.editor.active();
      if (!editor || busy) return;
      const selection = editor.selection();
      const text = selection.text || editor.text().slice(0, selection.to);
      const path = editor.path;
      busy = true;
      status.setText("Thinking…");
      try {
        const answer = await generate(task.ask, text);
        // The user may have moved on while the model was thinking.
        if (ctx.editor.active()?.path !== path) return ctx.ui.notify(answer);
        if (task.replace && selection.text) editor.replace(selection.from, selection.to, answer);
        else editor.insert(selection.to, `\n\n${answer}\n`);
      } catch (e) {
        ctx.ui.notify(`Is Ollama running? ${e instanceof Error ? e.message : e}`, { kind: "error" });
      } finally {
        busy = false;
        status.setText(null);
      }
    }

    for (const [id, task] of Object.entries(TASKS)) {
      ctx.commands.register({
        id,
        title: task.title,
        keywords: ["ai", "llm", "ollama"],
        enabled: () => !busy && ctx.editor.active() !== null && (!task.replace || ctx.editor.active()?.selection().text !== ""),
        run: () => run(task),
      });
    }
    ctx.contextActions.register(({ selection }) =>
      selection ? [TASKS.summarize, TASKS.improve].map((task) => ({ title: task.title, run: () => run(task) })) : [],
    );
  },
};

export default plugin;
