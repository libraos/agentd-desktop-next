import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface, ThreadRightPanelState } from "../../rightPanelStore";
import {
  agentWorkPanelKind,
  latestAgentWorkItem,
  resolveAgentWorkPanelAction,
} from "./agentWorkPanels.logic";

const item = (fields: Record<string, unknown>) => fields as unknown as ThreadStructureTurnItem;
const command = (id: string, status = "running", monitor?: boolean) =>
  item({ id, type: "command_execution", status, input: "ls", ...(monitor ? { monitor } : {}) });
const tool = (id: string, toolName: string | null, status = "running") =>
  item({ id, type: "dynamic_tool", status, toolName, input: {} });

const terminal: RightPanelSurface = {
  id: "terminal:term-1",
  kind: "terminal",
  resourceId: "term-1",
  terminalIds: ["term-1"],
  activeTerminalId: "term-1",
};
const browser: RightPanelSurface = { id: "browser:tab-1", kind: "preview", resourceId: "tab-1" };
const file: RightPanelSurface = {
  id: "file:a.ts",
  kind: "file",
  relativePath: "a.ts",
  revealLine: null,
  revealRequestId: 0,
};
const panel = (fields: Partial<ThreadRightPanelState>) =>
  ({ isOpen: false, activeSurfaceId: null, surfaces: [], ...fields }) as ThreadRightPanelState;

describe("agentWorkPanels", () => {
  it.each([
    [command("c"), "terminal"],
    [command("m", "running", true), null],
    [tool("p1", "mcp__agentd-next__preview_open"), "preview"],
    [tool("p2", "agentd-next.preview_snapshot"), "preview"],
    [tool("p3", "mcp__t3-code__preview_act"), "preview"],
    [tool("h", "mcp__agentd-next__html_preview"), null],
    [tool("o", "mcp__other__preview_open"), null],
    [tool("n", null), null],
    [item({ id: "f", type: "file_change", status: "running" }), null],
  ])("reads %o as %s", (entry, kind) => {
    expect(agentWorkPanelKind(entry)).toBe(kind);
  });

  it("takes the newest command or browser call and whether it still runs", () => {
    expect(latestAgentWorkItem([])).toBeNull();
    expect(
      latestAgentWorkItem([
        command("old", "completed"),
        tool("web", "mcp__agentd-next__preview_open", "completed"),
        item({ id: "msg", type: "assistant_message", status: "completed" }),
      ]),
    ).toEqual({ id: "web", kind: "preview", live: false });
    expect(latestAgentWorkItem([command("now", "pending")])).toEqual({
      id: "now",
      kind: "terminal",
      live: true,
    });
  });

  it("opens a closed panel on the agent's tab, launching a terminal or waiting for a browser", () => {
    expect(resolveAgentWorkPanelAction(panel({}), "terminal")).toEqual({
      action: "launch-terminal",
    });
    expect(resolveAgentWorkPanelAction(panel({}), "preview")).toEqual({ action: "wait" });
    const withTabs = panel({ surfaces: [terminal, browser], activeSurfaceId: "terminal:term-1" });
    expect(resolveAgentWorkPanelAction(withTabs, "terminal")).toEqual({
      action: "reveal",
      surfaceId: "terminal:term-1",
    });
    expect(resolveAgentWorkPanelAction(withTabs, "preview")).toEqual({
      action: "reveal",
      surfaceId: "browser:tab-1",
    });
  });

  it("follows the agent between its tabs but leaves a tab the user chose", () => {
    const onTerminal = panel({
      isOpen: true,
      surfaces: [terminal, browser, file],
      activeSurfaceId: "terminal:term-1",
    });
    expect(resolveAgentWorkPanelAction(onTerminal, "terminal")).toEqual({ action: "none" });
    expect(resolveAgentWorkPanelAction(onTerminal, "preview")).toEqual({
      action: "reveal",
      surfaceId: "browser:tab-1",
    });
    const onFile = { ...onTerminal, activeSurfaceId: "file:a.ts" };
    expect(resolveAgentWorkPanelAction(onFile, "preview")).toEqual({ action: "none" });
  });

  it("does not reopen a panel the user closed", () => {
    const dismissed = panel({ surfaces: [terminal, browser], agentWorkPanelsDismissed: true });
    expect(resolveAgentWorkPanelAction(dismissed, "terminal")).toEqual({ action: "none" });
    expect(resolveAgentWorkPanelAction(dismissed, "preview")).toEqual({ action: "none" });
  });
});
