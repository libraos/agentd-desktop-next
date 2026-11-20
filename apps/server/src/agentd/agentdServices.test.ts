import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import type * as ProcessRunner from "../processRunner.ts";
import {
  isStaleProgram,
  plistProgram,
  repairServices,
  taskNames,
  taskProgram,
  unitProgram,
  unitsToEnable,
} from "./agentdServices.ts";

const OLD = "/Applications/AgentD Desktop.app/Contents/Resources/bin/agentd";
const NEXT = "/Applications/AgentD Next.app/Contents/Resources/bin/agentd";

const plist = (program: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.libraos.agentd.watchdog</string>
<key>ProgramArguments</key>
<array>
  <string>${program.replaceAll("&", "&amp;")}</string>
  <string>watchdog</string>
</array>
</dict></plist>`;

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
      const run: ProcessRunner.ProcessRunner["Service"]["run"] = (input) => {
        runs.push([input.command, ...input.args]);
        return Effect.succeed(output("services  reloaded com.libraos.agentd.watchdog"));
      };
      const deps = { bundled, platform: "darwin", home, root: undefined, run };
      expect(yield* repairServices(deps)).toEqual({ services: ["watchdog"], ok: true });
      expect(runs).toEqual([[bundled, "install"]]);

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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
