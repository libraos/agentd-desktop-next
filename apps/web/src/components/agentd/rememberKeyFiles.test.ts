import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: { getClientSettings: async () => null } }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
} from "~/hooks/useSettings";
import { persistRememberedKeyFiles } from "./rememberKeyFiles";

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
});

it("keeps a key path another window remembered while this one was writing", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  let durable: ClientSettings = DEFAULT_CLIENT_SETTINGS;
  const persist = vi.fn(async (settings: ClientSettings) => {
    if (persist.mock.calls.length === 1) {
      // The other window's write lands, and reaches this one, before this write finishes.
      __setClientSettingsForTests({
        ...DEFAULT_CLIENT_SETTINGS,
        agentdCloudKeyFiles: { other: { openai: "/b/openai.key" } },
      });
      return;
    }
    durable = settings;
  });

  await persistRememberedKeyFiles("here", { anthropicKeyFile: "/a/anthropic.key" }, persist);

  const both = {
    other: { openai: "/b/openai.key" },
    here: { anthropic: "/a/anthropic.key" },
  };
  expect(durable.agentdCloudKeyFiles).toEqual(both);
  expect(getClientSettings().agentdCloudKeyFiles).toEqual(both);
});
