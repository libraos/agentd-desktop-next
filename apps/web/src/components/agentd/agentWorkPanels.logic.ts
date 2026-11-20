import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

import type { ThreadRightPanelState } from "../../rightPanelStore";

export type AgentWorkPanelAction =
  | { readonly action: "none" }
  | { readonly action: "reveal"; readonly surfaceId: string }
  /** The browser tab the agent is opening has no panel surface yet. */
  | { readonly action: "wait" };

const inProgress = (item: ThreadStructureTurnItem) =>
  item.status === "pending" || item.status === "running";

export function isAgentBrowserCall(item: ThreadStructureTurnItem): boolean {
  return (
    item.type === "dynamic_tool" &&
    resolveT3McpToolId(item.toolName)?.startsWith("preview_") === true
  );
}

/** The thread's newest app-browser call, and whether the agent is still on it. */
export function latestAgentBrowserCall(
  items: ReadonlyArray<ThreadStructureTurnItem>,
): { readonly id: string; readonly live: boolean } | null {
  const item = items.findLast(isAgentBrowserCall);
  return item === undefined ? null : { id: item.id, live: inProgress(item) };
}

/**
 * What the agent's browser use does to a thread's panel. A panel the user closed stays
 * closed, and an open panel is left on the tab the user chose.
 */
export function resolveAgentWorkPanelAction(panel: ThreadRightPanelState): AgentWorkPanelAction {
  if (panel.agentWorkPanelsDismissed) return { action: "none" };
  if (panel.isOpen && panel.activeSurfaceId !== null) return { action: "none" };
  const existing = panel.surfaces.findLast(
    (surface) => surface.kind === "preview" && surface.resourceId,
  );
  return existing ? { action: "reveal", surfaceId: existing.id } : { action: "wait" };
}
