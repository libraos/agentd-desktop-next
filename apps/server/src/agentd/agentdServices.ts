// @effect-diagnostics-next-line nodeBuiltinImport:off -- A sync digest names the Windows tasks.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- agentd cleans Windows roots as POSIX paths.
import * as NodePathPosix from "node:path/posix";

import type { AgentdInstallRecord, AgentdServicesRepair } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ProcessRunner } from "../processRunner.ts";

// A service whose agentd is missing or the old AgentD Desktop's is re-registered by an agentd this
// app carries, with its own `install` (and `dash install` for a Linux dash) and the root and ledger
// the service names. An AppImage's agentd is never registered: its mount is gone when the app quits.

export type ServiceName = "watchdog" | "dash";
const SERVICES: ReadonlyArray<ServiceName> = ["watchdog", "dash"];

/** The old AgentD Desktop's install folder on macOS, Windows or Linux; not AgentD Next's. */
const OLD_DESKTOP = /(?:^|[\\/])AgentD[ -]Desktop(?:\.app)?[\\/]/i;
/** An AppImage's mount, such as /tmp/.mount_AgentDXXXXXX/: removed when that app quits. */
const APPIMAGE_MOUNT = /^\/(?:[^/]+\/)*\.mount_[^/]+\//;

export function isStaleProgram(program: string, exists: boolean, bundled: string): boolean {
  return (
    program !== bundled && (!exists || OLD_DESKTOP.test(program) || APPIMAGE_MOUNT.test(program))
  );
}

/**
 * The agentd services may run: the bundled one, unless it is inside this AppImage's mount. Then
 * the copy the app installed for the terminal (the same agentd, kept after the app quits), else
 * null: nothing lasting to register.
 */
export function serviceAgentd(
  bundled: string,
  appDir: string | undefined,
  installed: AgentdInstallRecord | null,
): string | null {
  const mount = appDir?.trim().replace(/\/+$/, "");
  const inMount = (file: string) =>
    APPIMAGE_MOUNT.test(file) || (!!mount && file.startsWith(`${mount}/`));
  if (!inMount(bundled)) return bundled;
  const ours =
    installed !== null && ["installed", "replaced", "unchanged"].includes(installed.action);
  return ours && !inMount(installed.path) ? installed.path : null;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The root and ledger a service names; null where it names none and agentd's default applies. */
interface ServiceLedger {
  readonly root: string | null;
  readonly db: string | null;
}

function ledgerOf(vars: ReadonlyMap<string, string>): ServiceLedger {
  const pick = (name: string) => vars.get(`AGENTD_${name}`) || vars.get(`AGENTOPS_${name}`) || null;
  return { root: pick("ROOT"), db: pick("DB") };
}

/** install's environment for a ledger: an unset name is cleared, never inherited from this server. */
function installEnv(ledger: ServiceLedger): NodeJS.ProcessEnv {
  return {
    AGENTD_ROOT: ledger.root ?? "",
    AGENTD_DB: ledger.db ?? "",
    AGENTOPS_ROOT: "",
    AGENTOPS_DB: "",
  };
}

/** The ledger a LaunchAgent's EnvironmentVariables name. */
export function plistLedger(plist: string): ServiceLedger {
  const dict = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1] ?? "";
  const vars = new Map<string, string>();
  for (const [, key, value] of dict.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g))
    vars.set(unescapeXml(key!.trim()), unescapeXml(value!.trim()));
  return ledgerOf(vars);
}

/** The ledger a systemd unit's Environment= lines name. */
export function unitLedger(unit: string): ServiceLedger {
  const vars = new Map<string, string>();
  for (const [, key, value] of unit.matchAll(/^Environment="?([A-Z_]+)=([^"\n]*)"?\s*$/gm))
    vars.set(key!, value!.trim());
  return ledgerOf(vars);
}

/** The ledger an agentd task's env file (KEY=VALUE lines) names. */
export function envFileLedger(text: string): ServiceLedger {
  const vars = new Map<string, string>();
  for (const [, key, value] of text.matchAll(/^([A-Z_]+)=(.*?)\r?$/gm)) vars.set(key!, value!);
  return ledgerOf(vars);
}

/** The env file an agentd task runs with: its `service-run --env FILE`, ROOT\services\NAME.env. */
export function taskEnvFile(xml: string): string | null {
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml.replaceAll("\0", ""))?.[1];
  if (args === undefined) return null;
  const match = /(?:^|\s)--env\s+(?:"([^"]*)"|(\S+))/.exec(unescapeXml(args));
  return match?.[1] ?? match?.[2] ?? null;
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
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(xml.replaceAll("\0", ""))?.[1];
  return command === undefined ? null : unescapeXml(command.trim()).replace(/^"(.*)"$/, "$1");
}

/** A Windows root as agentd's task names compare it (schtasksRootKey): cleaned, lower case. */
function windowsRootKey(root: string): string {
  const cleaned = NodePathPosix.normalize(root.replaceAll("\\", "/"));
  return (cleaned.length > 1 ? cleaned.replace(/\/+$/, "") : cleaned).toLowerCase();
}

/** agentd's task names for a root (schtasksTaskName): plain for the default root. */
export function taskNames(service: ServiceName, root: string | undefined): ReadonlyArray<string> {
  const plain = `\\LibraOS\\agentd-${service}`;
  if (root === undefined || root.trim() === "") return [plain];
  const hash = NodeCrypto.createHash("sha256")
    .update(windowsRootKey(root))
    .digest("hex")
    .slice(0, 8);
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
  /** The agentd to register: bundled, or null when it can't outlast this app (an AppImage). */
  readonly target: string | null;
  readonly platform: string;
  readonly home: string;
  readonly root: string | undefined;
  readonly run: ProcessRunner["Service"]["run"];
}) {
  const { bundled, target, platform, home, root, run } = deps;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = (file: string) => fs.readFileString(file).pipe(Effect.option);
  const exec = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    run({ command, args, env, timeout: "2 minutes", maxOutputBytes: 256 * 1024 }).pipe(
      Effect.map((output) => ({ ok: output.code === 0, text: output.stdout + output.stderr })),
      Effect.orElseSucceed(() => ({ ok: false, text: "" })),
    );

  const noLedger: ServiceLedger = { root: null, db: null };
  const service = Effect.fn("AgentdServices.program")(function* (name: ServiceName) {
    if (platform === "darwin") {
      const plist = yield* read(
        path.join(home, "Library", "LaunchAgents", `com.libraos.agentd.${name}.plist`),
      );
      if (plist._tag === "None") return null;
      const program = plistProgram(plist.value);
      return program === null ? null : { program, ledger: plistLedger(plist.value) };
    }
    if (platform === "win32") {
      const names = taskNames(name, root);
      const legacy = names[1];
      for (const task of names) {
        const query = yield* exec("schtasks", ["/Query", "/TN", task, "/XML"]);
        if (!query.ok) continue;
        const program = taskProgram(query.text);
        const envFile = taskEnvFile(query.text);
        // The plain legacy name may be another root's task: only one whose env file is this root's.
        const owner =
          envFile === null
            ? null
            : NodePathPosix.dirname(NodePathPosix.dirname(envFile.replaceAll("\\", "/")));
        if (
          task === legacy &&
          (owner === null || windowsRootKey(owner) !== windowsRootKey(root ?? ""))
        )
          continue;
        if (program === null) return null;
        const env = envFile === null ? null : yield* read(envFile);
        return { program, ledger: env?._tag === "Some" ? envFileLedger(env.value) : noLedger };
      }
      return null;
    }
    const unit = yield* read(
      path.join(home, ".config", "systemd", "user", `agentd-${name}.service`),
    );
    if (unit._tag === "None") return null;
    const program = unitProgram(unit.value, home);
    return program === null ? null : { program, ledger: unitLedger(unit.value) };
  });

  const stale: ServiceName[] = [];
  // Services on another working agentd, the user's own: never moved.
  const kept: ServiceName[] = [];
  const ledgers = new Map<ServiceName, ServiceLedger>();
  for (const name of SERVICES) {
    const found = yield* service(name);
    if (found === null) continue;
    ledgers.set(name, found.ledger);
    const exists = yield* fs.exists(found.program).pipe(Effect.orElseSucceed(() => false));
    const agentd = target ?? bundled;
    if (isStaleProgram(found.program, exists, agentd)) stale.push(name);
    else if (found.program !== agentd) kept.push(name);
  }
  if (stale.length === 0) return null;
  if (target === null)
    return { services: stale, ok: false, reason: "transient" } satisfies AgentdServicesRepair;
  const ledgerEnv = (name: ServiceName) => installEnv(ledgers.get(name) ?? noLedger);

  let ok = true;
  let command: string | null = null;
  let reason: "ledger" | null = null;
  if (platform === "darwin" || platform === "win32") {
    // install moves both services, so it would also move the one kept on the user's agentd.
    if (kept.length > 0) return { services: stale, ok: false, kept } satisfies AgentdServicesRepair;
    // install moves both LaunchAgents or both tasks of one root and ledger: services on two of
    // them can't be moved by one install without one changing ledger.
    const [first, ...rest] = [...ledgers.values()];
    if (rest.some((ledger) => ledger.root !== first?.root || ledger.db !== first?.db))
      return { services: stale, ok: false, reason: "ledgers" } satisfies AgentdServicesRepair;
    ok = (yield* exec(target, ["install"], installEnv(first ?? noLedger))).ok;
  } else {
    // agentd's Linux units name only PATH, so install would move a watchdog off a ledger it names.
    const watchdogLedger = ledgers.get("watchdog") ?? noLedger;
    const ownLedger = watchdogLedger.root !== null || watchdogLedger.db !== null;
    if (stale.includes("watchdog") && ownLedger) {
      ok = false;
      reason = "ledger";
    } else if (stale.includes("watchdog")) {
      const installed = yield* exec(target, ["install"], ledgerEnv("watchdog"));
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
    if (stale.includes("dash"))
      ok = (yield* exec(target, ["dash", "install"], ledgerEnv("dash"))).ok && ok;
  }
  return {
    services: stale,
    ok,
    ...(command === null ? {} : { command }),
    ...(reason === null ? {} : { reason }),
  } satisfies AgentdServicesRepair;
});
