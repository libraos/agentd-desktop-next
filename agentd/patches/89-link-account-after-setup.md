# Link the LibraOS account after setup

After Set up AgentD succeeds, the same dialog offers linking the LibraOS account, with Skip. Linking uses the existing Cloud Workers account key form; nothing is sent until the person presses its button. An account that is already linked, or an agentd with no Cloud Workers, never sees the step: the dialog closes as before.

- **Entry points.** The setup dialog after a success; "Link account" beside the LibraOS account line, which the indicator popover and Settings → Workers share. Both open the dialog at the link step.
- **Rule.** `offerAccountLink`: the step shows only when agentd answers with Cloud Workers supported and no account key (`problem: "setup"`). A failed read closes the dialog.

Files:

- `apps/web/src/components/agentd/agentdVisibility.logic.ts`: `offerAccountLink`.
- `apps/web/src/components/agentd/agentdVisibility.logic.test.ts`: when the step shows and when it does not.
- `apps/web/src/components/agentd/AgentdSetupDialog.tsx`: the link step, `openAgentdLinkDialog`.
- `apps/web/src/components/agentd/AgentdIndicator.tsx`: "Link account" in the shared status lines.
- `apps/web/src/i18n/translations/*.json`: new strings; zh translated, other locales in English until translated.

Not verified:

- In a running app: covered by the logic test and typecheck only.
