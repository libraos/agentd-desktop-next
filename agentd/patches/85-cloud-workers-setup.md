# 85: Set up Cloud Workers, and run them on your own subscription

libraos/agentd-core#935 part 2 and #952, with #954's ChatGPT plan. Ported in behaviour from agentd-desktop's `agentd-cloud.mjs` and `claude-subscription-terminal.mjs`; the code is not copied.

- **Set up Cloud Workers.** Where the Start dialog said Cloud Workers aren't set up (and where a Start failed for that reason), and in a new Cloud Workers section of the AgentD page, the person opens LibraOS Console to create an account key, pastes it into a password field and presses Set up Cloud Workers. The server runs `agentd cloud setup --key-file - --json` with the key on stdin only: never in argv, a log or an error (agentd prints none, and the server scrubs it from any reason all the same). The answer shows the balance agentd verified, or one line for the refusal. The AgentD page can replace a configured key and keep the current one. The read-only `cloudSetup` probe stays; it now says whether agentd has `cloud setup` (`agentd help cloud` lists `setup … --key-file`, v0.1.15) and takes a null working directory for the account alone. Without it, the Console link stays and the step says to run `agentd upgrade`. The key setup is its own command, `agentd.cloudConfigure`, under the environment maintain scope, since it writes agentd's key file and `[cloud]` settings; the caller refreshes its probe after success.
- **Your subscription.** Model access gains Your subscription, with a plan under it: Claude (Claude Code) or ChatGPT (Codex). It is listed only as disabled ("needs AgentD v0.1.14 or later") until `handoff offer --help` names `--claude-token-file`. ChatGPT is offered only when it names `--codex-auth-file` (#954), and otherwise shows "needs a newer AgentD". Subscription is never filled in by #96's default. A Claude task submits `--model-access subscription`, plus `--claude-token-file` only when the person enters a file; otherwise agentd reads `cloud.claude_token_file`. A ChatGPT task submits `--codex-auth-file FILE` the same way, or relies on `cloud.codex_auth_file`. With both plans configured and no file entered, agentd would ask which, so the server names the chosen plan's configured path.
- **Credential state, from agentd only.** The app never opens a credential file. It reads #954's `agentd cloud subscription --json` when the offer help lists `--codex-auth-file`, and otherwise `config get cloud.claude_token_file`, `cloud.claude_token_expires_about` and `cloud.codex_auth_file`. A configured Claude file with no expiry is one agentd can't read, so it counts as not valid. With no or a bad credential, the dialog says to run `claude setup-token` or `codex login` in a terminal, with a Copy button, how to point agentd at the file (with the `~/.codex/auth.json` hint), and to come back. With a credential, it says it uses it and when the Claude token runs out. The billing note reads "Billed to your Claude plan" or "Billed to your ChatGPT plan".
- **Windows.** As in AgentD Desktop, setting a plan up isn't offered on win32. agentd checks only the cloud account key with Windows ACLs; a token file gets only the Unix mode check. A configured plan, or a file the person enters, still runs.
- **Task rows.** The task read carries `cloud.plan` (`codex` when the show body names `codex_auth_file`, else `claude`), and the background task row and the AgentD page show "Your Claude subscription" or "Your ChatGPT subscription" with "Inference: billed to your … plan". `agentdJson.ts` no longer maps subscription to LibraOS.
- **Reasons.** `cloudFailure.ts` adds the Claude token refusal and ChatGPT's unavailable, sign-in, usage-limit, not-set-up and both-plans refusals. These match only text that names ChatGPT, `codex_auth_file` or `codex login`, so a BYOK Codex failure stays the provider's. It also adds the `cloud setup` refusal lines.

Files:

- `packages/contracts/src/agentd.ts`: `subscription` in `AgentdCloudModelAccess`, `AgentdCloudPlan`, plan and files on the cloud input, `canConfigure` and `subscription` on the probe, a nullable probe `cwd`, `cloud.plan` on the task, `AgentdCloudConfigureInput` and `AgentdCloudConfigured`.
- `packages/contracts/src/rpc.ts`: append `agentd.cloudConfigure` (upstream file).
- `packages/contracts/src/clientRpcPermissions.ts`: its maintain scope (upstream file, one line).
- `apps/server/src/agentd/agentdCommands.ts`: `help cloud`, `cloud setup --key-file - --json`, `cloud subscription --json`, the three `config get` keys, the subscription flags on the offer.
- `apps/server/src/agentd/agentdCloud.ts`: offer-help features, the `cloud setup` check, plan state, `cloudConfigure`, subscription checks and the named plan at submit.
- `apps/server/src/agentd/agentdCloudSubmissions.ts`: plan and file in a subscription offer's fingerprint (LibraOS and BYOK digests unchanged).
- `apps/server/src/agentd/agentdJson.ts`: subscription and its plan on the task read.
- `apps/server/src/agentd/cloudFailure.ts`: the reasons above.
- `apps/server/src/agentd/AgentdBridge.ts`: pass the platform; append `cloudConfigure`.
- `apps/server/src/ws.ts`: the thin handler (upstream file, one line).
- `apps/server/src/observability/RpcInstrumentation.ts`: its span group (upstream file, one line).
- `apps/server/src/agentd/AgentdBridge.test.ts`: subscription argv for both plans, the plan state from either query, too old an agentd, the key on stdin only with its refusals and redaction, the plan on the task read.
- `apps/server/src/agentd/cloudFailure.test.ts`: the ChatGPT rows and the new refusals.
- `packages/client-runtime/src/state/agentd.ts`: the `cloudConfigure` command.
- `apps/web/src/lib/agentdState.ts`: `useAgentdCloudAccount` and the command.
- `apps/web/src/components/agentd/CloudWorkersSetup.tsx` (new): the setup step and the Console link.
- `apps/web/src/components/agentd/AgentdPageCloud.tsx` (new), `AgentdPage.tsx`: the AgentD page's Cloud Workers section.
- `apps/web/src/components/agentd/StartTaskCloud.tsx`: the setup step, Your subscription and its plan.
- `apps/web/src/components/agentd/StartTaskDialog.tsx`, `taskPlan.tsx`: the step beside a setup failure, the plan in the summary and its problem line.
- `apps/web/src/components/agentd/startTask.logic.ts` and its test: `cloudPlanProblem`, `defaultCloudPlan`, `modelAccessChoices`, the subscription problem.
- `apps/web/src/components/agentd/AgentdBackgroundTaskRow.tsx`: the plan on cloud rows.
- `apps/web/src/components/agentd/StartTaskDialog.browser.test.tsx`: paste, refusal and balance; the upgrade case; subscription with and without credentials; agentd too old for subscription and for ChatGPT.
- `apps/web/src/i18n/translations/*.json`: regenerated; zh filled.

Not verified:

- **#954 is not released.** No agentd build has `--codex-auth-file` or `cloud subscription --json`. The app follows the CLI surface #954 fixes, and reads the JSON report as one entry per provider (`claude`, `codex` or `chatgpt`) with `configured`, `valid` and `expires_about`. If #954 ships another shape, the config-key fallback still gives each plan's configured state.
- **Real agentd.** The runner's agentd is older than v0.1.15, so neither `cloud setup` nor a subscription offer ran against a real agentd. They ran against a stub agentd, with the shapes read from agentd-core main (`cloudsetup.go`, `cloudsubscription.go`, `settings_config.go`).
- **Windows and macOS:** not run.
- **Translations:** only zh is translated; the other locales keep English for the new strings, as earlier patches did.
