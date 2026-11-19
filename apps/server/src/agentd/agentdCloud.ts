import {
  AgentdCloudBudget,
  AgentdCloudKeyFile,
  AgentdCommandError,
  type AgentdCloudConfigureInput,
  type AgentdCloudConfigured,
  type AgentdCloudPlanState,
  type AgentdCloudSetup,
  type AgentdCloudSubscription,
  type AgentdCloudSetupInput,
  type AgentdCloudTaskInput,
  type AgentdError,
  type AgentdStartTaskResult,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { ProcessRunner } from "../processRunner.ts";
import {
  currentReservation,
  foundHandoffs,
  nextSubmissionId,
  type Reservation,
  submissionFingerprint,
  submissionMarker,
  submissionSession,
} from "./agentdCloudSubmissions.ts";
import { agentdArgs } from "./agentdCommands.ts";
import {
  CLOUD_REASONS,
  cloudFailureReason,
  cloudReason,
  cloudSetupProblem,
  cloudSetupReason,
} from "./cloudFailure.ts";

const isCloudTask = Schema.is(AgentdCloudBudget);
const isKeyFile = Schema.is(AgentdCloudKeyFile);
const balanceJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const balanceDetails = Schema.decodeUnknownOption(
  Schema.Struct({
    available_usd: Schema.optionalKey(Schema.Unknown),
    balance_usd: Schema.optionalKey(Schema.Unknown),
    default_budget: Schema.optionalKey(Schema.Unknown),
  }),
);
const offerReceipt = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      handoff: Schema.String,
      cloud: Schema.optionalKey(
        Schema.Struct({
          state: Schema.String,
          error: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);

const configuredResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      balance: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            available_usd: Schema.optionalKey(Schema.Unknown),
            balance_usd: Schema.optionalKey(Schema.Unknown),
          }),
        ),
      ),
    }),
  ),
);
const planJson = Schema.Struct({
  configured: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  valid: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  expires_about: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
// `agentd cloud subscription --json`: each plan under providers.
const subscriptionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      providers: Schema.Struct({
        claude: Schema.optionalKey(Schema.NullOr(planJson)),
        codex: Schema.optionalKey(Schema.NullOr(planJson)),
      }),
    }),
  ),
);
const setupTarget = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String })),
);
const configJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const EXPIRY = /^\d{4}-\d{2}-\d{2}$/;
const UPGRADE_SUBSCRIPTION =
  "This version of AgentD can’t run Cloud Workers on your own subscription. Run agentd upgrade, then try again.";
const UPGRADE_CHATGPT =
  "This version of AgentD can’t run Codex on your ChatGPT plan. Run agentd upgrade, then try again.";
const UPGRADE_SETUP =
  "This version of AgentD can’t set up Cloud Workers. Run agentd upgrade, then try again.";

interface CloudFeatures {
  readonly cloud: boolean;
  /** `--model-access subscription` (v0.1.14+), named by its `--claude-token-file`. */
  readonly subscription: boolean;
  /** Codex on a ChatGPT plan. */
  readonly codex: boolean;
}

/** A `config get KEY --json` answer as text; null when unset. */
function configText(stdout: string): string | null {
  const parsed = configJson(stdout);
  const value = parsed._tag === "Some" ? parsed.value : stdout;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function usdAmount(value: unknown): number | null {
  const usd = typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof usd === "number" && Number.isFinite(usd) ? usd : null;
}

/** `today` is YYYY-MM-DD: an expiry before it is not valid, whatever else agentd said. */
function planState(
  supported: boolean,
  plan: typeof planJson.Type | null | undefined,
  today: string,
): AgentdCloudPlanState {
  const configured = plan?.configured === true;
  const date = plan?.expires_about ?? null;
  const expiresAbout = configured && date !== null && EXPIRY.test(date) ? date : null;
  return {
    supported,
    configured,
    valid: !configured
      ? null
      : expiresAbout !== null && expiresAbout < today
        ? false
        : (plan?.valid ?? null),
    expiresAbout,
  };
}

const emptySetup = {
  project: null,
  balanceUsd: null,
  balanceText: null,
  defaultBudget: null,
  problem: null,
};
const originError = "Cloud Workers require a GitHub repository as the checkout’s origin.";
const UNKNOWN_OUTCOME =
  "AgentD may have created this cloud task. Check Background tasks. Start checks whether AgentD recorded it before submitting again.";
const CLOSED_STATES = new Set(["cancelled", "declined", "done", "expired"]);
const GITHUB_ORIGIN =
  /^(?:https?:\/\/(?:[^/@\s]+@)?(?:www\.)?github\.com(?::\d+)?\/|(?:git\+)?ssh:\/\/(?:git@)?(?:ssh\.)?github\.com(?::\d+)?\/|git@github\.com:\/?)(\S+)$/i;
export const GITHUB_PROJECT = /^[a-z\d][a-z\d-]{0,38}\/(?!-|\.{1,2}$)[\w.-]{1,100}$/i;

const submissionShow = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      cloud_state: Schema.optionalKey(Schema.NullOr(Schema.String)),
      body: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ state: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
      ),
    }),
  ),
);

/** OWNER/REPO of a GitHub origin in any form git accepts for github.com; null for any other host. */
function githubProject(origin: string): string | null {
  const path = GITHUB_ORIGIN.exec(origin.trim())?.[1]
    ?.replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return path !== undefined && GITHUB_PROJECT.test(path) ? path.toLowerCase() : null;
}

function cloudProblem(message: string): NonNullable<AgentdCloudSetup["problem"]> {
  return cloudSetupProblem(message) ?? "balance";
}

function commandError(message: string, notSetUp = false) {
  return new AgentdCommandError({ message, notSetUp });
}

function offerError(message: string, notSetUp = false): AgentdCommandError {
  if (notSetUp) return commandError(CLOUD_REASONS.setup, true);
  const problem = cloudSetupProblem(message);
  return commandError(cloudReason(message) ?? CLOUD_REASONS.submit, problem === "setup");
}

const unknownOutcome = (message = UNKNOWN_OUTCOME) =>
  new AgentdCommandError({ message, notSetUp: false, outcomeUnknown: true });

/** A cloud job's one-line reason: why it failed, or a setup problem agentd is still waiting on. */
export function cloudJobNote(
  state: string | null,
  messages: ReadonlyArray<string | null | undefined>,
): string | null {
  const failure = state === null ? null : cloudFailureReason(state, messages);
  if (failure !== null) return failure;
  for (const message of messages) {
    const problem = message ? cloudSetupProblem(message) : null;
    if (problem !== null) return CLOUD_REASONS[problem];
  }
  return null;
}

function readBalance(stdout: string) {
  const parsed = balanceJson(stdout);
  if (parsed._tag === "None") return { ...emptySetup, balanceText: stdout.trim() || null };
  const details = balanceDetails(parsed.value);
  const balanceUsd = usdAmount(
    details._tag === "Some" ? (details.value.available_usd ?? details.value.balance_usd) : null,
  );
  return {
    ...emptySetup,
    balanceUsd,
    defaultBudget:
      details._tag === "Some" && isCloudTask(details.value.default_budget)
        ? details.value.default_budget
        : null,
  };
}

export const makeAgentdCloud = Effect.fn("AgentdCloud.make")(function* (deps: {
  readonly binary: Effect.Effect<string, AgentdError>;
  readonly run: (
    argv: ReadonlyArray<string>,
    options?: {
      readonly command?: string;
      readonly jsonOnFailure?: boolean;
      readonly stdin?: string;
    },
  ) => Effect.Effect<string, AgentdError>;
  readonly runProcess: ProcessRunner["Service"]["run"];
  readonly isAbsolute: (path: string) => boolean;
  readonly args: (
    build: () => ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, AgentdError>;
  readonly platform: string;
}) {
  const { binary, run, runProcess, isAbsolute, args, platform } = deps;
  // A second Start for a project waits on agentd's answer to the first, in this server too.
  const inFlight = new Set<string>();
  const capabilities = yield* Cache.makeWith(
    ([command]: readonly [string, string]) =>
      run(agentdArgs.cloudHelp(), { command, jsonOnFailure: true }).pipe(
        Effect.map((help): CloudFeatures => ({
          cloud: /(?:^|[\s[|])--cloud(?=[\s\]|=,]|$)/u.test(help),
          subscription: /--claude-token-file\b/.test(help),
          codex: /--codex-auth-file\b/.test(help),
        })),
      ),
    { capacity: 16, timeToLive: (exit) => (Exit.isSuccess(exit) ? "Infinity" : 0) },
  );
  // `cloud setup` (v0.1.15) is listed in `agentd help cloud`; an agentd without it fails or omits it.
  const setupCommand = yield* Cache.makeWith(
    ([command]: readonly [string, string]) =>
      run(agentdArgs.cloudCommands(), { command, jsonOnFailure: true }).pipe(
        Effect.map((help) => /(?:^|[\s|])setup \[[^\n]*--key-file\b/u.test(help)),
        Effect.orElseSucceed(() => false),
      ),
    { capacity: 16, timeToLive: (exit) => (Exit.isSuccess(exit) ? "Infinity" : 0) },
  );
  const cloudAgentd = Effect.gen(function* () {
    const command = yield* binary;
    const version = (yield* run(agentdArgs.version(), { command })).trim();
    const features = yield* Cache.get(capabilities, [command, version]);
    return features.cloud ? { command, version, features } : null;
  });

  const configured = (command: string, key: Parameters<typeof agentdArgs.configGet>[0]) =>
    run(agentdArgs.configGet(key), { command }).pipe(
      Effect.map(configText),
      Effect.orElseSucceed(() => null),
    );

  // Each plan's credential as agentd reports it: its report, else the config keys.
  const readSubscription = Effect.fn("AgentdCloud.subscription")(function* (
    command: string,
    features: CloudFeatures,
  ) {
    const setupUnavailable = platform === "win32";
    const today = DateTime.formatIso(yield* DateTime.now).slice(0, 10);
    if (features.codex) {
      const report = yield* run(agentdArgs.cloudSubscription(), { command }).pipe(
        Effect.map(subscriptionJson),
        Effect.orElseSucceed(() => null),
      );
      if (report?._tag === "Some") {
        return {
          claude: planState(true, report.value.providers.claude, today),
          codex: planState(true, report.value.providers.codex, today),
          setupUnavailable,
        } satisfies AgentdCloudSubscription;
      }
    }
    const [claudeFile, expires, codexFile] = yield* Effect.all(
      [
        configured(command, "cloud.claude_token_file"),
        configured(command, "cloud.claude_token_expires_about"),
        features.codex ? configured(command, "cloud.codex_auth_file") : Effect.succeed(null),
      ],
      { concurrency: 3 },
    );
    return {
      // Older agentd dates any nonempty file without checking it holds a setup-token: an estimate.
      claude: planState(
        true,
        { configured: claudeFile !== null, valid: null, expires_about: expires },
        today,
      ),
      codex: planState(features.codex, { configured: codexFile !== null, valid: null }, today),
      setupUnavailable,
    } satisfies AgentdCloudSubscription;
  });

  // Where `cloud setup` would send a key: [cloud] url, else LibraOS. Null when agentd won't say.
  const setupDestination = (command: string) =>
    run(agentdArgs.cloudSetupTarget(), { command }).pipe(
      Effect.map((stdout) => {
        const target = setupTarget(stdout);
        return target._tag === "Some" ? target.value.url : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  const originProject = Effect.fn("AgentdCloud.originProject")(function* (cwd: string) {
    if (!isAbsolute(cwd) || cwd.includes("\0")) return null;
    const result = yield* runProcess({
      command: "git",
      args: ["remote", "get-url", "--", "origin"],
      cwd,
      timeout: "5 seconds",
      maxOutputBytes: 4096,
    }).pipe(Effect.option);
    if (result._tag === "None" || result.value.code !== 0) return null;
    return githubProject(result.value.stdout);
  });

  const cloudSetup = Effect.fn("AgentdCloud.setup")(function* ({
    cwd,
    includeBalance,
  }: AgentdCloudSetupInput) {
    const found = yield* cloudAgentd;
    if (found === null) return { ...emptySetup, supported: false };
    const { command, version, features } = found;
    const project = cwd === null ? null : yield* originProject(cwd);
    const canConfigure = yield* Cache.get(setupCommand, [command, version]);
    const base = {
      supported: true,
      canConfigure,
      setupUrl: canConfigure ? yield* setupDestination(command) : null,
      subscription: null,
    };
    if ((cwd !== null && project === null) || !includeBalance)
      return { ...emptySetup, ...base, project };
    const readAccount = run(agentdArgs.cloudBalance(), { command }).pipe(
      Effect.map(readBalance),
      Effect.catchTags({
        AgentdCommandError: (error) =>
          Effect.succeed({
            ...emptySetup,
            problem: error.notSetUp ? ("setup" as const) : cloudProblem(error.message),
          }),
      }),
    );
    const [balance, subscription] = yield* Effect.all(
      [
        readAccount,
        features.subscription
          ? readSubscription(command, features)
          : Effect.succeed<AgentdCloudSubscription | null>(null),
      ],
      { concurrency: 2 },
    );
    return { ...balance, ...base, project, subscription } satisfies AgentdCloudSetup;
  });

  const cloudConfigure = Effect.fn("AgentdCloud.configure")(function* ({
    key,
    url,
  }: AgentdCloudConfigureInput) {
    const secret = key.trim();
    if (secret === "" || /[\r\n\0]/.test(secret))
      return yield* commandError("Paste the account key on one line.");
    const found = yield* cloudAgentd;
    if (found === null || !(yield* Cache.get(setupCommand, [found.command, found.version])))
      return yield* commandError(UPGRADE_SETUP);
    // agentd never prints the key; the reason is scrubbed of it all the same.
    const scrub = (message: string) => message.split(secret).join("[redacted]");
    const argv = yield* args(() => agentdArgs.cloudConfigure(url));
    const stdout = yield* run(argv, {
      command: found.command,
      stdin: `${secret}\n`,
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "AgentdCommandError"
          ? commandError(scrub(cloudSetupReason(error.message)), error.notSetUp)
          : error,
      ),
    );
    const result = configuredResult(stdout);
    const balance = result._tag === "Some" ? result.value.balance : null;
    return {
      balanceUsd: usdAmount(balance?.available_usd ?? balance?.balance_usd),
    } satisfies AgentdCloudConfigured;
  });

  // The chosen plan's configured file, always named: with no flag agentd runs on whichever plan
  // is set up, which may not be the one chosen.
  const boundPlan = Effect.fn("AgentdCloud.boundPlan")(function* (
    command: string,
    input: AgentdCloudTaskInput,
  ) {
    const codex = input.cloud.plan === "codex";
    const file = yield* run(
      agentdArgs.configGet(codex ? "cloud.codex_auth_file" : "cloud.claude_token_file"),
      { command },
    ).pipe(
      Effect.map(configText),
      Effect.mapError(() =>
        commandError(
          codex
            ? "AgentD couldn’t read which ChatGPT sign-in is set up, so nothing was submitted. Try again."
            : "AgentD couldn’t read which Claude token is set up, so nothing was submitted. Try again.",
        ),
      ),
    );
    if (file === null || !isKeyFile(file) || !isAbsolute(file))
      return yield* commandError(
        codex ? CLOUD_REASONS.chatgptAuth : CLOUD_REASONS.subscriptionToken,
      );
    return {
      ...input,
      cloud: { ...input.cloud, ...(codex ? { codexAuthFile: file } : { claudeTokenFile: file }) },
    };
  });

  const startCloudTask = Effect.fn("AgentdCloud.startTask")(function* (
    input: AgentdCloudTaskInput,
  ) {
    if (!isCloudTask(input.cloud.budget))
      return yield* commandError("Enter a positive dollar cap for this cloud task.");
    const subscribed = input.cloud.modelAccess === "subscription";
    const planFile =
      input.cloud.plan === "codex" ? input.cloud.codexAuthFile : input.cloud.claudeTokenFile;
    if (subscribed && input.cloud.plan === undefined)
      return yield* commandError("Choose the plan this cloud task runs on.");
    if (subscribed && planFile !== undefined && !(isKeyFile(planFile) && isAbsolute(planFile)))
      return yield* commandError(
        "Enter the absolute path of the credential file on the selected machine.",
      );
    if (input.cloud.modelAccess === "byok") {
      const files = [input.cloud.anthropicKeyFile, input.cloud.openaiKeyFile].filter(
        (file) => file !== undefined,
      );
      if (files.length === 0 || !files.every((file) => isKeyFile(file) && isAbsolute(file))) {
        return yield* commandError(
          "Enter at least one absolute provider key-file path on the selected machine.",
        );
      }
    }
    const found = yield* cloudAgentd;
    if (found === null)
      return yield* commandError("This version of AgentD does not support Cloud Workers.");
    const { command, features } = found;
    if (subscribed && !features.subscription) return yield* commandError(UPGRADE_SUBSCRIPTION);
    if (subscribed && input.cloud.plan === "codex" && !features.codex)
      return yield* commandError(UPGRADE_CHATGPT);
    const resolved =
      subscribed && planFile === undefined ? yield* boundPlan(command, input) : input;
    const project = yield* originProject(input.cwd);
    if (project === null) return yield* commandError(originError);
    if (inFlight.has(project))
      return yield* commandError(
        `A Cloud Workers submission for ${project} is in progress. Wait for it before starting another.`,
      );
    inFlight.add(project);
    return yield* submitCloudTask(command, project, resolved).pipe(
      Effect.ensuring(Effect.sync(() => inFlight.delete(project))),
    );
  });

  const submitCloudTask = Effect.fn("AgentdCloud.submit")(function* (
    command: string,
    project: string,
    input: AgentdCloudTaskInput,
  ) {
    const session = submissionSession(project);
    const fingerprint = submissionFingerprint(input, project);
    const agentd = (build: () => ReadonlyArray<string>) =>
      args(build).pipe(Effect.flatMap((argv) => run(argv, { command })));
    const reservation = agentd(() => agentdArgs.submissionPins(session)).pipe(
      Effect.map((stdout) => currentReservation(stdout, session)),
      Effect.filterOrFail(
        (current): current is Reservation | null => current !== undefined,
        () => unknownOutcome(),
      ),
      Effect.mapError(() =>
        unknownOutcome(
          "AgentD couldn’t check this project’s earlier Cloud Workers submission, so nothing was submitted. Try again.",
        ),
      ),
    );
    // The task agentd recorded for a submission; null when it has none.
    const recorded = (id: string) =>
      agentd(() => agentdArgs.findSubmission(id)).pipe(
        Effect.map(foundHandoffs),
        Effect.flatMap((hits) =>
          hits === undefined || hits.length > 1
            ? Effect.fail(unknownOutcome())
            : Effect.forEach(hits, (hit) =>
                agentd(() => agentdArgs.show(hit)).pipe(Effect.map(submissionShow)),
              ),
        ),
        Effect.flatMap((shows) => {
          const show = shows[0];
          if (show === undefined) return Effect.succeed(null);
          return show._tag === "Some" && show.value.body?.state === submissionMarker(id)
            ? Effect.succeed(show.value.id)
            : Effect.fail(unknownOutcome());
        }),
        Effect.mapError(() => unknownOutcome()),
      );
    const remember = (id: string, handoff: string) =>
      agentd(() => agentdArgs.rememberSubmission(session, id, handoff)).pipe(Effect.ignore);
    const alreadyRecorded = (handoff: string): AgentdStartTaskResult => ({
      id: handoff,
      started: false,
      note: `AgentD already recorded this Cloud Workers submission as task ${handoff}. See it in Background tasks before starting again.`,
    });

    const current = yield* reservation;
    let submission: string;
    if (current !== null && current.handoff === null) {
      const handoff = yield* recorded(current.id);
      if (handoff !== null) {
        yield* remember(current.id, handoff);
        return alreadyRecorded(handoff);
      }
      if (current.fingerprint !== fingerprint && input.cloud.replaceSubmission !== current.id) {
        return yield* new AgentdCommandError({
          message: `${project} holds an AgentD reservation for an earlier Cloud Workers submission that has no task. Start that task again, or replace it with this one.`,
          notSetUp: false,
          replaceSubmission: current.id,
        });
      }
      // The same key again: agentd's --idem makes this the earlier offer, never a second one.
      submission = current.id;
    } else {
      if (current !== null && current.handoff !== null) {
        const holder = current.handoff;
        const show = yield* agentd(() => agentdArgs.show(holder)).pipe(
          Effect.map(submissionShow),
          Effect.mapError(() => unknownOutcome()),
        );
        if (show._tag === "None") return yield* unknownOutcome();
        if (show.value.cloud_state === "submitting" && !CLOSED_STATES.has(show.value.state)) {
          return yield* commandError(
            `${project} already holds an AgentD reservation: task ${holder} is still being submitted to Cloud Workers. Wait for it, or stop it in Background tasks.`,
          );
        }
      }
      submission = nextSubmissionId(session, current?.id ?? null);
      yield* agentd(() =>
        agentdArgs.reserveSubmission(session, submission, current?.id ?? null, fingerprint),
      ).pipe(
        Effect.mapError(() =>
          commandError(
            "AgentD couldn’t reserve this Cloud Workers submission, so nothing was submitted.",
          ),
        ),
      );
      const saved = yield* reservation;
      if (saved?.id !== submission || saved.fingerprint !== fingerprint) {
        return yield* commandError(
          `Another window started a Cloud Workers submission for ${project}. Press Start to check it.`,
        );
      }
    }

    const argv = yield* args(() => agentdArgs.cloudOffer(input, project, submission));
    yield* agentd(() => agentdArgs.cloudSession(input.cwd)).pipe(
      Effect.catchTags({
        AgentdCommandError: (error) =>
          Effect.fail(
            error.notSetUp
              ? offerError(error.message, true)
              : commandError("AgentD couldn’t prepare a session for the cloud task."),
          ),
      }),
    );
    const reconcile = (said: string | null) =>
      recorded(submission).pipe(
        Effect.orElseSucceed(() => null),
        Effect.flatMap((handoff) => {
          if (handoff !== null)
            return remember(submission, handoff).pipe(
              Effect.as({
                id: handoff,
                started: false,
                note:
                  (said && cloudReason(said)) ??
                  `AgentD recorded task ${handoff} but didn’t confirm that Cloud Workers accepted it. Check Background tasks for updates.`,
              } satisfies AgentdStartTaskResult),
            );
          const reason = said ? cloudReason(said) : null;
          return Effect.fail(reason === null ? unknownOutcome() : commandError(reason));
        }),
      );
    const offered = yield* run(argv, { command }).pipe(Effect.result);
    if (offered._tag === "Failure") {
      const error = offered.failure;
      if (error._tag !== "AgentdCommandError") return yield* error;
      if (error.notSetUp) return yield* offerError(error.message, true);
      return yield* reconcile(error.message);
    }
    const receipt = offerReceipt(offered.success);
    if (receipt._tag === "None") return yield* reconcile(null);
    const { handoff: id, cloud } = receipt.value;
    yield* remember(submission, id);
    const note = cloud?.error
      ? offerError(cloud.error).message
      : cloud === undefined
        ? "AgentD did not confirm that Cloud Workers accepted the task. Check Background tasks for updates."
        : null;
    return { id, started: note === null, note } satisfies AgentdStartTaskResult;
  });

  return { cloudSetup, cloudConfigure, startCloudTask, originProject };
});
