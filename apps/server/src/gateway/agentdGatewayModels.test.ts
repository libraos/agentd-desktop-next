import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  AgentdGatewayModels,
  type AgentdGatewayModelsJson,
  agentdGatewayEndpointModels,
  decodeAgentdGatewayModels,
  makeEndpointModels,
} from "./agentdGatewayModels.ts";

const GATEWAY = "https://api.libraos.com";

const answer = (
  status: string,
  models: AgentdGatewayModelsJson["models"] = [],
  gateway: string | null = GATEWAY,
): AgentdGatewayModelsJson => ({ gateway, status, message: null, models });

it("lists the family's models agentd's Gateway key allows, for that Gateway only", () => {
  const key = answer("available", [
    { id: "openai/gpt-6-astra", name: "GPT-6-Astra" },
    { id: "openai/gpt-6-luna", name: null },
    { id: "anthropic/claude-opus-5-5", name: null },
  ]);
  assert.deepStrictEqual(agentdGatewayEndpointModels(key, GATEWAY, "openai"), [
    { slug: "gpt-6-astra", name: "GPT-6-Astra" },
    { slug: "gpt-6-luna" },
  ]);
  assert.deepStrictEqual(agentdGatewayEndpointModels(key, GATEWAY, "anthropic"), [
    { slug: "claude-opus-5-5" },
  ]);
  // agentd's key is for another gateway: it says nothing about this endpoint.
  assert.isUndefined(agentdGatewayEndpointModels(key, "https://proxy.example", "openai"));
  // A refused key allows none; agentd unable to ask leaves the catalog.
  assert.deepStrictEqual(agentdGatewayEndpointModels(answer("refused"), GATEWAY, "openai"), []);
  for (const status of ["unreachable", "not configured"]) {
    assert.isUndefined(agentdGatewayEndpointModels(answer(status), GATEWAY, "openai"));
  }
  assert.isUndefined(
    agentdGatewayEndpointModels(answer("not configured", [], null), GATEWAY, "openai"),
  );
});

it("reads agentd's JSON and nothing an older agentd prints", () => {
  assert.deepStrictEqual(
    decodeAgentdGatewayModels(
      JSON.stringify({
        gateway: GATEWAY,
        status: "available",
        message: null,
        models: [{ id: "openai/gpt-6-astra", name: null }],
      }),
    ),
    Option.some(answer("available", [{ id: "openai/gpt-6-astra", name: null }])),
  );
  assert.isTrue(Option.isNone(decodeAgentdGatewayModels("error: unknown command gateway")));
});

it.effect("asks agentd only when the server provides it", () =>
  Effect.gen(function* () {
    assert.isUndefined(yield* makeEndpointModels("openai"));

    let asked = 0;
    const endpointModels = yield* makeEndpointModels("openai").pipe(
      Effect.provideService(
        AgentdGatewayModels,
        Effect.sync(() => {
          asked += 1;
          return answer("available", [{ id: "openai/gpt-6-luna", name: null }]);
        }),
      ),
    );
    assert.deepStrictEqual(yield* endpointModels!(GATEWAY), [{ slug: "gpt-6-luna" }]);
    assert.strictEqual(asked, 1);

    // agentd without `gateway models`: the bridge answers null.
    const old = yield* makeEndpointModels("openai").pipe(
      Effect.provideService(AgentdGatewayModels, Effect.succeed(null)),
    );
    assert.isUndefined(yield* old!(GATEWAY));
  }),
);
