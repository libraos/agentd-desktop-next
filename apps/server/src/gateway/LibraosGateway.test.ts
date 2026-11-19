import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { AgentdBridge } from "../agentd/AgentdBridge.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as LibraosGateway from "./LibraosGateway.ts";

const GOOD_KEY = "lk_good_key_0123456789";
const GATEWAY_INSTANCES = ["libraosClaude", "libraosCodex", "libraosOpencode"];

const SIGNED_IN_KEY = "lk_signed_in_key_0123456789";
const SESSION_TOKEN = "session-token-not-to-keep";

interface CloudRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** What Cloud answers each /v1/device/token poll, in turn; the last one repeats. */
type TokenScript = Array<{ readonly status: number; readonly body: unknown }>;

const pending = { status: 400, body: { error: "authorization_pending" } };
const granted = {
  status: 200,
  body: {
    access_token: SESSION_TOKEN,
    token_type: "Bearer",
    email: "jo@example.com",
    workspace: "Acme",
  },
};

function setup(options: { tokenScript?: TokenScript; createdKey?: string } = {}) {
  const tokenScript = options.tokenScript ?? [granted];
  const cloud: CloudRequest[] = [];
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
  const cloudAnswer = (url: URL, method: string) => {
    if (url.pathname === "/v1/device/code") {
      return Response.json({
        device_code: "dev-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://app.libraos.com/device",
        verification_uri_complete: "https://app.libraos.com/device?user_code=ABCD-EFGH",
        expires_in: 60,
        interval: 5,
      });
    }
    if (url.pathname === "/v1/device/token") {
      const next = tokenScript.length > 1 ? tokenScript.shift()! : tokenScript[0]!;
      return Response.json(next.body, { status: next.status });
    }
    if (url.pathname === "/v1/gateway-keys" && method === "POST") {
      return Response.json(
        { id: "key_1", key: options.createdKey ?? SIGNED_IN_KEY, hint: "lk_…6789" },
        { status: 201 },
      );
    }
    if (url.pathname === "/v1/gateway-keys/key_1" && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      if (url.origin === "https://app.libraos.com") {
        const body = request.body;
        cloud.push({
          method: request.method,
          url: url.pathname,
          authorization: request.headers.authorization,
          body:
            "body" in body && body.body instanceof Uint8Array
              ? new TextDecoder().decode(body.body)
              : "",
        });
        return HttpClientResponse.fromWeb(request, cloudAnswer(url, request.method));
      }
      const key = request.headers.authorization?.replace("Bearer ", "");
      return HttpClientResponse.fromWeb(
        request,
        key === GOOD_KEY || key === SIGNED_IN_KEY
          ? Response.json({ data: [{ id: "anthropic/claude-opus-5-5" }, { id: "openai/gpt-5.5" }] })
          : Response.json(
              { error: { message: "This API key is not valid.", type: "invalid_api_key" } },
              { status: 401 },
            ),
      );
    }),
  );
  const layer = Layer.effect(LibraosGateway.LibraosGateway, LibraosGateway.make()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        // The key file's mode 600 is the POSIX path; Windows uses an ACL instead.
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Hostname, "testhost"),
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
  return { secrets, runs, cloud, layer };
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
    assert.deepStrictEqual(disconnected, {
      connected: false,
      models: [],
      agentd: null,
      account: null,
      signIn: null,
      notice: null,
    });
    assert.strictEqual(secrets.size, 0);
    assert.isFalse(yield* fs.exists(keyFile));
    const remaining = Object.keys((yield* settings.getSettings).providerInstances);
    for (const id of GATEWAY_INSTANCES) assert.notInclude(remaining, id);
  }).pipe(Effect.provide(layer));
});

const failureText = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "succeeded";

it.effect("sign-in makes a key, connects it, keeps no token; disconnect revokes it", () => {
  const slowDown = { status: 400, body: { error: "slow_down" } };
  const { secrets, cloud, layer } = setup({ tokenScript: [pending, slowDown, granted] });
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    const signIn = yield* gateway.signInStart("connect");
    assert.strictEqual(signIn.userCode, "ABCD-EFGH");
    assert.strictEqual((yield* gateway.status).signIn?.userCode, "ABCD-EFGH");
    const wait = yield* Effect.forkChild(gateway.signInWait);
    // 5 s: pending; 10 s: slow_down; then the interval is 10 s, so nothing at 15 s.
    yield* TestClock.adjust("10 seconds");
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual(cloud.filter((r) => r.url === "/v1/device/token").length, 2);
    yield* TestClock.adjust("5 seconds");
    const connected = yield* Fiber.join(wait);

    assert.isTrue(connected.connected);
    assert.deepStrictEqual(connected.account, { email: "jo@example.com", workspace: "Acme" });
    assert.isNull(connected.signIn);
    const create = cloud.find((r) => r.url === "/v1/gateway-keys");
    assert.strictEqual(create?.authorization, `Bearer ${SESSION_TOKEN}`);
    assert.include(create?.body ?? "", "AgentD Desktop on testhost");
    assert.strictEqual(new TextDecoder().decode(secrets.get("libraos-gateway-key")), SIGNED_IN_KEY);
    for (const value of secrets.values()) {
      assert.notInclude(new TextDecoder().decode(value), SESSION_TOKEN);
    }

    yield* gateway.signInStart("revoke");
    const revoking = yield* Effect.forkChild(gateway.signInWait);
    yield* TestClock.adjust("5 seconds");
    const disconnected = yield* Fiber.join(revoking);
    const revoke = cloud.find((r) => r.method === "DELETE");
    assert.strictEqual(revoke?.url, "/v1/gateway-keys/key_1");
    assert.strictEqual(revoke?.authorization, `Bearer ${SESSION_TOKEN}`);
    assert.isFalse(disconnected.connected);
    assert.strictEqual(disconnected.notice, "The key was revoked in LibraOS.");
    assert.strictEqual(secrets.size, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("denial, expiry and Cancel each end the wait and connect nothing", () =>
  Effect.gen(function* () {
    const cases = [
      {
        script: [pending, { status: 400, body: { error: "access_denied" } }],
        end: (_: LibraosGateway.LibraosGateway["Service"]) => TestClock.adjust("10 seconds"),
        says: "denied",
      },
      {
        script: [pending],
        end: (_: LibraosGateway.LibraosGateway["Service"]) => TestClock.adjust("65 seconds"),
        says: "expired",
      },
      {
        script: [pending],
        end: (gateway: LibraosGateway.LibraosGateway["Service"]) => gateway.signInCancel,
        says: "cancelled",
      },
    ];
    for (const { script, end, says } of cases) {
      const { secrets, cloud, layer } = setup({ tokenScript: script });
      yield* Effect.gen(function* () {
        const gateway = yield* LibraosGateway.LibraosGateway;
        yield* gateway.signInStart("connect");
        const wait = yield* Effect.forkChild(gateway.signInWait);
        yield* TestClock.adjust("5 seconds");
        yield* end(gateway);
        const exit = yield* Effect.exit(Fiber.join(wait));
        assert.include(failureText(exit), says);
        const status = yield* gateway.status;
        assert.isFalse(status.connected);
        assert.isNull(status.signIn);
        assert.strictEqual(secrets.size, 0);
        assert.isUndefined(cloud.find((r) => r.url.startsWith("/v1/gateway-keys")));
      }).pipe(Effect.provide(layer));
    }
  }),
);

it.effect("a key the Gateway refuses after sign-in is revoked again in LibraOS", () => {
  const { secrets, cloud, layer } = setup({ createdKey: "lk_refused_key_0123456789" });
  return Effect.gen(function* () {
    const gateway = yield* LibraosGateway.LibraosGateway;
    yield* gateway.signInStart("connect");
    const wait = yield* Effect.forkChild(gateway.signInWait);
    yield* TestClock.adjust("5 seconds");
    const exit = yield* Effect.exit(Fiber.join(wait));
    assert.include(failureText(exit), "This API key is not valid.");
    assert.strictEqual(cloud.find((r) => r.method === "DELETE")?.url, "/v1/gateway-keys/key_1");
    assert.strictEqual(secrets.size, 0);
  }).pipe(Effect.provide(layer));
});
