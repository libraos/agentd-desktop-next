import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import type * as ProcessRunner from "../processRunner.ts";
import {
  envFileLedger,
  isStaleProgram,
  plistLedger,
  plistProgram,
  repairServices,
  taskEnvFile,
  taskNames,
  taskProgram,
  unitLedger,
  unitProgram,
  unitsToEnable,
} from "./agentdServices.ts";

const OLD = "/Applications/AgentD Desktop.app/Contents/Resources/bin/agentd";
const NEXT = "/Applications/AgentD Next.app/Contents/Resources/bin/agentd";

const plist = (
  program: string,
  env: Record<string, string> = {},
) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.libraos.agentd.watchdog</string>
<key>ProgramArguments</key>
<array>
  <string>${program.replaceAll("&", "&amp;")}</string>
  <string>watchdog</string>
</array>
<key>EnvironmentVariables</key>
<dict>
  <key>PATH</key><string>/usr/bin:/bin</string>
${Object.entries(env)
  .map(([key, value]) => `  <key>${key}</key><string>${value.replaceAll("&", "&amp;")}</string>`)
  .join("\n")}
</dict>
</dict></plist>`;

const task = (program: string, envFile: string) =>
  `<Actions Context="Author"><Exec><Command>${program}</Command><Arguments>service-run --env &quot;${envFile}&quot; --log x.log -- watchdog</Arguments></Exec></Actions>`;

const UNSET = { AGENTD_ROOT: "", AGENTD_DB: "", AGENTOPS_ROOT: "", AGENTOPS_DB: "" };

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

describe("agentd services", () => {
  it("reads the program each kind of service runs", () => {
    expect(plistProgram(plist(OLD))).toBe(OLD);
    expect(plistProgram(plist("/opt/R&D/agentd"))).toBe("/opt/R&D/agentd");
    expect(plistProgram("<plist/>")).toBe(null);
    expect(unitProgram("[Service]\nExecStart=-%h/.local/bin/agentd watchdog\n", "/home/me")).toBe(
      "/home/me/.local/bin/agentd",
    );
    expect(unitProgram('ExecStart="/opt/Agent D/agentd" dash --serve x', "/h")).toBe(
      "/opt/Agent D/agentd",
    );
    expect(
      taskProgram(
        "<Actions><Exec><Command>&quot;C:\\Program Files\\AgentD Desktop\\resources\\bin\\agentd.exe&quot;</Command></Exec></Actions>",
      ),
    ).toBe("C:\\Program Files\\AgentD Desktop\\resources\\bin\\agentd.exe");
    expect(taskNames("dash", undefined)).toEqual(["\\LibraOS\\agentd-dash"]);
    expect(taskNames("dash", "C:\\Users\\Me\\Root\\")[0]).toMatch(
      /^\\LibraOS\\agentd-dash-[0-9a-f]{8}$/,
    );
    // agentd cleans the root before hashing it: one root, one name, however it is spelled.
    expect(taskNames("dash", "C:\\Users\\Me\\Work\\..\\AgentD")).toEqual(
      taskNames("dash", "c:/users/me/./agentd/"),
    );
    expect(plistLedger(plist(OLD, { AGENTD_ROOT: "/r", AGENTD_DB: "/r/a&b.db" }))).toEqual({
      root: "/r",
      db: "/r/a&b.db",
    });
    expect(plistLedger(plist(OLD))).toEqual({ root: null, db: null });
    expect(
      unitLedger("[Service]\nEnvironment=PATH=/bin\nEnvironment=AGENTOPS_ROOT=/old\nExecStart=x\n"),
    ).toEqual({ root: "/old", db: null });
    expect(envFileLedger("PATH=C:\\bin\r\nAGENTD_DB=D:\\l.db\r\n")).toEqual({
      root: null,
      db: "D:\\l.db",
    });
    expect(taskEnvFile(task("agentd.exe", "C:\\R\\services\\agentd-dash.env"))).toBe(
      "C:\\R\\services\\agentd-dash.env",
    );
    expect(
      unitsToEnable(
        "/u: 1 unit(s) changed []\nthen: systemctl --user daemon-reload && systemctl --user enable --now agentd-notify.service agentd-watchdog.timer\n",
      ),
    ).toEqual(["agentd-notify.service", "agentd-watchdog.timer"]);
  });

  it("moves only a service on a missing agentd or the old app's, never the user's own", () => {
    expect(isStaleProgram(OLD, true, NEXT)).toBe(true);
    expect(isStaleProgram("/gone/agentd", false, NEXT)).toBe(true);
    expect(isStaleProgram("/usr/local/bin/agentd", true, NEXT)).toBe(false);
    expect(isStaleProgram(NEXT, true, NEXT)).toBe(false);
    expect(
      isStaleProgram("C:\\Program Files\\AgentD Desktop\\resources\\bin\\agentd.exe", true, NEXT),
    ).toBe(true);
  });

  it.effect("re-registers stale services with the bundled agentd's own install, once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const agents = path.join(home, "Library", "LaunchAgents");
      yield* fs.makeDirectory(agents, { recursive: true });
      yield* fs.writeFileString(path.join(agents, "com.libraos.agentd.watchdog.plist"), plist(OLD));
      const bundled = path.join(home, "agentd");
      yield* fs.writeFileString(bundled, "");
      yield* fs.writeFileString(path.join(agents, "com.libraos.agentd.dash.plist"), plist(bundled));
      const runs: Array<ReadonlyArray<string>> = [];
      const envs: Array<NodeJS.ProcessEnv | undefined> = [];
      const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        envs.push(input.env);
        return Effect.succeed(output("services  reloaded com.libraos.agentd.watchdog"));
      };
      const deps = { bundled, platform: "darwin", home, root: undefined, run };
      expect(yield* repairServices(deps)).toEqual({ services: ["watchdog"], ok: true });
      expect(runs).toEqual([[bundled, "install"]]);
      expect(envs).toEqual([UNSET]);

      // Services on a custom root and ledger stay on them, whatever this server's environment.
      const custom = { AGENTD_ROOT: "/data/agentd", AGENTD_DB: "/data/agentd/ledger.db" };
      yield* fs.writeFileString(
        path.join(agents, "com.libraos.agentd.watchdog.plist"),
        plist(OLD, custom),
      );
      yield* fs.writeFileString(
        path.join(agents, "com.libraos.agentd.dash.plist"),
        plist(bundled, custom),
      );
      runs.length = 0;
      envs.length = 0;
      expect(yield* repairServices(deps)).toEqual({ services: ["watchdog"], ok: true });
      expect(envs).toEqual([{ ...UNSET, ...custom }]);
      // Services on two ledgers: one install can't move both, so nothing runs.
      yield* fs.writeFileString(path.join(agents, "com.libraos.agentd.dash.plist"), plist(bundled));
      runs.length = 0;
      expect(yield* repairServices(deps)).toEqual({ services: ["watchdog"], ok: false });
      expect(runs).toEqual([]);
      yield* fs.writeFileString(path.join(agents, "com.libraos.agentd.watchdog.plist"), plist(OLD));

      // A working dash on the user's own agentd: install would move it too, so nothing runs.
      const own = path.join(home, "own-agentd");
      yield* fs.writeFileString(own, "");
      yield* fs.writeFileString(path.join(agents, "com.libraos.agentd.dash.plist"), plist(own));
      runs.length = 0;
      expect(yield* repairServices(deps)).toEqual({
        services: ["watchdog"],
        ok: false,
        kept: ["dash"],
      });
      expect(runs).toEqual([]);

      // Linux: agentd install for the watchdog units, then what it asks systemd to do.
      const units = path.join(home, ".config", "systemd", "user");
      yield* fs.makeDirectory(units, { recursive: true });
      yield* fs.writeFileString(
        path.join(units, "agentd-watchdog.service"),
        "[Service]\nExecStart=/gone/agentd watchdog\n",
      );
      yield* fs.writeFileString(
        path.join(units, "agentd-dash.service"),
        `[Service]\nExecStart=${bundled} dash --serve 127.0.0.1:21480\n`,
      );
      runs.length = 0;
      const linuxRun: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        return Effect.succeed(
          output(
            input.args[0] === "install"
              ? "then: systemctl --user daemon-reload && systemctl --user enable --now agentd-watchdog.timer\n"
              : "",
          ),
        );
      };
      expect(yield* repairServices({ ...deps, platform: "linux", run: linuxRun })).toEqual({
        services: ["watchdog"],
        ok: true,
      });
      expect(runs).toEqual([
        [bundled, "install"],
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "agentd-watchdog.timer"],
      ]);

      // agentd withholds the enable step while a legacy unit is enabled: not repaired, and the
      // step it asked for first is passed on.
      runs.length = 0;
      const legacyRun: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        return Effect.succeed(
          output(
            input.args[0] === "install"
              ? `${units}: 1 unit(s) changed [enabled:agentops-watchdog.timer]\n` +
                  "legacy units still enabled; first: systemctl --user disable --now agentops-watchdog.timer, then run agentd install again\n"
              : "",
          ),
        );
      };
      expect(yield* repairServices({ ...deps, platform: "linux", run: legacyRun })).toEqual({
        services: ["watchdog"],
        ok: false,
        command: "systemctl --user disable --now agentops-watchdog.timer",
      });
      expect(runs).toEqual([
        [bundled, "install"],
        ["systemctl", "--user", "daemon-reload"],
      ]);

      // Nothing stale: nothing runs.
      runs.length = 0;
      yield* fs.writeFileString(
        path.join(units, "agentd-watchdog.service"),
        `[Service]\nExecStart=${bundled} watchdog\n`,
      );
      expect(yield* repairServices({ ...deps, platform: "linux", run: linuxRun })).toBe(null);
      expect(runs).toEqual([]);

      // Windows: the plain legacy task is moved only when its env file is in this root.
      const root = path.join(home, "Work", "..", "Root");
      const envFile = path.join(home, "Root", "services", "agentd-watchdog.env");
      yield* fs.makeDirectory(path.dirname(envFile), { recursive: true });
      yield* fs.writeFileString(envFile, `PATH=/bin\nAGENTD_ROOT=${root}\n`);
      let legacyEnv = envFile;
      runs.length = 0;
      envs.length = 0;
      const windowsRun: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        envs.push(input.env);
        if (input.command !== "schtasks") return Effect.succeed(output(""));
        const plain = input.args[2] === "\\LibraOS\\agentd-watchdog";
        return Effect.succeed(
          plain ? output(task("C:\\gone\\agentd.exe", legacyEnv)) : output("", 1),
        );
      };
      const windows = { ...deps, platform: "win32", root, run: windowsRun };
      expect(yield* repairServices(windows)).toEqual({ services: ["watchdog"], ok: true });
      expect(runs.at(-1)).toEqual([bundled, "install"]);
      expect(envs.at(-1)).toEqual({ ...UNSET, AGENTD_ROOT: root });
      legacyEnv = path.join(home, "Other", "services", "agentd-watchdog.env");
      runs.length = 0;
      expect(yield* repairServices(windows)).toBe(null);
      expect(runs.every(([command]) => command === "schtasks")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
