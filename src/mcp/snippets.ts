/**
 * What to paste into an MCP client to reach Itztli. A token is only known
 * right after it is created or regenerated; everywhere else the snippets
 * carry {@link TOKEN_PLACEHOLDER} for the user to replace.
 */

export const TOKEN_PLACEHOLDER = "<TOKEN>";

/** The port the server listens on unless the user picks another. */
export const DEFAULT_PORT = 7413;

/** The name clients list the server under. */
export const SERVER_NAME = "itztli";

/** The MCP endpoint on `port`: an IP, not `localhost`, which may resolve to `::1` first. */
export function endpointUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * Itztli's executable once installed, which stdio-only clients run as `<it> mcp-bridge`.
 * The app reports the one it actually runs from (see `mcpApi.endpoint`); this is for until it does.
 */
export const INSTALLED_BRIDGE_COMMAND = "/Applications/Itztli.app/Contents/MacOS/itztli";

export type SnippetId = "claudeCode" | "claudeDesktop" | "cursor" | "vscode" | "other";

export interface Snippet {
  id: SnippetId;
  /** The client, as a tab label. */
  label: string;
  /** Where the text goes. */
  hint: string;
  text: string;
}

/**
 * `text` as one argument for a POSIX shell: as is when nothing in it is
 * special to the shell, else in double quotes with `\`, `"`, `$` and
 * backticks escaped.
 */
export function shellArg(text: string): string {
  if (/^[\w\-.,:/@%+=]+$/.test(text)) return text;
  return `"${text.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

export function claudeCodeSnippet(url: string, token: string): string {
  const header = shellArg(`Authorization: Bearer ${token}`);
  // For every project, not just the one the terminal is in: notes belong to none.
  return `claude mcp add --scope user --transport http ${SERVER_NAME} ${shellArg(url)} --header ${header}`;
}

export function cursorSnippet(url: string, token: string): string {
  const config = { mcpServers: { [SERVER_NAME]: { url, headers: { Authorization: `Bearer ${token}` } } } };
  return JSON.stringify(config, null, 2);
}

export function vscodeSnippet(url: string, token: string): string {
  const config = { servers: { [SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } };
  return JSON.stringify(config, null, 2);
}

export function genericSnippet(url: string, token: string): string {
  return `URL:    ${url}\nHeader: Authorization: Bearer ${token}`;
}

/**
 * A `claude_desktop_config.json` that runs Itztli's stdio bridge, `command mcp-bridge --port <port>`,
 * with the token in its environment: arguments are visible to other processes.
 */
export function claudeDesktopSnippet(command: string, port: number, token: string): string {
  const server = { command, args: ["mcp-bridge", "--port", String(port)], env: { ITZTLI_MCP_TOKEN: token } };
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: server } }, null, 2);
}

/**
 * Every snippet for the server on `port`, with the token or the placeholder. `bridgeCommand` is the
 * executable stdio-only clients run.
 */
export function snippets(
  port: number,
  token: string = TOKEN_PLACEHOLDER,
  bridgeCommand: string = INSTALLED_BRIDGE_COMMAND,
): Snippet[] {
  const url = endpointUrl(port);
  return [
    { id: "claudeCode", label: "Claude Code", hint: "Run in a terminal.", text: claudeCodeSnippet(url, token) },
    {
      id: "claudeDesktop",
      label: "Claude Desktop",
      hint: "Add to claude_desktop_config.json (Settings → Developer → Edit Config), then restart Claude.",
      text: claudeDesktopSnippet(bridgeCommand, port, token),
    },
    {
      id: "cursor",
      label: "Cursor",
      hint: "Add to ~/.cursor/mcp.json, or .cursor/mcp.json in a project.",
      text: cursorSnippet(url, token),
    },
    {
      id: "vscode",
      label: "VS Code",
      hint: "Add to .vscode/mcp.json, or with “MCP: Open User Configuration”.",
      text: vscodeSnippet(url, token),
    },
    {
      id: "other",
      label: "Other Clients",
      hint: "Any client that speaks MCP over Streamable HTTP.",
      text: genericSnippet(url, token),
    },
  ];
}
