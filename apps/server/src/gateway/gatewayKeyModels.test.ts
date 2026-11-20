import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import { askGatewayModels, makeGatewayKeyModels } from "./gatewayKeyModels.ts";
import { GATEWAY_KEY_SECRET } from "./gatewaySetup.ts";

const KEY = "lk_codex_key_0123456789";
const CONNECTED = "lk_connected_key_5555";

const secretStore = ServerSecretStore.ServerSecretStore.of({
  get: (name) =>
    Effect.succeed(
      name === GATEWAY_KEY_SECRET
        ? Option.some(new TextEncoder().encode(CONNECTED))
        : Option.none(),
    ),
  set: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
  create: () => Effect.die("unused"),
  getOrCreateRandom: () => Effect.die("unused"),
});

it.effect("an agent's own Gateway key decides its models", () => {
  const requests: Array<string | undefined> = [];
  let answer: Response = Response.json({
    data: [
      { id: "anthropic/claude-opus-5-5" },
      { id: "openai/gpt-6-astra" },
      { id: "gemini/gemini-2.5-pro" },
    ],
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

    const allowed = [
      { slug: "gpt-6-astra" },
      { slug: "anthropic/claude-opus-5-5" },
      { slug: "gemini/gemini-2.5-pro" },
    ];
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), allowed);
    assert.deepStrictEqual(requests, [`Bearer ${KEY}`]);

    // Another endpoint is not asked: the key goes only where the agent sends it anyway.
    assert.isUndefined(yield* ask("https://hub.example.com"));
    assert.strictEqual(requests.length, 1);

    // An outage keeps what the key allowed, never the agent's whole catalog.
    answer = Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), allowed);
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: "lk_other_key_9876543210" }),
      [],
    );
    // A Gateway agent's stored list is the connected key's: it stands while the Gateway has not
    // answered for that key, and never for another key.
    const known = [{ slug: "gpt-6-luna" }];
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: CONNECTED, known }),
      known,
    );
    assert.deepStrictEqual(
      yield* keyModels({
        endpoint: "https://api.libraos.com",
        key: "lk_other_key_9876543210",
        known,
      }),
      [],
    );

    // A refusal is an answer: a later outage keeps it, not the connected key's stored list.
    answer = Response.json({ error: { message: "This API key is not valid." } }, { status: 401 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), []);
    answer = Response.json({ error: { message: "Upstream unavailable." } }, { status: 503 });
    assert.deepStrictEqual(yield* ask("https://api.libraos.com"), []);
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: KEY, known }),
      [],
    );

    // The agent sends no key, so the Gateway serves it nothing.
    const asked = requests.length;
    assert.deepStrictEqual(
      yield* keyModels({ endpoint: "https://api.libraos.com", key: undefined }),
      [],
    );
    assert.strictEqual(requests.length, asked);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
  );
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
