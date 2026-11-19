import {
  AgentdCloudBudget,
  AgentdCloudKeyFile,
  type AgentdCloudPlan,
  type AgentdCloudTaskInput,
  type AgentdTaskEstimate,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, useLocale, Var } from "gt-react";
import { useId, useState } from "react";

import { useAgentdCloudSetup } from "~/lib/agentdState";
import { CommandBlock } from "../CommandBlock";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { CloudWorkersSetup } from "./CloudWorkersSetup";
import {
  autoBudget,
  budgetDollars,
  budgetMinutes,
  cloudPlanProblem,
  defaultCloudPlan,
  defaultModelAccess,
  modelAccessChoices,
} from "./startTask.logic";

const validBudget = Schema.is(AgentdCloudBudget);
const validPath = Schema.is(AgentdCloudKeyFile);
type CloudInput = AgentdCloudTaskInput["cloud"];
type KeyPath = string | null;

function keyPath(value: string): KeyPath {
  const path = value.trim();
  return path === "" || validPath(path) ? path : null;
}

export function useStartTaskCloud(
  cwd: string | null,
  environmentId: EnvironmentId,
  {
    estimate,
    gatewayConnected,
  }: {
    readonly estimate: Pick<AgentdTaskEstimate, "high"> | null;
    readonly gatewayConnected: boolean;
  },
) {
  const [requested, setRequested] = useState(false);
  const availability = useAgentdCloudSetup(cwd, environmentId, false);
  const billing = useAgentdCloudSetup(
    requested && availability.data?.project ? cwd : null,
    environmentId,
    true,
  );
  const setup = requested ? (billing.data ?? availability.data) : availability.data;
  const [chosenAccess, setModelAccess] = useState<CloudInput["modelAccess"] | null>(null);
  const [enteredDollars, setDollars] = useState<string | null>(null);
  const [enteredMinutes, setMinutes] = useState<string | null>(null);
  const [anthropicKey, setAnthropicKey] = useState<KeyPath>("");
  const [openaiKey, setOpenaiKey] = useState<KeyPath>("");
  const [chosenPlan, setPlan] = useState<AgentdCloudPlan | null>(null);
  const [claudeFile, setClaudeFile] = useState<KeyPath>("");
  const [codexFile, setCodexFile] = useState<KeyPath>("");
  // Signed in: agentd read the LibraOS account's balance with its cloud key.
  const signedIn =
    billing.data != null &&
    billing.data.problem !== "setup" &&
    (billing.data.balanceUsd !== null || billing.data.balanceText !== null);
  // Subscription is only ever the person's own choice, never the filled-in default.
  const modelAccess = chosenAccess ?? defaultModelAccess(signedIn, gatewayConnected);
  const subscription = billing.data?.subscription ?? null;
  const plan = chosenPlan ?? defaultCloudPlan(subscription);
  const planFile = plan === "codex" ? codexFile : claudeFile;
  const planProblem =
    modelAccess === "subscription" ? cloudPlanProblem(subscription, plan, Boolean(planFile)) : null;
  const filled = autoBudget({
    estimate,
    defaultMinutes: budgetMinutes(setup?.defaultBudget),
    balanceUsd: setup?.balanceUsd ?? null,
  });
  const dollars = enteredDollars ?? budgetDollars(filled.dollars);
  const minutes = enteredMinutes ?? String(filled.minutes);
  const budget = `${minutes === "" ? "" : `${minutes}m,`}$${dollars}`;
  const budgetValid = validBudget(budget);
  const keysValid =
    modelAccess === "subscription"
      ? planFile !== null && planProblem === null
      : modelAccess !== "byok" ||
        (anthropicKey !== null && openaiKey !== null && Boolean(anthropicKey || openaiKey));
  const enabled = requested && setup?.supported === true && setup.project !== null;
  const checkingBalance = enabled && billing.data === null && billing.error === null;
  const input: CloudInput | null =
    enabled &&
    !checkingBalance &&
    budgetValid &&
    keysValid &&
    (setup.problem === null || setup.problem === "balance")
      ? {
          budget,
          modelAccess,
          ...(modelAccess === "byok" && anthropicKey ? { anthropicKeyFile: anthropicKey } : {}),
          ...(modelAccess === "byok" && openaiKey ? { openaiKeyFile: openaiKey } : {}),
          ...(modelAccess === "subscription" ? { plan } : {}),
          ...(modelAccess === "subscription" && planFile
            ? plan === "codex"
              ? { codexAuthFile: planFile }
              : { claudeTokenFile: planFile }
            : {}),
        }
      : null;
  const refresh = () => {
    availability.refresh();
    billing.refresh();
  };
  return {
    setup,
    enabled,
    signedIn,
    checkingBalance,
    setRequested,
    modelAccess,
    setModelAccess,
    dollars,
    setDollars,
    minutes,
    setMinutes,
    budgetValid,
    input,
    anthropicKey,
    setAnthropicKey,
    openaiKey,
    setOpenaiKey,
    subscription,
    plan,
    setPlan,
    planProblem,
    claudeFile,
    setClaudeFile,
    codexFile,
    setCodexFile,
    refresh,
    environmentId,
  };
}

export function StartTaskCloud({
  cloud,
  disabled,
}: {
  readonly cloud: ReturnType<typeof useStartTaskCloud>;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const id = useId();
  const { setup, modelAccess } = cloud;
  if (!setup?.supported) return null;
  const balance =
    setup.balanceUsd === null
      ? null
      : new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
        }).format(setup.balanceUsd);
  const modelAccessItems = {
    libraos: "LibraOS",
    byok: gt("Your API key"),
    subscription: gt("Your subscription"),
  };
  const subscriptionChoice = modelAccessChoices(cloud.subscription)[2];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-enabled`}
          checked={cloud.enabled}
          onCheckedChange={(checked) => {
            cloud.setRequested(checked);
            if (cloud.anthropicKey === null) cloud.setAnthropicKey("");
            if (cloud.openaiKey === null) cloud.setOpenaiKey("");
          }}
          disabled={disabled || setup.project === null}
          aria-describedby={setup.project === null ? `${id}-origin` : undefined}
        />
        <Label htmlFor={`${id}-enabled`}>
          <T>Run in the cloud</T>
        </Label>
      </div>
      {setup.project === null ? (
        <p id={`${id}-origin`} className="text-xs text-muted-foreground">
          <T>Cloud Workers require a GitHub repository as the checkout’s origin.</T>
        </p>
      ) : null}
      {cloud.enabled && setup.project !== null ? (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            <T>
              Cloud repository: <Var>{setup.project}</Var>
            </T>
          </p>
          {cloud.checkingBalance ? (
            <p role="status" className="text-xs text-muted-foreground">
              <T>Checking LibraOS credit…</T>
            </p>
          ) : balance !== null ? (
            <p className="text-xs">
              <T>
                Available LibraOS credit: <Var>{balance}</Var>
              </T>
            </p>
          ) : setup.balanceText ? (
            <p className="whitespace-pre-wrap break-words text-xs">{setup.balanceText}</p>
          ) : setup.problem === "setup" ? (
            <div className="space-y-2">
              <p role="alert" className="text-xs">
                <T>
                  Cloud Workers aren’t set up. Check the cloud configuration and account key file.
                </T>
              </p>
              <CloudWorkersSetup
                environmentId={cloud.environmentId}
                canConfigure={setup.canConfigure === true}
                onConfigured={cloud.refresh}
              />
            </div>
          ) : setup.problem === "repository" ? (
            <p role="alert" className="text-xs">
              <T>
                The repository owner must install the Cloud Workers GitHub App on this repository.
              </T>
            </p>
          ) : setup.problem === "credit" ? (
            <p role="alert" className="text-xs">
              <T>There is not enough LibraOS credit.</T>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              <T>LibraOS balance unavailable.</T>
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-cap`}>
                <T>Dollar cap (USD)</T>
              </Label>
              <Input
                id={`${id}-cap`}
                value={cloud.dollars}
                inputMode="decimal"
                maxLength={7}
                disabled={disabled}
                required
                aria-describedby={cloud.budgetValid ? undefined : `${id}-budget-hint`}
                onChange={(event) => cloud.setDollars(event.target.value.trim())}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${id}-minutes`}>
                <T>Time limit in minutes (optional)</T>
              </Label>
              <Input
                id={`${id}-minutes`}
                value={cloud.minutes}
                inputMode="numeric"
                maxLength={4}
                disabled={disabled}
                onChange={(event) => cloud.setMinutes(event.target.value.trim())}
              />
            </div>
          </div>
          {!cloud.budgetValid ? (
            <p id={`${id}-budget-hint`} className="text-xs text-muted-foreground">
              <T>Enter a positive dollar cap and, if needed, a positive time limit.</T>
            </p>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-model`}>
              <T>Model access</T>
            </Label>
            <Select
              value={modelAccess}
              items={modelAccessItems}
              disabled={disabled}
              onValueChange={(value) => {
                if (value === "libraos" || value === "byok" || value === "subscription") {
                  cloud.setModelAccess(value);
                  if (cloud.anthropicKey === null) cloud.setAnthropicKey("");
                  if (cloud.openaiKey === null) cloud.setOpenaiKey("");
                }
              }}
            >
              <SelectTrigger id={`${id}-model`}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="libraos">LibraOS</SelectItem>
                <SelectItem value="byok">
                  <T>Your API key</T>
                </SelectItem>
                <SelectItem value="subscription" disabled={subscriptionChoice.disabled}>
                  {subscriptionChoice.disabled ? (
                    <T>Your subscription (needs AgentD v0.1.14 or later)</T>
                  ) : (
                    <T>Your subscription</T>
                  )}
                </SelectItem>
              </SelectPopup>
            </Select>
          </div>
          {modelAccess === "subscription" ? (
            <SubscriptionPlan cloud={cloud} disabled={disabled} />
          ) : modelAccess === "byok" ? (
            <>
              <p id={`${id}-keys`} className="text-xs text-muted-foreground">
                <T>
                  Enter at least one absolute key file path on this environment’s machine. Do not
                  paste the API key itself.
                </T>
              </p>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-anthropic`}>
                  <T>Anthropic key file path</T>
                </Label>
                <Input
                  id={`${id}-anthropic`}
                  defaultValue={cloud.anthropicKey ?? ""}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  aria-describedby={`${id}-keys`}
                  aria-invalid={cloud.anthropicKey === null}
                  onChange={(event) => cloud.setAnthropicKey(keyPath(event.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-openai`}>
                  <T>OpenAI key file path</T>
                </Label>
                <Input
                  id={`${id}-openai`}
                  defaultValue={cloud.openaiKey ?? ""}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  aria-describedby={`${id}-keys`}
                  aria-invalid={cloud.openaiKey === null}
                  onChange={(event) => cloud.setOpenaiKey(keyPath(event.target.value))}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                <T>
                  Worker time is billed to LibraOS credits. Your provider bills inference
                  separately; it isn’t covered by this dollar cap.
                </T>
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              <T>Worker time and inference are both billed to LibraOS credits.</T>
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

const PLAN_COMMANDS = { claude: "claude setup-token", codex: "codex login" } as const;

/** The plan under "Your subscription", its credential as agentd reports it, and how to set it up. */
function SubscriptionPlan({
  cloud,
  disabled,
}: {
  readonly cloud: ReturnType<typeof useStartTaskCloud>;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const locale = useLocale();
  const id = useId();
  const { plan, subscription, planProblem } = cloud;
  const codexSupported = subscription?.codex.supported === true;
  const planItems = {
    claude: gt("Claude (Claude Code)"),
    codex: codexSupported ? gt("ChatGPT (Codex)") : gt("ChatGPT (Codex): needs a newer AgentD"),
  };
  const state = subscription?.[plan] ?? null;
  const expires =
    state?.expiresAbout == null
      ? null
      : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
          new Date(`${state.expiresAbout}T00:00:00Z`),
        );
  const file = plan === "codex" ? cloud.codexFile : cloud.claudeFile;
  const setFile = plan === "codex" ? cloud.setCodexFile : cloud.setClaudeFile;
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-plan`}>
          <T>Plan</T>
        </Label>
        <Select
          value={plan}
          items={planItems}
          disabled={disabled}
          onValueChange={(value) => {
            if (value === "claude" || (value === "codex" && codexSupported)) cloud.setPlan(value);
          }}
        >
          <SelectTrigger id={`${id}-plan`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="claude">{planItems.claude}</SelectItem>
            <SelectItem value="codex" disabled={!codexSupported}>
              {planItems.codex}
            </SelectItem>
          </SelectPopup>
        </Select>
      </div>
      <div role={planProblem === null ? undefined : "alert"} className="space-y-1.5 text-xs">
        {planProblem === "agentd" ? (
          <p>
            {plan === "codex" ? (
              <T>Needs a newer AgentD. Run agentd upgrade to use your ChatGPT plan.</T>
            ) : (
              <T>Needs a newer AgentD. Run agentd upgrade to use your Claude plan.</T>
            )}
          </p>
        ) : planProblem === "windows" ? (
          <p>
            <T>
              Setting up a subscription from this app isn’t available on Windows yet: AgentD can’t
              keep the sign-in file private there.
            </T>
          </p>
        ) : planProblem === "not-set-up" || planProblem === "invalid" ? (
          <>
            <p>
              {plan === "codex" ? (
                planProblem === "invalid" ? (
                  <T>AgentD can’t use your ChatGPT sign-in. Sign in again in a terminal:</T>
                ) : (
                  <T>Your ChatGPT plan isn’t set up for Cloud Workers. Sign in in a terminal:</T>
                )
              ) : planProblem === "invalid" ? (
                <T>
                  Your Claude token is missing, expired or not valid. Make a new one in a terminal:
                </T>
              ) : (
                <T>Your Claude plan isn’t set up for Cloud Workers. Make a token in a terminal:</T>
              )}
            </p>
            <CommandBlock command={PLAN_COMMANDS[plan]} />
            <p className="text-muted-foreground">
              {plan === "codex" ? (
                <T>
                  Then enter the path of Codex’s auth.json below (usually ~/.codex/auth.json, or
                  auth.json in CODEX_HOME), or set it once with agentd config set
                  cloud.codex_auth_file PATH. Run agentd config set in a terminal, then reopen this
                  dialog.
                </T>
              ) : (
                <T>
                  Save the token alone in a private file (chmod 600), then enter its path below, or
                  set it once with agentd config set cloud.claude_token_file PATH. Come back to this
                  dialog when it’s saved.
                </T>
              )}
            </p>
          </>
        ) : state?.configured && file === "" ? (
          <p className="text-muted-foreground">
            {plan === "codex" ? (
              <T>Using the ChatGPT sign-in AgentD has set up.</T>
            ) : expires === null ? (
              <T>Using the Claude token AgentD has set up.</T>
            ) : (
              <T>
                Using the Claude token AgentD has set up. It runs out about <Var>{expires}</Var>.
              </T>
            )}
          </p>
        ) : null}
      </div>
      {planProblem === "agentd" ? null : (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-plan-file`}>
            {plan === "codex" ? (
              <T>ChatGPT auth.json path (optional)</T>
            ) : (
              <T>Claude token file path (optional)</T>
            )}
          </Label>
          <Input
            key={plan}
            id={`${id}-plan-file`}
            defaultValue={file ?? ""}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            aria-invalid={file === null}
            onChange={(event) => setFile(keyPath(event.target.value))}
          />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {plan === "codex" ? (
          <T>Billed to your ChatGPT plan. Worker time is billed to LibraOS credits.</T>
        ) : (
          <T>Billed to your Claude plan. Worker time is billed to LibraOS credits.</T>
        )}
      </p>
    </div>
  );
}
