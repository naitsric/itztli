// End-to-end tests: the real UI in WebKit against the real backend.
//   pnpm test:e2e [part of a name]
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { finish, freePort, start } from "./harness.mjs";

const tests = [];
const test = (name, run, options = {}) => tests.push({ name, run, options });

const mod = process.platform === "darwin" ? "Meta" : "Control";

/** Writes files in a vault. */
const files = (map) => (vault) => {
  for (const [path, text] of Object.entries(map)) {
    mkdirSync(dirname(join(vault, path)), { recursive: true });
    writeFileSync(join(vault, path), text);
  }
};

/** Things to do in the app, as a user would. */
function user({ tab, vault, page, until, errors }) {
  const key = (k) => tab.keyboard.press(k.replaceAll("Mod", mod));
  const editor = (path) => tab.locator(`.cm-content[aria-label="${path}"]`);
  return {
    key,
    editor,
    type: (text) => tab.keyboard.type(text),
    on: (path) => readFileSync(join(vault, path), "utf8"),
    exists: (path) => existsSync(join(vault, path)),
    write: (path, text) => files({ [path]: text })(vault),
    async load() {
      await tab.goto(page);
      await tab.getByRole("tree", { name: "Vault" }).waitFor();
    },
    /** What was being asked when the page went away fails, and means nothing. */
    async reload() {
      await tab.reload();
      const meaningful = errors.filter((e) => !/Load failed|due to access control checks/.test(e));
      errors.splice(0, errors.length, ...meaningful);
    },
    async open(name, path) {
      await key("Mod+o");
      await tab.getByRole("dialog").waitFor();
      await tab.keyboard.type(name);
      await tab.locator(`[cmdk-item][data-selected=true]`, { hasText: name }).first().waitFor();
      await key("Enter");
      await editor(path).waitFor();
      await until("the caret", () => editor(path).evaluate((e) => e === document.activeElement));
    },
    /** Puts the caret right after some text. */
    async caretAfter(path, text) {
      await editor(path).evaluate((dom, wanted) => {
        const { EditorView } = globalThis.itztli.modules["@codemirror/view"];
        const view = EditorView.findFromDOM(dom);
        const at = view.state.doc.toString().indexOf(wanted);
        if (at < 0) throw new Error(`no “${wanted}” in the note`);
        view.dispatch({ selection: { anchor: at + wanted.length }, scrollIntoView: true });
        view.focus();
      }, text);
    },
    async select(path, text) {
      await editor(path).evaluate((dom, wanted) => {
        const { EditorView } = globalThis.itztli.modules["@codemirror/view"];
        const view = EditorView.findFromDOM(dom);
        const at = view.state.doc.toString().indexOf(wanted);
        if (at < 0) throw new Error(`no “${wanted}” in the note`);
        view.dispatch({ selection: { anchor: at, head: at + wanted.length } });
        view.focus();
      }, text);
    },
    /** Runs an action by name, through Find Action. */
    async action(title) {
      await key("Mod+Shift+a");
      await tab.getByRole("dialog").waitFor();
      await tab.keyboard.type(title);
      await tab.locator("[cmdk-item][data-selected=true]", { hasText: title }).first().waitFor();
      await key("Enter");
      await tab.getByRole("dialog", { name: "Search Everywhere" }).waitFor({ state: "hidden" });
    },
    saved: (path, check) => until(`${path} to be saved`, async () => check(readFileSync(join(vault, path), "utf8")), 8000),
  };
}

// ── Writing ────────────────────────────────────────────────────────────────

test("shows Markdown as what it means, and its markup at the caret", async (app, u) => {
  await u.open("a", "a.md");
  const text = () => u.editor("a.md").innerText();
  await u.caretAfter("a.md", "end");
  await app.until("markup to hide", async () => !(await text()).includes("**"));
  assert.match(await text(), /bold and linked/);
  await u.caretAfter("a.md", "bo");
  await app.until("markup to show", async () => (await text()).includes("**bold**"));
  assert.equal(await app.tab.locator(".cm-task").count(), 1);
}, { fill: files({ "a.md": "# T\n\n**bold** and [[b|linked]]\n\n- [ ] task\n\nend\n", "b.md": "" }) });

test("saves by itself, and several editors of a note stay in step", async (app, u) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "one");
  await u.type(" two");
  await u.saved("a.md", (t) => t === "one two\n");
  await u.action("Split Right");
  await app.until("a second editor", async () => (await u.editor("a.md").count()) === 2);
  await app.until("the caret", () => app.tab.evaluate(() => !!document.activeElement?.closest(".cm-content")));
  await u.key("Mod+ArrowDown");
  await u.type("three");
  await app.until("both to show it", async () => (await u.editor("a.md").allInnerTexts()).every((t) => t.includes("three")));
  await u.saved("a.md", (t) => t === "one two\nthree");
}, { fill: files({ "a.md": "one\n" }) });

test("checks a task with a click", async (app, u) => {
  await u.open("a", "a.md");
  await app.tab.locator(".cm-task").first().click();
  await u.saved("a.md", (t) => t === "todo\n\n- [x] one\n- [ ] two\n");
}, { fill: files({ "a.md": "todo\n\n- [ ] one\n- [ ] two\n" }) });

test("edits with the IntelliJ keys", async (app, u) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "one");
  await u.key("Mod+d");
  await u.saved("a.md", (t) => t === "one\none\ntwo\n");
  await u.key("Mod+Backspace");
  await u.saved("a.md", (t) => t === "one\ntwo\n");
  await u.key("Alt+Shift+ArrowUp");
  await u.saved("a.md", (t) => t === "two\none\n");
  await u.caretAfter("a.md", "tw");
  await u.key("Mod+b");
  await u.saved("a.md", (t) => t === "**two**\none\n");
  await u.key("Mod+Enter");
  await u.saved("a.md", (t) => t === "- [ ] **two**\none\n");
}, { fill: files({ "a.md": "one\ntwo\n" }) });

test("keeps the line breaks a note has", async (app, u) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "two");
  await u.type("!");
  await u.saved("a.md", (t) => t === "one\r\ntwo!\r\n");
}, { fill: files({ "a.md": "one\r\ntwo\r\n" }) });

// ── Links ──────────────────────────────────────────────────────────────────

test("completes links, headings and tags", async (app, u) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "see ");
  await u.type("[[targ");
  await app.tab.locator(".cm-tooltip-autocomplete li", { hasText: "Target note" }).waitFor();
  await app.tab.waitForTimeout(150);
  await u.key("Enter");
  await u.saved("a.md", (t) => t.startsWith("see [[Target note]]"));
  await u.type(" [[Target note#two");
  await app.tab.locator(".cm-tooltip-autocomplete li", { hasText: "Section two" }).waitFor();
  await app.tab.waitForTimeout(150);
  await u.key("Enter");
  await u.saved("a.md", (t) => t.includes("[[Target note#Section two]]"));
  await u.type(" #proj");
  await app.tab.locator(".cm-tooltip-autocomplete li", { hasText: "project/x" }).waitFor();
}, { fill: files({ "a.md": "see \n", "f/Target note.md": "# Section one\n\n# Section two\n\n#project/x" }) });

test("follows links with ⌘B, to the heading, and comes back", async (app, u) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "[[b#Th");
  await u.key("Mod+b");
  await u.editor("b.md").waitFor();
  await app.until("the caret at the heading", async () => (await app.tab.locator("footer").innerText()).includes("43:1"));
  await u.key("Mod+BracketLeft");
  await app.until("to be back", async () => (await app.tab.locator("footer").innerText()).includes("› a") || u.editor("a.md").isVisible());
  await app.until("the caret where it was", async () => (await app.tab.locator("footer").innerText()).includes("1:9"));
}, { fill: files({ "a.md": "x [[b#There]] y\n", "b.md": `# B\n${"\n".repeat(41)}## There\n\ntext` }) });

test("creates a note from a link to nothing", async (app, u) => {
  await u.open("a", "f/a.md");
  await u.caretAfter("f/a.md", "[[New");
  await u.key("Alt+Enter");
  await app.tab.getByText("Create note “New one”").waitFor();
  await u.key("Enter");
  await app.until("the note", async () => u.exists("f/New one.md"));
  await app.until("the link to be found", async () => (await app.tab.locator(".cm-link-missing").count()) === 0);
}, { fill: files({ "f/a.md": "go to [[New one]]\n" }) });

test("renames a note and every link to it", async (app, u) => {
  await u.open("Old", "Old.md");
  await u.key("Shift+F6");
  const field = app.tab.getByLabel("Rename Note", { exact: true }).locator("visible=true").last();
  await field.waitFor();
  await app.tab.keyboard.press(`${mod}+a`);
  await u.type("Brand new");
  await app.tab.getByText("Updates 3 links in 2 notes").waitFor();
  await u.key("Enter");
  await u.editor("Brand new.md").waitFor();
  assert.equal(u.on("a.md"), "[[Brand new]] and [m](Brand%20new.md)\n");
  assert.equal(u.on("f/b.md"), "![[Brand new#H|x]]\n");
  assert.ok(!u.exists("Old.md"));
  await app.tab.getByText("Updated 3 links in 2 notes").waitFor();
}, { fill: files({ "Old.md": "# H\n", "a.md": "[[Old]] and [m](Old.md)\n", "f/b.md": "![[Old#H|x]]\n" }) });

test("finds usages of a note", async (app, u) => {
  await u.open("Target", "Target.md");
  await u.key("Alt+F7");
  await app.tab.getByRole("tree", { name: "Find results" }).getByText("the line with a Target").waitFor();
}, { fill: files({ "Target.md": "", "a.md": "x\n\nthe line with a [[Target]]\n" }) });

test("extracts a selection to a note", async (app, u) => {
  await u.open("a", "a.md");
  await u.select("a.md", "second part");
  await u.key("Mod+Alt+m");
  await app.tab.getByRole("dialog", { name: "Extract to Note" }).waitFor();
  await u.type("Part two");
  await u.key("Enter");
  await u.saved("a.md", (t) => t === "first part [[Part two]]\n");
  assert.equal(u.on("Part two.md"), "second part\n");
}, { fill: files({ "a.md": "first part second part\n" }) });

// ── Finding ────────────────────────────────────────────────────────────────

test("searches everywhere on Shift Shift", async (app, u) => {
  await u.key("Shift");
  await u.key("Shift");
  await app.tab.getByRole("dialog", { name: "Search Everywhere" }).waitFor();
  await u.type("cancion");
  await app.tab.locator("[cmdk-item]", { hasText: "Canción de otoño" }).first().waitFor();
  await u.key("Enter");
  await u.editor("música/Canción de otoño.md").waitFor();
}, { fill: files({ "música/Canción de otoño.md": "# x\n", "b.md": "" }) });

test("finds in files and goes to the match", async (app, u) => {
  await u.key("Mod+Shift+f");
  await app.tab.getByLabel("Text to find").waitFor();
  await u.type("needle");
  await app.tab.getByText("2 in 2 notes").waitFor();
  await u.key("ArrowDown");
  await u.key("Enter");
  await u.editor("b.md").waitFor();
  await app.until("the caret at the match", async () => (await app.tab.locator("footer").innerText()).includes("3:5"));
}, { fill: files({ "a.md": "a needle", "b.md": "1\n2\nthe needle\n" }) });

test("finds and replaces in the note", async (app, u) => {
  await u.open("a", "a.md");
  await u.key("Mod+r");
  await app.tab.getByLabel("Find in note").waitFor();
  await u.type("cat");
  await app.tab.locator(".cm-find-panel", { hasText: "2 results" }).waitFor();
  await app.tab.getByLabel("Replace with").fill("dog");
  await app.tab.getByRole("button", { name: "Replace All" }).click();
  await u.saved("a.md", (t) => t === "dog dog\n");
}, { fill: files({ "a.md": "cat cat\n" }) });

test("filters the vault tree by typing", async (app, u) => {
  await app.tab.getByRole("treeitem", { name: "f" }).click();
  await u.type("dee");
  await app.tab.getByRole("treeitem", { name: "deep note" }).waitFor();
  assert.equal(await app.tab.getByRole("treeitem", { name: "other" }).count(), 0);
  await u.key("Enter");
  await u.editor("f/g/deep note.md").waitFor();
}, { fill: files({ "f/g/deep note.md": "", "f/other.md": "", "z.md": "" }) });

test("shows structure, tags, problems and the graph", async (app, u) => {
  await u.open("a", "a.md");
  await u.key("Mod+7");
  await app.tab.getByRole("tree", { name: "Structure" }).getByText("Second").waitFor();
  await u.key("Mod+5");
  await app.tab.getByRole("tree", { name: "Tags" }).getByText("project").waitFor();
  await u.key("Mod+6");
  await app.tab.getByRole("tree", { name: "Problems" }).getByText("“nowhere” does not exist").waitFor();
  await u.key("Mod+8");
  await app.tab.getByLabel("Graph of 2 notes and 1 links").waitFor();
  await u.key("Mod+Shift+F12");
  await app.tab.getByRole("tree", { name: "Vault" }).waitFor({ state: "hidden" });
}, { fill: files({ "a.md": "# First\n\n## Second\n\n#project/x [[nowhere]]\n" }) });

test("shows how notes relate, by their properties", async (app, u) => {
  await u.open("Ana", "Ana.md");
  await u.key("Mod+4");
  const backlinks = app.tab.getByRole("tree", { name: "Backlinks" });
  await backlinks.getByRole("treeitem", { name: /^author/ }).waitFor();
  await backlinks.getByRole("treeitem", { name: /^Kickoff/ }).first().waitFor();
  await backlinks.getByText("Then Ana spoke").waitFor();
  await u.key("Mod+8");
  await app.tab.getByLabel("Graph of 2 notes and 1 links").waitFor();
  await app.tab.getByRole("list", { name: "Types" }).getByText("meeting").waitFor();
  await app.tab.getByLabel("Relation").selectOption("author");
}, { fill: files({ "Ana.md": "---\ntype: person\n---\n", "Kickoff.md": "---\ntype: meeting\nauthor: \"[[Ana]]\"\n---\nThen [[Ana]] spoke\n" }) });

// ── Not losing anything ────────────────────────────────────────────────────

test("takes changes made elsewhere", async (app, u) => {
  await u.open("a", "a.md");
  u.write("a.md", "changed outside\n");
  await app.until("the change to show", async () => (await u.editor("a.md").innerText()).includes("changed outside"), 10_000);
  u.write("brand-new.md", "hi");
  await app.tab.getByRole("treeitem", { name: "brand-new" }).waitFor();
}, { fill: files({ "a.md": "original\n" }) });

test("never overwrites a change it has not seen", async (app, u) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "original");
  // Both at once, before either hears of the other.
  await u.type(" mine");
  u.write("a.md", "theirs\n");
  await app.tab.getByText("changed on disk while you had unsaved changes").waitFor({ timeout: 10_000 });
  assert.equal(u.on("a.md"), "theirs\n");
  await app.tab.getByRole("button", { name: "Compare" }).click();
  await app.tab.getByRole("dialog").getByText("On disk").first().waitFor();
  await app.tab.getByRole("dialog").getByRole("button", { name: "Keep mine" }).click();
  await u.saved("a.md", (t) => t === "original mine\n");
}, { fill: files({ "a.md": "original\n" }) });

test("brings a note back from local history", async (app, u) => {
  await u.open("a", "a.md");
  await u.key("Mod+a");
  await u.key("Backspace");
  await u.saved("a.md", (t) => t === "");
  await u.action("Local History");
  await app.tab.getByRole("dialog", { name: /Local History/ }).getByRole("button", { name: "Revert to this" }).click();
  await u.saved("a.md", (t) => t === "precious words\n");
}, { fill: files({ "a.md": "precious words\n" }) });

test("moves to the trash after asking", async (app, u) => {
  await app.tab.getByRole("treeitem", { name: "a" }).click();
  await u.key("Mod+Backspace");
  await app.tab.getByText("1 link in 1 note will lead nowhere").waitFor();
  await app.tab.getByRole("button", { name: "Move to Trash" }).click();
  await app.until("it to be gone", async () => !u.exists("a.md"));
}, { fill: files({ "a.md": "x", "b.md": "[[a]]" }) });

test("acts on the file right-clicked, whatever note is open", async (app, u) => {
  const row = (name) => app.tab.getByRole("treeitem", { name, exact: true });
  const choose = async (name, item) => {
    await row(name).click({ button: "right" });
    await app.tab.getByRole("menuitem", { name: item }).click();
  };
  await u.open("a", "a.md");

  await choose("c", /^Rename/);
  const rename = app.tab.getByRole("dialog", { name: "Rename Note" });
  await rename.waitFor();
  assert.equal(await rename.getByRole("textbox").inputValue(), "c");
  await app.until("the name to be selected", () => rename.getByRole("textbox").evaluate((e) => e === document.activeElement && e.selectionEnd === 1));
  await u.type("renamed");
  await u.key("Enter");
  await app.until("c to be renamed", async () => u.exists("renamed.md") && !u.exists("c.md"));

  await choose("b", /^Move to Trash/);
  const trash = app.tab.getByRole("dialog", { name: "Move “b” to the Trash?" });
  await trash.getByRole("button", { name: "Move to Trash" }).click();
  await app.until("b to be gone", async () => !u.exists("b.md"));

  // From one row's menu to another's.
  const dir = await row("dir").boundingBox();
  await row("a").click({ button: "right" });
  await app.tab.getByRole("menuitem", { name: /^Rename/ }).waitFor();
  await app.tab.mouse.click(dir.x + 40, dir.y + 8, { button: "right" });
  await u.key("Escape");
  await app.tab.getByRole("menu").waitFor({ state: "hidden" });
  await choose("dir", /^Rename/);
  await app.tab.getByRole("dialog", { name: "Rename Folder" }).waitFor();
  await u.key("Escape");

  await choose("pic.png", /^Rename/);
  await app.tab.getByRole("dialog", { name: "Rename File" }).waitFor();
  await u.key("Escape");
  // Nobody touched the note in front.
  assert.equal(u.on("a.md"), "a [[b]]\n");
  await u.editor("a.md").waitFor();

  // The empty space is about no file.
  const tree = await app.tab.getByRole("tree", { name: "Vault" }).boundingBox();
  await app.tab.mouse.click(tree.x + 60, tree.y + tree.height - 20, { button: "right" });
  await app.tab.getByRole("menuitem", { name: "New Note…" }).waitFor();
  assert.equal(await app.tab.getByRole("menuitem", { name: /^Rename/ }).count(), 0);
}, { fill: files({ "a.md": "a [[b]]\n", "b.md": "b\n", "c.md": "c\n", "dir/d.md": "d\n", "pic.png": "x" }) });

test("comes back as it was left", async (app, u) => {
  await u.open("a", "a.md");
  await u.key("Mod+4");
  await app.tab.getByRole("tree", { name: "Backlinks" }).waitFor();
  await app.tab.waitForTimeout(1500);
  await u.reload();
  await u.editor("a.md").waitFor();
  await app.tab.getByRole("tree", { name: "Backlinks" }).waitFor();
}, { fill: files({ "a.md": "x" }) });

// ── Plugins ────────────────────────────────────────────────────────────────

const manifest = (id, extra = {}) => JSON.stringify({ id, name: "Demo", version: "1.0.0", api: 1, ...extra });

test("runs a vault's plugin only once enabled, and undoes all of it when disabled", async (app, u) => {
  await u.key("Mod+Shift+a");
  await u.type("Demo: Hello");
  await app.tab.getByText("Nothing found").waitFor();
  await u.key("Escape");

  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Plugins", exact: true }).click();
  await app.tab.getByRole("switch", { name: "Enable Demo" }).click();
  await app.until("it to run", async () => (await app.tab.getByRole("switch", { name: "Enable Demo" }).getAttribute("aria-checked")) === "true");
  await u.key("Escape");
  await app.tab.getByText("demo ready").waitFor();

  await u.open("a", "a.md");
  await u.action("Demo: Hello");
  await u.saved("a.md", (t) => t.includes("hello from demo"));
  await app.tab.locator(".demo-block", { hasText: "X MARKS" }).waitFor();
  await app.tab.getByRole("button", { name: "Demo window" }).click();
  await app.tab.getByText("inside the window").waitFor();
  assert.equal(await app.tab.locator(".demo-block").evaluate((e) => getComputedStyle(e).color), "rgb(1, 2, 3)");

  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Plugins", exact: true }).click();
  await app.tab.getByRole("switch", { name: "Enable Demo" }).click();
  await u.key("Escape");
  await app.tab.getByRole("button", { name: "Demo window" }).waitFor({ state: "detached" });
  await app.tab.getByText("demo ready").waitFor({ state: "detached" });
  assert.equal(await app.tab.locator(".demo-block").count(), 0);
  assert.equal(await app.tab.locator("style[data-plugin=demo]").count(), 0);
}, {
  fill: files({
    "a.md": "x\n\n```demo\nx marks\n```\n",
    ".itztli/plugins/demo/plugin.json": manifest("demo", { styles: "styles.css" }),
    ".itztli/plugins/demo/styles.css": ".demo-block { color: rgb(1, 2, 3); }",
    ".itztli/plugins/demo/main.js": `export default {
      activate(ctx) {
        ctx.commands.register({ id: "hello", title: "Demo: Hello", run() { ctx.editor.active().insert(0, "hello from demo\\n"); } });
        ctx.markdown.registerCodeBlock("demo", (source, el) => { el.className = "demo-block"; el.textContent = source.toUpperCase(); });
        ctx.toolWindows.register({ id: "w", title: "Demo window", icon: "star", side: "right", mount(el) { el.textContent = "inside the window"; } });
        ctx.ui.statusBar({}).setText("demo ready");
      },
    };`,
  }),
});

test("reloads a plugin in development as its files change", async (app, u) => {
  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Plugins", exact: true }).click();
  await app.tab.getByRole("button", { name: "Enable for development" }).click();
  await u.key("Escape");
  await app.tab.getByText("version one").waitFor();
  u.write(".itztli/plugins/demo/main.js", `export default { activate(ctx) { ctx.ui.statusBar({}).setText("version two"); } };`);
  await app.tab.getByText("version two").waitFor({ timeout: 10_000 });
  assert.equal(await app.tab.getByText("version one").count(), 0);
}, {
  fill: files({
    ".itztli/plugins/demo/plugin.json": manifest("demo"),
    ".itztli/plugins/demo/main.js": `export default { activate(ctx) { ctx.ui.statusBar({}).setText("version one"); } };`,
  }),
});

test("stops a plugin whose files changed until it is reviewed", async (app, u) => {
  await app.call("host", "plugin_enable", { id: "demo", development: false });
  await app.tab.getByText("version one").waitFor();
  u.write(".itztli/plugins/demo/main.js", `export default { activate(ctx) { ctx.ui.statusBar({}).setText("version two"); } };`);
  await app.tab.getByText("version one").waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(await app.tab.getByText("version two").count(), 0);
  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Plugins", exact: true }).click();
  await app.tab.getByText("Changed: review it to run it").waitFor();
}, {
  fill: files({
    ".itztli/plugins/demo/plugin.json": manifest("demo"),
    ".itztli/plugins/demo/main.js": `export default { activate(ctx) { ctx.ui.statusBar({}).setText("version one"); } };`,
  }),
});

test("contains a plugin that fails", async (app, u) => {
  await app.call("host", "plugin_enable", { id: "bad", development: false });
  await app.call("host", "plugin_enable", { id: "broken", development: false });
  await app.tab.getByText(/Demo failed starting: no good/).waitFor();
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "text");
  await u.type(" more");
  await u.saved("a.md", (t) => t === "text more\n");
  await u.action("Boom");
  await app.tab.getByText(/Boom: it broke/).waitFor();
}, {
  errors: true,
  fill: files({
    "a.md": "text\n",
    ".itztli/plugins/bad/plugin.json": manifest("bad"),
    ".itztli/plugins/bad/main.js": `export default { activate() { throw new Error("no good"); } };`,
    ".itztli/plugins/broken/plugin.json": manifest("broken"),
    ".itztli/plugins/broken/main.js": `export default { activate(ctx) {
      ctx.commands.register({ id: "boom", title: "Boom", run() { throw new Error("it broke"); } });
      ctx.editor.onDocumentChange(() => { throw new Error("on every key"); });
    } };`,
  }),
});

test("gives plugins settings, storage and themes", async (app, u) => {
  await app.call("host", "plugin_enable", { id: "demo", development: false });
  await app.tab.getByText("greeting: Hi").waitFor();
  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Demo", exact: true }).click();
  await app.tab.getByLabel("Greeting").fill("Hola");
  await u.key("Enter");
  await u.key("Escape");
  await app.tab.getByText("greeting: Hola").waitFor();
  await app.until("it to be saved", async () => JSON.parse(u.on(".itztli/plugin-data/demo.json")).settings.greeting === "Hola");
  assert.equal(JSON.parse(u.on(".itztli/plugin-data/demo.json")).storage.runs, 1);
  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Appearance" }).click();
  await app.tab.getByLabel("Theme", { exact: true }).selectOption({ label: "Demo theme" });
  await app.until("the theme", () => app.tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#ff8800"));
}, {
  fill: files({
    ".itztli/plugins/demo/plugin.json": manifest("demo", { settings: [{ key: "greeting", title: "Greeting", type: "string", default: "Hi" }] }),
    ".itztli/plugins/demo/main.js": `export default { async activate(ctx) {
      const item = ctx.ui.statusBar({});
      const show = () => item.setText("greeting: " + ctx.settings.get("greeting"));
      ctx.settings.onChange(show);
      show();
      await ctx.storage.set("runs", (ctx.storage.get("runs") ?? 0) + 1);
      ctx.themes.register({ id: "t", name: "Demo theme", appearance: "dark", colors: { accent: "#ff8800" } });
    } };`,
  }),
});

test("extends the editor with CodeMirror from a plugin", async (app, u) => {
  await app.call("host", "plugin_enable", { id: "demo", development: false });
  await u.open("a", "a.md");
  await app.tab.locator(".demo-line").first().waitFor();
  await u.caretAfter("a.md", "text ");
  await u.type("@jo");
  await app.tab.locator(".cm-tooltip-autocomplete li", { hasText: "@john" }).waitFor();
  await app.tab.waitForTimeout(150);
  await u.key("Enter");
  await u.saved("a.md", (t) => t === "text John Smith\n");
  await u.key("Alt+Enter");
  await app.tab.getByText("Shout this line").waitFor();
}, {
  fill: files({
    "a.md": "text \n",
    ".itztli/plugins/demo/plugin.json": manifest("demo"),
    ".itztli/plugins/demo/main.js": `export default { activate(ctx) {
      const { EditorView, Decoration } = ctx.modules["@codemirror/view"];
      ctx.editor.registerExtension(EditorView.decorations.compute(["doc"], (state) => Decoration.set([Decoration.line({ class: "demo-line" }).range(0)])));
      ctx.editor.registerCompletion(({ before }) => { const m = /@\\w*$/.exec(before); return m && { replace: m[0].length, options: [{ label: "@john", insert: "John Smith" }] }; });
      ctx.contextActions.register(({ editor, line }) => [{ title: "Shout this line", run: () => editor.setText(line.toUpperCase()) }]);
    } };`,
  }),
});

test("starts plugins from a template that works as it is", async (app, u) => {
  await u.action("New Plugin");
  await app.tab.getByRole("dialog", { name: "New Plugin" }).waitFor();
  await u.type("Mi Plugin Ñandú");
  await u.key("Enter");
  await app.tab.getByRole("button", { name: "Enable for development" }).click();
  await app.tab.getByRole("button", { name: "Mi Plugin Ñandú" }).waitFor();
  assert.ok(u.exists(".itztli/plugins/mi-plugin-nandu/itztli.d.ts"));
  await u.open("a", "a.md");
  await u.action("Mi Plugin Ñandú: Insert Greeting");
  await u.saved("a.md", (t) => t.includes("Hello, a!"));
}, { fill: files({ "a.md": "" }) });

test("leaves out a plugin that hung the app while starting", async (app, u) => {
  await app.call("host", "plugin_enable", { id: "demo", development: false });
  await app.tab.getByText("demo ready").waitFor();
  // As if it had never finished starting.
  await app.tab.evaluate(() => localStorage.setItem("itztli.plugins.starting", "demo"));
  await u.reload();
  await app.tab.getByText("Demo was not started").waitFor();
  assert.equal(await app.tab.getByText("demo ready").count(), 0);
  await app.tab.getByRole("button", { name: "Try again" }).click();
  await app.tab.getByText("demo ready").waitFor();
}, {
  fill: files({
    ".itztli/plugins/demo/plugin.json": manifest("demo"),
    ".itztli/plugins/demo/main.js": `export default { activate(ctx) { ctx.ui.statusBar({}).setText("demo ready"); } };`,
  }),
});

// Every snippet of the guide that uses `ctx`, each in a plugin of its own.
const snippets = [...readFileSync(join(import.meta.dirname, "../docs/plugins.md"), "utf8").matchAll(/```js\n([\s\S]*?)```/g)]
  .map((m) => m[1])
  .filter((code) => /\bctx\./.test(code));

test("runs the snippets of the plugin guide", async (app, u) => {
  for (const i of snippets.keys()) await app.call("host", "plugin_enable", { id: `snippet-${i}`, development: false });
  for (const i of snippets.keys()) await app.tab.getByText(`snippet ${i} ran`, { exact: true }).waitFor();
  await app.tab.getByRole("button", { name: "Recently Changed" }).click();
  await app.tab.getByRole("region", { name: "Recently Changed" }).getByText("Inbox.md").waitFor();
  assert.match(u.on("Inbox.md"), /one more thing/);
  await u.open("a", "a.md");
  await app.tab.locator(".my-todo").waitFor();
  await app.tab.locator(".cm-block-widget progress").waitFor();
}, {
  fill: (vault) => {
    files({ "Inbox.md": "# Inbox\n", "a.md": "x\n\nTODO\n\n```progress\n40\n```\n" })(vault);
    for (const [i, code] of snippets.entries()) {
      const main = code.startsWith("export default")
        ? code.replace("activate(ctx) {", `activate(ctx) { ctx.ui.statusBar({}).setText("snippet ${i} ran");`)
        : `export default { async activate(ctx) {\n${code}\nctx.ui.statusBar({}).setText("snippet ${i} ran"); } };`;
      files({ [`.itztli/plugins/snippet-${i}/plugin.json`]: manifest(`snippet-${i}`), [`.itztli/plugins/snippet-${i}/main.js`]: main })(vault);
    }
  },
});

test("runs every example plugin", async (app, u) => {
  for (const id of ["csv-table", "volcan-theme", "local-llm"]) {
    assert.equal(await app.call("host", "plugin_enable", { id, development: false }), true, id);
  }
  await u.open("a", "a.md");
  await app.tab.locator(".csv-table td", { hasText: "Ana, la primera" }).waitFor();
  await app.tab.locator(".csv-table th", { hasText: "n" }).last().click();
  assert.deepEqual(await app.tab.locator(".csv-table td:last-child").allInnerTexts(), ["2", "10"]);
  await app.tab.getByRole("treeitem", { name: "data.csv" }).dblclick();
  await app.tab.locator(".csv-file td", { hasText: "y" }).waitFor();
  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Appearance" }).click();
  await app.tab.getByLabel("Theme", { exact: true }).selectOption({ label: "Volcán" });
  await app.until("the theme", () => app.tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#e8673c"));
  await app.tab.getByRole("button", { name: "Local LLM", exact: true }).click();
  await app.tab.getByLabel("Model").waitFor();
}, {
  fill: (vault) => {
    files({ "a.md": 'x\n\n```csv\nname,n\nLuis,10\n"Ana, la primera",2\n```\n', "data.csv": "x,y\n1,y\n" })(vault);
    cpSync(join(import.meta.dirname, "../examples/plugins"), join(vault, ".itztli/plugins"), { recursive: true });
  },
});

// ── The keymap ─────────────────────────────────────────────────────────────

test("gives the keyboard back when a popup closes", async (app, u) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "x");
  const popups = [
    async () => (await u.key("Shift"), await u.key("Shift")),
    () => u.key("Mod+e"),
    () => u.key("Mod+Shift+f"),
    () => u.key("Mod+Comma"),
    () => u.key("Alt+Enter"),
    () => u.key("Mod+l"),
  ];
  for (const [i, open] of popups.entries()) {
    await open();
    await app.tab.getByRole("dialog").waitFor();
    await u.key("Escape");
    await app.tab.getByRole("dialog").waitFor({ state: "hidden" });
    await app.until(`the caret back after popup ${i}`, () => u.editor("a.md").evaluate((e) => e === document.activeElement), 4000);
    await u.type(String(i));
  }
  await u.saved("a.md", (t) => t === "x012345\n");
}, { fill: files({ "a.md": "x\n" }) });

test("stays where it was scrolled to when a popup closes", async (app, u) => {
  await u.open("long", "long.md");
  await u.caretAfter("long.md", "line 150");
  const scrolled = () => app.tab.locator(".cm-scroller").evaluate((e) => e.scrollTop);
  await app.until("it to scroll", async () => (await scrolled()) > 1000);
  await app.tab.waitForTimeout(200);
  const before = await scrolled();
  for (const keys of ["Mod+e", "Mod+Comma", "Mod+l"]) {
    await u.key(keys);
    await app.tab.getByRole("dialog").waitFor();
    await u.key("Escape");
    await app.tab.getByRole("dialog").waitFor({ state: "hidden" });
    await app.tab.waitForTimeout(150);
    assert.ok(Math.abs((await scrolled()) - before) < 5, `${keys}: ${before} → ${await scrolled()}`);
  }
}, { fill: files({ "long.md": Array.from({ length: 300 }, (_, i) => `line ${i}\n`).join("\n") }) });

test("lets keys be changed", async (app, u) => {
  await u.key("Mod+Comma");
  await app.tab.getByRole("button", { name: "Keymap", exact: true }).click();
  await app.tab.getByLabel("Search actions or keys").fill("Recent Files");
  await app.tab.getByRole("button", { name: "Change keys of Recent Files" }).click();
  await u.key("Mod+Shift+y");
  await u.key("Escape");
  await u.key("Mod+Shift+y");
  await app.tab.getByRole("dialog", { name: "Recent Files" }).waitFor();
}, { fill: files({ "a.md": "" }) });

// ── MCP ────────────────────────────────────────────────────────────────────

/** The MCP server listens where nothing else does. */
async function mcpPort(app) {
  const port = await freePort();
  const settings = await app.call("host", "mcp", { command: "settings", args: {} });
  await app.call("host", "mcp_change", { change: { kind: "settings", settings: { ...settings, port } } });
  return port;
}

/** Calls tools as an assistant does: a request on its own, as MCP 2026-07-28 has them. */
const assistant = (port, token) => async (tool, args) => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const params = { name: tool, arguments: { vault: "My Vault", ...args }, _meta: meta };
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": tool,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }),
  });
  const answer = await response.json();
  if (!answer.result) throw new Error(JSON.stringify(answer));
  return answer.result.isError ? { error: answer.result.content[0].text } : answer.result.structuredContent;
};

/** An assistant with access, already connected. */
async function connected(app) {
  const port = await mcpPort(app);
  const { id } = await app.call("call", "vault_current");
  const change = { kind: "createClient", name: "claude-code", access: { vaultId: id, access: "write" }, turnOn: true };
  const { token } = await app.call("host", "mcp_change", { change });
  return assistant(port, token);
}

test("connects an MCP client, and shows what it does", async (app, u, port) => {
  await u.action("Connect an MCP Client");
  const dialog = app.tab.getByRole("dialog", { name: "Connect an MCP Client" });
  await dialog.getByLabel("Client name").fill("claude-code");
  await dialog.getByRole("radio", { name: "Read", exact: true }).click();
  await app.shot("mcp-new-client");
  await dialog.getByRole("button", { name: "Create" }).click();
  const shown = app.tab.getByRole("dialog", { name: "Token for claude-code" });
  const token = await shown.getByLabel("Token", { exact: true }).innerText();
  assert.match(token, /^itztli_[\w-]{43}$/);
  const command = await shown.getByLabel("Claude Code configuration", { exact: true }).innerText();
  assert.equal(command.trim(), `claude mcp add --scope user --transport http itztli http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`);
  await app.shot("mcp-token");
  await u.key("Enter");
  await shown.waitFor({ state: "hidden" });
  await app.shot("mcp-clients");
  const access = app.tab.getByRole("table", { name: "Access of claude-code" });
  assert.equal(await access.getByRole("radio", { name: "Read", exact: true }).getAttribute("aria-checked"), "true");

  const call = assistant(port, token);
  const found = await call("search_notes", { query: "cancion" });
  assert.deepEqual(found.notes, [{ path: "Work/Plan.md", lines: [{ line: 3, text: "La canción" }] }]);
  assert.match((await call("create_note", { path: "x", text: "x" })).error, /may only read/);
  assert.ok(!u.exists("x.md"));

  const window = app.tab.locator("[data-tool-window=mcp]");
  await window.getByRole("radio", { name: "Activity" }).click();
  const log = window.getByRole("listbox", { name: "MCP activity" });
  await log.getByRole("option", { name: /Denied.*claude-code.*Create x/ }).waitFor();
  await log.getByRole("option", { name: /Allowed.*claude-code.*1 match.*Searched “cancion”/ }).click();
  await window.getByRole("region", { name: "Activity details" }).getByText("e2e 1.0").waitFor();
  // A read of a note opens it.
  await call("read_note", { path: "Plan" });
  await log.getByRole("option", { name: /Read Work\/Plan.md/ }).dblclick();
  await u.editor("Work/Plan.md").waitFor();
  await app.tab.locator("footer").getByText(`MCP :${port} · 1`).waitFor();
  await app.shot("mcp-activity");
}, { fill: files({ "Work/Plan.md": "# Plan\n\nLa canción\n" }), prepare: mcpPort });

test("asks before an MCP client changes a note, and keeps what it said", async (app, u, call) => {
  await u.open("a", "a.md");
  await u.caretAfter("a.md", "three");
  const edit = call("edit_note", { path: "a.md", edits: [{ oldText: "two", newText: "2" }], reason: "You asked" });
  const dialog = app.tab.getByRole("dialog", { name: "claude-code wants to change a note: a" });
  await dialog.waitFor();
  // Someone was typing.
  await u.type("x y\n");
  await u.key("Escape");
  assert.ok(await dialog.isVisible());
  assert.match(await dialog.innerText(), /My Vault \/\s*a\.md[^]*“You asked”/);
  const approve = dialog.getByRole("button", { name: "Approve" });
  assert.ok(await approve.isDisabled());
  await app.shot("mcp-approval");
  assert.equal(u.on("a.md"), "one\ntwo\nthree\n");
  await approve.click();
  assert.equal((await edit).path, "a.md");
  assert.equal(u.on("a.md"), "one\n2\nthree\n");
  await app.until("the editor to show it", async () => (await u.editor("a.md").innerText()).includes("2"));
  // The keyboard is back in the note.
  await app.until("the caret", () => u.editor("a.md").evaluate((e) => e === document.activeElement));
  await u.action("Local History");
  await app.tab.getByRole("dialog").getByText("Changed by an MCP client").waitFor();
}, { fill: files({ "a.md": "one\ntwo\nthree\n" }), prepare: connected });

test("rejects, puts off and queues the changes of an MCP client", async (app, u, call) => {
  const answers = [
    call("delete_note", { path: "a.md" }),
    call("create_note", { path: "New/b", text: "# B\n" }),
    call("move_note", { path: "a.md", to: "c.md" }),
  ];
  await app.tab.getByText("1 of 3").waitFor();
  await app.tab.waitForTimeout(900);
  await u.key("Escape");
  await app.tab.getByRole("dialog").waitFor({ state: "hidden" });
  await app.tab.getByRole("button", { name: "3 approvals" }).click();
  // Enter, with Reject focused, says no to the first.
  await app.tab.getByText("1 of 3").waitFor();
  const title = await app.tab.getByRole("dialog").getByRole("heading").innerText();
  await app.tab.waitForTimeout(900);
  await u.key("Enter");
  await app.tab.getByText("1 of 2").waitFor();
  for (let left = 2; left > 0; left--) await app.tab.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  const results = await Promise.all(answers);
  const rejected = results.filter((r) => r.error?.startsWith("The user rejected"));
  assert.equal(rejected.length, 1, title);
  await app.tab.getByRole("dialog").waitFor({ state: "hidden" });
}, { fill: files({ "a.md": "a\n", "x.md": "[[a]]\n" }), prepare: connected });

test("makes no change of an MCP client that nobody answers", async (app, u, call) => {
  await u.open("a", "a.md");
  const edit = call("edit_note", { path: "a.md", edits: [{ oldText: "one", newText: "two" }] });
  const dialog = app.tab.getByRole("dialog", { name: "claude-code wants to change a note: a" });
  await dialog.waitFor();
  // In front, with Approve ready, until its time is over.
  await app.until("Approve to be ready", () => dialog.getByRole("button", { name: "Approve" }).isEnabled());
  assert.match((await edit).error, /^Nobody approved the change in Itztli within 10s/);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(u.on("a.md"), "one\n");
  const [last] = await app.call("host", "mcp", { command: "audit", args: { filter: { limit: 1 } } });
  assert.deepEqual([last.tool, last.decision], ["edit_note", "timeout"]);
}, {
  fill: files({ "a.md": "one\n" }),
  async prepare(app) {
    const call = await connected(app);
    const settings = await app.call("host", "mcp", { command: "settings", args: {} });
    await app.call("host", "mcp_change", { change: { kind: "settings", settings: { ...settings, approvalTimeoutSecs: 10 } } });
    return call;
  },
});

test("lets an MCP client change notes without asking, until asked again", async (app, u, call) => {
  await u.key("Mod+9");
  const window = app.tab.locator("[data-tool-window=mcp]");
  await window.getByRole("radio", { name: "Clients" }).click();
  const ask = window.getByRole("switch", { name: "Ask before each change" });
  assert.equal(await ask.getAttribute("aria-checked"), "true");
  await ask.click();
  await app.until("it to stop asking", async () => (await ask.getAttribute("aria-checked")) === "false");
  await window.getByText("Its changes are made at once").waitFor();
  await ask.scrollIntoViewIfNeeded();
  await app.shot("mcp-unasked");

  const created = await call("create_note", { path: "New", text: "# New\n", reason: "You asked" });
  assert.equal(created.path, "New.md");
  assert.equal(u.on("New.md"), "# New\n");
  assert.equal(await app.tab.getByRole("dialog").count(), 0, "nobody was asked");
  await window.getByRole("radio", { name: "Activity" }).click();
  await window.getByRole("listbox", { name: "MCP activity" }).getByRole("option", { name: /Allowed.*claude-code.*Create New.md/ }).click();
  const detail = window.getByRole("region", { name: "Activity details" });
  await detail.getByText("Not asked: this client's changes did not need your approval.").waitFor();
  await detail.getByText("Not asked", { exact: true }).waitFor();

  await window.getByRole("radio", { name: "Clients" }).click();
  await ask.click();
  await app.until("it to ask again", async () => (await ask.getAttribute("aria-checked")) === "true");
  const edit = call("edit_note", { path: "New.md", edits: [{ oldText: "New", newText: "Old" }] });
  const dialog = app.tab.getByRole("dialog", { name: "claude-code wants to change a note: New" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Reject" }).click();
  assert.match((await edit).error, /^The user rejected this change/);
  assert.equal(u.on("New.md"), "# New\n");
  const log = await app.call("host", "mcp", { command: "audit", args: { filter: { limit: 2 } } });
  assert.deepEqual(log.map((e) => [e.tool, e.decision, e.approvalWaitMs === null]), [
    ["edit_note", "rejected", false],
    ["create_note", "allowed", true],
  ]);
}, { prepare: connected });

test("takes an MCP client's access away at once", async (app, u, call) => {
  await call("read_note", { path: "a.md" });
  await u.key("Mod+9");
  const window = app.tab.locator("[data-tool-window=mcp]");
  await window.getByRole("radio", { name: "Clients" }).click();
  await window.getByRole("radio", { name: "None", exact: true }).click();
  await app.until("it to be gone", async () => /No vault/.test((await call("read_note", { path: "a.md" })).error ?? ""));
  await window.getByRole("button", { name: "Revoke…" }).click();
  await app.tab.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await app.until("its token to stop", () => call("list_vaults", {}).then(() => false, (e) => /-32001/.test(e.message)));
  await window.getByRole("radio", { name: "Server" }).click();
  await app.shot("mcp-server");
  await window.getByRole("switch", { name: "MCP server" }).click();
  await app.until("the server to stop", () => call("list_vaults", {}).then(() => false, (e) => !/-32001/.test(e.message)));
}, { fill: files({ "a.md": "a\n" }), prepare: connected });

// ── Running them ───────────────────────────────────────────────────────────

const wanted = process.argv[2];
let failed = 0;
for (const { name, run, options } of tests.filter((t) => !wanted || t.name.includes(wanted))) {
  const app = await start({ welcome: false, ...options });
  const started = Date.now();
  try {
    const u = user(app);
    // What has to be there before the UI is.
    const prepared = await options.prepare?.(app);
    await u.load();
    await run(app, u, prepared);
    if (!options.errors) assert.deepEqual(app.errors, [], "no errors in the console");
    console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    await app.shot(`failed-${name.replace(/\W+/g, "-")}`).catch(() => {});
    console.log(`✗ ${name}\n    ${String(e.message).split("\n").slice(0, 6).join("\n    ")}`);
    if (app.errors.length) console.log(`    console: ${app.errors.slice(0, 3).join("\n    ")}`);
  } finally {
    await app.stop();
  }
}
await finish();
console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
