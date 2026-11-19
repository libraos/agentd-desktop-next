import {
  AgentdCommandError,
  type AgentdCloudKeyFileCheck,
  type AgentdCloudKeyFileInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

// Which provider's key a Cloud Workers key file holds, read from its first bytes only, before the
// key reaches a cloud worker that would refuse it minutes later. Nothing read is logged or sent:
// only the provider's name leaves this module. agentd-core#978 adds this check to agentd itself;
// once the bundled agentd answers it, its answer replaces this one.

// A UTF-8 byte order mark and "sk-ant-": enough to tell the two prefixes apart, and no more.
const PREFIX_BYTES = 10;
const OPEN_TO_OTHERS = 0o077;
const PRIVATE_MODE = 0o600;

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

export const makeCloudKeyFile = (deps: {
  readonly fs: FileSystem.FileSystem;
  readonly isAbsolute: (path: string) => boolean;
  readonly platform: string;
}) => {
  const { fs, isAbsolute, platform } = deps;
  const checkModes = platform !== "win32";

  const read = (path: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path, { flag: "r" });
        const info = yield* file.stat;
        if (info.type !== "File") return unreadable;
        const bytes = yield* file.readAlloc(PREFIX_BYTES, { position: 0n });
        const prefix = new TextDecoder().decode(Option.getOrElse(bytes, () => new Uint8Array()));
        return {
          provider: keyFileProvider(prefix),
          readable: true,
          openToOthers: checkModes && (info.mode & OPEN_TO_OTHERS) !== 0,
        } satisfies AgentdCloudKeyFileCheck;
      }),
    ).pipe(Effect.orElseSucceed(() => unreadable));

  return Effect.fn("AgentdCloud.keyFile")(function* (
    { path }: AgentdCloudKeyFileInput,
    makePrivate: boolean,
  ) {
    if (!isAbsolute(path))
      return yield* new AgentdCommandError({
        message: "Enter the absolute path of the key file on the selected machine.",
        notSetUp: false,
      });
    if (makePrivate && checkModes) {
      // Only the owner may chmod; a file of another user's stays as it is, and agentd refuses it.
      yield* fs.chmod(path, PRIVATE_MODE).pipe(
        Effect.mapError(
          () =>
            new AgentdCommandError({
              message: `Couldn’t change the permissions of ${path}. Run chmod 600 on it in a terminal, then try again.`,
              notSetUp: false,
            }),
        ),
      );
    }
    return yield* read(path);
  });
};
