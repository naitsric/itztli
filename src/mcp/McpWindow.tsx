import { useEffect, type ComponentType } from "react";
import { cx, Segmented, StatusDot } from "../ui/primitives";
import { ToolWindowHeader } from "../workbench/ToolWindowPane";
import { hideToolWindow } from "../workbench/toolWindows";
import { ActivityTab } from "./ActivityTab";
import { ClientsTab } from "./ClientsTab";
import { ServerTab } from "./ServerTab";
import { serverState } from "./status";
import { reloadClients, setMcpTab, useMcp, type McpTab } from "./store";

const TABS: Record<McpTab, { label: string; content: ComponentType }> = {
  activity: { label: "Activity", content: ActivityTab },
  clients: { label: "Clients", content: ClientsTab },
  server: { label: "Server", content: ServerTab },
};

/**
 * The MCP tool window: what clients do through Itztli, who may reach the
 * user's vaults and with which access, and the server they reach it on.
 */
export function McpWindow() {
  const tab = useMcp((s) => s.tab);
  const Content = TABS[tab].content;

  // Presence moves without events in between (seen at most every 30 s).
  useEffect(() => {
    void reloadClients();
  }, []);

  return (
    <>
      <ToolWindowHeader title="MCP" icon="bot" onHide={() => hideToolWindow("mcp")}>
        <ServerSummary />
        <Segmented
          label="MCP"
          value={tab}
          options={(Object.keys(TABS) as McpTab[]).map((id) => ({ value: id, label: TABS[id].label }))}
          onChange={setMcpTab}
        />
      </ToolWindowHeader>
      <div className="flex min-h-0 flex-1 flex-col border-t border-border">
        <Content />
      </div>
    </>
  );
}

/** Whether the server is on; opens the Server tab. Its error is the tooltip. */
function ServerSummary() {
  const status = useMcp((s) => s.status);
  const enabled = useMcp((s) => s.settings?.enabled ?? false);
  const { tone, label } = serverState(status, enabled);
  return (
    <button
      type="button"
      onClick={() => setMcpTab("server")}
      title={status.error ?? undefined}
      className="mr-2 flex min-w-0 items-center gap-1.5 rounded px-1 text-[11.5px] text-muted hover:text-fg"
    >
      <StatusDot tone={tone} />
      <span className={cx("truncate", tone === "danger" && "text-danger")}>{label}</span>
    </button>
  );
}
