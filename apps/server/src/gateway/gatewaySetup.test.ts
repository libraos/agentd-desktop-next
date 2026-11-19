import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { describe, expect, it } from "@effect/vitest";

import {
  codexGatewayLaunchArgs,
  gatewayInstanceUpdates,
  gatewayProviderInstances,
  gatewayRefusal,
} from "./gatewaySetup.ts";

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

  it("updates only the Gateway agents still present whose models changed", () => {
    const key = "lk_test_key_123456";
    const before = [{ id: "anthropic/claude-opus-5-5" }, { id: "openai/gpt-5.5" }];
    const current = Object.fromEntries(
      gatewayProviderInstances(key, before)
        .filter(({ instanceId }) => instanceId !== "libraosOpencode")
        .map(({ instanceId, instance }) => [instanceId, instance]),
    );
    expect(gatewayInstanceUpdates(current, key, before)).toEqual([]);

    const updates = gatewayInstanceUpdates(current, key, [{ id: "openai/gpt-5.5" }]);
    expect(updates.map((update) => update.instanceId)).toEqual(["libraosClaude"]);
    expect(updates[0]?.instance.config).toEqual({ customModels: [], onlyCustomModels: true });
  });

  it("shows the Gateway's own message for a refused key", () => {
    expect(
      gatewayRefusal(401, {
        error: { message: "This API key is not valid.", type: "invalid_api_key" },
      }),
    ).toBe("This API key is not valid.");
    expect(gatewayRefusal(502, "<html>")).toBe("LibraOS Gateway answered HTTP 502.");
  });
});
