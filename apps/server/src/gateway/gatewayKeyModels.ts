import {
  type CustomModelSetting,
  LIBRAOS_GATEWAY_ORIGIN,
  type LibraosGatewayModel,
} from "@t3tools/contracts";
import type { EndpointKeyModels } from "@t3tools/provider-core/server/snapshotProbe";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import {
  gatewayFamilyModels,
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
 * For an agent configured by hand to reach the Gateway: the models the key it sends allows, of
 * `family` with the family prefix dropped, or every model by its full id. Another endpoint leaves
 * the agent's catalog as it is. Without a key, the Gateway serves nothing; when it cannot answer,
 * the key's last list stands, or none if it never answered.
 */
export const makeGatewayKeyModels = Effect.fn("LibraosGateway.makeGatewayKeyModels")(function* (
  family?: "anthropic" | "openai",
) {
  const http = yield* HttpClient.HttpClient;
  // In memory only, beside the environment the key was read from; never written or logged.
  const lastAllowed = new Map<string, ReadonlyArray<CustomModelSetting>>();
  const keyModels: EndpointKeyModels = ({ endpoint, key }) => {
    if (endpoint !== LIBRAOS_GATEWAY_ORIGIN) return Effect.undefined;
    if (!key) return Effect.succeed([]);
    return askGatewayModels(key).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.map((answer) => {
        if (answer.kind === "models") {
          const models = family
            ? gatewayFamilyModels(answer.models, family)
            : answer.models.map((model) => ({
                slug: model.id,
                ...(model.name ? { name: model.name } : {}),
              }));
          lastAllowed.set(key, models);
          return models;
        }
        if (answer.kind === "refused") {
          lastAllowed.delete(key);
          return [];
        }
        return lastAllowed.get(key) ?? [];
      }),
    );
  };
  return keyModels;
});
