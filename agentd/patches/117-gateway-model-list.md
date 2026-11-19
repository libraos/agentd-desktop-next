# 117 — Gateway agents list only the models the key allows

"Claude Code · LibraOS Gateway" and "Codex · LibraOS Gateway" now list the key's models instead of the agent's whole catalog with the key's models added. A catalog entry the key allows keeps its name and options, a key model the catalog lacks is added as a custom model, the rest is dropped. With none, the agent lists nothing and says why. A provider refresh asks the Gateway for the key's list again and updates the Gateway agents still present, keeping what the user set on them. Agents on their own login keep their full catalogs. A thread on a Gateway agent set to a model the key no longer allows shows it as unavailable instead of quietly showing another model.

An agent whose own config points at the Gateway (Codex with `model_provider` at api.libraos.com) is unchanged: agentd has no command yet that returns the Gateway's list for its key, and Desktop does not read Codex's environment or a key file.

## Upstream files changed

- `packages/contracts/src/settings.ts` — Hidden `onlyCustomModels` on Codex and Claude settings: the custom models replace the catalog.
- `packages/provider-core/src/server/snapshotProbe.ts` — `providerModelsFromSettings` takes `onlyCustomModels`; `withNoServedModelsNotice` says why such a list is empty.
- `packages/provider-core/src/server/snapshotProbe.test.ts` — The replace rule and the empty-list notice.
- `apps/server/src/provider/CodexProvider.ts` — Pass `onlyCustomModels` through and add the empty-list notice to the status check.
- `apps/server/src/provider/ClaudeProvider.ts` — The same for Claude.
- `apps/server/src/provider/ProviderRegistry.test.ts` — A Gateway Codex agent lists only the key's models, or none with a warning.
- `apps/server/src/ws.ts` — A provider refresh with `refreshModels` re-reads the key's models before probing the Gateway agents.
- `apps/server/src/ws.test.ts` — The Gateway mock answers `refreshModels`.
- `apps/web/src/modelSelection.ts` — An instance with `onlyCustomModels` keeps a selected model it no longer lists, marked unavailable, as runtime-catalog drivers already do.
- `apps/web/src/modelSelection.test.ts` — A Gateway Codex agent shows a dropped model as unavailable; the agent's own instance does not.
