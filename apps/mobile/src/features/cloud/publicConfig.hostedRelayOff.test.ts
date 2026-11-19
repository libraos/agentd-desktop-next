import { describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "relay" },
        relay: { url: "https://relay.example.test" },
      },
    },
  },
}));

describe("hosted relay flag off", () => {
  it("shows no hosted relay entry even when the build carries its public config", () => {
    expect(hasCloudPublicConfig()).toBe(false);
    expect(resolveCloudPublicConfig().relay.url).toBeNull();
  });
});
