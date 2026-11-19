# 84: Start a task with one look

A Start fills in what it can and shows it as one line with Start: the worker (or Cloud Workers), "budget up to $N", the model access and the check. A second line gives the estimate behind the budget. Problems show as a single line, and Start stays disabled until they are fixed.

- **Budget.** The new read `agentd.taskDefaults` runs `agentd handoff estimate --type TYPE --json` on the environment's host. The type comes from the draft's size, and is `implement` when there is no size. The dollar cap is agentd's `high` rounded up to a whole dollar. For Cloud Workers it is also capped by the available credit. Minutes come from agentd's `default_budget` in the cloud balance answer, else 60. With no estimate (fewer than 5 priced past jobs, or no answer), the budget is `60m,$5`. When the person empties the budget, the filled one comes back. The Cloud Workers estimate line says it comes from local runs of similar tasks.
- **Model access.** It defaults to LibraOS when agentd read the LibraOS balance with its cloud key (signed in) or the LibraOS Gateway is connected. Otherwise it defaults to "Your API key" with the path inputs open. LibraOS chosen with neither available is the sign-in problem.
- **Check.** The same read suggests a check from the project root: the `package.json` test script with the lockfile's or `packageManager`'s runner (`npm init`'s placeholder is skipped), then `go.mod` → `go test ./...`, `Cargo.toml` → `cargo test`, `pyproject.toml` → `pytest`. Only `package.json` is opened (when it is at most 1 MiB); the other files are only checked to exist. The suggestion fills an empty check until the person edits the field.
- **Chat card.** `TASK_DRAFT_PROMPT` and its schema gain `size` (optional when decoding, so older drafts still parse). A finished assistant reply whose run's user message is the draft prompt renders in the conversation as a task card: goal, summary, Start and Edit. Start goes through the same `useTaskPlan` start as the dialog, with the local branch check first, and then the same `agentd.startTask` RPC. For a cloud Start, that RPC applies batch 1's reservation, duplicate-offer guard and failure reasons on the server. Edit opens the dialog with the card's fields.
- **Dialog.** It shows the same summary and Start. A drafted task's inputs are folded under Edit. A hand-filled task starts unfolded, and inputs that need attention unfold on their own. Batch 1's "Check and retry" and "Submit this task in its place" are unchanged.

Files:

- `apps/server/src/agentd/taskDefaults.ts` (new): estimate type, estimate parsing, check suggestion.
- `apps/server/src/agentd/taskDefaults.test.ts` (new): size → type, estimate and no-estimate parsing, each check rule.
- `apps/server/src/agentd/AgentdBridge.ts`: the `taskDefaults` read (estimate and project files in parallel; failures give null).
- `apps/server/src/agentd/AgentdBridge.test.ts`: the read against a stub agentd and a temporary project.
- `apps/server/src/agentd/agentdCommands.ts`: the fixed `handoff estimate --type TYPE --json` argument list.
- `apps/server/src/ws.ts`: route the new RPC (upstream file, one line).
- `apps/server/src/auth/RpcAuthorization.ts`: the read scope for it (upstream file, one line).
- `apps/server/src/observability/RpcInstrumentation.ts`: its span group (upstream file, one line).
- `packages/contracts/src/agentd.ts`: `AgentdTaskSize`, `AgentdTaskDefaultsInput`, `AgentdTaskEstimate`, `AgentdTaskDefaults`.
- `packages/contracts/src/rpc.ts`: the `agentd.taskDefaults` RPC (upstream file, appended).
- `packages/client-runtime/src/state/agentd.ts`: its query atom.
- `apps/web/src/lib/agentdState.ts`: `useAgentdTaskDefaults`.
- `apps/web/src/components/agentd/startTask.logic.ts`: draft size, `taskDraftReply`, `autoBudget`, `defaultModelAccess`, `taskStartProblem`.
- `apps/web/src/components/agentd/startTask.logic.test.ts`: size in the draft, the card's reply detection, budget, model access and problem rules.
- `apps/web/src/components/agentd/taskPlan.tsx` (new): the shared plan (filled fields, summary, estimate line, problem, Start) and `TaskPlanSummary`.
- `apps/web/src/components/agentd/TaskDraftCard.tsx` (new): the chat task card.
- `apps/web/src/components/agentd/StartTaskCloud.tsx`: estimate-based cap and minutes, default model access, `signedIn`.
- `apps/web/src/components/agentd/StartTaskDialog.tsx`: summary and Start, inputs under Edit, `openStartTaskDialog(threadRef, fields)`.
- `apps/web/src/components/agentd/StartTaskDialog.browser.test.tsx`: summary and fold, check suggestion, model access default, balance cap, each problem line, the card's Start and Edit.
- `apps/web/src/components/chat/TimelineAssistantRows.tsx`: render a draft reply as the task card (upstream file, a few lines).

Not verified:

- **Windows:** not run. The project files are found with the host's `path.join` and `isAbsolute`, and agentd runs through the existing process runner with a fixed argument list.
- **macOS:** not run.
- **Linux:** the server unit and bridge tests and the web unit and browser tests ran here against a stub agentd. A real agentd answered `handoff estimate --type implement --json` and `--type small` by hand. No task was started against a real agentd or Cloud Workers, and the card was not seen in a running app.
- **Translations:** catalogs regenerated and zh filled.
- **Minutes:** a local task has no agentd default minutes to read, so it always gets 60m. Only Cloud Workers read `default_budget`.
