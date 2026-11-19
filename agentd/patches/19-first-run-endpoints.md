# 19 — Choose an API key or gateway on first run

- `apps/web/src/components/onboarding/ConnectEndpointScreen.tsx` — Show only the chosen agent's compatible endpoint options, with the gateway account requirement and explicit unavailable states.
- `apps/web/src/components/onboarding/WelcomePage.tsx` — Put the AgentD-branded Gateway shortcut directly below the agent rows and open the chooser with Gateway selected.
- `apps/web/src/routes/welcome.tsx` — Validate the Gateway shortcut's screen value without changing authentication or environment selection.
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` — Add the chooser link and return to the same Providers settings on Back.
- `apps/web/src/routes/_chat.settings.providers.tsx` — Validate the credential-free chooser flag while keeping the environment and provider selection.
- `apps/web/src/components/onboarding/WelcomePage.import.browser.test.tsx` — Verify the compatibility matrix, disabled states, Gateway shortcut, and Back navigation in the existing welcome flow.
- `PR-BODY.md` — Record the AgentD dependency blocking endpoint application and readiness verification.

Disabled for every compatible agent: **LibraOS Gateway**, **Anthropic API key**, **OpenAI API key**, **AWS Bedrock**, **Ollama**, and **Custom endpoint**. AgentD has no command to write these endpoints into the agents' own config. `agentd init --model-key` configures AgentD workers only and does not make the agent ready on the welcome screen. The UI does not collect credentials or write settings; application, readiness re-check, and AgentD error display need the per-agent write command first.

The web and Electron surfaces share this code on Linux and Windows. There are no new paths, subprocesses, or host-specific assumptions. Browser tests run on Linux; native Windows verification was not performed. The separate native mobile setup is unchanged.
