import {
  CustomGatewayError,
  type CustomGatewayAddInput,
  type CustomGatewayAddResult,
  type CustomGatewayList,
  type CustomGatewaySetting,
  type LibraosGatewayModel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { askModels } from "./gatewayKeyModels.ts";
import {
  customGatewayInstanceIds,
  customGatewayInstances,
  customGatewayKeySecret,
  customGatewayModels,
  newCustomGatewayId,
  trimGatewayUrl,
  withCustomGateway,
} from "./gatewaySetup.ts";

export class CustomGateway extends Context.Service<
  CustomGateway,
  {
    readonly list: Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /**
     * Asks the gateway for its models unless `models` are typed, then keeps the key and adds the
     * agents of its format. A model list it cannot read is `modelsProblem`, and nothing is kept.
     */
    readonly add: (
      input: CustomGatewayAddInput,
    ) => Effect.Effect<CustomGatewayAddResult, CustomGatewayError>;
    /** A blank name names the gateway after its URL. */
    readonly rename: (
      id: string,
      name: string,
    ) => Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /** Removes the gateway's agents and key; nothing else. */
    readonly remove: (id: string) => Effect.Effect<CustomGatewayList, CustomGatewayError>;
    /** Gives the agents the gateway's current list; one it cannot read leaves the last one. */
    readonly refreshModels: (id: string) => Effect.Effect<CustomGatewayList, CustomGatewayError>;
  }
>()("t3/gateway/CustomGateway") {}

const fail = (message: string) => new CustomGatewayError({ message });
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** The URL as typed without trailing slashes, if it is http(s). */
function readGatewayUrl(raw: string): string | null {
  const url = trimGatewayUrl(raw);
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

const baseOf = (url: string) => `${url.replace(/\/v1$/, "")}/v1`;

function typedModels(ids: ReadonlyArray<string>): ReadonlyArray<LibraosGatewayModel> {
  const unique = new Set(ids.map((id) => id.trim()).filter((id) => id !== ""));
  return Array.from(unique, (id) => ({ id }));
}

export const make = Effect.fn("CustomGateway.make")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* ServerSettingsService;
  const http = yield* HttpClient.HttpClient;
  const lock = yield* Semaphore.make(1);

  const storageFailure = (what: string) => (cause: unknown) =>
    Effect.logWarning(`Custom gateway: failed to ${what}`, { cause }).pipe(
      Effect.andThen(Effect.fail(fail(`Could not ${what} on this host.`))),
    );

  const readSettings = settings.getSettings.pipe(Effect.catch(storageFailure("read settings")));

  const readKey = (id: string) =>
    secrets
      .get(customGatewayKeySecret(id))
      .pipe(
        Effect.map(Option.map((bytes) => textDecoder.decode(bytes).trim())),
        Effect.map(Option.filter((key) => key !== "")),
        Effect.map(Option.getOrNull),
        Effect.catch(storageFailure("read the gateway's key")),
      );

  const ask = (gateway: CustomGatewaySetting, key: string | null) =>
    askModels({ base: baseOf(gateway.url), name: gateway.name, key }).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

  const list: CustomGateway["Service"]["list"] = Effect.gen(function* () {
    const current = yield* readSettings;
    const gateways = yield* Effect.forEach(current.customGateways, (gateway) =>
      readKey(gateway.id).pipe(
        Effect.map((key) => ({
          ...gateway,
          hasKey: key !== null,
          modelCount: customGatewayModels(current.providerInstances, gateway.id)?.length ?? 0,
        })),
      ),
    );
    return { gateways };
  }).pipe(Effect.withSpan("CustomGateway.list"));

  const find = Effect.fn("CustomGateway.find")(function* (id: string) {
    const gateway = (yield* readSettings).customGateways.find((entry) => entry.id === id);
    if (gateway === undefined) return yield* fail("That gateway is no longer here.");
    return gateway;
  });

  const add: CustomGateway["Service"]["add"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const url = readGatewayUrl(input.url);
          if (url === null) return yield* fail("Enter the gateway's http:// or https:// URL.");
          const key = input.key?.trim() || null;
          // Without one, Claude Code would send the person's own Claude login to this gateway.
          if (input.format === "anthropic" && key === null) {
            return yield* fail("An Anthropic-format gateway needs a key.");
          }
          const existing = (yield* readSettings).customGateways;
          let id = newCustomGatewayId();
          while (existing.some((entry) => entry.id === id)) id = newCustomGatewayId();
          const gateway: CustomGatewaySetting = {
            id,
            name: input.name?.trim() || url,
            url,
            format: input.format,
          };
          let models: ReadonlyArray<LibraosGatewayModel>;
          if (input.models !== undefined) {
            models = typedModels(input.models);
            if (models.length === 0) return yield* fail("Enter at least one model id.");
          } else {
            const answer = yield* ask(gateway, key);
            if (answer.kind !== "models") {
              return {
                kind: "modelsProblem",
                message: answer.message,
              } satisfies CustomGatewayAddResult;
            }
            if (answer.models.length === 0) {
              return {
                kind: "modelsProblem",
                message: `${gateway.name} lists no models.`,
              } satisfies CustomGatewayAddResult;
            }
            models = answer.models;
          }
          if (key !== null) {
            yield* secrets
              .set(customGatewayKeySecret(id), textEncoder.encode(key))
              .pipe(Effect.catch(storageFailure("store the gateway's key")));
          }
          const instances = customGatewayInstances({ ...gateway, key, models });
          yield* settings
            .updateProviderInstances((current) => ({
              ...current,
              ...Object.fromEntries(
                instances.map(({ instanceId, instance }) => [instanceId, instance]),
              ),
            }))
            .pipe(Effect.catch(storageFailure("add the gateway's agents")));
          yield* settings
            .updateSettings({ customGateways: [...existing, gateway] })
            .pipe(Effect.catch(storageFailure("save the gateway")));
          return {
            kind: "added",
            gateway: { ...gateway, hasKey: key !== null, modelCount: models.length },
          } satisfies CustomGatewayAddResult;
        }),
      )
      .pipe(Effect.withSpan("CustomGateway.add"));

  const rename: CustomGateway["Service"]["rename"] = (id, name) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const gateway = yield* find(id);
          const renamed = { ...gateway, name: name.trim() || gateway.url };
          yield* settings
            .updateProviderInstances((current) => withCustomGateway(current, renamed, null))
            .pipe(Effect.catch(storageFailure("rename the gateway's agents")));
          const stored = (yield* readSettings).customGateways;
          yield* settings
            .updateSettings({
              customGateways: stored.map((entry) => (entry.id === id ? renamed : entry)),
            })
            .pipe(Effect.catch(storageFailure("save the gateway")));
        }),
      )
      .pipe(Effect.andThen(list), Effect.withSpan("CustomGateway.rename"));

  const remove: CustomGateway["Service"]["remove"] = (id) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* readSettings;
          for (const instanceId of Object.values(customGatewayInstanceIds(id))) {
            if (!Object.hasOwn(current.providerInstances, instanceId)) continue;
            yield* settings
              .updateProviderInstance({ operation: "remove", instanceId })
              .pipe(Effect.catch(storageFailure("remove the gateway's agents")));
          }
          yield* secrets
            .remove(customGatewayKeySecret(id))
            .pipe(Effect.catch(storageFailure("remove the gateway's key")));
          const stored = (yield* readSettings).customGateways;
          yield* settings
            .updateSettings({ customGateways: stored.filter((entry) => entry.id !== id) })
            .pipe(Effect.catch(storageFailure("remove the gateway")));
        }),
      )
      .pipe(Effect.andThen(list), Effect.withSpan("CustomGateway.remove"));

  const refreshModels: CustomGateway["Service"]["refreshModels"] = (id) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const gateway = yield* find(id);
          const answer = yield* ask(gateway, yield* readKey(id));
          // Ids typed because the list was unreadable stay until it can be read.
          if (answer.kind !== "models") return yield* fail(answer.message);
          if (answer.models.length === 0) return yield* fail(`${gateway.name} lists no models.`);
          yield* settings
            .updateProviderInstances((current) =>
              withCustomGateway(current, gateway, answer.models),
            )
            .pipe(Effect.catch(storageFailure("update the gateway's agents")));
        }),
      )
      .pipe(Effect.andThen(list), Effect.withSpan("CustomGateway.refreshModels"));

  return CustomGateway.of({ list, add, rename, remove, refreshModels });
});

export const layer = Layer.effect(CustomGateway, make()).pipe(Layer.provide(FetchHttpClient.layer));
