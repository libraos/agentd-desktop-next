# 107: AgentD is visible

AgentD shows where people already look, and onboarding names its two ways in: your own keys on this machine, or a LibraOS account for LibraOS Gateway and Cloud Workers.

- **Indicator.** A row in the sidebar footer shows "AgentD: not installed", "not set up", "needs attention" or "on" for the open thread's environment (else the primary one). It keeps the last known state while a read fails and never shows a spinner. Not set up opens Set up AgentD where the connection allows it. On opens a popover with "This machine" and "LibraOS account" and links to the AgentD page and Worker settings.
- **Set up AgentD.** Three benefit lines and "Chat and Code work without it." come first. The agreement is folded under "Read the agreement" with its version, and it starts open on windows 640px high or less.
- **Try a worker.** After setup, the first Code thread in a git project shows one card that opens Hand to a worker with nothing started. It shows once per environment (`agentdFirstTaskShown` in client settings).
- **Offers.** With Suggest workers on, a Code thread shows "Hand this to a worker" after a turn has run 5 minutes, or when the person sends while a turn runs. Draft the task queues the task-draft prompt. Not now hides it in that thread. Don't suggest again turns the setting off, and other windows follow through the synced setting. It is hidden in Chat threads, non-git folders, while a worker of this project runs, and on main or a detached head, where it names Cloud Workers if the account is linked.
- **Settings → Workers.** Suggest workers, Run tasks on (Cloud Workers selectable only with a linked account), Default budget (`60m,$5`) and the indicator's two lines. Hand to a worker takes its initial "Run in the cloud" and its no-estimate budget from here, and a per-task choice still overrides.
- **Session panel.** "AgentD workers" shows the destination from Run tasks on.
- **Welcome page.** Two cards, Bring your own key and LibraOS account, sit above the agent list. They store nothing, hide nothing, and link only to the Product usage data page. The LibraOS account card replaces the Gateway row under the agents and shows "Gateway connected" once a key is saved. Ready and turned-off agents get a switch, and the Projects card moves under the agent list with "(optional)" in its title.
- **Turned-off agents.** Reproduced: turning one off saves `enabled: false`, which beats every other flag at load. The legacy migration fills only an unset flag, and the default-instance derivation skips saved instances, so a signed-in Codex stays off after Continue and a restart. Nothing changed there.

Files:

- `packages/contracts/src/settings.ts`: four client settings and their patch keys, `AgentdRunTasksOn`, `AgentdDefaultBudget` (upstream file, appended fields).
- `apps/web/src/components/agentd/agentdVisibility.logic.ts` (new): indicator state, offer signal and rules, first-task rule, budget parsing.
- `apps/web/src/components/agentd/agentdVisibility.logic.test.ts` (new): indicator state mapping, offer show and hide rules.
- `apps/web/src/components/agentd/AgentdIndicator.tsx` (new): the sidebar row, its popover and the shared status lines.
- `apps/web/src/components/agentd/AgentdThreadNudges.tsx` (new): Try a worker and the offer.
- `apps/web/src/components/agentd/WorkersSettings.tsx` (new): Settings → Workers.
- `apps/web/src/components/agentd/WelcomeAccountCards.tsx` (new): the two welcome cards.
- `apps/web/src/components/agentd/workerSettings.ts` (new): the defaults Hand to a worker reads.
- `apps/web/src/components/agentd/startTask.logic.ts`: `autoBudget` takes the default budget.
- `apps/web/src/components/agentd/taskPlan.tsx`, `StartTaskCloud.tsx`: read the Workers defaults.
- `apps/web/src/components/agentd/StartTaskDialog.browser.test.tsx`: settings defaults reach the dialog; the environments mock keeps the real module's other exports.
- `apps/web/src/components/agentd/AgentdSetupDialog.tsx`: benefits first, agreement folded.
- `apps/web/src/routes/_chat.settings.workers.tsx` (new): the route.
- `apps/web/src/routeTree.gen.ts`: regenerated for the route (upstream file, generated).
- `apps/web/src/components/settings/settingsSearch.ts`: the Workers path, label, nav entry, search item and scope (upstream file, a few lines).
- `apps/web/src/components/settings/SettingsSidebarNav.tsx`: its icon (upstream file, two lines).
- `apps/web/src/components/sidebar/SidebarChrome.tsx`: mounts the indicator (upstream file, two lines).
- `apps/web/src/components/ChatView.tsx`: mounts the nudges above the composer and notes a send while a turn runs (upstream file, a few lines).
- `apps/web/src/components/chat/ThreadDetailsAgentdWorkers.tsx`: the destination beside the heading.
- `apps/web/src/components/onboarding/WelcomePage.tsx`: the cards, agent switches, heading line, Projects card under the agents, its "(optional)" title; the Gateway row is removed (upstream file).
- `apps/web/src/components/onboarding/WelcomePage.import.browser.test.tsx`: the Gateway link is now the LibraOS account card's.
- `apps/web/src/i18n/translations/*.json`: new strings; zh translated, other locales in English until translated.

Not verified:

- Windows and macOS: built and tested on Linux only. Nothing here is platform-specific.
- A real remote environment and a non-git folder workspace in a running app; the rules for them are covered by the logic tests.
- Translations other than zh.
