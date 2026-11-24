import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * What the UI runs on: the desktop app, or a browser talking to the
 * development server (`pnpm dev:web`).
 */
export interface Host {
  /** Runs a backend command. */
  call<T>(command: string, args: object): Promise<T>;
  /** Runs a command of the host itself: what needs the user's say or the system. */
  ask<T>(command: string, args: object): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): () => void;
  pluginUrl(token: string, file: string): string;
  vaultUrl(path: string): string;
  remoteUrl(url: string): string;
  readonly desktop: boolean;
}

const desktopHost: Host = {
  desktop: true,
  call: (command, args) => invoke("call", { command, args }),
  ask: (command, args) => invoke(command, { ...args }),
  listen(event, handler) {
    const stop = listen(event, ({ payload }) => handler(payload as never));
    return () => void stop.then((unlisten) => unlisten());
  },
  // Not convertFileSrc: it would encode the slash between token and file.
  pluginUrl: (token, file) => `${convertFileSrc("", "itztli-plugin")}${token}/${file}`,
  vaultUrl: (path) => convertFileSrc(path, "itztli-vault"),
  remoteUrl: (url) => convertFileSrc(url, "itztli-remote"),
};

function browserHost(base: string): Host {
  const post = async <T,>(kind: "call" | "host", command: string, args: object): Promise<T> => {
    const response = await fetch(`${base}/${kind}/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const value = await response.json();
    if (!response.ok) throw value;
    return value as T;
  };
  let events: EventSource | null = null;
  return {
    desktop: false,
    call: (command, args) => post("call", command, args),
    ask: (command, args) => post("host", command, args),
    listen(event, handler) {
      events ??= new EventSource(`${base}/events`);
      const listener = (e: MessageEvent<string>) => handler(JSON.parse(e.data));
      events.addEventListener(event, listener);
      return () => events?.removeEventListener(event, listener);
    },
    pluginUrl: (token, file) => `${base}/plugin/${token}/${file}`,
    vaultUrl: (path) => `${base}/vault/${path.split("/").map(encodeURIComponent).join("/")}`,
    remoteUrl: (url) => url,
  };
}

// A constant the build removes the other branch with.
export const host: Host = import.meta.env.VITE_DEV_BACKEND
  ? browserHost(import.meta.env.VITE_DEV_BACKEND)
  : desktopHost;
