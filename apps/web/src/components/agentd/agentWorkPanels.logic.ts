import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

import type { ThreadRightPanelState } from "../../rightPanelStore";

export type AgentWorkPanelKind = "terminal" | "preview";

export type AgentWorkPanelAction =
  | { readonly action: "none" }
  | { readonly action: "reveal"; readonly surfaceId: string }
  | { readonly action: "launch-terminal" }
  /** The browser tab the agent is opening has no panel surface yet. */
  | { readonly action: "wait" };

const inProgress = (item: ThreadStructureTurnItem) =>
  item.status === "pending" || item.status === "running";

export function agentWorkPanelKind(item: ThreadStructureTurnItem): AgentWorkPanelKind | null {
  if (item.type === "command_execution") return item.monitor ? null : "terminal";
  if (item.type === "dynamic_tool") {
    return resolveT3McpToolId(item.toolName)?.startsWith("preview_") ? "preview" : null;
  }
  return null;
}

/** The thread's newest command or app-browser call, and whether the agent is still on it. */
export function latestAgentWorkItem(
  items: ReadonlyArray<ThreadStructureTurnItem>,
): { readonly id: string; readonly kind: AgentWorkPanelKind; readonly live: boolean } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    const kind = agentWorkPanelKind(item);
    if (kind !== null) return { id: item.id, kind, live: inProgress(item) };
  }
  return null;
}

/**
 * What showing the agent's work does to a thread's panel. A panel the user closed stays
 * closed, and an open panel on a tab the user chose (a file, the diff) is left alone.
 */
export function resolveAgentWorkPanelAction(
  panel: ThreadRightPanelState,
  kind: AgentWorkPanelKind,
): AgentWorkPanelAction {
  if (panel.agentWorkPanelsDismissed) return { action: "none" };
  const active = panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId);
  if (panel.isOpen && active !== undefined) {
    if (active.kind === kind) return { action: "none" };
    if (active.kind !== "terminal" && active.kind !== "preview") return { action: "none" };
  }
  const existing = panel.surfaces.findLast(
    (surface) => surface.kind === kind && (surface.kind !== "preview" || surface.resourceId),
  );
  if (existing) return { action: "reveal", surfaceId: existing.id };
  return kind === "terminal" ? { action: "launch-terminal" } : { action: "wait" };
}
