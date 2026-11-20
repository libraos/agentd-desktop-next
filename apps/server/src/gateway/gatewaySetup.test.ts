import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  codexGatewayLaunchArgs,
  customGatewayInstances,
  gatewayProviderInstances,
  GATEWAY_INSTANCE_IDS,
  gatewayRefusal,
  withCustomGateway,
  withGatewayModels,
} from "./gatewaySetup.ts";

const env = (
  entry: ReturnType<typeof customGatewayInstances>[number] | undefined,
  name: string,
): string | undefined => {
  const value = entry?.instance.environment?.find((variable) => variable.name === name)?.value;
  return typeof value === "string" ? value : undefined;
};
const opencodeConfigOf = (entries: ReturnType<typeof customGatewayInstances>) =>
  JSON.parse(
    env(
      entries.find(({ instanceId }) => instanceId.endsWith("-opencode")),
      "OPENCODE_CONFIG_CONTENT",
    )!,
  );
const customGateway = {
  id: "a1",
  name: "My GW",
  url: "https://gw.example.com/v1/",
  format: "openai" as const,
  key: "k1" as string | null,
  models: [{ id: "gpt-x" }],
};

describe("gatewaySetup", () => {
  it("points a Codex session at the Gateway with one -c per setting", () => {
    expect(tokenizeCliArgs(codexGatewayLaunchArgs())).toEqual([
      "-c",
      'model_provider="libraos"',
      "-c",
      'model_providers.libraos.name="LibraOS Gateway"',
      "-c",
      'model_providers.libraos.base_url="https://api.libraos.com/v1"',
      "-c",
      'model_providers.libraos.env_key="LIBRAOS_API_KEY"',
      "-c",
      'model_providers.libraos.wire_api="responses"',
    ]);
  });

  it("lists each agent's own model family and keeps the key out of plain values", () => {
    const [claude, codex, opencode] = gatewayProviderInstances("lk_test_key_123456", [
      { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "openai/gpt-5.5" },
      { id: "google/gemini-3" },
    ]);
    expect(claude?.instance.config).toEqual({
      customModels: [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }],
      onlyCustomModels: true,
    });
    expect(codex?.instance.config).toMatchObject({
      customModels: [{ slug: "gpt-5.5" }],
      onlyCustomModels: true,
    });
    const opencodeConfig = JSON.parse(
      String(
        opencode?.instance.environment?.find((v) => v.name === "OPENCODE_CONFIG_CONTENT")?.value,
      ),
    );
    expect(opencodeConfig.model).toBe("libraos/anthropic/claude-opus-5-5");
    expect(Object.keys(opencodeConfig.provider.libraos.models)).toEqual([
      "anthropic/claude-opus-5-5",
      "openai/gpt-5.5",
      "google/gemini-3",
    ]);
    for (const instance of [claude, codex, opencode]) {
      for (const variable of instance?.instance.environment ?? []) {
        if (variable.value === "lk_test_key_123456") expect(variable.sensitive).toBe(true);
        else expect(String(variable.value)).not.toContain("lk_test_key_123456");
      }
    }
  });

  it("changes only the model lists of the Gateway agents still present", () => {
    const key = "lk_test_key_123456";
    const before = [{ id: "anthropic/claude-opus-5-5" }, { id: "openai/gpt-5.5" }];
    const current = Object.fromEntries(
      gatewayProviderInstances(key, before)
        .filter(({ instanceId }) => instanceId !== "libraosOpencode")
        .map(({ instanceId, instance }) => [instanceId, instance]),
    );
    expect(withGatewayModels(current, before)).toBe(current);

    // The user's own launch option and proxy on the Codex agent.
    const codex = current[GATEWAY_INSTANCE_IDS.codex]!;
    const userArgs = `${codexGatewayLaunchArgs()} -c 'model_reasoning_summary="none"'`;
    const proxy = { name: "HTTPS_PROXY", value: "http://proxy:3128", sensitive: false };
    const edited = {
      ...current,
      [GATEWAY_INSTANCE_IDS.codex]: {
        ...codex,
        environment: [...(codex.environment ?? []), proxy],
        config: { ...(codex.config as object), launchArgs: userArgs },
      },
    };
    const next = withGatewayModels(edited, [{ id: "openai/gpt-6-luna" }]);
    expect(next[GATEWAY_INSTANCE_IDS.codex]?.config).toEqual({
      setupMode: "existing",
      launchArgs: userArgs,
      customModels: [{ slug: "gpt-6-luna" }],
      onlyCustomModels: true,
    });
    expect(next[GATEWAY_INSTANCE_IDS.codex]?.environment).toEqual(
      edited[GATEWAY_INSTANCE_IDS.codex]?.environment,
    );
    expect(next[GATEWAY_INSTANCE_IDS.claude]?.config).toEqual({
      customModels: [],
      onlyCustomModels: true,
    });
    expect(next[GATEWAY_INSTANCE_IDS.claude]?.environment).toBe(
      current[GATEWAY_INSTANCE_IDS.claude]?.environment,
    );
    expect(next).not.toHaveProperty(GATEWAY_INSTANCE_IDS.opencode);
  });

  it("gives opencode the new list without touching its other variables", () => {
    const key = "lk_test_key_123456";
    const opencode = gatewayProviderInstances(key, [{ id: "openai/gpt-5.5" }]).find(
      ({ instanceId }) => instanceId === "libraosOpencode",
    )!.instance;
    const proxy = { name: "HTTPS_PROXY", value: "http://proxy:3128", sensitive: false };
    // What the user set in the inline config: a preference, a model option and their default.
    const userConfig = JSON.parse(String(opencode.environment![1]?.value));
    userConfig.autoupdate = false;
    userConfig.model = "libraos/openai/gpt-6-luna";
    userConfig.provider.libraos.models = { "openai/gpt-6-luna": { limit: { context: 1000 } } };
    const next = withGatewayModels(
      {
        [GATEWAY_INSTANCE_IDS.opencode]: {
          ...opencode,
          environment: [
            opencode.environment![0]!,
            { ...opencode.environment![1]!, value: JSON.stringify(userConfig) },
            proxy,
          ],
          // Added while an older build still offered the control; the key does not serve it.
          config: { enabled: true, customModels: [{ slug: "libraos/openai/gpt-unserved" }] },
        },
      },
      [{ id: "openai/gpt-6-luna" }, { id: "openai/gpt-6-astra" }],
    );
    expect(next[GATEWAY_INSTANCE_IDS.opencode]?.config).toEqual({
      enabled: true,
      customModels: [],
    });
    const environment = next[GATEWAY_INSTANCE_IDS.opencode]?.environment ?? [];
    expect(environment.map((variable) => variable.name)).toEqual([
      "LIBRAOS_API_KEY",
      "OPENCODE_CONFIG_CONTENT",
      "HTTPS_PROXY",
    ]);
    const config = JSON.parse(String(environment[1]?.value));
    expect(config.provider.libraos.models).toEqual({
      "openai/gpt-6-luna": { limit: { context: 1000 } },
      "openai/gpt-6-astra": {},
    });
    expect(config.autoupdate).toBe(false);
    expect(config.model).toBe("libraos/openai/gpt-6-luna");
    expect(config.provider.libraos.options.baseURL).toBe("https://api.libraos.com/v1");
  });

  it("limits agents connected before #117 to the models they already list", () => {
    const { onlyCustomModels: _flag, ...config } = gatewayProviderInstances("lk_test_key_123456", [
      { id: "openai/gpt-5.5" },
    ]).find(({ instanceId }) => instanceId === "libraosCodex")!.instance.config as Record<
      string,
      unknown
    >;
    const codex = { driver: "codex", enabled: true, config } as never;
    const next = withGatewayModels({ [GATEWAY_INSTANCE_IDS.codex]: codex }, null);
    expect(next[GATEWAY_INSTANCE_IDS.codex]?.config).toEqual({
      ...config,
      onlyCustomModels: true,
    });
  });

  it("shows the Gateway's own message for a refused key", () => {
    expect(
      gatewayRefusal(401, {
        error: { message: "This API key is not valid.", type: "invalid_api_key" },
      }),
    ).toBe("This API key is not valid.");
    expect(gatewayRefusal(502, "<html>")).toBe("LibraOS Gateway answered HTTP 502.");
    const echoed = (message: string) => gatewayRefusal(401, { error: { message } });
    expect(echoed("Key lk_live_0123456789abcdef was revoked.\nat auth.ts:12")).toBe(
      "Key [redacted] was revoked.",
    );
    expect(echoed("Bad header: Bearer lk_x.y")).toBe("Bad header: [redacted]");
    expect(echoed("x".repeat(500))).toHaveLength(200);
  });

  it("openai format builds codex and opencode with one /v1", () => {
    const entries = customGatewayInstances(customGateway);
    expect(entries.map(({ instanceId }) => instanceId)).toEqual(["gw-a1-codex", "gw-a1-opencode"]);
    const [codex] = entries;
    expect(codex?.instance.displayName).toBe("Codex · My GW");
    expect(codex?.instance.environment).toEqual([
      { name: "CUSTOM_GATEWAY_API_KEY", value: "k1", sensitive: true },
    ]);
    const config = codex?.instance.config as { launchArgs: string };
    expect(tokenizeCliArgs(config.launchArgs)).toEqual([
      "-c",
      'model_provider="gw_a1"',
      "-c",
      'model_providers.gw_a1.name="My GW"',
      "-c",
      'model_providers.gw_a1.base_url="https://gw.example.com/v1"',
      "-c",
      'model_providers.gw_a1.env_key="CUSTOM_GATEWAY_API_KEY"',
      "-c",
      'model_providers.gw_a1.wire_api="responses"',
    ]);
    expect(codex?.instance.config).toMatchObject({
      customModels: [{ slug: "gpt-x" }],
      onlyCustomModels: true,
    });
    const opencode = opencodeConfigOf(entries).provider.gw_a1;
    expect(opencode.npm).toBe("@ai-sdk/openai-compatible");
    expect(opencode.options).toEqual({
      baseURL: "https://gw.example.com/v1",
      apiKey: "{env:CUSTOM_GATEWAY_API_KEY}",
    });
  });

  it("anthropic format builds claude and opencode without /v1 for claude", () => {
    for (const url of [
      "https://gw.example.com",
      "https://gw.example.com/",
      "https://gw.example.com/v1",
    ]) {
      const entries = customGatewayInstances({ ...customGateway, url, format: "anthropic" });
      expect(entries.map(({ instanceId }) => instanceId)).toEqual([
        "gw-a1-claude",
        "gw-a1-opencode",
      ]);
      expect(env(entries[0], "ANTHROPIC_BASE_URL")).toBe("https://gw.example.com");
      expect(entries[0]?.instance.config).toEqual({
        customModels: [{ slug: "gpt-x" }],
        onlyCustomModels: true,
      });
      const opencode = opencodeConfigOf(entries).provider.gw_a1;
      expect(opencode.npm).toBe("@ai-sdk/anthropic");
      expect(opencode.options.baseURL).toBe("https://gw.example.com/v1");
    }
  });

  it("no key writes no key", () => {
    for (const format of ["openai", "anthropic"] as const) {
      const entries = customGatewayInstances({ ...customGateway, format, key: null });
      for (const { instance } of entries) {
        expect(instance.environment?.filter((variable) => variable.sensitive)).toEqual([]);
        expect(JSON.stringify(instance.config)).not.toContain("env_key");
      }
      expect(opencodeConfigOf(entries).provider.gw_a1.options).not.toHaveProperty("apiKey");
    }
  });

  it("a renamed custom gateway renames its agents and keeps its key and models", () => {
    const current = Object.fromEntries(
      customGatewayInstances(customGateway).map(({ instanceId, instance }) => [
        instanceId,
        instance,
      ]),
    );
    const renamed = { ...customGateway, name: "Work" };
    const next = withCustomGateway(current, renamed, null);
    expect(next[ProviderInstanceId.make("gw-a1-codex")]?.displayName).toBe("Codex · Work");
    expect(next[ProviderInstanceId.make("gw-a1-codex")]?.environment).toEqual(
      current[ProviderInstanceId.make("gw-a1-codex")]?.environment,
    );
    expect(next[ProviderInstanceId.make("gw-a1-codex")]?.config).toEqual(
      customGatewayInstances({ ...renamed, key: "k1" })[0]?.instance.config,
    );
    expect(next[ProviderInstanceId.make("gw-a1-opencode")]?.displayName).toBe("opencode · Work");
    const opencode = JSON.parse(
      String(next[ProviderInstanceId.make("gw-a1-opencode")]?.environment?.[1]?.value),
    );
    expect(opencode.provider.gw_a1.name).toBe("Work");
    expect(Object.keys(opencode.provider.gw_a1.models)).toEqual(["gpt-x"]);
    expect(withCustomGateway(next, renamed, null)).toBe(next);
  });
});
