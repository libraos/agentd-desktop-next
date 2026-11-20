import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { describe, expect, it } from "@effect/vitest";

import {
  codexGatewayLaunchArgs,
  gatewayProviderInstances,
  GATEWAY_INSTANCE_IDS,
  gatewayRefusal,
  withGatewayModels,
} from "./gatewaySetup.ts";

// Another family's model keeps its Gateway id, sits under its family and has no agent options.
const otherFamily = (slug: string, name?: string) => ({
  slug,
  ...(name ? { name } : {}),
  subProvider: slug.split("/")[0],
  capabilities: { optionDescriptors: [] },
});

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

  it("lists every key model on both agents, the agent's own family first, and keeps the key out of plain values", () => {
    const [claude, codex, opencode] = gatewayProviderInstances("lk_test_key_123456", [
      { id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "openai/gpt-5.5" },
      { id: "google/gemini-3" },
      { id: "gemini/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "Qwen/Qwen3.5-Plus" },
    ]);
    // The own family drops its prefix to keep its catalog entry; the rest keep the Gateway's id.
    expect(claude?.instance.config).toEqual({
      customModels: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
        otherFamily("openai/gpt-5.5"),
        otherFamily("google/gemini-3"),
        otherFamily("gemini/gemini-2.5-pro", "Gemini 2.5 Pro"),
        otherFamily("Qwen/Qwen3.5-Plus"),
      ],
      onlyCustomModels: true,
    });
    expect(codex?.instance.config).toMatchObject({
      customModels: [
        { slug: "gpt-5.5" },
        otherFamily("anthropic/claude-opus-5-5", "Claude Opus 5.5"),
        otherFamily("google/gemini-3"),
        otherFamily("gemini/gemini-2.5-pro", "Gemini 2.5 Pro"),
        otherFamily("Qwen/Qwen3.5-Plus"),
      ],
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
      "gemini/gemini-2.5-pro",
      "Qwen/Qwen3.5-Plus",
    ]);
    for (const instance of [claude, codex, opencode]) {
      for (const variable of instance?.instance.environment ?? []) {
        if (variable.value === "lk_test_key_123456") expect(variable.sensitive).toBe(true);
        else expect(String(variable.value)).not.toContain("lk_test_key_123456");
      }
    }
  });

  it("keeps a model's slug when the key adds a bare id equal to its own-family name", () => {
    const key = "lk_test_key_123456";
    const before = Object.fromEntries(
      gatewayProviderInstances(key, [
        { id: "openai/gpt-5.5", name: "GPT 5.5" },
        { id: "anthropic/claude-opus-5-5" },
      ]).map(({ instanceId, instance }) => [instanceId, instance]),
    );
    const after = withGatewayModels(before, [
      { id: "openai/gpt-5.5", name: "GPT 5.5" },
      { id: "gpt-5.5", name: "Standalone GPT route" },
      { id: "anthropic/claude-opus-5-5" },
      { id: "claude-opus-5-5" },
    ]);
    const entries = (instanceId: keyof typeof after) =>
      readCustomModelEntries(
        (after[instanceId]?.config as { customModels?: unknown } | undefined)?.customModels,
      ).map(({ slug, subProvider }) => [slug, subProvider]);
    // A thread, favorite or hidden model saved as `gpt-5.5` still names the GPT 5.5 row.
    expect(entries(GATEWAY_INSTANCE_IDS.codex)).toEqual([
      ["gpt-5.5", undefined],
      ["anthropic/claude-opus-5-5", "anthropic"],
      ["claude-opus-5-5", undefined],
    ]);
    expect(entries(GATEWAY_INSTANCE_IDS.claude)).toEqual([
      ["claude-opus-5-5", undefined],
      ["openai/gpt-5.5", "openai"],
      ["gpt-5.5", undefined],
    ]);
  });

  it("changes only the model lists of the Gateway agents still present", () => {
    const key = "lk_test_key_123456";
    const before = [
      { id: "anthropic/claude-opus-5-5" },
      { id: "openai/gpt-5.5" },
      { id: "gemini/gemini-2.5-pro" },
    ];
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
    // The key dropped Claude Opus and Gemini: both agents lose them.
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
      customModels: [otherFamily("openai/gpt-6-luna")],
      onlyCustomModels: true,
    });
    expect(next[GATEWAY_INSTANCE_IDS.claude]?.environment).toBe(
      current[GATEWAY_INSTANCE_IDS.claude]?.environment,
    );
    expect(next).not.toHaveProperty(GATEWAY_INSTANCE_IDS.opencode);

    // A Claude agent connected by an older build learns to send the picked id as it is.
    const claude = current[GATEWAY_INSTANCE_IDS.claude]!;
    const older = {
      ...current,
      [GATEWAY_INSTANCE_IDS.claude]: {
        ...claude,
        environment: (claude.environment ?? []).filter(
          ({ name }) => !name.startsWith("CLAUDE_CODE_"),
        ),
      },
    };
    expect(withGatewayModels(older, before)[GATEWAY_INSTANCE_IDS.claude]?.environment).toEqual(
      claude.environment,
    );
  });

  it("offers Claude Code only the ids it sends as they are", () => {
    const [claude, codex] = gatewayProviderInstances("lk_test_key_123456", [
      { id: "anthropic/opusplan" },
      { id: "anthropic/opus" },
      { id: "anthropic/claude-opus-4-1" },
      { id: "best" },
      { id: "Sonnet" },
      { id: "haiku" },
      { id: "gemini/gemini-2.5-pro[1m]" },
    ]);
    // No legacy remap (`claude-opus-4-1` to the current Opus), no fallback to another model.
    expect(
      claude?.instance.environment?.filter(({ name }) => name.startsWith("CLAUDE_CODE_")),
    ).toEqual([
      { name: "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP", value: "1", sensitive: false },
      { name: "CLAUDE_CODE_NO_MODEL_FALLBACK", value: "1", sensitive: false },
    ]);
    const slugs = (config: unknown) =>
      readCustomModelEntries((config as { customModels?: unknown } | undefined)?.customModels).map(
        ({ slug }) => slug,
      );
    // Claude Code swaps aliases for its own models; only the lowercase family names are pinned.
    expect(slugs(claude?.instance.config)).toEqual([
      "opus",
      "claude-opus-4-1",
      "anthropic/opusplan",
      "haiku",
    ]);
    expect(slugs(codex?.instance.config)).toEqual([
      "anthropic/opusplan",
      "anthropic/opus",
      "anthropic/claude-opus-4-1",
      "best",
      "Sonnet",
      "haiku",
      "gemini/gemini-2.5-pro[1m]",
    ]);
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
});
