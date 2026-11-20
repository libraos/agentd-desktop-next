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

const C_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  s: " ",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

/** The C escape at `at` (just after its backslash), as systemd's cunescape reads it; null if invalid. */
function cEscape(
  value: string,
  at: number,
): { readonly text: string; readonly length: number } | null {
  const char = value[at];
  if (char === undefined) return null;
  const simple = C_ESCAPES[char];
  if (simple !== undefined) return { text: simple, length: 1 };
  const [radix, digits] =
    char === "x" ? [16, 2] : char === "u" ? [16, 4] : char === "U" ? [16, 8] : [8, 3];
  const start = radix === 8 ? at : at + 1;
  const code = value.slice(start, start + digits);
  const valid = radix === 8 ? /^[0-3][0-7]{2}$/ : /^[0-9a-fA-F]+$/;
  if (code.length !== digits || !valid.test(code)) return null;
  const point = Number.parseInt(code, radix);
  // systemd refuses NUL; a byte past ASCII may be part of a UTF-8 sequence, so it isn't guessed.
  const byte = char === "x" || radix === 8;
  if (point === 0 || (byte && point > 0x7f) || point > 0x10ffff) return null;
  if (point >= 0xd800 && point <= 0xdfff) return null;
  return { text: String.fromCodePoint(point), length: start - at + digits };
}

/** The words of a systemd Environment= value: split at spaces, quotes removed, C escapes read. */
function unitWords(value: string): ReadonlyArray<string> | null {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\") {
      const escape = cEscape(value, i + 1);
      if (escape === null) return null;
      word = (word ?? "") + escape.text;
      i += escape.length;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else word = (word ?? "") + char;
    } else if (char === '"' || char === "'") {
      quote = char;
      word ??= "";
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + char;
  }
  if (quote !== null) return null;
  if (word !== null) words.push(word);
  return words;
}

const LEDGER_NAME = /\b(?:AGENTD|AGENTOPS)_(?:ROOT|DB)\b/;

/**
 * The ledger a systemd unit's Environment= lines name, as systemd reads them: several
 * assignments a line, quoted or not, a later one winning and an empty Environment= clearing all.
 * Null when it can't tell: an EnvironmentFile=, a line it can't read, or a ledger name it didn't find.
 */
export function unitLedger(unit: string, home: string): ServiceLedger | null {
  const vars = new Map<string, string>();
  let named = false;
  for (const [, key, value] of unit.matchAll(/^[ \t]*([A-Za-z]+)[ \t]*=(.*)$/gm)) {
    if (key === "EnvironmentFile") return null;
    if (key !== "Environment") continue;
    const words = unitWords(value!.trim());
    if (words === null) return null;
    if (words.length === 0) vars.clear();
    for (const word of words) {
      const eq = word.indexOf("=");
      if (eq <= 0) continue;
      // %h and %% are all agentd's units use; any other specifier is systemd's to expand.
      if (/%[^h%]/.test(word.replaceAll("%%", ""))) return null;
      const text = word.slice(eq + 1).replace(/%([h%])/g, (_, spec) => (spec === "h" ? home : "%"));
      vars.set(word.slice(0, eq), text);
      named ||= LEDGER_NAME.test(word.slice(0, eq));
    }
  }
  return !named && LEDGER_NAME.test(unit) ? null : ledgerOf(vars);
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

/**
 * The program a systemd unit runs, with %h as the home folder: its first ExecStart after the last
 * empty `ExecStart=`, which clears the ones before (as a drop-in does to override the unit's).
 */
export function unitProgram(unit: string, home: string): string | null {
  let line: string | undefined;
  for (const [, value] of unit.matchAll(/^[ \t]*ExecStart[ \t]*=(.*)$/gm)) {
    const command = value!.trim();
    if (command === "") line = undefined;
    else line ??= command.replace(/^[-@:+!]+\s*/, "");
  }
  if (line === undefined) return null;
  const quoted = /^"([^"]+)"/.exec(line)?.[1];
  const program = quoted ?? line.split(/\s+/)[0] ?? "";
  return program === "" ? null : program.replaceAll("%h", home);
}

/** `schtasks /Query /XML` output as text: UTF-16 when it starts with a byte order mark or a NUL. */
export function schtasksText(bytes: Uint8Array): string {
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length > 1 && bytes[1] === 0);
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
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

/** agentd's pre-rename units (install.go legacyUnits): install enables nothing while one is. */
const LEGACY_UNITS = [
  "agentops-daily.service",
  "agentops-daily.timer",
  "agentops-notify.service",
  "agentops-watchdog.service",
  "agentops-watchdog.timer",
  "agentops-dash.service",
  "agentops-rt-ports.service",
];

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
  const exec = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) => {
    // schtasks may answer in UTF-16, which can't be read back from the runner's UTF-8 text.
    const chunks: Uint8Array[] = [];
    const onStdoutChunk = (chunk: Uint8Array) => void chunks.push(chunk);
    return run({
      command,
      args,
      env,
      timeout: "2 minutes",
      maxOutputBytes: 256 * 1024,
      onStdoutChunk,
    }).pipe(
      Effect.map((output) => ({
        ok: output.code === 0,
        text:
          (chunks.length > 0 ? schtasksText(Buffer.concat(chunks)) : output.stdout) + output.stderr,
      })),
      Effect.orElseSucceed(() => ({ ok: false, text: "" })),
    );
  };

  const noLedger: ServiceLedger = { root: null, db: null };
  const unitDir = path.join(home, ".config", "systemd", "user");
  const names = (dir: string) => fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  // A unit with its drop-ins, which systemd reads after it.
  const unitText = Effect.fn("AgentdServices.unit")(function* (file: string) {
    const unit = yield* read(path.join(unitDir, file));
    if (unit._tag === "None") return null;
    const dropIns = (yield* names(path.join(unitDir, `${file}.d`)))
      .filter((name) => name.endsWith(".conf"))
      .toSorted();
    let text = unit.value;
    let overrides = false;
    for (const name of dropIns) {
      const conf = yield* read(path.join(unitDir, `${file}.d`, name));
      // A drop-in it can't read may set anything.
      if (conf._tag === "None") return { text, readable: false, overrides };
      text += `\n${conf.value}`;
      overrides ||= /^[ \t]*ExecStart[ \t]*=/m.test(conf.value);
    }
    return { text, readable: true, overrides };
  });
  const service = Effect.fn("AgentdServices.program")(function* (name: ServiceName) {
    if (platform === "darwin") {
      const plist = yield* read(
        path.join(home, "Library", "LaunchAgents", `com.libraos.agentd.${name}.plist`),
      );
      if (plist._tag === "None") return null;
      const program = plistProgram(plist.value);
      return program === null
        ? null
        : { program, ledger: plistLedger(plist.value), overridden: false };
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
        // An env file it can't read names a ledger it can't tell; no file names none.
        const ledger =
          env === null ? noLedger : env._tag === "Some" ? envFileLedger(env.value) : null;
        return { program, ledger, overridden: false };
      }
      return null;
    }
    const unit = yield* unitText(`agentd-${name}.service`);
    if (unit === null) return null;
    const program = unitProgram(unit.text, home);
    // null: a ledger this app can't tell, which a move could change.
    const ledger = unit.readable ? unitLedger(unit.text, home) : null;
    // A drop-in's ExecStart outlives the unit install rewrites.
    return program === null ? null : { program, ledger, overridden: unit.overrides };
  });

  const stale: ServiceName[] = [];
  // Services on another working agentd, the user's own: never moved.
  const kept: ServiceName[] = [];
  const ledgers = new Map<ServiceName, ServiceLedger | null>();
  const agentd = target ?? bundled;
  let watchdogOnTarget = false;
  let overridden = false;
  for (const name of SERVICES) {
    const found = yield* service(name);
    if (found === null) continue;
    ledgers.set(name, found.ledger);
    const exists = yield* fs.exists(found.program).pipe(Effect.orElseSucceed(() => false));
    if (isStaleProgram(found.program, exists, agentd)) {
      stale.push(name);
      overridden ||= found.overridden;
    } else if (found.program !== agentd) kept.push(name);
    else if (name === "watchdog") watchdogOnTarget = true;
  }
  if (stale.length === 0 && platform === "linux" && watchdogOnTarget) {
    // A repair that stopped at agentd's legacy-unit step left the new unit written but its timer
    // off: still reported, with that step, until the timer is on.
    const enabled = new Set<string>();
    for (const wants of (yield* names(unitDir)).filter((name) => name.endsWith(".wants")))
      for (const name of yield* names(path.join(unitDir, wants))) enabled.add(name);
    const legacy: string[] = [];
    for (const unit of LEGACY_UNITS)
      if (
        enabled.has(unit) &&
        (yield* fs.exists(path.join(unitDir, unit)).pipe(Effect.orElseSucceed(() => false)))
      )
        legacy.push(unit);
    if (legacy.length > 0 && !enabled.has("agentd-watchdog.timer"))
      return {
        services: ["watchdog"],
        ok: false,
        command: `systemctl --user disable --now ${legacy.join(" ")}`,
      } satisfies AgentdServicesRepair;
  }
  if (stale.length === 0) return null;
  if (target === null)
    return { services: stale, ok: false, reason: "transient" } satisfies AgentdServicesRepair;
  // install rewrites the unit, never a drop-in that sets the program it runs.
  if (overridden)
    return { services: stale, ok: false, reason: "override" } satisfies AgentdServicesRepair;
  const ledgerEnv = (name: ServiceName) => installEnv(ledgers.get(name) ?? noLedger);
  const sameLedger = (a: ServiceLedger | null, b: ServiceLedger | null) =>
    a?.root === b?.root && a?.db === b?.db;

  let ok = true;
  let command: string | null = null;
  let reason: "ledger" | null = null;
  if (platform === "darwin" || platform === "win32") {
    // install moves both services, so it would also move the one kept on the user's agentd.
    if (kept.length > 0) return { services: stale, ok: false, kept } satisfies AgentdServicesRepair;
    // A task whose env file can't be read: its ledger is unknown, and install would pick one.
    if ([...ledgers.values()].includes(null))
      return { services: stale, ok: false, reason: "unread" } satisfies AgentdServicesRepair;
    const watchdog = ledgers.get("watchdog") ?? null;
    const dash = ledgers.get("dash") ?? null;
    // install rewrites both services with one ledger. Restoring the dash's with `dash install`
    // after it would leave it on the watchdog's if that second run failed or the app quit first,
    // and then nothing would show it had another: services on two ledgers are the user's to move.
    if (ledgers.has("watchdog") && ledgers.has("dash") && !sameLedger(watchdog, dash))
      return { services: stale, ok: false, reason: "ledgers" } satisfies AgentdServicesRepair;
    ok = (yield* exec(target, ["install"], installEnv(watchdog ?? dash ?? noLedger))).ok;
  } else {
    // agentd's Linux units name only PATH, so install would move a watchdog off a ledger it names.
    const watchdogLedger = ledgers.get("watchdog");
    const ownLedger =
      watchdogLedger === null ||
      (watchdogLedger !== undefined &&
        (watchdogLedger.root !== null || watchdogLedger.db !== null));
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
    // dash install keeps the ledger it is run with, unless the unit's can't be told.
    if (stale.includes("dash") && ledgers.get("dash") === null) {
      ok = false;
      reason = "ledger";
    } else if (stale.includes("dash"))
      ok = (yield* exec(target, ["dash", "install"], ledgerEnv("dash"))).ok && ok;
  }
  return {
    services: stale,
    ok,
    ...(command === null ? {} : { command }),
    ...(reason === null ? {} : { reason }),
  } satisfies AgentdServicesRepair;
});
