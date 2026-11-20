# 93: A first-run budget without model prices; how the task card is produced

Issues #131 and #133.

**#131.** Hand to a worker filled `60m,$5`, which agentd refuses for a local worker while its
`[budget.prices]` is empty. agentd's status read now also asks `agentd config get budget.prices`
(beside `dispatch.default_tool`) and reports `dollarBudgets`: false for an empty table, null when
agentd does not answer. With false, a local Start fills minutes only, the summary says
"time limit N min" instead of a dollar limit, the budget field says why, and a typed budget with
dollars is flagged before Start. A summary only promises a dollar limit agentd can hold. Cloud
Workers budgets are unchanged. Settings → Workers → Default budget says the same while this
machine's agentd has no prices.

**#133.** The card with Start and Edit appears only for the reply to **Draft from this
conversation**. That stays so (no parsing of agents' free text); `docs/user/workers.md` says how
to get the card and what happens when you ask the agent in your own words, and the slash menu
entry says it can draft a task card.

## Upstream files changed

- `apps/web/src/components/chat/useComposerMenuItems.ts`: the Hand to a worker entry's
  description says it can draft a task card from the chat.
- `apps/web/src/i18n/translations/*.json`: the new and changed strings (zh translated; other
  locales get the English text until translated, as `i18n:generate` writes them).
- `docs/README.md`: links the new user page.
