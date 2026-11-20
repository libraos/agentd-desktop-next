import {
  AgentdApprovalListJson,
  AgentdCommandError,
  AgentdDoctorJson,
  type AgentdError,
  AgentdHandoffListJson,
  AgentdHandoffShowJson,
  AgentdInboxListJson,
  AgentdInstallRecord,
  AgentdNode,
  AgentdNotFoundError,
  AgentdUserListJson,
  AgentdWhoJson,
  AgentdWorkerTool,
  type AgentdApproval,
  type AgentdCloudSetup,
  type AgentdCloudReview,
  type AgentdCloudReviewInput,
  type AgentdCloudSetupInput,
  type AgentdCloudConfigureInput,
  type AgentdCloudConfigured,
  type AgentdCloudKeyFileCheck,
  type AgentdCloudKeyFileInput,
  type AgentdServicesRepair,
  type AgentdTaskDefaults,
  type AgentdTaskDefaultsInput,
  type AgentdCloudTaskInput,
  type AgentdCommandOutput,
  type AgentdConnectAgentInput,
  type AgentdEula,
  type AgentdInboxItem,
  type AgentdJoinTeamInput,
  type AgentdPeople,
  type AgentdPeopleInput,
  type AgentdStartTaskInput,
  type AgentdStartTaskResult,
  type AgentdStatus,
  type AgentdStopTaskInput,
  type AgentdTask,
  type AgentdTaskInput,
  type AgentdTaskRow,
  type AgentdTaskOther,
  type AgentdTaskOthersInput,
  type OrchestrationV2CommandOutputFrame,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeAgentdCloud } from "./agentdCloud.ts";
import { makeCloudReview } from "./agentdCloudReview.ts";
import { AgentdArgumentError, agentdArgs, agentdTicket } from "./agentdCommands.ts";
import * as AgentdJson from "./agentdJson.ts";
import { repairServices, serviceAgentd } from "./agentdServices.ts";
import { makeCloudKeyFile } from "./cloudKeyFile.ts";
import { estimateType, PROJECT_FILES, readEstimate, suggestCheck } from "./taskDefaults.ts";
import { joinedPerson, mergeTaskHolders, repositoryTargets } from "./taskOthers.ts";

export class AgentdBridge extends Context.Service<
  AgentdBridge,
  {
    readonly status: Effect.Effect<AgentdStatus, AgentdError>;
    readonly subscribeTasks: Stream.Stream<ReadonlyArray<AgentdTaskRow>, AgentdError>;
    readonly task: (input: AgentdTaskInput) => Effect.Effect<AgentdTask, AgentdError>;
    readonly subscribeTaskOutput: (
      input: AgentdTaskInput,
    ) => Stream.Stream<OrchestrationV2CommandOutputFrame, AgentdError>;
    readonly stopTask: (input: AgentdStopTaskInput) => Effect.Effect<{}, AgentdError>;
    readonly startTask: (
      input: AgentdStartTaskInput | AgentdCloudTaskInput,
    ) => Effect.Effect<AgentdStartTaskResult, AgentdError>;
    readonly approvals: Effect.Effect<ReadonlyArray<AgentdApproval>, AgentdError>;
    readonly inbox: Effect.Effect<ReadonlyArray<AgentdInboxItem>, AgentdError>;
    readonly people: (input: AgentdPeopleInput) => Effect.Effect<AgentdPeople, AgentdError>;
    readonly connectAgent: (
      input: AgentdConnectAgentInput,
    ) => Effect.Effect<AgentdCommandOutput, AgentdError>;
    readonly joinTeam: (
      input: AgentdJoinTeamInput,
    ) => Effect.Effect<AgentdCommandOutput, AgentdError>;
    readonly cloudSetup: (
      input: AgentdCloudSetupInput,
    ) => Effect.Effect<AgentdCloudSetup, AgentdError>;
    readonly cloudReview: (
      input: AgentdCloudReviewInput,
    ) => Effect.Effect<AgentdCloudReview, AgentdError>;
    /** `agentd cloud setup` with the account key on stdin; the balance it verified. */
    readonly cloudConfigure: (
      input: AgentdCloudConfigureInput,
    ) => Effect.Effect<AgentdCloudConfigured, AgentdError>;
    /** A chosen key file's provider and privacy; with makePrivate, chmod 600 first. */
    readonly cloudKeyFile: (
      input: AgentdCloudKeyFileInput,
      makePrivate: boolean,
    ) => Effect.Effect<AgentdCloudKeyFileCheck, AgentdError>;
    readonly taskDefaults: (
      input: AgentdTaskDefaultsInput,
    ) => Effect.Effect<AgentdTaskDefaults, AgentdError>;
    readonly taskOthers: (
      input: AgentdTaskOthersInput,
    ) => Effect.Effect<ReadonlyArray<AgentdTaskOther>>;
    /** agentd's path, for the team node's long-lived worker. */
    readonly binary: Effect.Effect<string, AgentdError>;
    readonly enrolWorker: (server: string, ticket: string) => Effect.Effect<void, AgentdError>;
    readonly foreground: (minutes: number) => Effect.Effect<void, AgentdError>;
    readonly eula: Effect.Effect<AgentdEula, AgentdError>;
  }
>()("t3/agentd/AgentdBridge") {}

// agentd's exit status for a command run before `agentd init`.
const NOT_SET_UP_EXIT = 78;
const TASKS_POLL_INTERVAL = Duration.seconds(5);
const OUTPUT_POLL_INTERVAL = Duration.seconds(1);
// Re-read the task this many output polls apart to learn whether its worker still runs.
const OUTPUT_STATE_EVERY = 5;
const OUTPUT_TAIL_BYTES = 64 * 1024;
// agentd reads are host reads a client asks for while it shows them, as diagnostics are.
const POLL_SCOPE = { type: "diagnostics" } as const;
const RUNNING_STATES = new Set(["offered", "claimed"]);
// A cloud job past these has nothing more for `cloud sync` to mirror.
const CLOUD_FINAL_STATES = new Set([
  "completed",
  "failed",
  "failed_verification",
  "budget_exceeded",
  "cancelled",
  "settlement_conflict",
  "expired",
]);
// The watchdog syncs cloud jobs each pass; while one may not run, a shown list syncs this often.
const CLOUD_SYNC_INTERVAL = Duration.seconds(30);

/** A listed cloud job whose state agentd still has to mirror from the Job API. */
function hasOpenCloudJob(rows: ReadonlyArray<AgentdTaskRow>): boolean {
  return rows.some(
    (row) =>
      row.cloudState != null && row.cloudState !== "" && !CLOUD_FINAL_STATES.has(row.cloudState),
  );
}

function sameRows(a: ReadonlyArray<AgentdTaskRow>, b: ReadonlyArray<AgentdTaskRow>): boolean {
  return (
    a.length === b.length &&
    a.every((row, i) => {
      const other = b[i]!;
      return (Object.keys(row) as Array<keyof AgentdTaskRow>).every(
        (key) => row[key] === other[key],
      );
    })
  );
}

const commandError = (message: string, notSetUp = false) =>
  new AgentdCommandError({ message, notSetUp });

function decodeJson<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) {
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
  return (stdout: string) =>
    decode(stdout).pipe(
      Effect.mapError(() => commandError("agentd answered with JSON this app cannot read.")),
    );
}

const decodeDoctor = decodeJson(AgentdDoctorJson);
const decodeList = decodeJson(AgentdHandoffListJson);
const decodeShow = decodeJson(AgentdHandoffShowJson);
const decodeApprovals = decodeJson(AgentdApprovalListJson);
const decodeInbox = decodeJson(AgentdInboxListJson);
const decodeUsers = decodeJson(AgentdUserListJson);
const decodeNodes = decodeJson(Schema.Array(AgentdNode));
const decodeWho = decodeJson(AgentdWhoJson);
const isDefaultWorker = Schema.is(AgentdWorkerTool);
const decodeInstallRecord = Schema.decodeEffect(Schema.fromJsonString(AgentdInstallRecord));

const isArgumentError = Schema.is(AgentdArgumentError);

function args(
  build: () => ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, AgentdError> {
  return Effect.try({
    try: build,
    catch: (error) =>
      commandError(isArgumentError(error) ? error.message : "Invalid agentd input."),
  });
}

export const make = Effect.fn("AgentdBridge.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const env = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;

  // Set by the desktop app beside the AGENTD_BIN of the agentd it carries.
  const bundled = env.AGENTD_DESKTOP_BUNDLED === "1" ? { bundled: true } : {};
  // Resolved per call, so an agentd installed after the server started is found.
  const binary = Effect.gen(function* () {
    const configured = env.AGENTD_BIN?.trim() || undefined;
    const found = yield* resolveCommandPath(configured ?? "agentd", { env }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.provideService(HostProcess.Platform, platform),
    );
    if (found === null) {
      return yield* new AgentdNotFoundError({
        message:
          configured === undefined
            ? "agentd was not found on PATH."
            : `agentd was not found at AGENTD_BIN (${configured}).`,
        ...bundled,
      });
    }
    return found;
  });

  const run = Effect.fn("AgentdBridge.run")(function* (
    argv: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly jsonOnFailure?: boolean;
      readonly command?: string;
    } = {},
  ) {
    const command = options.command ?? (yield* binary);
    const output = yield* runner
      .run({
        command,
        args: argv,
        stdin: options.stdin,
        timeout: Duration.seconds(60),
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ProcessSpawnError"
            ? new AgentdNotFoundError({
                message: `agentd at ${command} could not be started.`,
                ...bundled,
              })
            : commandError(
                error._tag === "ProcessTimeoutError"
                  ? "agentd did not answer in time."
                  : "agentd could not be read.",
              ),
        ),
      );
    if (output.timedOut) return yield* commandError("agentd did not answer in time.");
    const said = (output.stderr || output.stdout).trim();
    if (output.code === NOT_SET_UP_EXIT) {
      return yield* commandError(said || "agentd is not set up yet.", true);
    }
    // doctor exits non-zero when a check fails and still prints its whole report.
    if (output.code !== 0 && !options.jsonOnFailure) {
      return yield* commandError(said || `agentd exited with ${output.code}.`);
    }
    return output.stdout;
  });

  const cloud = yield* makeAgentdCloud({
    binary,
    run,
    runProcess: runner.run,
    isAbsolute: pathService.isAbsolute,
    args,
    platform,
  });

  const cloudKeyFile = makeCloudKeyFile({
    isAbsolute: pathService.isAbsolute,
    platform,
    uid: process.getuid?.(),
  });

  const readShow = (id: string) =>
    args(() => agentdArgs.show(id)).pipe(
      Effect.flatMap((argv) => run(argv)),
      Effect.flatMap(decodeShow),
    );

  const cloudReview = makeCloudReview({
    runProcess: runner.run,
    readShow,
    originProject: cloud.originProject,
  });

  // The desktop app's last pass installing agentd for the terminal and agents, when it ran one.
  const recordPath = env.AGENTD_DESKTOP_INSTALL_RECORD?.trim();
  const readInstallRecord = recordPath
    ? fs.readFileString(recordPath).pipe(
        Effect.flatMap(decodeInstallRecord),
        Effect.orElseSucceed(() => null),
      )
    : Effect.succeed(null);

  // Set once on start when agentd's services were moved to the bundled agentd.
  let servicesRepair: AgentdServicesRepair | null = null;
  const bundledBinary = env.AGENTD_DESKTOP_BUNDLED === "1" ? env.AGENTD_BIN?.trim() : undefined;
  if (bundledBinary) {
    const home = yield* HostProcess.HomeDirectory;
    yield* readInstallRecord.pipe(
      Effect.flatMap((installed) =>
        repairServices({
          bundled: bundledBinary,
          target: serviceAgentd(bundledBinary, env.APPDIR, installed),
          platform,
          home,
          root: env.AGENTD_ROOT,
          run: runner.run,
        }),
      ),
      Effect.tap((repair) =>
        Effect.sync(() => {
          servicesRepair = repair;
        }),
      ),
      Effect.tap((repair) =>
        repair === null
          ? Effect.void
          : repair.ok
            ? Effect.logInfo("agentd services moved to the bundled agentd", repair)
            : Effect.logWarning(
                "agentd services on a missing or old agentd were not moved",
                repair,
              ),
      ),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.ignore,
      Effect.forkScoped,
    );
  }

  // Until the watchdog runs a working agentd, the listed cloud jobs are synced here, never often.
  // One sync at a time, beside the list: a slow Job API never holds up the local tasks.
  const bridgeScope = yield* Scope.Scope;
  let lastCloudSync = 0;
  let syncing = false;
  const syncCloud = Effect.fn("AgentdBridge.syncCloud")(function* (
    rows: ReadonlyArray<AgentdTaskRow>,
  ) {
    if (syncing || !hasOpenCloudJob(rows)) return;
    const now = yield* Clock.currentTimeMillis;
    if (now - lastCloudSync < Duration.toMillis(CLOUD_SYNC_INTERVAL)) return;
    lastCloudSync = now;
    syncing = true;
    yield* run(agentdArgs.cloudSync()).pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          syncing = false;
        }),
      ),
      Effect.forkIn(bridgeScope),
    );
  });

  const readTasks = run(agentdArgs.list()).pipe(
    Effect.flatMap(decodeList),
    Effect.map((rows) => rows.map(AgentdJson.agentdTaskRow)),
  );

  const eula: AgentdBridge["Service"]["eula"] = run(agentdArgs.eula()).pipe(
    Effect.map((text) => ({ version: AgentdJson.eulaVersion(text), text })),
    Effect.withSpan("AgentdBridge.eula"),
  );

  const status: AgentdBridge["Service"]["status"] = Effect.gen(function* () {
    const [version, doctor] = yield* Effect.all(
      [run(agentdArgs.version()), run(agentdArgs.doctor(), { jsonOnFailure: true })],
      { concurrency: 2 },
    ).pipe(
      Effect.flatMap(([version, doctor]) =>
        Effect.map(decodeDoctor(doctor), (d) => [version, d] as const),
      ),
    );
    // Only a saved acceptance needs the carried version, to see whether agentd would ask again.
    const carried =
      typeof AgentdJson.acceptedEula(doctor) === "string"
        ? yield* eula.pipe(
            Effect.map((read) => read.version),
            Effect.orElseSucceed(() => null),
          )
        : null;
    const status = AgentdJson.agentdStatus(version, doctor, carried);
    const defaultWorker = status.setUp
      ? yield* run(agentdArgs.defaultWorker()).pipe(
          Effect.map((stdout) => {
            const worker = stdout.trim();
            return isDefaultWorker(worker) ? worker : null;
          }),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const install = yield* readInstallRecord;
    return {
      ...status,
      defaultWorker,
      binary: yield* binary,
      install,
      ...(servicesRepair === null ? {} : { servicesRepair }),
    };
  }).pipe(Effect.withSpan("AgentdBridge.status"));

  // The first read fails the stream; a later failed read keeps the last list until agentd answers.
  const subscribeTasks: AgentdBridge["Service"]["subscribeTasks"] = Stream.paginate(
    null as ReadonlyArray<AgentdTaskRow> | null,
    (previous) =>
      Effect.gen(function* () {
        if (previous === null) {
          const rows = yield* readTasks;
          return [[rows], Option.some(rows)] as const;
        }
        yield* Effect.sleep(TASKS_POLL_INTERVAL);
        if (!(yield* backgroundPolicy.shouldRunScopeWork(POLL_SCOPE))) {
          return [[], Option.some(previous)] as const;
        }
        yield* syncCloud(previous);
        const rows = yield* readTasks.pipe(Effect.option);
        if (Option.isNone(rows) || sameRows(previous, rows.value)) {
          return [[], Option.some(previous)] as const;
        }
        return [[rows.value], Option.some(rows.value)] as const;
      }),
  );

  const readLog = (path: string, from: number, to: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r" });
        const bytes = yield* file.readAlloc(to - from, { position: BigInt(from) });
        return Option.getOrElse(bytes, () => new Uint8Array());
      }),
    );

  const logSize = (path: string) =>
    fs.stat(path).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );

  const subscribeTaskOutput: AgentdBridge["Service"]["subscribeTaskOutput"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const show = yield* readShow(input.id);
        const log = show.worker_log ?? null;
        if (log === null || log === "") {
          const empty: OrchestrationV2CommandOutputFrame = {
            kind: "replace",
            text: "",
            truncated: false,
            running: false,
          };
          return Stream.succeed(empty);
        }
        let decoder = new TextDecoder();
        let offset: number | null = null;
        let running = RUNNING_STATES.has(show.state);
        let polls = 0;
        const tail = Effect.fn("AgentdBridge.outputTail")(function* (size: number) {
          const from = Math.max(0, size - OUTPUT_TAIL_BYTES);
          decoder = new TextDecoder();
          const bytes = yield* readLog(log, from, size);
          offset = size;
          return {
            kind: "replace",
            text: decoder.decode(bytes, { stream: true }),
            truncated: from > 0,
            running,
          } satisfies OrchestrationV2CommandOutputFrame;
        });
        return Stream.paginate(true, (more: boolean) =>
          Effect.gen(function* () {
            if (!more) return [[], Option.none()] as const;
            if (offset === null) {
              const frame = yield* tail(yield* logSize(log));
              return [[frame], Option.some(running)] as const;
            }
            yield* Effect.sleep(OUTPUT_POLL_INTERVAL);
            polls += 1;
            if (polls % OUTPUT_STATE_EVERY === 0) {
              const state = yield* readShow(input.id).pipe(Effect.option);
              if (Option.isSome(state)) running = RUNNING_STATES.has(state.value.state);
            }
            const size = yield* logSize(log);
            const frames: OrchestrationV2CommandOutputFrame[] = [];
            if (size < offset || size - offset > OUTPUT_TAIL_BYTES) {
              frames.push(yield* tail(size));
            } else if (size > offset || !running) {
              const bytes = yield* readLog(log, offset, size);
              offset = size;
              frames.push({
                kind: "append",
                text: decoder.decode(bytes, { stream: running }),
                truncated: false,
                running,
              });
            }
            return [frames, Option.some(running)] as const;
          }).pipe(Effect.mapError(() => commandError("The task's worker log could not be read."))),
        );
      }),
    );

  const startTask = Effect.fn("AgentdBridge.startTask")(function* (
    input: AgentdStartTaskInput | AgentdCloudTaskInput,
  ) {
    if (input.cloud !== undefined) return yield* cloud.startCloudTask(input);
    const created = yield* run(yield* args(() => agentdArgs.new(input))).pipe(
      Effect.flatMap(
        decodeJson(
          Schema.Struct({
            handoff: Schema.optionalKey(Schema.String),
            id: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
    );
    const id = created.handoff ?? created.id;
    if (id === undefined) return yield* commandError("agentd new did not name the task it made.");
    // A failed dispatch leaves the task offered in agentd, where Start can run it again.
    return yield* run(yield* args(() => agentdArgs.dispatch(id, input.worker))).pipe(
      Effect.as({ id, started: true, note: null }),
      Effect.catchTags({
        AgentdCommandError: (error) => Effect.succeed({ id, started: false, note: error.message }),
      }),
    );
  });

  const people = Effect.fn("AgentdBridge.people")(function* (input: AgentdPeopleInput) {
    const users = yield* run(agentdArgs.users()).pipe(Effect.flatMap(decodeUsers));
    const target = input.target;
    const holders =
      target === undefined
        ? []
        : AgentdJson.agentdHolders(
            yield* run(yield* args(() => agentdArgs.who(target))).pipe(Effect.flatMap(decodeWho)),
          );
    const nodes = input.includeNodes
      ? yield* run(agentdArgs.nodes()).pipe(
          Effect.flatMap(decodeNodes),
          // agentd v0.1.15+ public builds have no `agentd server`: no node cards, people still list.
          Effect.catchTags({
            AgentdCommandError: (error) =>
              error.message.includes("part of the team server")
                ? Effect.undefined
                : Effect.fail(error),
          }),
        )
      : undefined;
    return {
      people: AgentdJson.agentdPeople(users),
      holders,
      ...(nodes === undefined ? {} : { nodes }),
    };
  });

  const readTaskWho = Effect.fn("AgentdBridge.readTaskWho")(function* (target: string) {
    const who = yield* run(yield* args(() => agentdArgs.who(target))).pipe(
      Effect.flatMap(decodeWho),
    );
    if (!who.server || who.server_note) {
      return yield* commandError("agentd could not look up team holdings.");
    }
    return who;
  });

  const taskOthers = Effect.fn("AgentdBridge.taskOthers")(
    function* ({ cwd, issue }: AgentdTaskOthersInput) {
      const doctor = yield* run(agentdArgs.doctor(), { jsonOnFailure: true }).pipe(
        Effect.flatMap(decodeDoctor),
      );
      const team = joinedPerson(doctor);
      if (doctor.set_up === false || team === null) return [];
      const namedUser = env.AGENTD_USER?.trim();
      const [checkout, onIssue, local] = yield* Effect.all(
        [
          readTaskWho(cwd),
          issue === null ? Effect.succeed(null) : readTaskWho(issue),
          namedUser
            ? Effect.succeed([namedUser])
            : Effect.gen(function* () {
                const username = env.USER?.trim() || (yield* HostProcess.Username);
                const users = yield* run(agentdArgs.users()).pipe(Effect.flatMap(decodeUsers));
                const owner =
                  users.length === 1 && users[0]?.role === "owner" ? users[0].name : null;
                return [username, owner];
              }),
        ],
        { concurrency: "unbounded" },
      );
      const onRepository = yield* Effect.forEach(repositoryTargets(checkout), readTaskWho, {
        concurrency: "unbounded",
      });
      return mergeTaskHolders(
        onIssue === null ? [checkout, ...onRepository] : [onIssue, checkout, ...onRepository],
        {
          local: [team, ...local],
          team,
        },
      );
    },
    Effect.timeout("3 seconds"),
    Effect.orElseSucceed(() => []),
  );

  const projectFile = Effect.fn("AgentdBridge.projectFile")(
    function* (cwd: string, name: string) {
      const file = pathService.join(cwd, name);
      const info = yield* fs.stat(file);
      if (info.type !== "File") return null;
      // Only package.json is read, and only to find its test script.
      if (name !== "package.json") return "";
      return Number(info.size) > 1024 * 1024 ? null : yield* fs.readFileString(file);
    },
    Effect.orElseSucceed(() => null),
  );

  const taskDefaults = Effect.fn("AgentdBridge.taskDefaults")(function* ({
    cwd,
    size,
  }: AgentdTaskDefaultsInput) {
    const type = estimateType(size);
    const [estimate, found] = yield* Effect.all(
      [
        run(agentdArgs.estimate(type)).pipe(
          Effect.map((stdout) => readEstimate(stdout, type)),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => null),
        ),
        pathService.isAbsolute(cwd) && !cwd.includes("\0")
          ? Effect.forEach(PROJECT_FILES, (name) => projectFile(cwd, name), {
              concurrency: "unbounded",
            })
          : Effect.succeed(PROJECT_FILES.map(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    const contents = new Map(PROJECT_FILES.map((name, index) => [name, found[index] ?? null]));
    const check = suggestCheck({
      packageJson: contents.get("package.json") ?? null,
      has: (name) => (contents.get(name as (typeof PROJECT_FILES)[number]) ?? null) !== null,
    });
    return { estimate, check };
  });

  return AgentdBridge.of({
    status,
    subscribeTasks,
    task: Effect.fn("AgentdBridge.task")(function* (input) {
      return AgentdJson.agentdTask(yield* readShow(input.id));
    }),
    subscribeTaskOutput,
    stopTask: Effect.fn("AgentdBridge.stopTask")(function* (input) {
      yield* run(yield* args(() => agentdArgs.cancel(input.id, input.reason)));
      return {};
    }),
    startTask,
    approvals: run(agentdArgs.approvals()).pipe(
      Effect.flatMap(decodeApprovals),
      Effect.map(AgentdJson.agentdApprovals),
      Effect.withSpan("AgentdBridge.approvals"),
    ),
    inbox: run(agentdArgs.inbox()).pipe(
      Effect.flatMap(decodeInbox),
      Effect.map(AgentdJson.agentdInbox),
      Effect.withSpan("AgentdBridge.inbox"),
    ),
    people,
    connectAgent: Effect.fn("AgentdBridge.connectAgent")(function* (input) {
      return { output: (yield* run(agentdArgs.connectAgent(input))).trim() };
    }),
    // The ticket goes on stdin only: agentd refuses it as an argument, and spans never record it.
    joinTeam: Effect.fn("AgentdBridge.joinTeam")(function* (input) {
      const argv = yield* args(() => agentdArgs.joinTeam(input.server));
      const ticket = yield* args(() => [agentdTicket(input.ticket)]);
      return { output: (yield* run(argv, { stdin: `${ticket[0]}\n` })).trim() };
    }),
    cloudSetup: cloud.cloudSetup,
    cloudReview,
    cloudConfigure: cloud.cloudConfigure,
    cloudKeyFile,
    taskDefaults,
    taskOthers,
    binary,
    enrolWorker: Effect.fn("AgentdBridge.enrolWorker")(function* (server, ticket) {
      const argv = yield* args(() => agentdArgs.enrolWorker(server));
      const checked = yield* args(() => [agentdTicket(ticket)]);
      yield* run(argv, { stdin: `${checked[0]}\n` });
    }),
    foreground: Effect.fn("AgentdBridge.foreground")(function* (minutes) {
      yield* run(agentdArgs.foreground(minutes));
    }),
    eula,
  });
});

export const layer = Layer.effect(AgentdBridge, make());
