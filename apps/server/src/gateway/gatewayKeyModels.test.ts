import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { makeGatewayKeyModels } from "./gatewayKeyModels.ts";

const KEY = "lk_codex_key_0123456789";

it.effect("an agent's own Gateway key decides its models", () => {
  const requests: Array<string | undefined> = [];
  let answer: Response = Response.json({
    data: [{ id: "openai/gpt-6-astra" }, { id: "anthropic/claude-opus-5-5" }],
  });
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.headers.authorization);
      return HttpClientResponse.fromWeb(request, answer);
    }),
  );
  return Effect.gen(function* () {
    const keyModels = yield* makeGatewayKeyModels("openai");
    const ask = (endpoint: string) => keyModels({ endpoint, key: KEY });

    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), [{ slug: "gpt-6-astra" }]);
    assert.deepStrictEqual(requests, [`Bearer ${KEY}`]);

    // Another endpoint is not asked: the key goes only where the agent sends it anyway.
    assert.isUndefined(yield* ask("https://hub.example.com"));
    assert.strictEqual(requests.length, 1);

    answer = Response.json({ error: { message: "This API key is not valid." } }, { status: 401 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), []);

    answer = Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 });
    assert.isUndefined(yield* ask("https://api.libraos.com"));
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});
