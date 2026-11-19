import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AgentdCommandError,
  type AgentdStartTaskResult,
  type AgentdTaskDefaults,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useGT, useLocale } from "gt-react";
import { useRef, useState } from "react";

import { agentdEnvironment, useAgentdStatus, useAgentdTaskDefaults } from "~/lib/agentdState";
import { useLibraosGatewayConnected } from "~/lib/libraosGatewayState";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import type { useStartTaskCloud } from "./StartTaskCloud";
import {
  autoBudget,
  budgetDollars,
  prepareTaskFields,
  TASK_WORKERS,
  taskBranchProblem,
  taskStartProblem,
  type TaskFields,
} from "./startTask.logic";
import { useWorkerDefaults } from "./workerSettings";

const isCommandError = Schema.is(AgentdCommandError);

/** The session's project directory, where a task from it runs. */
export function useTaskDirectory(threadRef: ScopedThreadRef) {
  const thread = useQuietThreadShell(threadRef);
  const project = useProject(
    thread ? scopeProjectRef(threadRef.environmentId, thread.projectId) : null,
  );
  return { thread, cwd: thread?.worktreePath ?? project?.workspaceRoot ?? null };
}

export function useTaskDefaults(
  cwd: string | null,
  environmentId: EnvironmentId,
  size: TaskFields["size"],
): AgentdTaskDefaults | null {
  return useAgentdTaskDefaults(cwd, environmentId, size).data ?? null;
}

export type TaskStartOutcome =
  | { readonly kind: "started"; readonly task: AgentdStartTaskResult }
  | { readonly kind: "offered"; readonly task: AgentdStartTaskResult }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      readonly outcomeUnknown: boolean;
      readonly replaceSubmission: string | null;
      /** A key file of the user's that agentd refused because others can read it. */
      readonly privateFile?: string;
    }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Everything a Start decides for the person: the fields filled from agentd's estimate and the
 * project, a one-line summary, the one problem that stops it, and the Start itself. The task card
 * in the chat and the Start task dialog share it, so both go through the same guarded path.
 */
export function useTaskPlan({
  threadRef,
  cwd,
  fields,
  checkEdited,
  defaults,
  cloud,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | null;
  readonly fields: TaskFields;
  /** The person changed the check, so a suggestion no longer fills an empty one. */
  readonly checkEdited: boolean;
  readonly defaults: AgentdTaskDefaults | null;
  readonly cloud: ReturnType<typeof useStartTaskCloud>;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { environmentId } = threadRef;
  const canStart = useAtomValue(agentdEnvironment.startTask.permissionAtom(environmentId));
  const status = useAgentdStatus(environmentId);
  const gatewayConnected = useLibraosGatewayConnected(environmentId);
  const git = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const refreshBranch = useAtomCommand(vcsEnvironment.refreshLocalStatusForPicker, {
    reportFailure: false,
  });
  const startTask = useAtomCommand(agentdEnvironment.startTask, { reportFailure: false });
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const workerDefaults = useWorkerDefaults();

  const estimate = defaults?.estimate ?? null;
  const local = autoBudget({
    estimate,
    defaultMinutes: null,
    balanceUsd: null,
    fallback: workerDefaults.budget,
  });
  const filled: TaskFields = {
    ...fields,
    budget: fields.budget.trim() || `${local.minutes}m,$${budgetDollars(local.dollars)}`,
    check: checkEdited || fields.check.trim() !== "" ? fields.check : (defaults?.check ?? ""),
  };
  const validation = prepareTaskFields(filled);
  const worker = filled.worker ?? status.data?.defaultWorker ?? null;
  const branch = git.data ? taskBranchProblem(git.data) : null;

  const money = (amount: number) =>
    new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount);
  const branchReason = (problem: ReturnType<typeof taskBranchProblem>, name: string | null) => {
    switch (problem) {
      case "not-repo":
        return gt("The working directory is not a Git repository.");
      case "detached":
        return gt("Check out a named branch in this working directory first.");
      case "protected":
        return gt("The working directory is on {branch}. Switch to a different branch first.", {
          branch: name ?? "",
        });
      case null:
        return null;
    }
  };
  const problemKind = taskStartProblem({
    cloud: cloud.enabled,
    balanceUsd: cloud.setup?.balanceUsd ?? null,
    creditProblem: cloud.setup?.problem === "credit",
    modelAccess: cloud.modelAccess,
    planProblem: cloud.planProblem,
    signedIn: cloud.signedIn,
    gatewayConnected,
    worker,
    hasDirectory: cwd !== null,
    branch,
  });
  const problem = (() => {
    switch (problemKind) {
      case "no-directory":
        return gt("This session has no project working directory.");
      case "balance":
        return gt("There is not enough LibraOS credit for Cloud Workers.");
      case "sign-in":
        return gt("Sign in to LibraOS or connect the LibraOS Gateway to use LibraOS models.");
      case "subscription":
        return cloud.plan === "codex"
          ? gt("Set up your ChatGPT plan, or choose another model access.")
          : gt("Set up your Claude plan, or choose another model access.");
      case "worker":
        return gt("Choose a worker. The default is set in agentd.");
      case "not-repo":
      case "detached":
      case "protected":
        return branchReason(problemKind, git.data?.refName ?? null);
      case null:
        break;
    }
    if (cloud.enabled && cloud.setup?.problem === "setup")
      return gt("Cloud Workers aren’t set up. Check the cloud configuration and account key file.");
    if (cloud.enabled && cloud.setup?.problem === "repository")
      return gt(
        "The repository owner must install the Cloud Workers GitHub App on this repository.",
      );
    if (!cloud.enabled && cwd !== null && git.error) return git.error;
    return null;
  })();
  const checking = cloud.enabled ? cloud.checkingBalance : cwd !== null && git.data === null;

  const capText = cloud.enabled
    ? money(Number(cloud.dollars) || 0)
    : money(Number(/\$([\d.]+)/.exec(validation.input.budget)?.[1] ?? 0));
  const models = cloud.enabled
    ? cloud.modelAccess === "libraos"
      ? gt("LibraOS models")
      : cloud.modelAccess === "subscription"
        ? cloud.plan === "codex"
          ? gt("your ChatGPT plan")
          : gt("your Claude plan")
        : gt("your API key")
    : gatewayConnected
      ? gt("LibraOS models")
      : null;
  const summary = [
    cloud.enabled ? gt("Cloud Workers") : worker === null ? null : TASK_WORKERS[worker],
    gt("budget up to {cap}", { cap: capText }),
    models,
    validation.input.check
      ? gt("check: {check}", { check: validation.input.check })
      : gt("no check"),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const estimateLine =
    estimate === null
      ? gt("Budget up to {cap} (agentd has no estimate for similar tasks yet).", { cap: capText })
      : gt("Budget up to {cap} (similar tasks cost {low}–{high}).", {
          cap: capText,
          low: money(estimate.low),
          high: money(estimate.high),
        }) +
        (cloud.enabled ? ` ${gt("The estimate comes from local runs of similar tasks.")}` : "");

  const ready =
    canStart &&
    problem === null &&
    !checking &&
    validation.goal === null &&
    (validation.check === null || (cloud.enabled && validation.check === "required")) &&
    !validation.accept &&
    (cloud.enabled ? cloud.input !== null : validation.budget === null && !validation.issue);

  async function run(replacing: string | null): Promise<TaskStartOutcome> {
    if (cwd === null)
      return { kind: "refused", reason: gt("This session has no project working directory.") };
    if (!cloud.enabled) {
      const current = await refreshBranch({ environmentId, input: { cwd, localOnly: true } });
      if (current._tag === "Failure") {
        return {
          kind: "failed",
          error: squashAtomCommandFailure(current),
          outcomeUnknown: false,
          replaceSubmission: null,
        };
      }
      const reason = branchReason(taskBranchProblem(current.value), current.value.refName);
      if (reason !== null) return { kind: "refused", reason };
    }
    const { goal, accept, check } = validation.input;
    const input = cloud.enabled
      ? cloud.input && {
          goal,
          accept,
          check: check || null,
          cwd,
          cloud:
            replacing === null ? cloud.input : { ...cloud.input, replaceSubmission: replacing },
        }
      : worker !== null && { ...validation.input, cwd, worker };
    if (!input) return { kind: "refused", reason: gt("AgentD could not start the task.") };
    const result = await startTask({ environmentId, input });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      return {
        kind: "failed",
        error: failure,
        outcomeUnknown: isCommandError(failure) && failure.outcomeUnknown === true,
        replaceSubmission: isCommandError(failure) ? (failure.replaceSubmission ?? null) : null,
        ...(isCommandError(failure) && failure.privateFile !== undefined
          ? { privateFile: failure.privateFile }
          : {}),
      };
    }
    if (cloud.enabled && cloud.input !== null) cloud.remember(cloud.input);
    return result.value.started
      ? { kind: "started", task: result.value }
      : { kind: "offered", task: result.value };
  }

  /** One Start at a time; null while one is running. */
  function start(replacing: string | null = null): Promise<TaskStartOutcome | null> {
    if (startingRef.current) return Promise.resolve(null);
    startingRef.current = true;
    setStarting(true);
    return run(cloud.enabled ? replacing : null)
      .catch((error: unknown): TaskStartOutcome => ({
        kind: "failed",
        error,
        outcomeUnknown: false,
        replaceSubmission: null,
      }))
      .finally(() => {
        startingRef.current = false;
        setStarting(false);
      });
  }

  return {
    canStart,
    filled,
    validation,
    worker,
    branch,
    gatewayConnected,
    git,
    problem,
    checking,
    summary,
    estimateLine,
    ready,
    starting,
    startingRef,
    start,
  };
}

/** The one-line summary of a Start, the estimate behind its budget, and what stops it. */
export function TaskPlanSummary({
  plan,
}: {
  readonly plan: Pick<ReturnType<typeof useTaskPlan>, "summary" | "estimateLine" | "problem">;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="wrap-anywhere text-sm">{plan.summary}</p>
      <p className="text-muted-foreground text-xs">{plan.estimateLine}</p>
      {plan.problem !== null ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {plan.problem}
        </p>
      ) : null}
    </div>
  );
}
