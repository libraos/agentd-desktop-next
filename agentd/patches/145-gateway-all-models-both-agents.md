# 145 — Every Gateway model on both Gateway agents

"Claude Code · LibraOS Gateway" and "Codex · LibraOS Gateway" each list every model the key allows (`GET /v1/models`), not only their own family. The agent's own family (`anthropic/*` for Claude Code, `openai/*` for Codex) drops its prefix as before, so it keeps its catalog name and options (Fast mode, reasoning effort) and comes first; every other model keeps the Gateway's full id (`gemini/gemini-2.5-pro`, `Qwen/Qwen3.5-Plus`, `openai/gpt-5.5` under Claude Code) as a custom model. No family is hard-coded: the label is whatever the id names before its first `/`. Running one passes that id unchanged: Claude Code's `model` with `ANTHROPIC_BASE_URL` at the Gateway, Codex's `model` on the `libraos` provider at the Gateway's `/v1` (Responses). The Gateway sends ids without a route of their own to MegaNova. The same rule holds for an agent whose own config points at the Gateway (#117's hand-configured check). opencode already listed every model.

Ours: `apps/server/src/gateway/gatewaySetup.ts` (`gatewayAgentModels` replaces `gatewayFamilyModels`), `apps/server/src/gateway/gatewayKeyModels.ts` and their tests.

## Upstream files changed

- `packages/provider-core/src/server/snapshotProbe.ts` — A custom model an endpoint-limited agent lists is labelled (`subProvider`) with the family its id names, which the web picker, mobile and Settings already show.
- `packages/provider-core/src/server/snapshotProbe.test.ts` — That label.
- `apps/web/src/components/settings/ProviderModelsSection.tsx` — A model row shows its `subProvider`.
- `apps/server/src/provider/Drivers/ClaudeDriver.test.ts` — A Gateway Claude agent lists a `gemini/*` model, labelled, beside its own catalog model.
- `apps/server/src/provider/ProviderRegistry.test.ts` — A Gateway Codex agent lists a `gemini/*` model, labelled.
- `apps/server/src/claudeModelOptions.test.ts` — A `gemini/*` or `Qwen/*` id reaches Claude Code unchanged.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts` — A `gemini/*` id reaches Codex's `turn/start` unchanged, with no reasoning effort.
- `docs/user/welcome-page.md` — The Gateway agents list every model the key allows.
