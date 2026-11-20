import { LIBRAOS_GATEWAY_ORIGIN, type LibraosGatewayModel } from "@t3tools/contracts";
import type { EndpointKeyModels } from "@t3tools/provider-core/server/snapshotProbe";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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

/** Asks the Gateway which models `key` allows. Never fails: an unreachable Gateway is an answer. */
export const askGatewayModels = Effect.fn("LibraosGateway.askModels")(function* (key: string) {
  const http = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(`${LIBRAOS_GATEWAY_ORIGIN}/v1/models`).pipe(
    HttpClientRequest.acceptJson,
  );
  const response = yield* http.execute(HttpClientRequest.bearerToken(request, key)).pipe(
    // A redirect could carry the key to another origin.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.timeout(CHECK_TIMEOUT),
    Effect.option,
  );
  if (response._tag === "None") {
    return {
      kind: "unavailable",
      message: "Couldn't reach LibraOS Gateway at api.libraos.com. Check your connection.",
    } satisfies GatewayModelsAnswer;
  }
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
      ? { kind: "unavailable", message: "LibraOS Gateway answered with an unreadable model list." }
      : { kind: "models", models }
  ) satisfies GatewayModelsAnswer;
});

/**
 * For an agent configured by hand to reach the Gateway: the models of `family` the key it sends
 * allows. Another endpoint, or a Gateway that cannot answer, leaves the agent's catalog as it is.
 */
export const makeGatewayKeyModels = Effect.fn("LibraosGateway.makeGatewayKeyModels")(function* (
  family: "anthropic" | "openai",
) {
  const http = yield* HttpClient.HttpClient;
  const keyModels: EndpointKeyModels = ({ endpoint, key }) =>
    endpoint !== LIBRAOS_GATEWAY_ORIGIN
      ? Effect.undefined
      : askGatewayModels(key).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.map((answer) =>
            answer.kind === "models"
              ? gatewayFamilyModels(answer.models, family)
              : answer.kind === "refused"
                ? []
                : undefined,
          ),
        );
  return keyModels;
});
