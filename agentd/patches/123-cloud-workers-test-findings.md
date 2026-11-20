# 123 Cloud Workers test findings

Ten findings from testing 0.1.10-agentd.7 on macOS. Our own files carry most of it (`apps/server/src/agentd/`, `apps/web/src/components/agentd/`). agentd's services are re-registered only through the app's agentd's own `install` and `dash install`, run with the root and ledger each service names, never by writing plists, units or tasks. They are left alone, and the AgentD page says why, when that agentd is in an AppImage mount with no installed copy to register, or when a Linux watchdog names a ledger agentd's PATH-only unit would drop. The key file prefix check reads the first 48 bytes and returns only the provider's name; agentd-core#978 moves it into agentd, and its answer replaces this one then. agentd has no writable `cloud.anthropic_key_file` / `cloud.openai_key_file`, so the last submitted BYOK paths are kept in app settings.

- `packages/contracts/src/agentd.ts` — Append the key file check, the quoted `chmod 600` command it suggests, the services repair on status (and why it was refused), `unreachable` and `checkoutUnknown` on cloud setup and `privateFile` on refusals.
- `packages/contracts/src/rpc.ts` — Append the key file check and fix RPCs.
- `packages/contracts/src/clientRpcPermissions.ts` — Give making a key file private the environment maintain scope: it reaches host files outside the workspaces that filesystem write covers.
- `packages/contracts/src/settings.ts` — Append the remembered BYOK key file paths per environment.
- `packages/client-runtime/src/state/agentd.ts` — Append the key file check query and fix command.
- `apps/server/src/auth/RpcAuthorization.ts` — Give the key file check the filesystem read scope, as browsing files has.
- `apps/server/src/auth/RpcAuthorization.test.ts` — Check both key file scopes.
- `apps/server/src/observability/RpcInstrumentation.ts` — Append the two key file RPCs to the AgentD group.
- `apps/server/src/ws.ts` — Append the thin key file check and fix handlers.
- `apps/web/src/lib/agentdState.ts` — Append the key file check hook and fix command.
- `apps/web/src/components/chat/useComposerMenuItems.ts` — Show Hand to a worker as `/hand-to-worker`, like every other built-in command, from our `handToWorkerSlashItem`.
- `apps/web/src/composer-logic.test.ts` — Check that `/hand` finds the item the menu shows.
- `apps/web/src/i18n/translations/de.json` — Add the new strings.
- `apps/web/src/i18n/translations/en.json` — Add the new strings (source catalog).
- `apps/web/src/i18n/translations/es.json` — Add the new strings.
- `apps/web/src/i18n/translations/fr.json` — Add the new strings.
- `apps/web/src/i18n/translations/ja.json` — Add the new strings.
- `apps/web/src/i18n/translations/ko.json` — Add the new strings.
- `apps/web/src/i18n/translations/pt-BR.json` — Add the new strings.
- `apps/web/src/i18n/translations/ru.json` — Add the new strings.
- `apps/web/src/i18n/translations/sv.json` — Add the new strings.
- `apps/web/src/i18n/translations/zh.json` — Add the new strings.
