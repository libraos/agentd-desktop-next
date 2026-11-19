import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hosted relay flag off", () => {
  it("shows no hosted relay entry even when the build carries its public config", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubGlobal("window", { desktopBridge: {} });

    expect(hasCloudPublicConfig()).toBe(false);
    expect(resolveCloudPublicConfig()).toMatchObject({
      clerkPublishableKey: null,
      relayUrl: null,
      relayTracing: { tracesUrl: null },
    });
  });
});
