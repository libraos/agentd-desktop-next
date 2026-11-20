import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { ensureLocalApi } from "~/localApi";
import { rememberKeyFiles } from "./startTask.logic";

/**
 * Keeps the BYOK paths a cloud worker took. Storage, read just before the write, is the base: this
 * window's snapshot may predate another window's save and would write its older paths back. Only
 * the submitted paths go on top. With no compare-and-set, saves in the same moment can drop one.
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
        stored ?? current.agentdCloudKeyFiles,
        environmentId,
        submitted,
      ),
    }),
    persist,
  );
}
