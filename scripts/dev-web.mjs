// Runs the UI in a browser against a real vault, without building the desktop
// app: `pnpm dev:web <vault folder>`. For working on the UI.
//
// Everything listens on this computer only, and the backend answers only to
// this page, which gets a token made up for the occasion.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const vault = process.argv[2];
if (!vault) {
  console.error("usage: pnpm dev:web <vault folder>");
  process.exit(1);
}
const root = resolve(import.meta.dirname, "..");
const data = resolve(root, "target/dev-web");
mkdirSync(data, { recursive: true });

const token = randomBytes(16).toString("hex");
const port = process.env.ITZTLI_DEV_PORT ?? "7465";
const page = "http://localhost:1420";

const children = [
  spawn("cargo", ["run", "-q", "-p", "itztli-devserver", "--", resolve(vault), data], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ITZTLI_DEV_PORT: port, ITZTLI_DEV_TOKEN: token, ITZTLI_DEV_PAGE: page, ITZTLI_DEV_OPEN: "1" },
  }),
  spawn("pnpm", ["exec", "vite"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_BACKEND: `http://127.0.0.1:${port}/${token}` },
  }),
];

const stop = () => children.forEach((c) => c.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
