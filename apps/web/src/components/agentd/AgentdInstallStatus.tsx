import type { AgentdStatus } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, Var } from "gt-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

const PATH_NOTICE_KEY = "agentd:path-notice-dismissed";
const DismissedFolder = Schema.NullOr(Schema.String);

/** Which agentd the app runs, where the desktop app installed it, and a missing PATH folder once. */
export function AgentdInstallStatus({ status }: { status: AgentdStatus }) {
  const install = status.install ?? null;
  // The folder the notice was dismissed for; a different folder is reported again.
  const [dismissed, setDismissed] = useLocalStorage(PATH_NOTICE_KEY, null, DismissedFolder);
  const repair = status.servicesRepair ?? null;
  if (status.binary === undefined && install === null && repair === null) return null;
  const pathLine = install?.pathLine ?? null;
  return (
    <div className="space-y-2 border-t border-border pt-3 text-sm">
      {status.binary !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">
            <T>Uses</T>
          </span>
          <span className="break-all text-muted-foreground">{status.binary}</span>
        </div>
      ) : null}
      {repair !== null ? (
        <p role="status" className={repair.ok ? "text-muted-foreground" : "text-destructive"}>
          {repair.kept !== undefined && repair.kept.length > 0 ? (
            <T>
              One of AgentD’s background services runs an AgentD that is missing or belongs to the
              old AgentD Desktop, and another runs your own AgentD. This app left both alone: run
              agentd install with the AgentD you use.
            </T>
          ) : repair.reason === "ledgers" ? (
            <T>
              AgentD’s background services run an AgentD that is missing or belongs to the old
              AgentD Desktop, and they use two different AgentD ledgers. This app left them alone:
              run agentd install for each ledger, with its AGENTD_ROOT and AGENTD_DB set as that
              service has them.
            </T>
          ) : repair.reason === "ledger" ? (
            <T>
              AgentD’s watchdog runs an AgentD that is missing or belongs to the old AgentD Desktop,
              and its service sets its own AGENTD_ROOT or AGENTD_DB, which agentd install would not
              keep. This app left it alone: run agentd install in a terminal, then set those for the
              agentd-watchdog service again.
            </T>
          ) : repair.reason === "transient" ? (
            <T>
              AgentD’s background services run an AgentD that is missing or belongs to the old
              AgentD Desktop. This app’s AgentD is gone once the app closes, so they were left
              alone: install agentd for the terminal, then run agentd install.
            </T>
          ) : repair.command !== undefined ? (
            <>
              <T>
                AgentD’s background services run an AgentD that is missing or belongs to the old
                AgentD Desktop. AgentD won’t start them while older AgentD services are on: run
                this, then agentd install, in a terminal.
              </T>
              <code className="mt-1 block whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-xs text-foreground">
                {repair.command}
              </code>
            </>
          ) : repair.ok ? (
            <T>
              AgentD’s background services ran an AgentD that is missing or belongs to the old
              AgentD Desktop. They now run this app’s AgentD, so cloud results sync again.
            </T>
          ) : (
            <T>
              AgentD’s background services run an AgentD that is missing or belongs to the old
              AgentD Desktop, and moving them to this app’s AgentD failed. Run agentd install in a
              terminal.
            </T>
          )}
        </p>
      ) : null}
      {install !== null ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium">
            <T>Installed for the terminal</T>
          </span>
          <span className="break-all text-muted-foreground">
            {install.action === "kept-newer" || install.action === "kept-unknown" ? (
              <T>
                <Var>{install.path}</Var> (your own agentd, kept)
              </T>
            ) : (
              install.path
            )}
          </span>
        </div>
      ) : null}
      {install !== null && pathLine !== null && dismissed !== install.directory ? (
        <Alert variant="info">
          <AlertTitle>
            <T>
              <Var>{install.directory}</Var> is not on your PATH
            </T>
          </AlertTitle>
          <AlertDescription>
            <T>To run agentd in a terminal, add this line to your shell profile:</T>
            <code className="block whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1 text-xs">
              {pathLine}
            </code>
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => setDismissed(install.directory)}>
              <T>Got it</T>
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
    </div>
  );
}
