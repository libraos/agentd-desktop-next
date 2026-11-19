import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { type EnvironmentId, type MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { T, useGT } from "gt-react";
import { useId, useState } from "react";

import { agentdEnvironment } from "~/lib/agentdState";
import { useLibraosGatewayConnected } from "~/lib/libraosGatewayState";
import { newMessageId } from "~/lib/utils";
import { rightPanelHostRef, useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useThreadProjection } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { CloudWorkersSetup } from "./CloudWorkersSetup";
import { StartTaskCloud, useStartTaskCloud } from "./StartTaskCloud";
import { StartTaskOthers } from "./StartTaskOthers";
import {
  conversationTaskDraft,
  EMPTY_TASK_FIELDS,
  TASK_ACCEPT_LIMIT,
  TASK_BUDGET_LIMIT,
  TASK_DRAFT_PROMPT,
  TASK_ISSUE_LIMIT,
  TASK_TEXT_LIMIT,
  TASK_WORKERS,
  type TaskFields,
} from "./startTask.logic";
import {
  TaskPlanSummary,
  type TaskStartOutcome,
  useTaskDefaults,
  useTaskDirectory,
  useTaskPlan,
} from "./taskPlan";

const dialogState = Atom.make<{
  readonly threadRef: ScopedThreadRef;
  readonly fields: TaskFields | null;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("agentd:start-task-dialog"));

/** Opens Start task for the session, with fields from a task card's draft when given. */
export function openStartTaskDialog(threadRef: ScopedThreadRef, fields: TaskFields | null = null) {
  appAtomRegistry.set(dialogState, { threadRef, fields });
}

export function useCanStartTask(environmentId: EnvironmentId | null) {
  return useAtomValue(agentdEnvironment.startTask.permissionAtom(environmentId));
}

export function StartTaskDialogHost() {
  const opened = useAtomValue(dialogState);
  return opened === null ? null : (
    <StartTaskDialog
      key={scopedThreadKey(opened.threadRef)}
      threadRef={opened.threadRef}
      initialFields={opened.fields}
      onClose={() => appAtomRegistry.set(dialogState, null)}
    />
  );
}

function TaskField({
  label,
  id,
  reason,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly reason?: string | null;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {reason && (
        <p id={`${id}-reason`} className="text-muted-foreground text-xs">
          {reason}
        </p>
      )}
    </div>
  );
}

function StartTaskDialog({
  threadRef,
  initialFields,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly initialFields: TaskFields | null;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const id = useId();
  const { environmentId, threadId } = threadRef;
  const { thread, cwd } = useTaskDirectory(threadRef);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [editedFields, setEditedFields] = useState<TaskFields | null>(initialFields);
  const [checkEdited, setCheckEdited] = useState(initialFields !== null);
  // A hand-filled task starts with its inputs open; a drafted one starts as its summary.
  const [editing, setEditing] = useState(initialFields === null);
  const [draft, setDraft] = useState<{ messageId: MessageId; previous: TaskFields } | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [offeredId, setOfferedId] = useState<string | null>(null);
  // An earlier cloud offer whose outcome is unknown: Start checks agentd before offering again.
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [replaceSubmission, setReplaceSubmission] = useState<string | null>(null);
  const projection = useThreadProjection(draft === null ? null : threadRef)?.projection;
  const reply = draft === null ? null : conversationTaskDraft(projection, draft.messageId);
  const drafting = reply?.kind === "waiting";
  const fields =
    editedFields ?? (reply?.kind === "ready" ? reply.fields : draft?.previous) ?? EMPTY_TASK_FIELDS;
  const defaults = useTaskDefaults(cwd, environmentId, fields.size);
  const gatewayConnected = useLibraosGatewayConnected(environmentId);
  const cloud = useStartTaskCloud(cwd, environmentId, {
    estimate: defaults?.estimate ?? null,
    gatewayConnected,
  });
  const plan = useTaskPlan({
    threadRef,
    cwd,
    fields,
    checkEdited: checkEdited || reply?.kind === "ready",
    defaults,
    cloud,
  });
  const { canStart, filled, validation, worker, starting } = plan;
  const goalReason =
    validation.goal === "required"
      ? gt("Enter a goal.")
      : validation.goal === "invalid"
        ? gt("Enter a goal that does not begin with a dash or contain a NUL character.")
        : null;
  const checkReason =
    validation.check === "required" && !cloud.enabled
      ? gt("Enter a check command.")
      : validation.check === "invalid"
        ? gt("Enter a check command that does not begin with a dash or contain a NUL character.")
        : null;
  const budgetReason =
    validation.budget === "invalid"
      ? gt("Enter a positive budget such as 30m, $2, or 30m,$2.")
      : null;
  const acceptReason = validation.accept
    ? gt(
        "Use at most {limit} acceptance criteria, one per line, with no leading dashes or NUL characters.",
        { limit: TASK_ACCEPT_LIMIT },
      )
    : null;
  const issueReason = validation.issue ? gt("Use the format OWNER/REPO#123.") : null;
  const keysMissing = cloud.enabled && cloud.modelAccess !== "libraos" && cloud.input === null;
  const showInputs =
    editing ||
    goalReason !== null ||
    checkReason !== null ||
    budgetReason !== null ||
    acceptReason !== null ||
    issueReason !== null ||
    keysMissing ||
    (cloud.enabled && !cloud.budgetValid);
  const disabled = starting || drafting || offeredId !== null || !plan.ready;
  const draftDisabled =
    thread === null ||
    threadRuntimeIsActive(thread.runtime) ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    !canStart;

  function showFailure(error: unknown, fallback: string) {
    return error instanceof Error ? error.message : fallback;
  }

  async function requestDraft() {
    if (draftDisabled || drafting || starting || offeredId !== null || thread === null) return;
    const messageId = newMessageId();
    setDraftError(null);
    setEditedFields(null);
    setDraft({ messageId, previous: fields });
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: { messageId, role: "user", text: TASK_DRAFT_PROMPT, attachments: [] },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: "default",
        dispatchMode: "start",
        createdAt: new Date().toISOString(),
      },
    });
    if (result._tag === "Failure") {
      setDraft(null);
      setEditedFields(fields);
      setDraftError(
        showFailure(
          squashAtomCommandFailure(result),
          gt("Could not ask the session’s agent for a draft."),
        ),
      );
    }
  }

  function settle(outcome: TaskStartOutcome) {
    switch (outcome.kind) {
      case "refused":
        setStartError(outcome.reason);
        return;
      case "failed":
        setOutcomeUnknown(outcome.outcomeUnknown);
        setReplaceSubmission(outcome.replaceSubmission);
        setStartError(showFailure(outcome.error, gt("AgentD could not start the task.")));
        return;
      case "offered":
        setOutcomeUnknown(false);
        setReplaceSubmission(null);
        setOfferedId(outcome.task.id);
        setStartError(outcome.task.note ?? gt("AgentD did not dispatch the task."));
        return;
      case "started":
        useRightPanelStore.getState().open(rightPanelHostRef(threadRef), "background-tasks");
        toastManager.add({
          type: "success",
          title: gt("Started task {taskId}.", { taskId: outcome.task.id }),
        });
        onClose();
    }
  }

  function submit(replacing: string | null = null) {
    if (disabled) return;
    setStartError(null);
    void plan.start(replacing).then((outcome) => {
      if (outcome !== null) settle(outcome);
    });
  }

  function fieldProps(field: keyof TaskFields, reason: string | null) {
    const fieldId = `${id}-${field}`;
    return {
      id: fieldId,
      "aria-describedby": reason ? `${fieldId}-reason` : undefined,
      disabled: starting || drafting || offeredId !== null,
    };
  }
  function updateField<Field extends keyof TaskFields>(field: Field, value: TaskFields[Field]) {
    if (field === "check") setCheckEdited(true);
    setEditedFields({ ...filled, [field]: value });
  }
  const goalProps = fieldProps("goal", goalReason);
  const acceptProps = fieldProps("accept", acceptReason);
  const checkProps = fieldProps("check", checkReason);
  const workerProps = fieldProps("worker", null);
  const budgetProps = fieldProps("budget", budgetReason);
  const issueProps = fieldProps("issue", issueReason);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !plan.startingRef.current) onClose();
      }}
    >
      <DialogPopup showCloseButton={!starting}>
        <DialogHeader>
          <DialogTitle>
            <T>Hand to a worker</T>
          </DialogTitle>
          <DialogDescription>
            <T>Review the task and its budget before starting a worker on your account.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Button
            type="button"
            variant="outline"
            disabled={draftDisabled || drafting || starting || offeredId !== null}
            onClick={() => void requestDraft()}
          >
            {drafting ? (
              <T>Waiting for the session’s agent…</T>
            ) : (
              <T>Draft from this conversation</T>
            )}
          </Button>
          {draftError !== null || reply?.kind === "failed" ? (
            <p role="status" className="text-muted-foreground text-sm">
              {draftError ??
                gt(
                  "The session’s agent did not return a usable draft. You can still fill in the form.",
                )}
            </p>
          ) : null}
          {filled.goal.trim() !== "" ? <p className="text-sm">{filled.goal.trim()}</p> : null}
          <TaskPlanSummary plan={plan} />
          {showInputs && !editing ? null : (
            <Button
              type="button"
              variant="link"
              size="sm"
              aria-expanded={showInputs}
              onClick={() => setEditing(!editing)}
            >
              {showInputs ? <T>Hide details</T> : <T>Edit</T>}
            </Button>
          )}
          {showInputs ? (
            <>
              <TaskField label={gt("Goal")} id={goalProps.id} reason={goalReason}>
                <Textarea
                  {...goalProps}
                  rows={2}
                  maxLength={TASK_TEXT_LIMIT}
                  value={filled.goal}
                  onChange={(event) => updateField("goal", event.target.value)}
                />
              </TaskField>
              <TaskField
                label={gt("Acceptance criteria (one per line)")}
                id={acceptProps.id}
                reason={acceptReason}
              >
                <Textarea
                  {...acceptProps}
                  rows={2}
                  maxLength={TASK_TEXT_LIMIT}
                  value={filled.accept}
                  onChange={(event) => updateField("accept", event.target.value)}
                />
              </TaskField>
              <TaskField
                label={cloud.enabled ? gt("Check command (optional)") : gt("Check command")}
                id={checkProps.id}
                reason={
                  checkReason ??
                  (cloud.enabled && !validation.input.check
                    ? gt("Without a check command, you’ll need to accept the result yourself.")
                    : null)
                }
              >
                <Input
                  {...checkProps}
                  maxLength={TASK_TEXT_LIMIT}
                  value={filled.check}
                  onChange={(event) => updateField("check", event.target.value)}
                />
              </TaskField>
              <StartTaskCloud
                cloud={cloud}
                disabled={starting || drafting || offeredId !== null || !canStart}
              />
              {!cloud.enabled ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <TaskField label={gt("Worker")} id={workerProps.id}>
                    <Select
                      value={worker}
                      items={TASK_WORKERS}
                      disabled={workerProps.disabled}
                      onValueChange={(value) => updateField("worker", value)}
                    >
                      <SelectTrigger id={workerProps.id}>
                        <SelectValue placeholder={gt("Choose a worker")} />
                      </SelectTrigger>
                      <SelectPopup>
                        {Object.entries(TASK_WORKERS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </TaskField>
                  <TaskField label={gt("Budget")} id={budgetProps.id} reason={budgetReason}>
                    <Input
                      {...budgetProps}
                      maxLength={TASK_BUDGET_LIMIT}
                      placeholder="30m,$2"
                      value={filled.budget}
                      onChange={(event) => updateField("budget", event.target.value)}
                    />
                  </TaskField>
                </div>
              ) : null}
              <TaskField label={gt("Working directory")} id={`${id}-cwd`}>
                <Input id={`${id}-cwd`} readOnly value={cwd ?? ""} />
              </TaskField>
              {!cloud.enabled ? (
                <TaskField label={gt("Issue (optional)")} id={issueProps.id} reason={issueReason}>
                  <Input
                    {...issueProps}
                    maxLength={TASK_ISSUE_LIMIT}
                    placeholder="owner/repo#123"
                    value={filled.issue}
                    onChange={(event) => updateField("issue", event.target.value)}
                  />
                </TaskField>
              ) : null}
            </>
          ) : null}
          {!canStart && (
            <p className="text-muted-foreground text-sm">
              <T>This connection cannot start AgentD tasks.</T>
            </p>
          )}
          {startError !== null && (
            <div
              role="alert"
              className="space-y-1 rounded-lg border border-destructive/30 p-3 text-sm"
            >
              {offeredId !== null && (
                <p>
                  {cloud.enabled
                    ? gt(
                        "AgentD saved task {taskId}, but it didn’t start in Cloud Workers. Check Background tasks for updates before trying again.",
                        { taskId: offeredId },
                      )
                    : gt("Task {taskId} was offered but did not start.", { taskId: offeredId })}
                </p>
              )}
              <pre className="wrap-anywhere whitespace-pre-wrap">{startError}</pre>
              {cloud.enabled && replaceSubmission !== null ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => submit(replaceSubmission)}
                >
                  <T>Submit this task in its place</T>
                </Button>
              ) : null}
              {cloud.enabled &&
              cloud.setup?.problem !== "setup" &&
              /cloud configuration and account key file/.test(startError) ? (
                <CloudWorkersSetup
                  environmentId={environmentId}
                  canConfigure={cloud.setup?.canConfigure === true}
                  onConfigured={cloud.refresh}
                />
              ) : null}
            </div>
          )}
        </DialogPanel>
        <StartTaskOthers
          environmentId={environmentId}
          input={
            cwd !== null && canStart && !drafting && issueReason === null && offeredId === null
              ? { cwd, issue: validation.input.issue }
              : null
          }
        />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={starting} onClick={onClose}>
            {offeredId === null ? <T>Cancel</T> : <T>Close</T>}
          </Button>
          {offeredId === null && (
            <Button type="button" disabled={disabled} onClick={() => submit()}>
              {cloud.enabled && outcomeUnknown ? (
                starting ? (
                  <T>Checking the earlier submission…</T>
                ) : (
                  <T>Check and retry</T>
                )
              ) : starting ? (
                <T>Starting…</T>
              ) : (
                <T>Start</T>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
