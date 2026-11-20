import {
  type CustomModelSetting,
  LIBRAOS_GATEWAY_ORIGIN,
  type LibraosGatewayModel,
} from "@t3tools/contracts";
import type { EndpointKeyModels } from "@t3tools/provider-core/server/snapshotProbe";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  GATEWAY_KEY_SECRET,
  gatewayAgentModels,
  gatewayRefusal,
  isKeyRefusal,
  parseGatewayModels,
} from "./gatewaySetup.ts";

const CHECK_TIMEOUT = Duration.seconds(15);

export type GatewayModelsAnswer =
  | { readonly kind: "models"; readonly models: ReadonlyArray<LibraosGatewayModel> }
  /** 401/403: the key is revoked, deleted or may not list models. */
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

const UNREACHABLE: GatewayModelsAnswer = {
  kind: "unavailable",
  message: "Couldn't reach LibraOS Gateway at api.libraos.com. Check your connection.",
};

/** Asks the Gateway which models `key` allows. Never fails: an unreachable Gateway is an answer. */
export const askGatewayModels = Effect.fn("LibraosGateway.askModels")(function* (key: string) {
  const http = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${LIBRAOS_GATEWAY_ORIGIN}/v1/models`).pipe(
    HttpClientRequest.acceptJson,
  );
  const ask = Effect.gen(function* () {
    const response = yield* http.execute(HttpClientRequest.bearerToken(request, key)).pipe(
      // A redirect could carry the key to another origin.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.option,
    );
    if (response._tag === "None") return UNREACHABLE;
    const body = yield* response.value.json.pipe(Effect.orElseSucceed((): unknown => undefined));
    const status = response.value.status;
    if (status < 200 || status >= 300) {
      const message = gatewayRefusal(status, body);
      return (
        isKeyRefusal(status) ? { kind: "refused", message } : { kind: "unavailable", message }
      ) satisfies GatewayModelsAnswer;
    }
    const models = parseGatewayModels(body);
    return (
      models === null
        ? {
            kind: "unavailable",
            message: "LibraOS Gateway answered with an unreadable model list.",
          }
        : { kind: "models", models }
    ) satisfies GatewayModelsAnswer;
  });
  // The deadline covers the body too: a Gateway that stalls mid-answer must not hold a refresh.
  return yield* ask.pipe(
    Effect.timeoutOption(CHECK_TIMEOUT),
    Effect.map(Option.getOrElse(() => UNREACHABLE)),
  );
});

/**
 * Every model the key an agent sends to the Gateway allows (`family`'s own without the prefix, the
 * rest by full id); another endpoint is not asked. Down Gateway: the key's last answer (a refusal is empty),
 * else `known` only for the connected key it was stored from, else none.
 */
export const makeGatewayKeyModels = Effect.fn("LibraosGateway.makeGatewayKeyModels")(function* (
  family?: "anthropic" | "openai",
) {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const connectedKey = Option.match(secrets, {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (store) =>
      store.get(GATEWAY_KEY_SECRET).pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes).trim())),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
  });
  // In memory only, beside the environment the key was read from; never written or logged.
  const lastAllowed = new Map<string, ReadonlyArray<CustomModelSetting>>();
  const keyModels: EndpointKeyModels = ({ endpoint, key, known }) => {
    if (endpoint !== LIBRAOS_GATEWAY_ORIGIN) return Effect.undefined;
    if (!key) return Effect.succeed([]);
    return askGatewayModels(key).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.flatMap((answer): Effect.Effect<ReadonlyArray<CustomModelSetting>> => {
        if (answer.kind === "models") {
          const models = family
            ? gatewayAgentModels(answer.models, family)
            : answer.models.map((model) => ({
                slug: model.id,
                ...(model.name ? { name: model.name } : {}),
              }));
          lastAllowed.set(key, models);
          return Effect.succeed(models);
        }
        if (answer.kind === "refused") {
          lastAllowed.set(key, []);
          return Effect.succeed([]);
        }
        const last = lastAllowed.get(key);
        if (last !== undefined || known === undefined) return Effect.succeed(last ?? []);
        return connectedKey.pipe(
          Effect.map((connected) =>
            Option.isSome(connected) && connected.value === key ? known : [],
          ),
        );
      }),
    );
  };
  return keyModels;
});

/**
 * Keeps the list `keyModels` last gave this agent, so its turns read an id the way its picker
 * showed it even when the agent's own settings list no models (a hand-configured endpoint).
 */
export const rememberServedModels = Effect.fn("LibraosGateway.rememberServedModels")(function* (
  keyModels: EndpointKeyModels,
) {
  const served = yield* Ref.make<ReadonlyArray<CustomModelSetting>>([]);
  const remembering: EndpointKeyModels = (input) =>
    keyModels(input).pipe(Effect.tap((models) => Ref.set(served, models ?? [])));
  return { keyModels: remembering, served: Ref.get(served) };
});
