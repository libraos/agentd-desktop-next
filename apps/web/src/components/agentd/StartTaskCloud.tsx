import {
  AgentdCloudBudget,
  AgentdCloudKeyFile,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type AgentdCloudPlan,
  type AgentdCloudTaskInput,
  type AgentdTaskEstimate,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { T, useGT, useLocale, Var } from "gt-react";
import { useId, useState, type ReactNode } from "react";

import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { useAgentdCloudKeyFile, useAgentdCloudSetup, useAgentdCommands } from "~/lib/agentdState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { CommandBlock } from "../CommandBlock";
import { Button } from "../ui/button";
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
  keyFileProblem,
  looksLikeKey,
  modelAccessChoices,
} from "./startTask.logic";
import { useWorkerDefaults } from "./workerSettings";

const validBudget = Schema.is(AgentdCloudBudget);
const validPath = Schema.is(AgentdCloudKeyFile);
type CloudInput = AgentdCloudTaskInput["cloud"];
type KeyPath = string | null;
type KeyField = "anthropic" | "openai" | "claude" | "codex";

/** The path a field holds: "" when empty, null when it isn't a path (or is the key itself). */
function keyPath(value: string): KeyPath {
  const path = value.trim();
  if (looksLikeKey(path)) return null;
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
  const workerDefaults = useWorkerDefaults();
  const allRemembered = useClientSettings((settings) => settings.agentdCloudKeyFiles);
  // Settings → Workers chooses where a task starts; the checkbox still overrides it per task.
  const [requested, setRequested] = useState(workerDefaults.runTasksOn === "cloud");
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
  // Each field keeps its own text: switching model access or plan never moves a path to another.
  const remembered = useClientSettings((settings) => settings.agentdCloudKeyFiles[environmentId]);
  const [texts, setTexts] = useState<Partial<Record<KeyField, string>>>({});
  const keyText = (field: KeyField) =>
    texts[field] ??
    (field === "anthropic" || field === "openai" ? (remembered?.[field] ?? "") : "");
  const setKeyText = (field: KeyField, value: string) =>
    setTexts((current) => ({ ...current, [field]: value }));
  const anthropicKey = keyPath(keyText("anthropic"));
  const openaiKey = keyPath(keyText("openai"));
  const claudeFile = keyPath(keyText("claude"));
  const codexFile = keyPath(keyText("codex"));
  const [chosenPlan, setPlan] = useState<AgentdCloudPlan | null>(null);
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
    fallback: workerDefaults.budget,
  });
  const dollars = enteredDollars ?? budgetDollars(filled.dollars);
  const minutes = enteredMinutes ?? String(filled.minutes);
  const budget = `${minutes === "" ? "" : `${minutes}m,`}$${dollars}`;
  const budgetValid = validBudget(budget);
  const byok = modelAccess === "byok" && requested;
  const anthropicCheck = useAgentdCloudKeyFile(
    byok && anthropicKey ? anthropicKey : null,
    environmentId,
  );
  const openaiCheck = useAgentdCloudKeyFile(byok && openaiKey ? openaiKey : null, environmentId);
  const keyProblems = {
    anthropic: keyFileProblem("anthropic", anthropicKey ? (anthropicCheck.data ?? null) : null),
    openai: keyFileProblem("openai", openaiKey ? (openaiCheck.data ?? null) : null),
  };
  const keysValid =
    modelAccess === "subscription"
      ? planFile !== null && planProblem === null
      : modelAccess !== "byok" ||
        (anthropicKey !== null &&
          openaiKey !== null &&
          Boolean(anthropicKey || openaiKey) &&
          keyProblems.anthropic === null &&
          keyProblems.openai === null);
  const unreachable = availability.error !== null || setup?.unreachable === true;
  const enabled = requested && setup?.supported === true && !unreachable && setup.project !== null;
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
  const refreshKeyFiles = () => {
    anthropicCheck.refresh();
    openaiCheck.refresh();
  };
  /** After agentd took the task: the BYOK paths it was given prefill the next one. */
  const remember = (submitted: CloudInput) => {
    if (submitted.modelAccess !== "byok") return;
    void updateClientSettings({
      agentdCloudKeyFiles: {
        ...allRemembered,
        [environmentId]: {
          ...remembered,
          ...(submitted.anthropicKeyFile ? { anthropic: submitted.anthropicKeyFile } : {}),
          ...(submitted.openaiKeyFile ? { openai: submitted.openaiKeyFile } : {}),
        },
      },
    });
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
    keyText,
    setKeyText,
    keyProblems,
    refreshKeyFiles,
    remember,
    unreachable,
    subscription,
    plan,
    setPlan,
    planProblem,
    claudeFile,
    codexFile,
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
  if (cloud.unreachable) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Checkbox id={`${id}-enabled`} checked={false} disabled aria-describedby={`${id}-down`} />
          <Label htmlFor={`${id}-enabled`}>
            <T>Run in the cloud</T>
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <p id={`${id}-down`} role="status" className="text-xs text-muted-foreground">
            <T>Couldn’t reach AgentD.</T>
          </p>
          <Button variant="outline" size="xs" disabled={disabled} onClick={cloud.refresh}>
            <T>Retry</T>
          </Button>
        </div>
      </div>
    );
  }
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
          }}
          disabled={disabled || setup.project === null || cloud.unreachable}
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
                setupUrl={setup.setupUrl}
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
            <ByokKeyFiles cloud={cloud} disabled={disabled} />
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

const KEY_FILE_HOME = {
  windows: "C:\\Users\\<you>\\.config\\",
  darwin: "/Users/<you>/.config/",
  linux: "/home/<you>/.config/",
  unknown: "/",
} satisfies Record<ExecutionEnvironmentPlatformOs, string>;

function ByokKeyFiles({
  cloud,
  disabled,
}: {
  readonly cloud: ReturnType<typeof useStartTaskCloud>;
  readonly disabled: boolean;
}) {
  const id = useId();
  const environment = useEnvironment(cloud.environmentId);
  const primaryId = usePrimaryEnvironmentId();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const pickFiles =
    bridge?.pickFiles &&
    cloud.environmentId === primaryId &&
    bridge
      .getLocalEnvironmentBootstraps()
      .some(
        (bootstrap) =>
          bootstrap.id === PRIMARY_LOCAL_ENVIRONMENT_ID &&
          bootstrap.runningDistro === null &&
          bootstrap.httpBaseUrl !== null,
      )
      ? bridge.pickFiles
      : undefined;
  const home = KEY_FILE_HOME[environment?.serverConfig?.environment.platform.os ?? "unknown"];

  return (
    <>
      <div id={id} className="space-y-1 text-xs text-muted-foreground">
        <p>
          <T>
            Enter at least one absolute key file path on this environment’s machine. Do not paste
            the API key itself.
          </T>
        </p>
        <p>
          <T>Save the key on its own line in a text file, then choose that file.</T>
        </p>
      </div>
      <ByokKeyFile
        field="anthropic"
        label={<T>Anthropic key file path</T>}
        placeholder={home + "anthropic.key"}
        helpId={id}
        disabled={disabled}
        cloud={cloud}
        pickFiles={pickFiles}
      />
      <ByokKeyFile
        field="openai"
        label={<T>OpenAI key file path</T>}
        placeholder={home + "openai.key"}
        helpId={id}
        disabled={disabled}
        cloud={cloud}
        pickFiles={pickFiles}
      />
      <p className="text-xs text-muted-foreground">
        <T>
          Worker time is billed to LibraOS credits. Your provider bills inference separately; it
          isn’t covered by this dollar cap.
        </T>
      </p>
    </>
  );
}

function ByokKeyFile({
  field,
  label,
  placeholder,
  helpId,
  disabled,
  cloud,
  pickFiles,
}: {
  readonly field: "anthropic" | "openai";
  readonly label: ReactNode;
  readonly placeholder: string;
  readonly helpId: string;
  readonly disabled: boolean;
  readonly cloud: ReturnType<typeof useStartTaskCloud>;
  readonly pickFiles: (() => Promise<string | null>) | undefined;
}) {
  const id = useId();
  const [picking, setPicking] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const { cloudKeyFileFix } = useAgentdCommands();
  const text = cloud.keyText(field);
  const isKey = looksLikeKey(text);
  const problem = cloud.keyProblems[field];
  const path = text.trim();
  const errorId = id + "-error";

  const fixPermissions = async () => {
    setFixing(true);
    setFixError(null);
    const result = await cloudKeyFileFix({
      environmentId: cloud.environmentId,
      input: { path },
    });
    setFixing(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setFixError(failure instanceof Error ? failure.message : null);
    }
    cloud.refreshKeyFiles();
  };

  return (
    <div className="space-y-1.5">
      <Label id={id + "-label"} htmlFor={id}>
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            nativeInput
            id={id}
            value={text}
            placeholder={placeholder}
            disabled={disabled || picking}
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            aria-describedby={isKey || problem !== null ? helpId + " " + errorId : helpId}
            aria-invalid={keyPath(text) === null || problem !== null}
            onChange={(event) => cloud.setKeyText(field, event.target.value)}
          />
        </div>
        {pickFiles ? (
          <Button
            variant="outline"
            disabled={disabled || picking}
            aria-labelledby={id + "-browse " + id + "-label"}
            onClick={async () => {
              setPicking(true);
              const selected = await pickFiles().catch(() => null);
              setPicking(false);
              if (selected !== null) cloud.setKeyText(field, selected);
            }}
          >
            <span id={id + "-browse"}>
              <T>Browse…</T>
            </span>
          </Button>
        ) : null}
      </div>
      {isKey ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          <T>This looks like the key itself. Save it in a file and choose that file.</T>
        </p>
      ) : problem === "anthropic-key" ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          <T>This is an Anthropic key; choose it under Anthropic key file.</T>
        </p>
      ) : problem === "openai-key" ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          <T>This is an OpenAI key; choose it under OpenAI key file.</T>
        </p>
      ) : problem === "open-to-others" ? (
        <div id={errorId} role="alert" className="space-y-1.5 text-xs text-destructive">
          <p>
            <T>
              <Var>{path}</Var> can be read by other users. Run chmod 600 <Var>{path}</Var>, then
              try again.
            </T>
          </p>
          <Button
            variant="outline"
            size="xs"
            disabled={disabled || fixing}
            onClick={fixPermissions}
          >
            <T>Fix permissions</T>
          </Button>
          {fixError ? <p>{fixError}</p> : null}
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
  const field = plan === "codex" ? "codex" : "claude";
  const text = cloud.keyText(field);
  const file = keyPath(text);
  // A plan agentd has set up needs no file: the optional one stays folded until asked for.
  const [differentFile, setDifferentFile] = useState<Record<KeyField, boolean>>({
    anthropic: false,
    openai: false,
    claude: false,
    codex: false,
  });
  const folded =
    state?.configured === true && planProblem === null && text === "" && !differentFile[field];
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
                  Then enter the absolute path of Codex’s auth.json on that machine below (in the
                  .codex folder of its home folder, or in CODEX_HOME), or set it once with agentd
                  config set cloud.codex_auth_file PATH. Run agentd config set in a terminal, then
                  reopen this dialog.
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
      {planProblem === "agentd" ? null : folded ? (
        <Button
          variant="link"
          size="xs"
          disabled={disabled}
          onClick={() => setDifferentFile((current) => ({ ...current, [field]: true }))}
        >
          {plan === "codex" ? <T>Use a different auth.json</T> : <T>Use a different token file</T>}
        </Button>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-plan-file`}>
            {plan === "codex" ? (
              <T>ChatGPT auth.json path (optional)</T>
            ) : (
              <T>Claude token file path (optional)</T>
            )}
          </Label>
          <Input
            key={field}
            id={`${id}-plan-file`}
            value={text}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            maxLength={4096}
            aria-invalid={file === null}
            onChange={(event) => cloud.setKeyText(field, event.target.value)}
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
