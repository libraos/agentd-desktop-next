import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { rememberKeyFiles } from "./startTask.logic";

/**
 * Keeps the BYOK paths a cloud worker took, merged into the settings as they are when the write
 * runs: a path another window remembered meanwhile is kept, not overwritten by this one's snapshot.
 */
export function persistRememberedKeyFiles(
  environmentId: string,
  submitted: Parameters<typeof rememberKeyFiles>[2],
  persist?: Parameters<typeof persistClientSettingsUpdate>[1],
) {
  return persistClientSettingsUpdate(
    (current) => ({
      ...current,
      agentdCloudKeyFiles: rememberKeyFiles(current.agentdCloudKeyFiles, environmentId, submitted),
    }),
    persist,
  );
}
