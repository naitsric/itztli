import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpClient, McpSettings } from "./api";

vi.mock("../backend/host", () => ({ host: { listen: () => () => {}, ask: async () => {}, call: async () => {}, desktop: false } }));
vi.mock("./api", () => ({
  mcpApi: {
    saveSettings: vi.fn(),
    createClient: vi.fn(),
    rotateClient: vi.fn(),
    setAccess: vi.fn(),
    setApproval: vi.fn(),
    deleteClient: vi.fn(),
  },
}));

const { mcpApi } = await import("./api");
const { createClient, replaceToken, saveSettings, setAccess, setApproval, useMcp } = await import("./store");

const settings: McpSettings = { enabled: false, port: 7413, maxResults: 100, approvalTimeoutSecs: 120 };
const client: McpClient = {
  id: "c1",
  name: "claude-code",
  tokenPrefix: "itztli_abcdef",
  createdAt: "2026-11-01T12:00:00.000Z",
  lastSeenAt: null,
  lastClientName: null,
  lastClientVersion: null,
  revokedAt: null,
  changesNeedApproval: true,
  grants: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  useMcp.setState({ settings, clients: [client], dialog: { kind: "newClient" }, tab: "activity" });
});

describe("when the user says no to the system's question", () => {
  it("the server stays as it was", async () => {
    vi.mocked(mcpApi.saveSettings).mockResolvedValue(null);
    expect(await saveSettings({ ...settings, enabled: true })).toBe(false);
    expect(useMcp.getState().settings?.enabled).toBe(false);
  });

  it("there is no client, and its dialog is still there", async () => {
    vi.mocked(mcpApi.createClient).mockResolvedValue(null);
    expect(await createClient("cursor", { vaultId: "v1", access: "read" }, true)).toBe(false);
    expect(useMcp.getState()).toMatchObject({ clients: [client], dialog: { kind: "newClient" } });
  });

  it("access, approval and token stay as they were", async () => {
    vi.mocked(mcpApi.setAccess).mockResolvedValue(null);
    vi.mocked(mcpApi.setApproval).mockResolvedValue(null);
    vi.mocked(mcpApi.rotateClient).mockResolvedValue(null);
    useMcp.setState({ dialog: null });
    await setAccess("c1", "v1", "write");
    await setApproval("c1", false);
    await replaceToken(client);
    expect(useMcp.getState()).toMatchObject({ clients: [client], dialog: null });
  });
});

describe("when the user agrees", () => {
  it("a new client shows its token, and the server is on", async () => {
    const created = { ...client, id: "c2", name: "cursor" };
    vi.mocked(mcpApi.createClient).mockResolvedValue({ client: created, token: "itztli_secret" });
    expect(await createClient("cursor", { vaultId: "v1", access: "read" }, true)).toBe(true);
    expect(useMcp.getState()).toMatchObject({
      clients: [client, created],
      selectedClientId: "c2",
      tab: "clients",
      settings: { enabled: true },
      dialog: { kind: "token", token: "itztli_secret", replaced: false },
    });
  });

  it("access changes", async () => {
    const granted = { ...client, grants: [{ vaultId: "v1", vaultName: "Notes", vaultPath: "/n", access: "write" as const }] };
    vi.mocked(mcpApi.setAccess).mockResolvedValue(granted);
    await setAccess("c1", "v1", "write");
    expect(useMcp.getState().clients).toEqual([granted]);
  });

  it("the client's changes stop waiting for approval, and wait again", async () => {
    const unasked = { ...client, changesNeedApproval: false };
    vi.mocked(mcpApi.setApproval).mockResolvedValueOnce(unasked).mockResolvedValueOnce(client);
    await setApproval("c1", false);
    expect(mcpApi.setApproval).toHaveBeenLastCalledWith("c1", false);
    expect(useMcp.getState().clients).toEqual([unasked]);
    await setApproval("c1", true);
    expect(useMcp.getState().clients).toEqual([client]);
  });
});
