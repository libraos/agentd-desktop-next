# 117 — Gateway agents list only the models the key allows

"Claude Code · LibraOS Gateway" and "Codex · LibraOS Gateway" now list the key's models instead of the agent's whole catalog with the key's models added. A catalog entry the key allows keeps its name and options, a key model the catalog lacks is added as a custom model, the rest is dropped. With none, the agent lists nothing and says why. A provider refresh by a client allowed to manage providers, and each server start, asks the Gateway for the key's list again and changes only the model lists of the Gateway agents still present, in one settings write, so the user's launch arguments, variables and a concurrent edit or removal stay. A key the Gateway refuses (401/403) leaves the agents no models and the Gateway card says why; an unreachable Gateway leaves the last list. Agents connected before #117 are limited to their list at the first start. The Gateway agents' models cannot be edited in Settings; mobile marks a model the key dropped unavailable. Agents on their own login keep their full catalogs. A thread on a Gateway agent set to a model the key no longer allows shows it as unavailable instead of quietly showing another model.

An agent whose own config points at the Gateway (Codex with `model_provider` at api.libraos.com) is unchanged: agentd has no command yet that returns the Gateway's list for its key, and Desktop does not read Codex's environment or a key file.

## Upstream files changed

- `packages/contracts/src/settings.ts` — Hidden `onlyCustomModels` on Codex and Claude settings: the custom models replace the catalog.
- `packages/provider-core/src/server/snapshotProbe.ts` — `providerModelsFromSettings` takes `onlyCustomModels`; `withNoServedModelsNotice` says why such a list is empty.
- `packages/provider-core/src/server/snapshotProbe.test.ts` — The replace rule and the empty-list notice.
- `apps/server/src/provider/CodexProvider.ts` — Pass `onlyCustomModels` through and add the empty-list notice to the status check.
- `apps/server/src/provider/ClaudeProvider.ts` — The same for Claude.
- `apps/server/src/provider/ProviderRegistry.test.ts` — A Gateway Codex agent lists only the key's models, or none with a warning. The OpenCode 2 empty-list message.
- `apps/server/src/ws.ts` — A provider refresh with `refreshModels` from a session with `providers:manage` re-reads the key's models before probing the Gateway agents. This puts a settings write in the upstream refresh RPC (read-scoped): when upstream changes refresh semantics or its authorization, carry the scope check forward.
- `apps/server/src/ws.test.ts` — The Gateway mock answers `refreshModels`; only a provider manager's refresh reaches it.
- `apps/server/src/serverSettings.ts` — `updateProviderInstances` rewrites instances from the stored ones within one write.
- `apps/server/src/device/DeviceService.test.ts`, `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` — Their settings mocks gain `updateProviderInstances`.
- `packages/provider-opencode/src/server/status.ts` — An empty model list no longer reads as a discovery delay ("yet"); a key may allow none.
- `packages/provider-opencode/src/server/status.test.ts` — The empty-list message.
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` — No custom models on the Gateway agents; a line says where their models come from.
- `apps/mobile/src/lib/modelOptions.ts` — A Gateway agent's model the key dropped is unavailable, as on web.
- `apps/mobile/src/lib/modelOptions.test.ts` — That case.
- `apps/{web,mobile}/src/i18n/translations/*.json` — The new strings.
- `apps/web/src/modelSelection.ts` — An instance with `onlyCustomModels` keeps a selected model it no longer lists, marked unavailable, as runtime-catalog drivers already do.
- `apps/web/src/modelSelection.test.ts` — A Gateway Codex agent shows a dropped model as unavailable; the agent's own instance does not.
