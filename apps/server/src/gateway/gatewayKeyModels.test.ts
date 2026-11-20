import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import { askGatewayModels, makeGatewayKeyModels } from "./gatewayKeyModels.ts";

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

    // An outage keeps what the key allowed, never the agent's whole catalog.
    answer = Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), [{ slug: "gpt-6-astra" }]);
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: "lk_other_key_9876543210" }),
      [],
    );
    // A Gateway agent's stored list stands for a key the Gateway has not answered for yet.
    assert.deepStrictEqual(
      yield* keyModels({
        endpoint: "https://api.libraos.com",
        key: "lk_other_key_9876543210",
        known: [{ slug: "gpt-6-luna" }],
      }),
      [{ slug: "gpt-6-luna" }],
    );

    answer = Response.json({ error: { message: "This API key is not valid." } }, { status: 401 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), []);
    answer = Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), []);

    // The agent sends no key, so the Gateway serves it nothing.
    const asked = requests.length;
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: undefined }),
      [],
    );
    assert.strictEqual(requests.length, asked);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect("a Gateway that stalls while sending its list times out", () => {
  // Headers arrive, the body never ends.
  const http = HttpClient.make((request) =>
    Effect.sync(() =>
      HttpClientResponse.fromWeb(
        request,
        new Response(new ReadableStream({ start: () => {} }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const fiber = yield* askGatewayModels(KEY).pipe(Effect.forkChild);
    yield* TestClock.adjust("16 seconds");
    const answer = yield* Fiber.join(fiber);
    assert.strictEqual(answer.kind, "unavailable");
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});
