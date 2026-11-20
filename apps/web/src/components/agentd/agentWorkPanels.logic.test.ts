import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface, ThreadRightPanelState } from "../../rightPanelStore";
import {
  isAgentBrowserCall,
  latestAgentBrowserCall,
  resolveAgentWorkPanelAction,
} from "./agentWorkPanels.logic";

const item = (fields: Record<string, unknown>) => fields as unknown as ThreadStructureTurnItem;
const tool = (id: string, toolName: string | null, status = "running") =>
  item({ id, type: "dynamic_tool", status, toolName, input: {} });

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
    [tool("p1", "mcp__agentd-next__preview_open"), true],
    [tool("p2", "agentd-next.preview_snapshot"), true],
    [tool("p3", "mcp__t3-code__preview_act"), true],
    [tool("h", "mcp__agentd-next__html_preview"), false],
    [tool("o", "mcp__other__preview_open"), false],
    [tool("n", null), false],
    [item({ id: "c", type: "command_execution", status: "running", input: "ls" }), false],
  ])("reads %o as a browser call: %s", (entry, expected) => {
    expect(isAgentBrowserCall(entry)).toBe(expected);
  });

  it("takes the newest browser call and whether it still runs", () => {
    expect(latestAgentBrowserCall([])).toBeNull();
    expect(
      latestAgentBrowserCall([
        tool("old", "mcp__agentd-next__preview_open", "completed"),
        tool("now", "mcp__agentd-next__preview_act", "pending"),
        item({ id: "msg", type: "assistant_message", status: "completed" }),
      ]),
    ).toEqual({ id: "now", live: true });
  });

  it("opens a closed panel on the agent's browser tab, waiting until the tab exists", () => {
    expect(resolveAgentWorkPanelAction(panel({}))).toEqual({ action: "wait" });
    expect(resolveAgentWorkPanelAction(panel({ surfaces: [file, browser] }))).toEqual({
      action: "reveal",
      surfaceId: "browser:tab-1",
    });
  });

  it("leaves an open panel on the tab the user chose", () => {
    const onFile = panel({ isOpen: true, surfaces: [browser, file], activeSurfaceId: "file:a.ts" });
    expect(resolveAgentWorkPanelAction(onFile)).toEqual({ action: "none" });
  });

  it("does not reopen a panel the user closed", () => {
    const dismissed = panel({ surfaces: [browser], agentWorkPanelsDismissed: true });
    expect(resolveAgentWorkPanelAction(dismissed)).toEqual({ action: "none" });
  });
});
