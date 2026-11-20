import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CustomGateway from "./CustomGateway.ts";
import { gatewayProviderInstances } from "./gatewaySetup.ts";

const URL = "https://gw.example.com";

const instance = (settings: ServerSettings, id: string) =>
  settings.providerInstances[ProviderInstanceId.make(id)];

function setup(answer: () => Response) {
  const secrets = new Map<string, Uint8Array>();
  const asked: Array<{ readonly url: string; readonly authorization: string | undefined }> = [];
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      asked.push({ url: request.url, authorization: request.headers.authorization });
      return HttpClientResponse.fromWeb(request, answer());
    }),
  );
  // The user's own Codex agent and a connected LibraOS Gateway, which a custom gateway leaves be.
  const own = {
    codex: { driver: "codex", displayName: "My Codex", enabled: true, config: {} },
    ...Object.fromEntries(
      gatewayProviderInstances("lk_test_key_123456", [{ id: "openai/gpt-5.5" }]).map(
        ({ instanceId, instance }) => [instanceId, instance],
      ),
    ),
  };
  const layer = Layer.effect(CustomGateway.CustomGateway, CustomGateway.make()).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
        Layer.succeed(HttpClient.HttpClient, http),
        ServerSettingsService.layerTest({ providerInstances: own as never }),
      ),
    ),
  );
  return { secrets, asked, own, layer };
}

const served = () => Response.json({ data: [{ id: "m1" }] });

it.effect("add names the gateway after its url", () => {
  const { secrets, asked, layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const result = yield* gateways.add({
      url: `${URL}/`,
      format: "openai",
      key: " k1 ",
      name: " ",
    });
    assert.strictEqual(result.kind, "added");
    if (result.kind !== "added") return;
    assert.deepInclude(result.gateway, { name: URL, url: URL, hasKey: true, modelCount: 1 });
    assert.deepStrictEqual(asked, [{ url: `${URL}/v1/models`, authorization: "Bearer k1" }]);
    const id = result.gateway.id;
    assert.match(id, /^[a-z0-9]{8}$/);
    assert.strictEqual(new TextDecoder().decode(secrets.get(`custom-gateway-key-${id}`)), "k1");
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.deepStrictEqual(settings.customGateways, [
      { id, name: URL, url: URL, format: "openai" },
    ]);
    const instances = Object.keys(settings.providerInstances);
    assert.include(instances, `gw-${id}-codex`);
    assert.include(instances, `gw-${id}-opencode`);
    assert.notInclude(instances, `gw-${id}-claude`);
    assert.deepStrictEqual(yield* gateways.list, { gateways: [result.gateway] });
  }).pipe(Effect.provide(layer));
});

it.effect("a refused model list is redacted and nothing is saved", () => {
  const { secrets, own, layer } = setup(() =>
    Response.json(
      { error: { message: "bad key sk-abcdef123456 or my-secret-key-9" } },
      { status: 401 },
    ),
  );
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const result = yield* gateways.add({ url: URL, format: "openai", key: "my-secret-key-9" });
    assert.strictEqual(result.kind, "modelsProblem");
    if (result.kind !== "modelsProblem") return;
    assert.strictEqual(result.message, "bad key [redacted] or [redacted]");
    assert.strictEqual(secrets.size, 0);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.deepStrictEqual(settings.customGateways, []);
    assert.deepStrictEqual(Object.keys(settings.providerInstances), Object.keys(own));
  }).pipe(Effect.provide(layer));
});

it.effect("typed ids save without asking", () => {
  const { asked, layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const result = yield* gateways.add({
      url: URL,
      format: "anthropic",
      models: ["a", " b ", "", "a"],
    });
    assert.strictEqual(result.kind, "added");
    if (result.kind !== "added") return;
    assert.deepInclude(result.gateway, { hasKey: false, modelCount: 2 });
    assert.strictEqual(asked.length, 0);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.deepStrictEqual(instance(settings, `gw-${result.gateway.id}-claude`)?.config, {
      customModels: [{ slug: "a" }, { slug: "b" }],
      onlyCustomModels: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("rename to blank falls back to the url", () => {
  const { layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const added = yield* gateways.add({ url: URL, format: "openai", key: "k1", name: "Work" });
    if (added.kind !== "added") return assert.fail(added.message);
    const id = added.gateway.id;
    const listed = yield* gateways.rename(id, "  ");
    assert.strictEqual(listed.gateways[0]?.name, URL);
    const settings = yield* (yield* ServerSettingsService).getSettings;
    assert.strictEqual(settings.customGateways[0]?.name, URL);
    assert.strictEqual(instance(settings, `gw-${id}-codex`)?.displayName, `Codex · ${URL}`);
    assert.strictEqual(instance(settings, `gw-${id}-opencode`)?.displayName, `opencode · ${URL}`);
  }).pipe(Effect.provide(layer));
});

it.effect("remove leaves the other gateway and the user's instances", () => {
  const { secrets, own, layer } = setup(served);
  return Effect.gen(function* () {
    const gateways = yield* CustomGateway.CustomGateway;
    const first = yield* gateways.add({ url: URL, format: "openai", key: "k1" });
    const second = yield* gateways.add({
      url: "http://localhost:4000",
      format: "anthropic",
      key: "k2",
    });
    if (first.kind !== "added" || second.kind !== "added") return assert.fail("not added");
    const before = (yield* (yield* ServerSettingsService).getSettings).providerInstances;

    const listed = yield* gateways.remove(first.gateway.id);
    assert.deepStrictEqual(listed, { gateways: [second.gateway] });
    const after = (yield* (yield* ServerSettingsService).getSettings).providerInstances;
    const secondIds = [`gw-${second.gateway.id}-claude`, `gw-${second.gateway.id}-opencode`];
    assert.deepStrictEqual(
      Object.keys(after).toSorted(),
      [...Object.keys(own), ...secondIds].toSorted(),
    );
    for (const id of [...Object.keys(own), ...secondIds])
      assert.deepStrictEqual(
        after[ProviderInstanceId.make(id)],
        before[ProviderInstanceId.make(id)],
      );
    assert.deepStrictEqual([...secrets.keys()], [`custom-gateway-key-${second.gateway.id}`]);
  }).pipe(Effect.provide(layer));
});
