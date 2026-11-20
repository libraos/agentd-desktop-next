// @effect-diagnostics-next-line nodeBuiltinImport:off -- A sync digest names the Windows tasks.
import * as NodeCrypto from "node:crypto";

import type { AgentdServicesRepair } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ProcessRunner } from "../processRunner.ts";

// agentd's services run the binary their LaunchAgent, systemd unit or task names; after the old
// AgentD Desktop is removed that binary is gone. A service on a missing or the old app's agentd is
// re-registered by the bundled agentd's own `install` (and `dash install` for a Linux dash).

export type ServiceName = "watchdog" | "dash";
const SERVICES: ReadonlyArray<ServiceName> = ["watchdog", "dash"];

/** The old AgentD Desktop's install folder on macOS, Windows or Linux; not AgentD Next's. */
const OLD_DESKTOP = /(?:^|[\\/])AgentD[ -]Desktop(?:\.app)?[\\/]/i;

export function isStaleProgram(program: string, exists: boolean, bundled: string): boolean {
  return program !== bundled && (!exists || OLD_DESKTOP.test(program));
}

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The first ProgramArguments string of a LaunchAgent plist. */
export function plistProgram(plist: string): string | null {
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
  const first = args === undefined ? undefined : /<string>([\s\S]*?)<\/string>/.exec(args)?.[1];
  return first === undefined ? null : unescapeXml(first.trim());
}

/** The program of a systemd unit's first ExecStart, with %h as the home folder. */
export function unitProgram(unit: string, home: string): string | null {
  const line = /^ExecStart=[-@:+!]*\s*(.+)$/m.exec(unit)?.[1]?.trim();
  if (line === undefined) return null;
  const quoted = /^"([^"]+)"/.exec(line)?.[1];
  const program = quoted ?? line.split(/\s+/)[0] ?? "";
  return program === "" ? null : program.replaceAll("%h", home);
}

/** The program of a scheduled task's first action, from `schtasks /Query /XML`. */
export function taskProgram(xml: string): string | null {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(xml)?.[1];
  return command === undefined ? null : unescapeXml(command.trim()).replace(/^"(.*)"$/, "$1");
}

/** agentd's task names for a root (schtasksTaskName): plain for the default root. */
export function taskNames(service: ServiceName, root: string | undefined): ReadonlyArray<string> {
  const plain = `\\LibraOS\\agentd-${service}`;
  if (root === undefined || root.trim() === "") return [plain];
  const key = root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const hash = NodeCrypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return [`${plain}-${hash}`, plain];
}

/** The units `agentd install` asks to enable, from its "then:" line. */
export function unitsToEnable(installOutput: string): ReadonlyArray<string> {
  const line = /^then:.*enable --now (.+)$/m.exec(installOutput)?.[1] ?? "";
  return line.split(/\s+/).filter((unit) => /^agentd-[\w-]+\.(?:service|timer)$/.test(unit));
}

/** The step `agentd install` asks for before it enables anything: disabling still-enabled legacy units. */
function legacyDisableCommand(installOutput: string): string | null {
  const units = /first: systemctl --user disable --now ([^,\n]+)/.exec(installOutput)?.[1] ?? "";
  const names = units.split(/\s+/).filter((unit) => /^[\w.@-]+\.(?:service|timer)$/.test(unit));
  return names.length === 0 ? null : `systemctl --user disable --now ${names.join(" ")}`;
}

export const repairServices = Effect.fn("AgentdServices.repair")(function* (deps: {
  readonly bundled: string;
  readonly platform: string;
  readonly home: string;
  readonly root: string | undefined;
  readonly run: ProcessRunner["Service"]["run"];
}) {
  const { bundled, platform, home, root, run } = deps;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) => fs.readFileString(file).pipe(Effect.option);
  const exec = (command: string, args: ReadonlyArray<string>) =>
    run({ command, args, timeout: "2 minutes", maxOutputBytes: 256 * 1024 }).pipe(
      Effect.map((output) => ({ ok: output.code === 0, text: output.stdout + output.stderr })),
      Effect.orElseSucceed(() => ({ ok: false, text: "" })),
    );

  const program = Effect.fn("AgentdServices.program")(function* (service: ServiceName) {
    if (platform === "darwin") {
      const plist = yield* read(
        path.join(home, "Library", "LaunchAgents", `com.libraos.agentd.${service}.plist`),
      );
      return plist._tag === "Some" ? plistProgram(plist.value) : null;
    }
    if (platform === "win32") {
      for (const name of taskNames(service, root)) {
        const query = yield* exec("schtasks", ["/Query", "/TN", name, "/XML"]);
        if (query.ok) return taskProgram(query.text);
      }
      return null;
    }
    const unit = yield* read(
      path.join(home, ".config", "systemd", "user", `agentd-${service}.service`),
    );
    return unit._tag === "Some" ? unitProgram(unit.value, home) : null;
  });

  const stale: ServiceName[] = [];
  // Services on another working agentd, the user's own: never moved.
  const kept: ServiceName[] = [];
  for (const service of SERVICES) {
    const found = yield* program(service);
    if (found === null) continue;
    const exists = yield* fs.exists(found).pipe(Effect.orElseSucceed(() => false));
    if (isStaleProgram(found, exists, bundled)) stale.push(service);
    else if (found !== bundled) kept.push(service);
  }
  if (stale.length === 0) return null;

  let ok = true;
  let command: string | null = null;
  if (platform === "darwin" || platform === "win32") {
    // install moves both services, so it would also move the one kept on the user's agentd.
    if (kept.length > 0) return { services: stale, ok: false, kept } satisfies AgentdServicesRepair;
    // install moves both LaunchAgents or both tasks of this root to the binary that runs it.
    ok = (yield* exec(bundled, ["install"])).ok;
  } else {
    if (stale.includes("watchdog")) {
      const installed = yield* exec(bundled, ["install"]);
      ok = installed.ok;
      if (ok) {
        ok = (yield* exec("systemctl", ["--user", "daemon-reload"])).ok;
        const units = unitsToEnable(installed.text);
        // No enable step: agentd withheld it (legacy units still enabled), so nothing runs yet.
        command = legacyDisableCommand(installed.text);
        if (units.length === 0) ok = false;
        else if (ok) ok = (yield* exec("systemctl", ["--user", "enable", "--now", ...units])).ok;
      }
    }
    if (stale.includes("dash")) ok = (yield* exec(bundled, ["dash", "install"])).ok && ok;
  }
  return {
    services: stale,
    ok,
    ...(command === null ? {} : { command }),
  } satisfies AgentdServicesRepair;
});
