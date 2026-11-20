// @effect-diagnostics-next-line nodeBuiltinImport:off -- O_NONBLOCK, which Effect's open can't pass.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- fstat, fchmod and read on one descriptor.
import * as NodeFSP from "node:fs/promises";

import {
  AgentdCommandError,
  type AgentdCloudKeyFileCheck,
  type AgentdCloudKeyFileInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

// Which provider's key a Cloud Workers key file holds, read from its first bytes only, before the
// key reaches a cloud worker that would refuse it minutes later. Nothing read is logged or sent:
// only the provider's name leaves this module. agentd-core#978 adds this check to agentd itself;
// once the bundled agentd answers it, its answer replaces this one.

// A UTF-8 byte order mark and "sk-ant-": enough to tell the two prefixes apart, and no more.
const PREFIX_BYTES = 10;
const OPEN_TO_OTHERS = 0o077;
const PRIVATE_MODE = 0o600;
// Non-blocking, so a named pipe at the path cannot hold the open waiting for a writer.
const OPEN_FLAGS = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0);

export function keyFileProvider(prefix: string): AgentdCloudKeyFileCheck["provider"] {
  const text = prefix.replace(/^﻿/, "");
  if (text.startsWith("sk-ant-")) return "anthropic";
  return text.startsWith("sk-") ? "openai" : null;
}

const unreadable: AgentdCloudKeyFileCheck = {
  provider: null,
  readable: false,
  openToOthers: false,
};

// A failed call on the descriptor is "couldn't", which each caller turns into its own answer.
const orNull = <A>(attempt: () => Promise<A>) =>
  Effect.tryPromise({ try: attempt, catch: () => "failed" as const }).pipe(
    Effect.orElseSucceed(() => null),
  );

const notChanged = (path: string, why: string) =>
  new AgentdCommandError({
    message: `Couldn’t change the permissions of ${path}: ${why}`,
    notSetUp: false,
  });

export const makeCloudKeyFile = (deps: {
  readonly isAbsolute: (path: string) => boolean;
  readonly platform: string;
  /** The server's own user; a file of anyone else's is never changed. */
  readonly uid: number | undefined;
}) => {
  const { isAbsolute, platform, uid } = deps;
  const checkModes = platform !== "win32";

  // Everything happens on one descriptor: what is checked is what is read and what is changed.
  const inspect = (path: string, makePrivate: boolean) =>
    Effect.acquireUseRelease(
      orNull(() => NodeFSP.open(path, OPEN_FLAGS)),
      (file) =>
        Effect.gen(function* () {
          if (file === null) return unreadable;
          const info = yield* orNull(() => file.stat());
          if (info === null || !info.isFile()) {
            if (makePrivate) return yield* notChanged(path, "it is not a regular file.");
            return unreadable;
          }
          let mode = info.mode;
          if (makePrivate && checkModes && (mode & OPEN_TO_OTHERS) !== 0) {
            if (uid !== undefined && info.uid !== uid)
              return yield* notChanged(path, "it belongs to another user.");
            yield* Effect.tryPromise({
              try: () => file.chmod(PRIVATE_MODE),
              catch: () => notChanged(path, "run chmod 600 on it in a terminal, then try again."),
            });
            mode = PRIVATE_MODE;
          }
          const bytes = new Uint8Array(PREFIX_BYTES);
          const read = yield* orNull(() => file.read(bytes, 0, PREFIX_BYTES, 0));
          if (read === null) return unreadable;
          const prefix = new TextDecoder().decode(bytes.subarray(0, read.bytesRead));
          return {
            provider: keyFileProvider(prefix),
            readable: true,
            openToOthers: checkModes && (mode & OPEN_TO_OTHERS) !== 0,
          } satisfies AgentdCloudKeyFileCheck;
        }),
      (file) => (file === null ? Effect.void : orNull(() => file.close())),
    );

  return Effect.fn("AgentdCloud.keyFile")(function* (
    { path }: AgentdCloudKeyFileInput,
    makePrivate: boolean,
  ) {
    if (!isAbsolute(path))
      return yield* new AgentdCommandError({
        message: "Enter the absolute path of the key file on the selected machine.",
        notSetUp: false,
      });
    return yield* inspect(path, makePrivate);
  });
};
