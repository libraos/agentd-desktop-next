# 145 — Every Gateway model on both Gateway agents

"Claude Code · LibraOS Gateway" and "Codex · LibraOS Gateway" each list every model the key allows (`GET /v1/models`), not only their own family. The agent's own family (`anthropic/*` for Claude Code, `openai/*` for Codex) drops its prefix as before, so it keeps its catalog name and options (Fast mode, reasoning effort) and comes first; every other model keeps the Gateway's full id (`gemini/gemini-2.5-pro`, `Qwen/Qwen3.5-Plus`, `openai/gpt-5.5` under Claude Code) as a custom model with none of the agent's options (Codex would otherwise lend it the first GPT model's reasoning and service-tier controls). A model's slug depends on its id alone, so a saved choice, favorite or hidden model names the same row after the key changes; a bare Gateway id equal to an own-family name (`gpt-5.5` beside `openai/gpt-5.5`) is the request that row already sends, so it is not a second row, and the prefixed id then gets a custom row of its own (`openai/gpt-5.5`) so both ids stay reachable. Claude Code sends the id unchanged: a bare id equal to one of its four family aliases (`opus`) is pinned to itself by upstream's alias pin; an id it would swap anyway (`best`, `opusplan`, `Sonnet`, a `[1m]` suffix) is not offered under Claude Code, or keeps its full id (`anthropic/opusplan`); and the Gateway Claude agent sets `CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP` and `CLAUDE_CODE_NO_MODEL_FALLBACK`, also on agents connected before, so old Opus ids are not remapped and no other model is swapped in. No family is hard-coded: the Gateway setting gives each other model the family its id names before its first `/` (`subProvider`). Running one passes that id unchanged: Claude Code's `model` with `ANTHROPIC_BASE_URL` at the Gateway, Codex's `model` on the `libraos` provider at the Gateway's `/v1` (Responses). The Gateway sends ids without a route of their own to MegaNova. The same rule holds for an agent whose own config points at the Gateway (#117's hand-configured check). opencode already listed every model.

Ours: `apps/server/src/gateway/gatewaySetup.ts` (`gatewayAgentModels` replaces `gatewayFamilyModels`), `apps/server/src/gateway/gatewayKeyModels.ts` and their tests.

## Upstream files changed

- `packages/contracts/src/model.ts` — A custom model entry may name its family (`subProvider`).
- `packages/shared/src/model.ts` — `readCustomModelEntries` keeps that family.
- `packages/provider-core/src/server/snapshotProbe.ts` — A custom model an endpoint-limited agent lists carries the family its entry names (never guessed from the slug), which the web picker, mobile and Settings already show.
- `packages/provider-core/src/server/snapshotProbe.test.ts` — That label, and none for a slash id without one.
- `apps/web/src/components/settings/ProviderModelsSection.tsx` — A model row shows its `subProvider`.
- `apps/server/src/provider/Drivers/ClaudeDriver.test.ts` — A Gateway Claude agent lists a `gemini/*` model, labelled, beside its own catalog model.
- `apps/server/src/provider/ProviderRegistry.test.ts` — A Gateway Codex agent lists a `gemini/*` model, labelled and without Codex's options.
- `apps/server/src/claudeModelOptions.test.ts` — A `gemini/*` or `Qwen/*` id reaches Claude Code unchanged.
- `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts` — A Gateway key's bare `opus` id reaches Claude Code as `opus`, like a user-added one.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` — A `gemini/*` id reaches Codex's `turn/start` unchanged, with no reasoning effort.
- `apps/server/src/provider/Drivers/ClaudeDriver.ts` — A turn reads the picked id against the key's discovered models too, so a hand-configured Gateway agent with no saved list sends a bare `opus` as `opus`.
- `docs/user/welcome-page.md` — The Gateway agents list every model the key allows; Claude Code leaves out ids it would run as another model.
