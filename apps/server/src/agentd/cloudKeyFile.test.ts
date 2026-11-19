import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { keyFileProvider, makeCloudKeyFile } from "./cloudKeyFile.ts";

describe("keyFileProvider", () => {
  it.each([
    ["sk-ant-api0", "anthropic"],
    ["﻿sk-ant-ap", "anthropic"],
    ["sk-proj-ab", "openai"],
    ["sk-abcdefg", "openai"],
    ["lcw_live_0", null],
    ["", null],
  ] as const)("%s", (prefix, provider) => {
    expect(keyFileProvider(prefix)).toBe(provider);
  });
});

describe("makeCloudKeyFile", () => {
  it.effect("tells the provider by the first bytes, and makes a shared file private", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const check = makeCloudKeyFile({ fs, isAbsolute: path.isAbsolute, platform: "linux" });
      const anthropic = path.join(dir, "openai.key");
      yield* fs.writeFileString(anthropic, "sk-ant-api03-secret\n");
      yield* fs.chmod(anthropic, 0o644);
      expect(yield* check({ path: anthropic }, false)).toEqual({
        provider: "anthropic",
        readable: true,
        openToOthers: true,
      });
      expect(yield* check({ path: anthropic }, true)).toEqual({
        provider: "anthropic",
        readable: true,
        openToOthers: false,
      });
      expect(((yield* fs.stat(anthropic)).mode & 0o777).toString(8)).toBe("600");
      expect(yield* check({ path: path.join(dir, "missing.key") }, false)).toEqual({
        provider: null,
        readable: false,
        openToOthers: false,
      });
      expect(yield* check({ path: dir }, false)).toMatchObject({ readable: false });
      // Windows has no mode for agentd to refuse, so nothing is reported or changed.
      const windows = makeCloudKeyFile({ fs, isAbsolute: path.isAbsolute, platform: "win32" });
      yield* fs.chmod(anthropic, 0o644);
      expect(yield* windows({ path: anthropic }, true)).toMatchObject({ openToOthers: false });
      expect(((yield* fs.stat(anthropic)).mode & 0o777).toString(8)).toBe("644");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
