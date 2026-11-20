import type { ClientSettings } from "@t3tools/contracts/settings";

import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { rememberKeyFiles } from "./startTask.logic";

type KeyFiles = ClientSettings["agentdCloudKeyFiles"];

// Storage holds paths another window saved that may not have reached this window's snapshot; this
// window's own path for the same environment and provider wins.
function mergeKeyFiles(snapshot: KeyFiles, stored: KeyFiles | undefined): KeyFiles {
  if (stored === undefined) return snapshot;
  const merged: Record<string, KeyFiles[string]> = { ...stored };
  for (const [environmentId, files] of Object.entries(snapshot))
    merged[environmentId] = { ...stored[environmentId], ...files };
  return merged;
}

/**
 * Keeps the BYOK paths a cloud worker took. Storage is read just before the write, so a path
 * another window saved is kept even before its change reaches this window. Storage offers no
 * compare-and-set: two windows saving within the same moment can still drop one path.
 */
export async function persistRememberedKeyFiles(
  environmentId: string,
  submitted: Parameters<typeof rememberKeyFiles>[2],
  persist?: Parameters<typeof persistClientSettingsUpdate>[1],
) {
  const stored = await ensureLocalApi()
    .persistence.getClientSettings()
    .then((settings) => settings?.agentdCloudKeyFiles)
    .catch(() => undefined);
  return persistClientSettingsUpdate(
    (current) => ({
      ...current,
      agentdCloudKeyFiles: rememberKeyFiles(
        mergeKeyFiles(current.agentdCloudKeyFiles, stored),
        environmentId,
        submitted,
      ),
    }),
    persist,
  );
}
