import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import { AgentdBridge } from "../agentd/AgentdBridge.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { codexGatewayLaunchArgs, GATEWAY_INSTANCE_IDS } from "./gatewaySetup.ts";
import * as LibraosGateway from "./LibraosGateway.ts";

const GOOD_KEY = "lk_good_key_0123456789";
const GATEWAY_INSTANCES = ["libraosClaude", "libraosCodex", "libraosOpencode"];

function setup() {
  const served: Array<{ readonly id: string }> = [
    { id: "anthropic/claude-opus-5-5" },
    { id: "openai/gpt-5.5" },
  ];
  const secrets = new Map<string, Uint8Array>();
  const runs: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        runs.push({ command: input.command, args: input.args });
        const help = input.args.includes("--help");
        return {
          stdout: help ? "usage: agentd init [--no-services] [--model-key FILE]" : "set up",
          stderr: "",
          code: 0,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } as ProcessRunner.ProcessRunOutput;
      }),
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        request.headers.authorization === `Bearer ${GOOD_KEY}`
          ? Response.json({ data: served })
          : Response.json(
              { error: { message: "This API key is not valid.", type: "invalid_api_key" } },
              { status: 401 },
            ),
      ),
    ),
  );
  const layer = Layer.effect(LibraosGateway.LibraosGateway, LibraosGateway.make()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        // The key file's mode 600 is the POSIX path; Windows uses an ACL instead.
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
        Layer.succeed(ProcessRunner.ProcessRunner, runner),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.mock(AgentdBridge)({ binary: Effect.succeed("agentd") }),
        ServerSettingsService.layerTest(),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-gateway-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { served, secrets, runs, layer };
}

it.effect("a refused key shows the Gateway's message and keeps nothing", () => {
  const { secrets, runs, layer } = setup();
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const exit = yield* Effect.exit(gateway.connect("lk_revoked_key_0123456789"));
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit)) {
      assert.include(String(exit.cause), "This API key is not valid.");
    }
    assert.strictEqual(secrets.size, 0);
    assert.strictEqual(runs.length, 0);
    const settings = yield* ServerSettingsService;
    const instances = Object.keys((yield* settings.getSettings).providerInstances);
    for (const id of GATEWAY_INSTANCES) assert.notInclude(instances, id);
  }).pipe(Effect.provide(layer));
});

it.effect("connect keeps the key for agentd and the agents; disconnect removes it all", () => {
  const { secrets, runs, layer } = setup();
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const settings = yield* ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const keyFile = path.join(
      (yield* ServerConfig.ServerConfig).stateDir,
      "agentd",
      "libraos-gateway-key",
    );

    const connected = yield* gateway.connect(`  ${GOOD_KEY}\n`);
    assert.isTrue(connected.connected);
    assert.deepStrictEqual(
      connected.models.map((model) => model.id),
      ["anthropic/claude-opus-5-5", "openai/gpt-5.5"],
    );
    assert.deepStrictEqual(connected.agentd, { ok: true, output: "set up" });
    assert.strictEqual(new TextDecoder().decode(secrets.get("libraos-gateway-key")), GOOD_KEY);
    assert.strictEqual(yield* fs.readFileString(keyFile), `${GOOD_KEY}\n`);
    assert.strictEqual((yield* fs.stat(keyFile)).mode & 0o777, 0o600);
    assert.deepStrictEqual(runs.at(-1)?.args, ["init", "--model-key", keyFile, "--no-services"]);
    const instances = (yield* settings.getSettings).providerInstances;
    for (const id of GATEWAY_INSTANCES) assert.property(instances, id);

    const disconnected = yield* gateway.disconnect;
    assert.deepStrictEqual(disconnected, { connected: false, models: [], agentd: null });
    assert.strictEqual(secrets.size, 0);
    assert.isFalse(yield* fs.exists(keyFile));
    const remaining = Object.keys((yield* settings.getSettings).providerInstances);
    for (const id of GATEWAY_INSTANCES) assert.notInclude(remaining, id);
  }).pipe(Effect.provide(layer));
});

it.effect("a refresh gives the Gateway agents the key's models as they are now", () => {
  const { served, layer } = setup();
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const settings = yield* ServerSettingsService;
    yield* gateway.connect(GOOD_KEY);
    const claude = (yield* settings.getSettings).providerInstances[GATEWAY_INSTANCE_IDS.claude];
    assert.isDefined(claude);
    if (claude === undefined) return;
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: GATEWAY_INSTANCE_IDS.claude,
      instance: { ...claude, enabled: false },
    });

    // In Console the key loses its Claude model and gains a Codex one.
    served.splice(0, served.length, { id: "openai/gpt-5.5" }, { id: "openai/gpt-6-luna" });
    yield* gateway.refreshModels;

    const instances = (yield* settings.getSettings).providerInstances;
    assert.deepStrictEqual(instances[GATEWAY_INSTANCE_IDS.codex]?.config, {
      setupMode: "existing",
      launchArgs: codexGatewayLaunchArgs(),
      customModels: [{ slug: "gpt-5.5" }, { slug: "gpt-6-luna" }],
      onlyCustomModels: true,
    });
    assert.deepStrictEqual(instances[GATEWAY_INSTANCE_IDS.claude]?.config, {
      customModels: [],
      onlyCustomModels: true,
    });
    assert.strictEqual(instances[GATEWAY_INSTANCE_IDS.claude]?.enabled, false);
  }).pipe(Effect.provide(layer));
});
