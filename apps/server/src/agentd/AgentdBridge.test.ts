import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as AgentdBridge from "./AgentdBridge.ts";

// Recorded from agentd v0.1.13 (`handoff list --json`, `handoff show ID --json`, `doctor --json`),
// trimmed; unknown keys stay to show they are ignored.
const LIST_JSON = `[
 {
  "a2a_state": "working",
  "check": "vp run check:changed",
  "claimer": "codex-615065aa16",
  "claimer_user": "alice",
  "from": "claude-67a65e011e",
  "goal": "Implement libraos/agentd-desktop-next#16: Offer Claude Code, Codex and opencode",
  "id": "hof-b449178313",
  "issue": "libraos/agentd-desktop-next#16",
  "origin": { "dir": "/home/alice/src/agentd-desktop", "tool": "claude" },
  "project": "libraos/agentd-desktop-next",
  "report": { "next_due": "2026-11-18T09:08:31+00:00" },
  "state": "claimed",
  "to_user": null,
  "updated": "2026-11-18T08:54:30+00:00",
  "version": 2,
  "worker_running": true,
  "worker_state": null
 },
 {
  "a2a_state": "completed",
  "claimer": "claude-8c11cb50d2",
  "goal": "Implement acme/api#897 (read it first: gh issue view 897 -R acme/api): in the weekly report, spli",
  "id": "hof-a6e5f4e329",
  "issue": "acme/api#897",
  "project": "acme/api",
  "state": "done",
  "title": "Weekly report: split retries by cause",
  "updated": "2026-11-18T06:47:57+00:00",
  "version": 3,
  "worker_state": null
 }
]`;

const SHOW_JSON = `{
 "a2a_state": "completed",
 "accept": ["A done with a passed check", "B created on the same PR after it merged: A is redone"],
 "body": { "goal": "Implement acme/api#897", "keep": "reverted stays a false accept" },
 "budget": "120m,$12",
 "budget_state": null,
 "check_cmd": "npm test -- report",
 "cloud_state": null,
 "cost": {
  "inference": { "usd": 2.87 },
  "total": { "estimate": true, "inference_usd": 2.87, "lines": 1, "partial": false, "usd": 2.87 }
 },
 "created": "2026-11-18T06:24:58+00:00",
 "id": "hof-a6e5f4e329",
 "lease_branch": null,
 "lease_device": null,
 "project": "acme/api",
 "state": "done",
 "title": null,
 "updated": "2026-11-18T06:47:57+00:00",
 "verdict": {
  "check": "passed: npm test -- report",
  "delivery": "unmerged: 18 commit(s) on agentd/hof-a6e5f4e329 not in main",
  "next": "verified: merge it as it is.",
  "verdict": "verified"
 },
 "worker_branch": "agentd/hof-a6e5f4e329",
 "worker_log": "/data/agentd/.state/dispatch/hof-a6e5f4e329-20261118T062504.log",
 "worker_note": null,
 "worker_state": "",
 "worker_tool": "claude"
}`;

const DOCTOR_JSON = `{
 "checks": [
  { "id": "binary", "status": "pass", "detail": "agentd v0.1.13 0d0b360a58c0" },
  { "id": "opencode", "status": "optional", "detail": "not found; agentd works without it", "fix": "install opencode" },
  { "id": "model-prices", "status": "warn", "detail": "unpriced models" },
  { "id": "server", "status": "fail", "detail": "https://team.example:8443/agentd: device dev-123 (cli, person Les): device revoked", "fix": "join with a new ticket" }
 ],
 "ok": false,
 "set_up": true
}`;

const SUBMISSION = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/;
const MARKER = /^desktop-cloud-[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/;

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const backgroundPolicy = BackgroundPolicy.BackgroundPolicy.of({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  snapshot: Effect.die("unused"),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeBridge = (env: NodeJS.ProcessEnv, run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  AgentdBridge.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(BackgroundPolicy.BackgroundPolicy, backgroundPolicy),
    Effect.provideService(HostProcess.Environment, env),
    Effect.provide(NodeServices.layer),
  );

// agentd's cloud submission records as `pin list/add --session` and `find` keep them, and the
// handoffs its offers created, for tests that cross several Starts.
function cloudLedger() {
  const pins: Array<{ session: string; text: string }> = [];
  const handoffs = new Map<string, Record<string, unknown>>();
  const record = (args: ReadonlyArray<string>, id: string, cloudState: string) => {
    const marker = args[args.indexOf("--state") + 1];
    handoffs.set(id, { id, state: "claimed", cloud_state: cloudState, body: { state: marker } });
  };
  const answer = (args: ReadonlyArray<string>): ProcessRunner.ProcessRunOutput | null => {
    const session = args[args.indexOf("--session") + 1] ?? "";
    switch (args[0] === "find" ? "find" : args.slice(0, 2).join(" ")) {
      case "pin list":
        return output(JSON.stringify(pins.filter((pin) => pin.session === session)));
      case "pin add":
        pins.push({ session, text: args[2]! });
        return output("{}");
      case "find": {
        const marker = args[1]!.slice(1, -1);
        const hits = [...handoffs.values()].filter(
          (show) => (show.body as { state: string }).state === marker,
        );
        return output(JSON.stringify(hits.map((show) => ({ kind: "handoff", ref: show.id }))));
      }
      case "handoff show": {
        const show = handoffs.get(args[2]!);
        return show === undefined ? output("no such handoff", 1) : output(JSON.stringify(show));
      }
      default:
        return null;
    }
  };
  return { pins, handoffs, record, answer };
}

describe("AgentdBridge", () => {
  it.effect("serves agentd's status, task list and task through the contract schemas", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const fs = yield* FileSystem.FileSystem;
      const recordPath = `${yield* fs.makeTempDirectoryScoped()}/agentd-install.json`;
      yield* fs.writeFileString(
        recordPath,
        '{"action":"installed","path":"/home/les/.local/bin/agentd","directory":"/home/les/.local/bin",' +
          '"onPath":false,"pathLine":"export PATH=\\"/home/les/.local/bin:$PATH\\"","skills":[]}\n',
      );
      const env = { AGENTD_BIN: process.execPath, AGENTD_DESKTOP_INSTALL_RECORD: recordPath };
      const bridge = yield* makeBridge(env, (input) => {
        calls.push(input.args);
        const key = input.args.join(" ");
        if (key === "version") return Effect.succeed(output("agentd v0.1.13 0d0b360a58c0\n"));
        // doctor exits 1 when a check fails and still prints its report.
        if (key === "doctor --json") return Effect.succeed(output(DOCTOR_JSON, 1));
        if (key === "config get dispatch.default_tool")
          return Effect.succeed(output("opencode\r\n"));
        if (key === "handoff list --json") return Effect.succeed(output(LIST_JSON));
        if (key === "handoff show hof-a6e5f4e329 --json") return Effect.succeed(output(SHOW_JSON));
        return Effect.die(`unexpected agentd ${key}`);
      });

      expect(yield* bridge.status).toEqual({
        version: "agentd v0.1.13 0d0b360a58c0",
        ok: false,
        setUp: true,
        defaultWorker: "opencode",
        teamServer: "https://team.example:8443/agentd",
        checks: [
          { id: "binary", status: "pass", detail: "agentd v0.1.13 0d0b360a58c0", fix: null },
          {
            id: "opencode",
            status: "optional",
            detail: "not found; agentd works without it",
            fix: "install opencode",
          },
          { id: "model-prices", status: "warn", detail: "unpriced models", fix: null },
          {
            id: "server",
            status: "fail",
            detail:
              "https://team.example:8443/agentd: device dev-123 (cli, person Les): device revoked",
            fix: "join with a new ticket",
          },
        ],
        binary: process.execPath,
        install: {
          action: "installed",
          path: "/home/les/.local/bin/agentd",
          directory: "/home/les/.local/bin",
          onPath: false,
          pathLine: 'export PATH="/home/les/.local/bin:$PATH"',
          skills: [],
        },
      });

      const first = yield* Stream.runHead(bridge.subscribeTasks);
      expect(first._tag === "Some" ? first.value : null).toEqual([
        {
          id: "hof-b449178313",
          title: "Implement libraos/agentd-desktop-next#16: Offer Claude Code, Codex and opencode",
          state: "claimed",
          workerState: null,
          workerRunning: true,
          workerTool: "codex",
          workerName: "alice",
          runsOn: "local",
          project: "libraos/agentd-desktop-next",
          issue: "libraos/agentd-desktop-next#16",
          started: null,
          branch: null,
          updated: "2026-11-18T08:54:30+00:00",
        },
        {
          id: "hof-a6e5f4e329",
          title: "Weekly report: split retries by cause",
          state: "done",
          workerState: null,
          workerRunning: false,
          workerTool: "claude",
          workerName: "claude-8c11cb50d2",
          runsOn: "local",
          project: "acme/api",
          issue: "acme/api#897",
          started: null,
          branch: null,
          updated: "2026-11-18T06:47:57+00:00",
        },
      ]);

      expect(yield* bridge.task({ id: "hof-a6e5f4e329" })).toEqual({
        id: "hof-a6e5f4e329",
        title: "Implement acme/api#897",
        goal: "Implement acme/api#897",
        state: "done",
        workerState: null,
        workerTool: "claude",
        runsOn: "local",
        accept: [
          "A done with a passed check",
          "B created on the same PR after it merged: A is redone",
        ],
        check: "npm test -- report",
        verdict: {
          verdict: "verified",
          check: "passed: npm test -- report",
          delivery: "unmerged: 18 commit(s) on agentd/hof-a6e5f4e329 not in main",
          next: "verified: merge it as it is.",
        },
        costUsd: 2.87,
        costEstimate: true,
        budget: "120m,$12",
        budgetState: null,
        branch: "agentd/hof-a6e5f4e329",
        note: null,
        project: "acme/api",
        hasLog: true,
        started: "2026-11-18T06:24:58+00:00",
        updated: "2026-11-18T06:47:57+00:00",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists people without node cards when agentd has no team server", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        switch (input.args.join(" ")) {
          case "user list --json":
            return Effect.succeed(output(`[{"name":"Les","role":"owner"}]`));
          case "server nodes --json":
            return Effect.succeed(
              output(
                "agentd: agentd server is part of the team server, which the public agentd does not include (LibraOS Team or Enterprise: https://libraos.com/pricing/)",
                2,
              ),
            );
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const read = yield* bridge.people({ includeNodes: true });
      expect(read.people.map((person) => person.name)).toEqual(["Les"]);
      expect(read.nodes).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves requesters and node cards and names leased and cloud work", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        switch (input.args.join(" ")) {
          case "user list --json":
            return Effect.succeed(output(`[{"name":"Les","role":"owner"}]`));
          case "server nodes --json":
            return Effect.succeed(
              output(
                `[{"name":"build-box","host":"runner-2","state":"busy","why":"Building locally","person":"Les","offline":false,"seen":"2026-11-18T09:14:00Z"}]`,
              ),
            );
          case "approval list --state pending --json":
            return Effect.succeed(
              output(`[{"id":"ap-01","text":"Raise the budget?","session":"codex-abc"}]`),
            );
          case "inbox list --mine --json":
            return Effect.succeed(
              output(
                `[{"id":"in-01","kind":"blocked","title":"Which release?","from":"les","claimer":"claude-abc"}]`,
              ),
            );
          case "handoff list --json":
            return Effect.succeed(
              output(`[
              {"id":"hof-abc123","state":"claimed","goal":"Run tests","claimer":"wrk-build-box"},
              {"id":"hof-abc456","state":"claimed","goal":"Check docs","claimer":"cloud","cloud_state":"running","cloud_usd":0.75}
            ]`),
            );
          case "handoff show hof-abc456 --json":
            return Effect.succeed(
              output(`{
              "id":"hof-abc456", "state":"done", "cloud_state":"failed",
              "worker_branch":"agentd/hof-abc456",
              "body":{"goal":"Check docs","model_access":"byok","anthropic_key_file":"/private/model-key"},
              "cloud":{"state":"failed","worker_usd":0.75,"inference_usd":0,"total_usd":0.75,
                "result":"the GitHub App is not installed on owner/fork: the repository's owner installs it once for that repository"}
            }`),
            );
          case "handoff done hof-abc456 --cancel --reason Stopped from AgentD Next":
            return Effect.succeed(output("{}"));
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      expect((yield* bridge.people({ includeNodes: true })).nodes).toEqual([
        {
          name: "build-box",
          host: "runner-2",
          person: "Les",
          state: "busy",
          why: "Building locally",
          seen: "2026-11-18T09:14:00Z",
          offline: false,
        },
      ]);
      expect(yield* bridge.approvals).toMatchObject([{ id: "ap-01", requester: "codex-abc" }]);
      expect(yield* bridge.inbox).toMatchObject([{ id: "in-01", requester: "claude-abc" }]);
      const first = yield* Stream.runHead(bridge.subscribeTasks);
      expect(first._tag === "Some" ? first.value : null).toMatchObject([
        { id: "hof-abc123", runsOn: "team", workerName: "build-box" },
        { id: "hof-abc456", runsOn: "cloud", cloudState: "running", cloudUsd: 0.75 },
      ]);
      const task = yield* bridge.task({ id: "hof-abc456" });
      expect(task).toMatchObject({
        runsOn: "cloud",
        branch: "agentd/hof-abc456",
        cloud: {
          state: "failed",
          modelAccess: "byok",
          workerUsd: 0.75,
          inferenceUsd: 0,
          totalUsd: 0.75,
        },
        note: "The repository owner must install the Cloud Workers GitHub App on this repository.",
      });
      expect(JSON.stringify(task)).not.toContain("/private/model-key");
      expect(
        yield* bridge.stopTask({ id: "hof-abc456", reason: "Stopped from AgentD Next" }),
      ).toEqual({});
    }),
  );

  it.effect("answers every method with AgentdNotFoundError when there is no agentd", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ PATH: "" }, () => Effect.die("agentd must not run"));
      const id = "hof-a6e5f4e329";
      const failures = yield* Effect.forEach(
        [
          bridge.status,
          Stream.runHead(bridge.subscribeTasks),
          bridge.task({ id }),
          Stream.runHead(bridge.subscribeTaskOutput({ id })),
          bridge.stopTask({ id, reason: "not needed" }),
          bridge.startTask({
            goal: "Fix it",
            accept: [],
            check: null,
            worker: "codex",
            budget: "30m",
            cwd: "/repo",
            issue: null,
          }),
          bridge.approvals,
          bridge.inbox,
          bridge.people({}),
          bridge.connectAgent({ agent: "opencode", dryRun: true }),
          bridge.joinTeam({ server: "https://agentd.example", ticket: "adt_0123456789abcdefXYZ" }),
        ],
        (effect) => Effect.flip(effect),
      );
      expect(failures.map((error) => error._tag)).toEqual(
        Array.from({ length: 11 }, () => "AgentdNotFoundError"),
      );
      expect(failures[0]).not.toHaveProperty("bundled");
      const bundled = yield* makeBridge(
        { PATH: "", AGENTD_BIN: "/missing/agentd", AGENTD_DESKTOP_BUNDLED: "1" },
        () => Effect.die("agentd must not run"),
      );
      expect(yield* Effect.flip(bundled.status)).toMatchObject({
        _tag: "AgentdNotFoundError",
        bundled: true,
      });
    }),
  );

  it.effect("offers cloud jobs against origin and passes only absolute key file paths", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      let origin = "git@github.com:fork-owner/its-fork.git";
      let version = "agentd v0.1.13";
      let help = "usage: agentd handoff offer [--cloud]";
      let receipt = '{"handoff":"hof-abc123","cloud":{"state":"queued"}}';
      let balance = output('{"available_usd":"12.75","default_budget":"30m,$5"}');
      const ledger = cloudLedger();
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        if (input.args.includes("--cloud")) {
          const parsed = JSON.parse(receipt) as { handoff: string; cloud: { state: string } };
          ledger.record(input.args, parsed.handoff, parsed.cloud.state);
        }
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output(version));
          case "remote get-url":
            return Effect.succeed(output(origin));
          case "cloud balance":
            return Effect.succeed(balance);
          case "session join":
            return Effect.succeed(output("{}"));
          case "handoff offer":
            return Effect.succeed(output(input.args.includes("--help") ? help : receipt));
          default:
            return Effect.die("unexpected command");
        }
      });

      const platform = yield* HostProcess.Platform;
      const path = yield* Effect.provide(Path.Path, NodeServices.layer);
      const cwd = platform === "win32" ? "C:\\work\\fork" : "/work/fork";
      const keyFile = path.join(cwd, "private", "OpenAI key.txt");
      const input = { cwd, goal: "Fix the check", accept: ["Pass it"], check: "pnpm test" };
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toEqual({
        supported: true,
        project: "fork-owner/its-fork",
        balanceUsd: 12.75,
        balanceText: null,
        defaultBudget: "30m,$5",
        problem: null,
      });
      expect(
        yield* bridge.startTask({ ...input, cloud: { modelAccess: "libraos", budget: "$5" } }),
      ).toEqual({ id: "hof-abc123", started: true, note: null });
      const byok = { modelAccess: "byok", budget: "20m,$8", openaiKeyFile: keyFile } as const;
      yield* bridge.startTask({ ...input, check: null, cloud: byok });
      const offers = () =>
        runs.filter(({ args }) => args.includes("--cloud")).map(({ args, stdin }) => [args, stdin]);
      expect(offers()).toEqual([
        [
          [
            "handoff",
            "offer",
            "--cloud",
            "--idem",
            expect.stringMatching(SUBMISSION),
            "--state",
            expect.stringMatching(MARKER),
            "--to",
            "any",
            "--session",
            "agentd-new",
            "--budget",
            "$5",
            "--model-access",
            "libraos",
            "--project",
            "fork-owner/its-fork",
            "--goal",
            "Fix the check",
            "--accept",
            "Pass it",
            "--check",
            "pnpm test",
            "--json",
          ],
          undefined,
        ],
        [
          [
            "handoff",
            "offer",
            "--cloud",
            "--idem",
            expect.stringMatching(SUBMISSION),
            "--state",
            expect.stringMatching(MARKER),
            "--to",
            "any",
            "--session",
            "agentd-new",
            "--budget",
            "20m,$8",
            "--model-access",
            "byok",
            "--openai-key-file",
            keyFile,
            "--project",
            "fork-owner/its-fork",
            "--goal",
            "Fix the check",
            "--accept",
            "Pass it",
            "--no-check",
            "--json",
          ],
          undefined,
        ],
      ]);
      expect(runs.filter(({ args }) => args.includes("--help"))).toHaveLength(1);
      expect(
        runs.filter(({ args }) => args[0] === "remote").map((run) => [run.args, run.cwd]),
      ).toEqual(Array.from({ length: 3 }, () => [["remote", "get-url", "--", "origin"], cwd]));

      const pastedKey = "sk-example-credential";
      yield* Effect.flip(
        bridge.startTask({ ...input, cloud: { ...byok, openaiKeyFile: pastedKey } }),
      );
      yield* Effect.flip(bridge.startTask({ ...input, cloud: { ...byok, budget: "20m" } }));
      expect(JSON.stringify(runs)).not.toContain(pastedKey);

      receipt =
        '{"handoff":"hof-abc123","cloud":{"state":"submitting","error":"402: insufficient credit"}}';
      expect(yield* bridge.startTask({ ...input, cloud: byok })).toEqual({
        id: "hof-abc123",
        started: false,
        note: "There is not enough LibraOS credit for this dollar cap.",
      });
      origin = "https://git.example.net/fork-owner/its-fork.git";
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: false })).toMatchObject({
        supported: true,
        project: null,
      });
      yield* Effect.flip(bridge.startTask({ ...input, cloud: byok }));
      expect(offers()).toHaveLength(3);

      origin = "ssh://git@ssh.github.com:443/fork-owner/its-fork.git";
      balance = output("LibraOS balance: $12.75\n");
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        project: "fork-owner/its-fork",
        balanceUsd: null,
        balanceText: "LibraOS balance: $12.75",
      });
      balance = output("set [cloud] url and the account key in key_file", 1);
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: true })).toMatchObject({
        problem: "setup",
        balanceText: null,
      });

      version = "agentd v0.1.0";
      help = "usage: agentd handoff offer [--goal G]";
      expect(yield* bridge.cloudSetup({ cwd, includeBalance: false })).toMatchObject({
        supported: false,
      });
      expect(runs.filter(({ args }) => args.includes("--help"))).toHaveLength(2);
    }),
  );

  it.effect("checks agentd before retrying a cloud Start whose outcome is unknown", () =>
    Effect.gen(function* () {
      const runs: Array<ReadonlyArray<string>> = [];
      const ledger = cloudLedger();
      let offer: (args: ReadonlyArray<string>) => ProcessRunner.ProcessRunOutput = () =>
        output("killed", 137);
      let origin = "https://github.com/acme/app.git";
      let failPinAdd = false;
      let brokenPins = false;
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input.args);
        if (brokenPins && input.args[0] === "pin") return Effect.succeed(output("<html>"));
        if (failPinAdd && input.args[0] === "pin" && input.args[1] === "add")
          return Effect.succeed(output("ledger busy", 1));
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output("agentd v0.1.14"));
          case "remote get-url":
            return Effect.succeed(output(origin));
          case "session join":
            return Effect.succeed(output("{}"));
          case "handoff offer":
            return Effect.succeed(
              input.args.includes("--help")
                ? output("usage: agentd handoff offer [--cloud]")
                : offer(input.args),
            );
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const platform = yield* HostProcess.Platform;
      const cwd = platform === "win32" ? "C:\\work\\app" : "/work/app";
      const clone = platform === "win32" ? "D:\\other\\app" : "/other/app";
      const input = {
        cwd,
        goal: "Fix the check",
        accept: [],
        check: "pnpm test",
        cloud: { modelAccess: "libraos", budget: "$5" },
      } as const;
      const offers = () => runs.filter((args) => args.includes("--cloud"));
      const keys = () => offers().map((args) => args[args.indexOf("--idem") + 1]);

      // Killed with nothing recorded: unknown, and a retry of the same draft reuses the paid key.
      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ outcomeUnknown: true });
      expect(yield* Effect.flip(bridge.startTask(input))).toMatchObject({ outcomeUnknown: true });
      expect(keys()).toHaveLength(2);
      expect(new Set(keys()).size).toBe(1);

      // A different draft is refused while that reservation has no task, until the user replaces it.
      const other = { ...input, goal: "Update the changelog" };
      const refused = yield* Effect.flip(bridge.startTask(other));
      expect(refused).toMatchObject({ replaceSubmission: keys()[0] });
      expect(refused.message).toMatch(/^acme\/app holds an AgentD reservation/);
      expect(offers()).toHaveLength(2);

      // agentd recorded the offer but the answer was lost, and so was the record of its task.
      offer = (args) => {
        ledger.record(args, "hof-aabbcc", "queued");
        return output("connection reset", 1);
      };
      failPinAdd = true;
      expect(
        yield* bridge.startTask({
          ...other,
          cloud: { ...other.cloud, replaceSubmission: keys()[0]! },
        }),
      ).toMatchObject({ id: "hof-aabbcc", started: false });
      expect(new Set(keys()).size).toBe(1);
      failPinAdd = false;
      // The next Start, from another checkout of the same project, finds that task and offers nothing.
      origin = "git@github.com:acme/app.git";
      expect(yield* bridge.startTask({ ...input, cwd: clone })).toMatchObject({
        id: "hof-aabbcc",
        started: false,
        note: expect.stringContaining("hof-aabbcc"),
      });
      expect(offers()).toHaveLength(3);

      // A task agentd is still submitting holds the project: no offer from any checkout.
      ledger.handoffs.set("hof-aabbcc", {
        ...ledger.handoffs.get("hof-aabbcc"),
        cloud_state: "submitting",
      });
      const held = yield* Effect.flip(bridge.startTask(other));
      expect(held.message).toBe(
        "acme/app already holds an AgentD reservation: task hof-aabbcc is still being submitted to Cloud Workers. Wait for it, or stop it in Background tasks.",
      );
      expect(offers()).toHaveLength(3);

      // Once it is queued, a new Start is a new submission with a new key.
      ledger.handoffs.set("hof-aabbcc", {
        ...ledger.handoffs.get("hof-aabbcc"),
        cloud_state: "queued",
      });
      offer = (args) => {
        ledger.record(args, "hof-ddeeff", "queued");
        return output('{"handoff":"hof-ddeeff","cloud":{"state":"queued"}}');
      };
      expect(yield* bridge.startTask(other)).toEqual({
        id: "hof-ddeeff",
        started: true,
        note: null,
      });
      expect(new Set(keys()).size).toBe(2);

      // A reservation agentd cannot list is an unknown outcome, never a blind offer.
      brokenPins = true;
      expect(yield* Effect.flip(bridge.startTask(other))).toMatchObject({ outcomeUnknown: true });
      expect(offers()).toHaveLength(4);
    }),
  );

  it.effect("names cloud refusals in one line, and reads GitHub origins in every form", () =>
    Effect.gen(function* () {
      let origin = "";
      let refusal = "";
      const ledger = cloudLedger();
      const offers: Array<ReadonlyArray<string>> = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        const recorded = ledger.answer(input.args);
        if (recorded !== null) return Effect.succeed(recorded);
        switch (input.args.slice(0, 2).join(" ")) {
          case "version":
            return Effect.succeed(output("agentd v0.1.14"));
          case "remote get-url":
            return Effect.succeed(output(`${origin}\n`));
          case "session join":
            return Effect.succeed(output("{}"));
          case "handoff offer":
            if (input.args.includes("--help"))
              return Effect.succeed(output("usage: agentd handoff offer [--cloud]"));
            offers.push(input.args);
            return Effect.succeed(output(`error: ${refusal}`, 1));
          default:
            return Effect.die(`unexpected agentd ${input.args.join(" ")}`);
        }
      });
      const platform = yield* HostProcess.Platform;
      const cwd = platform === "win32" ? "C:\\work\\app" : "/work/app";
      for (const [form, project] of [
        ["https://github.com/Acme/App.git", "acme/app"],
        ["https://www.github.com/acme/app/", "acme/app"],
        ["https://ci-bot@github.com/acme/app", "acme/app"],
        ["git+ssh://git@github.com/acme/app.git", "acme/app"],
        ["ssh://git@github.com:22/acme/app.git", "acme/app"],
        ["ssh://git@ssh.github.com:443/acme/app.git", "acme/app"],
        ["git@github.com:acme/task-sk-0123456789abcdef.git", "acme/task-sk-0123456789abcdef"],
        ["git@github.com:acme/app.js", "acme/app.js"],
        ["https://github.com/acme/..", null],
        ["https://github.example.com/acme/app.git", null],
        ["git@gitlab.com:acme/app.git", null],
        ["https://github.com/acme", null],
      ] as const) {
        origin = form;
        expect((yield* bridge.cloudSetup({ cwd, includeBalance: false })).project, form).toBe(
          project,
        );
      }

      origin = "git@github.com:acme/app.git";
      const path = yield* Effect.provide(Path.Path, NodeServices.layer);
      const keyFile = path.join(cwd, "risk-assessment-keys", "byok", "cloud-key", "openai.txt");
      const input = {
        cwd,
        goal: "Fix the check",
        accept: [],
        check: null,
        cloud: { modelAccess: "byok", budget: "$5", openaiKeyFile: keyFile },
      } as const;
      for (const [said, reason] of [
        [
          "the GitHub App is not installed on acme/app: the repository's owner installs it once",
          "The repository owner must install the Cloud Workers GitHub App on this repository.",
        ],
        [
          `cloud.openai_key_file ${keyFile} can be read or written by others`,
          "Choose a credential file that only your account can access.",
        ],
        [
          "--model-access subscription is not offered through an agentd server",
          "Submit cloud tasks from a local AgentD session, not through a team server.",
        ],
        [
          "the Claude subscription is not enabled for this account",
          "Running on your Claude subscription isn’t available yet. Use LibraOS or your API key.",
        ],
        ["402: insufficient credit", "There is not enough LibraOS credit for this dollar cap."],
        [
          "set [cloud] url first",
          "Cloud Workers aren’t set up. Check the cloud configuration and account key file.",
        ],
      ] as const) {
        refusal = said;
        expect((yield* Effect.flip(bridge.startTask(input))).message, said).toBe(reason);
      }
      expect(offers.every((args) => args.includes(keyFile))).toBe(true);
      expect(new Set(offers.map((args) => args[args.indexOf("--idem") + 1])).size).toBe(1);
    }),
  );

  it.effect("sends the joinTeam ticket on stdin, never in the arguments", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, (input) => {
        runs.push(input);
        return Effect.succeed(output("joined\n"));
      });
      const ticket = "adt_0123456789abcdefXYZ";
      yield* bridge.joinTeam({ server: "https://agentd.example/team/", ticket: ` ${ticket} ` });
      expect(runs.map((run) => [run.args, run.stdin])).toEqual([
        [
          ["connect", "--server", "https://agentd.example/team", "--ticket-file", "-"],
          `${ticket}\n`,
        ],
      ]);
    }),
  );

  it.effect("combines issue and repository holdings without naming the user or finished work", () =>
    Effect.gen(function* () {
      const cwd = "C:\\work\\app";
      const issue = "acme/app#42";
      const bob = { user: "Bob", via: "server", handoff: "hof-abcd42" };
      const file = { ...bob, resource: "repo:github.com/acme/app#src/login.ts" };
      const results = new Map([
        [cwd, { resource: "tree:github.com/acme/app@feature", holders: [] }],
        [
          issue,
          {
            holders: [
              { ...bob, resource: issue, activity: "Fix login", state: "claimed" },
              file,
              { user: "Les", via: "server", resource: issue, handoff: "hof-abcd43" },
              { user: "Tess", resource: issue, handoff: "hof-abcd44", state: "done" },
            ],
          },
        ],
        [
          "acme/app",
          {
            holders: [
              { user: "work-account", resource: "tree:github.com/acme/app@elsewhere" },
              { ...bob, path: "/work/app", resource: "tree:github.com/acme/app@elsewhere" },
            ],
          },
        ],
        [
          "repo:github.com/acme/app#",
          {
            holders: [file, { user: "Ari", resource: "repo:github.com/acme/app#README.md" }],
          },
        ],
      ]);
      const bridge = yield* makeBridge(
        { AGENTD_BIN: process.execPath, AGENTD_USER: "work-account" },
        ({ args }) => {
          if (args[0] === "doctor") return Effect.succeed(output(DOCTOR_JSON, 1));
          const answer = args[0] === "who" && results.get(args[1]!);
          return answer
            ? Effect.succeed(output(JSON.stringify({ ...answer, server: "https://team.example" })))
            : Effect.die(`unexpected agentd ${args.join(" ")}`);
        },
      );

      expect(yield* bridge.taskOthers({ cwd, issue })).toEqual([
        {
          person: "Bob",
          work: "hof-abcd42",
          activity: "Fix login",
          paths: ["src/login.ts", "/work/app"],
        },
        { person: "Ari", work: null, activity: null, paths: ["README.md"] },
      ]);
    }),
  );

  it.effect("does not ask who when the environment is off a team", () =>
    Effect.gen(function* () {
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, ({ args }) =>
        args[0] === "doctor"
          ? Effect.succeed(
              output(
                '{"checks":[{"id":"server","status":"pass","detail":"not joined to an agentd server: local mode"}]}',
              ),
            )
          : Effect.die(`unexpected agentd ${args.join(" ")}`),
      );

      expect(yield* bridge.taskOthers({ cwd: "/repo", issue: null })).toEqual([]);
    }),
  );

  it.effect.each(["error", "server_note", "slow"] as const)(
    "discards partial overlap answers when a who lookup returns %s",
    (failure) =>
      Effect.gen(function* () {
        const issueStarted = yield* Deferred.make<void>();
        const bridge = yield* makeBridge(
          { AGENTD_BIN: process.execPath, AGENTD_USER: "work-account" },
          ({ args }) => {
            if (args[0] === "doctor") return Effect.succeed(output(DOCTOR_JSON, 1));
            if (args[0] === "who" && args[1] === "/repo") {
              return Effect.succeed(
                output(
                  '{"server":"https://team.example","holders":[{"user":"Bob","path":"/repo"}]}',
                ),
              );
            }
            if (args[0] === "who" && args[1] === "acme/app#42") {
              switch (failure) {
                case "error":
                  return Effect.succeed(output("lookup failed", 1));
                case "server_note":
                  return Effect.succeed(
                    output(
                      '{"server":"https://team.example","server_note":"lookup failed","holders":[]}',
                    ),
                  );
                case "slow":
                  return Deferred.succeed(issueStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  );
              }
            }
            return Effect.die(`unexpected agentd ${args.join(" ")}`);
          },
        );

        const result = yield* bridge
          .taskOthers({ cwd: "/repo", issue: "acme/app#42" })
          .pipe(Effect.forkScoped);
        if (failure === "slow") {
          yield* Deferred.await(issueStarted);
          yield* TestClock.adjust("3 seconds");
        }
        expect(yield* Fiber.join(result)).toEqual([]);
      }),
  );

  it.effect("reads the estimate for the draft's size and suggests a check from the project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const runs: Array<ReadonlyArray<string>> = [];
      let estimate = output('{"high":4.98,"low":1.78,"median":3.11,"n":846,"type":"small"}');
      const bridge = yield* makeBridge({ AGENTD_BIN: process.execPath }, ({ args }) => {
        runs.push(args);
        return args[1] === "estimate" ? Effect.succeed(estimate) : Effect.die("unexpected");
      });

      expect(yield* bridge.taskDefaults({ cwd, size: "small" })).toEqual({
        estimate: { type: "small", low: 1.78, median: 3.11, high: 4.98, jobs: 846 },
        check: null,
      });
      yield* fs.writeFileString(path.join(cwd, "go.mod"), "module example.com/x\n");
      yield* fs.writeFileString(path.join(cwd, "package.json"), '{"scripts":{"test":"vitest"}}');
      yield* fs.writeFileString(path.join(cwd, "pnpm-lock.yaml"), "");
      estimate = output("agentd: no ledger", 1);
      expect(yield* bridge.taskDefaults({ cwd, size: "" })).toEqual({
        estimate: null,
        check: "pnpm test",
      });
      expect(runs).toEqual([
        ["handoff", "estimate", "--type", "small", "--json"],
        ["handoff", "estimate", "--type", "implement", "--json"],
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
