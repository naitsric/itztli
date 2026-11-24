// Runs the real UI, built as it ships, in WebKit (what the app uses on macOS)
// against the real backend, on a vault made for each test.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { webkit } from "playwright";

const root = resolve(import.meta.dirname, "..");
export const OUTPUT = join(root, "e2e/output");

export function freePort() {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function until(what, check, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`waited too long for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The UI is built once, for a backend at a port and with a token of this run. */
let build = null;

async function built() {
  if (build) return build;
  const [backendPort, pagePort] = [await freePort(), await freePort()];
  const token = randomBytes(16).toString("hex");
  const backend = `http://127.0.0.1:${backendPort}/${token}`;
  const out = mkdtempSync(join(tmpdir(), "itztli-e2e-dist-"));
  const result = spawnSync("pnpm", ["exec", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, VITE_DEV_BACKEND: backend },
  });
  if (result.status !== 0) throw new Error(`the UI does not build:\n${result.stdout}${result.stderr}`);
  const preview = spawn("pnpm", ["exec", "vite", "preview", "--outDir", out, "--port", String(pagePort), "--strictPort"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const page = `http://localhost:${pagePort}`;
  await until("the page", async () => (await fetch(page)).ok);
  process.on("exit", () => {
    preview.kill();
    rmSync(out, { recursive: true, force: true });
  });
  build = { backendPort, token, backend, page, browser: await webkit.launch() };
  return build;
}

export async function finish() {
  await build?.browser.close();
}

/** Starts everything. `fill` writes the vault's files; the welcome notes are there already. */
export async function start({ fill = () => {}, welcome = true, colorScheme = "dark" } = {}) {
  mkdirSync(OUTPUT, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "itztli-e2e-")));
  const vault = join(dir, "My Vault");
  const data = join(dir, "data");
  mkdirSync(vault);
  fill(vault);

  const { backendPort, token, backend, page, browser } = await built();
  const server = spawn(join(root, `target/${process.env.ITZTLI_PROFILE ?? "debug"}/itztli-devserver`), [vault, data], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ITZTLI_DEV_PORT: String(backendPort), ITZTLI_DEV_TOKEN: token, ITZTLI_DEV_PAGE: page },
  });
  const call = async (kind, command, args = {}) => {
    const response = await fetch(`${backend}/${kind}/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return response.json();
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme });
  const tab = await context.newPage();
  const errors = [];
  tab.on("pageerror", (e) => errors.push(`page: ${e.message}`));
  tab.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));

  await until("the backend", async () => (await call("call", "app_info")).version);
  await call("host", "vault_pick", { welcome });

  return {
    tab,
    vault,
    page,
    errors,
    call,
    until,
    shot: (name) => tab.screenshot({ path: join(OUTPUT, `${name}.png`) }),
    async stop() {
      await context.close();
      const gone = new Promise((done) => server.on("exit", done));
      server.kill();
      await gone;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
