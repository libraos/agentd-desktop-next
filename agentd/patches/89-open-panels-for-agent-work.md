# 89 — Open the browser beside the agent's work

In a Code thread the right panel opens on the browser tab when the agent calls the app's `preview_*` browser tools. It never takes focus, never moves an open panel off the tab the user chose, and stops for good in a thread once the user closes the panel there. The new client setting `agentWorkPanelsEnabled` defaults on. Chat (scratch) threads, embedded views and the narrow sheet layout are left alone. Every provider is covered because the rule reads turn items (app MCP tool names normalised by `resolveT3McpToolId`), not provider events. Codex's own browser-use runs outside the app's browser, so it does not open the browser tab.

The terminal is left out: the panel's terminal is the user's own shell and does not show the agent's command output, so opening it would show an empty tab.

Our files:

- `apps/web/src/components/agentd/agentWorkPanels.logic.ts` (+ test): which item is a browser call, and what it does to the panel.
- `apps/web/src/components/agentd/useAgentWorkPanels.ts`: shows each new running call once; reveals the agent's browser tab, or waits for it to reach the panel.

Upstream files:

- `packages/contracts/src/settings.ts`: `agentWorkPanelsEnabled` in client settings (default true) and the patch schema.
- `apps/web/src/rightPanelStore.ts`: `agentWorkPanelsDismissed` per thread, set when a user action closes the panel and kept through migration; `openForAgentWork`, an automatic open that respects it.
- `apps/web/src/rightPanelStore.test.ts`: a close stops agent opens across a reload; three full-state expectations now include the flag.
- `apps/web/src/components/ChatView.tsx`: one `useAgentWorkPanels` call, Code threads only.
- `apps/web/src/components/settings/SettingsPanels.tsx`: the switch under Chat > Activity, plus reset and changed-settings entries.
- `apps/web/src/components/settings/settingsSearch.ts`: the search entry.
- `apps/web/src/i18n/translations/*.json`: four new strings, in English and Chinese.
- `docs/user/default-browser.md`: a short section on the behaviour and the setting.
