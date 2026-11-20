import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { latestAgentBrowserCall, resolveAgentWorkPanelAction } from "./agentWorkPanels.logic";

/**
 * Opens a Code thread's right panel on the browser tab when the agent drives the app's
 * browser. Nothing here moves keyboard focus.
 */
export function useAgentWorkPanels(input: {
  /** Null when the thread is not a Code thread, is embedded, or the setting is off. */
  readonly threadRef: ScopedThreadRef | null;
  readonly turnItems: ReadonlyArray<ThreadStructureTurnItem>;
}) {
  const { threadRef, turnItems } = input;
  // Per thread: the call already shown, and one whose browser tab has not reached the panel yet.
  const shownRef = useRef(new Map<string, string>());
  const waitingRef = useRef(new Map<string, string>());
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the browser tab in the store as the agent's turn items arrive
  useEffect(() => {
    if (threadRef === null) return;
    const threadKey = scopedThreadKey(threadRef);
    const latest = latestAgentBrowserCall(turnItems);
    if (latest === null || shownRef.current.get(threadKey) === latest.id) return;
    if (!latest.live && waitingRef.current.get(threadKey) !== latest.id) return;
    const decision = resolveAgentWorkPanelAction(panel);
    if (decision.action === "wait") {
      waitingRef.current.set(threadKey, latest.id);
      return;
    }
    waitingRef.current.delete(threadKey);
    shownRef.current.set(threadKey, latest.id);
    if (decision.action === "reveal") {
      useRightPanelStore.getState().openForAgentWork(threadRef, decision.surfaceId);
    }
  }, [panel, threadRef, turnItems]);
}
