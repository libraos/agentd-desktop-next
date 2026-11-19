import { useAtomValue } from "@effect/atom-react";
import type { AgentdRunsOn, AgentdTask, AgentdTaskRow, EnvironmentId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { T, useGT, useLocale, useMessages, Var } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { agentdEnvironment, useAgentdCommands, useAgentdTask } from "../../lib/agentdState";
import { tickTextContent } from "../../lib/tickTextContent";
import { formatEnvironmentQueryError } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentdTaskOutput } from "./AgentdTaskOutput";
import { BackgroundTaskCard } from "./BackgroundTaskCard";
import { CloudTaskReviewActions } from "./CloudTaskReview";
import { finishedAgentdTaskLabel, runningAgentdTaskLabel } from "./backgroundTasks.logic";

function AgentdTaskLocation({ location }: { readonly location: AgentdRunsOn }) {
  switch (location) {
    case "local":
      return <T>Local worker</T>;
    case "team":
      return <T>Team node</T>;
    case "cloud":
      return <T>Cloud Worker</T>;
  }
}

function workerName(tool: string | null): string | null {
  switch (tool) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "opencode";
    default:
      return tool;
  }
}

function TaskDuration(props: {
  readonly started: string | null;
  readonly ended: string | null;
  readonly live: boolean;
}) {
  const resolve = useMessages();
  const started = Date.parse(props.started ?? "");
  const ended = Date.parse(props.ended ?? "");
  if (!Number.isFinite(started) || (!props.live && !Number.isFinite(ended))) {
    return (
      <span>
        <T>Duration unavailable</T>
      </span>
    );
  }
  const format = (now: number) => formatDuration(Math.max(0, now - started), resolve);
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="tabular-nums" />}>
        {props.live ? <span ref={tickTextContent(format, true)} /> : format(ended)}
      </TooltipTrigger>
      <TooltipPopup>
        {props.live ? (
          <T>Time since the task was created</T>
        ) : (
          <T>Time from task creation to last update</T>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

function TaskCost({ task }: { readonly task: AgentdTask }) {
  const locale = useLocale();
  if (task.costUsd === null) return <T>Cost unavailable</T>;
  const cost = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(task.costUsd);
  return task.costEstimate ? (
    <T>
      Estimated cost: <Var>{cost}</Var>
    </T>
  ) : (
    <T>
      Cost: <Var>{cost}</Var>
    </T>
  );
}

function FinishedTaskDetails({ task }: { readonly task: AgentdTask }) {
  return (
    <dl className="space-y-2 wrap-anywhere select-text">
      <div>
        <dt className="font-medium">
          <T>Check result</T>
        </dt>
        <dd className="whitespace-pre-wrap text-muted-foreground">
          {task.verdict?.check ?? <T>No check result was recorded.</T>}
        </dd>
      </div>
      <div>
        <dt className="font-medium">
          <T>Next step</T>
        </dt>
        <dd className="whitespace-pre-wrap text-muted-foreground">
          {task.verdict?.next ?? <T>No next step was recorded.</T>}
        </dd>
      </div>
    </dl>
  );
}

export function StopTaskButton(props: {
  readonly id: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
}) {
  const { environmentId, id, title } = props;
  const gt = useGT();
  const resolve = useMessages();
  const canStop = useAtomValue(agentdEnvironment.stopTask.permissionAtom(environmentId));
  const { stopTask } = useAgentdCommands();
  const [status, setStatus] = useState<"idle" | "pending" | "requested">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!canStop) return null;

  const stop = async () => {
    setStatus("pending");
    setError(null);
    const confirmed = await requestConfirmDialog(
      gt("Stop this background task?\n{title}", { title }),
      { variant: "destructive" },
    );
    if (confirmed !== true) {
      setStatus("idle");
      return;
    }
    const result = await stopTask({
      environmentId,
      input: { id, reason: "Stopped from AgentD Desktop" },
    });
    if (result._tag === "Failure") {
      setError(formatEnvironmentQueryError(result.cause, resolve));
      setStatus("idle");
      return;
    }
    setStatus("requested");
  };

  return (
    <>
      <Button size="xs" variant="ghost-destructive" disabled={status !== "idle"} onClick={stop}>
        {status === "requested" ? <T>Stop requested</T> : <T>Stop</T>}
      </Button>
      {error ? (
        <p className="max-w-32 wrap-anywhere text-xs text-destructive" role="alert">
          <T>
            Couldn&apos;t stop task: <Var>{error}</Var>
          </T>
        </p>
      ) : null}
    </>
  );
}

export function useAgentdTaskDetails(row: AgentdTaskRow, environmentId: EnvironmentId | null) {
  const { data, error, refresh } = useAgentdTask(row.id, environmentId);
  const task = data?.state === row.state ? data : null;
  const snapshot = JSON.stringify([
    row.state,
    row.updated,
    row.workerState,
    row.workerRunning,
    row.cloudState,
    row.cloudUsd,
  ]);
  const lastSnapshot = useRef(data !== null && task === null ? null : snapshot);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh bridge-only fields when the live list changes for this task
  useEffect(() => {
    if (lastSnapshot.current === snapshot) return;
    lastSnapshot.current = snapshot;
    refresh();
  }, [refresh, snapshot]);

  return { task, error };
}

function CloudState({ state }: { readonly state: string | null }) {
  switch (state) {
    case "submitting":
      return <T>Submitting</T>;
    case "queued":
      return <T>Queued</T>;
    case "running":
      return <T>Running</T>;
    case "settling":
      return <T>Settling</T>;
    case "completed":
      return <T>Completed</T>;
    case "failed":
      return <T>Failed</T>;
    case "failed_verification":
      return <T>Failed verification</T>;
    case "cancelled":
      return <T>Stopped</T>;
    case "budget_exceeded":
      return <T>Budget exceeded</T>;
    default:
      return state ?? <T>Status unavailable</T>;
  }
}

export function AgentdCloudTaskSummary({
  row,
  task,
}: {
  readonly row: AgentdTaskRow;
  readonly task: AgentdTask | null;
}) {
  const locale = useLocale();
  const format = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
  const cloud = task?.cloud;
  const state = row.cloudState ?? cloud?.state ?? row.workerState;
  const total = row.cloudUsd ?? cloud?.totalUsd;
  const branch = task?.branch ?? row.branch;
  return (
    <>
      <Badge variant="secondary">
        <AgentdTaskLocation location="cloud" />
      </Badge>
      <span className="font-medium text-foreground">
        <CloudState state={state} />
      </span>
      {cloud?.modelAccess === "subscription" ? (
        <span>
          {cloud.plan === "codex" ? (
            <T>Your ChatGPT subscription</T>
          ) : (
            <T>Your Claude subscription</T>
          )}
        </span>
      ) : cloud?.modelAccess === "byok" ? (
        <span>
          <T>Your API key</T>
        </span>
      ) : cloud?.modelAccess === "libraos" ? (
        <span>LibraOS</span>
      ) : null}
      {cloud?.workerUsd != null ? (
        <span>
          <T>
            Worker cost: <Var>{format.format(cloud.workerUsd)}</Var>
          </T>
        </span>
      ) : null}
      {cloud?.modelAccess === "subscription" ? (
        <span>
          {cloud.plan === "codex" ? (
            <T>Inference: billed to your ChatGPT plan</T>
          ) : (
            <T>Inference: billed to your Claude plan</T>
          )}
        </span>
      ) : cloud?.modelAccess === "byok" ? (
        <span>
          <T>Inference: billed by your provider</T>
        </span>
      ) : cloud?.inferenceUsd != null ? (
        <span>
          <T>
            Inference: <Var>{format.format(cloud.inferenceUsd)}</Var>
          </T>
        </span>
      ) : null}
      {total != null ? (
        <span>
          <T>
            Total (LibraOS): <Var>{format.format(total)}</Var>
          </T>
        </span>
      ) : null}
      {branch ? (
        <span className="min-w-0 wrap-anywhere">
          <T>
            Branch: <Var>{branch}</Var>
          </T>
        </span>
      ) : null}
    </>
  );
}

export function AgentdBackgroundTaskRow(props: {
  readonly row: AgentdTaskRow;
  readonly environmentId: EnvironmentId;
  readonly finished: boolean;
}) {
  const { row, environmentId, finished } = props;
  const gt = useGT();
  const resolve = useMessages();
  const { task, error } = useAgentdTaskDetails(row, environmentId);

  const title = task?.goal?.trim() || row.title || gt("Untitled task");
  const worker = workerName(task?.workerTool ?? row.workerTool);
  const location = task?.runsOn ?? (row.runsOn === "cloud" ? row.runsOn : null);
  const cloud = location === "cloud";
  return (
    <BackgroundTaskCard
      title={title}
      summary={
        <>
          {cloud ? (
            <AgentdCloudTaskSummary row={row} task={task} />
          ) : (
            <span className="font-medium text-foreground">
              {finished
                ? finishedAgentdTaskLabel(row.state, task?.verdict ?? null, resolve)
                : runningAgentdTaskLabel(row, task?.budgetState ?? null, resolve)}
            </span>
          )}
          {!finished && (!cloud || worker !== null) ? (
            <span>{worker ?? <T>Agent unknown</T>}</span>
          ) : null}
          {location === null || cloud ? null : (
            <span>
              <AgentdTaskLocation location={location} />
            </span>
          )}
          {task !== null || error !== null ? (
            <TaskDuration
              started={task?.started ?? null}
              ended={task?.updated ?? null}
              live={!finished}
            />
          ) : null}
          {finished && task && !cloud ? (
            <>
              <span className="min-w-0 wrap-anywhere">
                {task.branch ? (
                  <T>
                    Branch: <Var>{task.branch}</Var>
                  </T>
                ) : (
                  <T>Branch unavailable</T>
                )}
              </span>
              <span>
                <TaskCost task={task} />
              </span>
            </>
          ) : null}
          {cloud && task?.note ? (
            <span className="basis-full wrap-anywhere text-destructive">{task.note}</span>
          ) : null}
        </>
      }
      action={
        !finished ? (
          <StopTaskButton id={row.id} title={title} environmentId={environmentId} />
        ) : cloud ? (
          <CloudTaskReviewActions row={row} task={task} environmentId={environmentId} />
        ) : null
      }
    >
      {error ? (
        <p className="text-destructive" role="alert">
          <T>
            Couldn&apos;t load task details: <Var>{error}</Var>
          </T>
        </p>
      ) : null}
      {finished ? (
        task ? (
          <FinishedTaskDetails task={task} />
        ) : error === null ? (
          <T>Loading task details…</T>
        ) : null
      ) : (
        <AgentdTaskOutput
          id={task?.hasLog === false ? null : row.id}
          environmentId={environmentId}
        />
      )}
    </BackgroundTaskCard>
  );
}
