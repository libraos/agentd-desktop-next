import { useAtomValue } from "@effect/atom-react";
import type { AgentdCloudTaskInput, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { useAgentdTasks } from "~/lib/agentdState";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { rememberCloudKeyFiles } from "./rememberKeyFiles";
import { cloudOfferEnded, cloudOfferStarted } from "./startTask.logic";

interface PendingKeyFiles {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly submitted: AgentdCloudTaskInput["cloud"];
}

const pendingKeyFiles = Atom.make<ReadonlyArray<PendingKeyFiles>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("agentd:pending-cloud-key-files"),
);

/**
 * The BYOK paths sent with a cloud task agentd saved but didn't confirm: saved once the synced
 * task list shows it started, whether or not the dialog or card that started it is still open.
 */
export function followCloudKeyFiles(
  environmentId: EnvironmentId,
  taskId: string,
  submitted: AgentdCloudTaskInput["cloud"],
) {
  if (submitted.modelAccess !== "byok") return;
  const others = appAtomRegistry
    .get(pendingKeyFiles)
    .filter((entry) => entry.environmentId !== environmentId || entry.taskId !== taskId);
  appAtomRegistry.set(pendingKeyFiles, [...others, { environmentId, taskId, submitted }]);
}

function settle(entry: PendingKeyFiles) {
  appAtomRegistry.set(
    pendingKeyFiles,
    appAtomRegistry.get(pendingKeyFiles).filter((other) => other !== entry),
  );
}

/** Mounted with the app: its task subscriptions also run the server's cloud sync fallback. */
export function PendingCloudKeyFiles() {
  const pending = useAtomValue(pendingKeyFiles);
  return pending.map((entry) => (
    <PendingCloudKeyFile key={`${entry.environmentId}:${entry.taskId}`} entry={entry} />
  ));
}

function PendingCloudKeyFile({ entry }: { entry: PendingKeyFiles }) {
  const { data } = useAgentdTasks(entry.environmentId);
  const started = cloudOfferStarted(data, entry.taskId);
  const ended = cloudOfferEnded(data, entry.taskId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saves to client settings once the synced task list shows the offer started
  useEffect(() => {
    if (started) rememberCloudKeyFiles(entry.environmentId, entry.submitted);
    if (started || ended) settle(entry);
  }, [started, ended, entry]);
  return null;
}
