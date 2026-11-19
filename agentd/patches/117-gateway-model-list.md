# 117 — Gateway agents list only the models the key allows

"Claude Code · LibraOS Gateway" and "Codex · LibraOS Gateway" now list the key's models instead of the agent's whole catalog with the key's models added. A catalog entry the key allows keeps its name and options, a key model the catalog lacks is added as a custom model, the rest is dropped. With none, the agent lists nothing and says why. A provider refresh by a client allowed to manage providers, and each server start, asks the Gateway for the key's list again and changes only the model lists of the Gateway agents still present, in one settings write, so the user's launch arguments, variables and a concurrent edit or removal stay. A key the Gateway refuses (401/403) leaves the agents no models and the Gateway card says why, with the Gateway's reason cut to one line, 200 characters and no credentials; an unreachable Gateway leaves the last list. A model the key dropped is not brought back from the previous snapshot or the boot cache. Agents connected before #117 are limited to their list from their first snapshot, before the Gateway answers. The opencode Gateway agent loses custom models added before #117. A client without `providers:manage` is told its refresh does not ask the Gateway again. The Gateway agents' models cannot be edited in Settings; mobile marks a model the key dropped unavailable. Agents on their own login keep their full catalogs. A thread on a Gateway agent set to a model the key no longer allows shows it as unavailable instead of quietly showing another model.

An agent whose own config points at the Gateway (Codex with `model_provider` at api.libraos.com) is unchanged: agentd has no command yet that returns the Gateway's list for its key, and Desktop does not read Codex's environment or a key file.

## Upstream files changed

- `packages/contracts/src/settings.ts` — Hidden `onlyCustomModels` on Codex and Claude settings: the custom models replace the catalog.
- `packages/provider-core/src/server/snapshotProbe.ts` — `providerModelsFromSettings` takes `onlyCustomModels`; `withNoServedModelsNotice` says why such a list is empty.
- `packages/provider-core/src/server/snapshotProbe.test.ts` — The replace rule and the empty-list notice.
- `apps/server/src/provider/CodexProvider.ts` — Pass `onlyCustomModels` through and add the empty-list notice to the status check.
- `apps/server/src/provider/ClaudeProvider.ts` — The same for Claude.
- `apps/server/src/provider/Drivers/CodexDriver.ts` — A Gateway instance without the flag (saved before #117) is limited anyway.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts` — The same for Claude.
- `apps/server/src/provider/Drivers/ClaudeDriver.test.ts` — New: the first snapshot of a pre-#117 Gateway Claude agent lists only its key's models.
- `apps/server/src/provider/ProviderRegistry.ts` — A Gateway instance never keeps models missing from its new snapshot.
- `apps/server/src/provider/ProviderRegistry.test.ts` — A Gateway Codex agent lists only the key's models, or none with a warning; a dropped Gateway model is not brought back; the OpenCode 2 empty-list message.
- `apps/server/src/provider/providerStatusCache.ts` — The boot cache names a Gateway agent's models but adds none the settings lack.
- `apps/server/src/provider/providerStatusCache.test.ts` — That case.
- `apps/server/src/ws.ts` — A provider refresh with `refreshModels` from a session with `providers:manage` re-reads the key's models before probing the Gateway agents. This puts a settings write in the upstream refresh RPC (read-scoped): when upstream changes refresh semantics or its authorization, carry the scope check forward.
- `apps/server/src/ws.test.ts` — The Gateway mock answers `refreshModels`; only a provider manager's refresh reaches it.
- `apps/server/src/serverSettings.ts` — `updateProviderInstances` rewrites instances from the stored ones within one write.
- `apps/server/src/device/DeviceService.test.ts` — Its settings mock gains `updateProviderInstances`.
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` — Its settings mock gains `updateProviderInstances`.
- `packages/provider-opencode/src/server/status.ts` — An empty model list no longer reads as a discovery delay ("yet"); a key may allow none.
- `packages/provider-opencode/src/server/status.test.ts` — The empty-list message.
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` — No custom models on the Gateway agents; a line says where their models come from, and that a refresh without `providers:manage` does not ask the Gateway.
- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — The Gateway's refusal, and what to do then instead of the usual guidance.
- `apps/web/src/modelSelection.ts` — A Gateway instance keeps a selected model it no longer lists, marked unavailable, as runtime-catalog drivers already do.
- `apps/web/src/modelSelection.test.ts` — A Gateway Codex agent shows a dropped model as unavailable; the agent's own instance does not.
- `apps/mobile/src/lib/modelOptions.ts` — A Gateway agent's model the key dropped is unavailable, as on web.
- `apps/mobile/src/lib/modelOptions.test.ts` — That case.
- `apps/web/src/i18n/translations/de.json` — The new web strings.
- `apps/web/src/i18n/translations/en.json` — The new web strings.
- `apps/web/src/i18n/translations/es.json` — The new web strings.
- `apps/web/src/i18n/translations/fr.json` — The new web strings.
- `apps/web/src/i18n/translations/ja.json` — The new web strings.
- `apps/web/src/i18n/translations/ko.json` — The new web strings.
- `apps/web/src/i18n/translations/pt-BR.json` — The new web strings.
- `apps/web/src/i18n/translations/ru.json` — The new web strings.
- `apps/web/src/i18n/translations/sv.json` — The new web strings.
- `apps/web/src/i18n/translations/zh.json` — The new web strings.
- `apps/mobile/src/i18n/translations/de.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/en.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/es.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/fr.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/ja.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/ko.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/pt-BR.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/ru.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/sv.json` — The new mobile string.
- `apps/mobile/src/i18n/translations/zh.json` — The new mobile string.
