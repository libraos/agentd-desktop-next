# 123 Cloud Workers test findings

Ten findings from testing 0.1.10-agentd.7 on macOS. Our own files carry most of it (`apps/server/src/agentd/`, `apps/web/src/components/agentd/`). agentd's services that run a missing agentd or the old AgentD Desktop's are only detected and named on the AgentD page; nothing moves them on its own. Its Repair button, after the user confirms what changes, runs the app's agentd's own `install` (and `dash install` for a Linux dash), never writing plists, units or tasks. Repair isn't offered when that agentd is in an AppImage mount with no installed copy, or when install would also move a service on the user's own working agentd. The key file prefix check reads the first 4 KiB and returns only the provider's name, or none when the bytes can't tell, and Start names the wrong provider only to a connection with filesystem read; agentd-core#978 moves it into agentd, and its answer replaces this one then. agentd has no writable `cloud.anthropic_key_file` / `cloud.openai_key_file`, so the last submitted BYOK paths are kept in app settings, merged at each settings write.

- `packages/contracts/src/agentd.ts` — Append the key file check, the quoted `chmod 600` command it suggests, the services problem on status and the Repair result, `unreachable` and `checkoutUnknown` on cloud setup and `privateFile` and `wrongKeyFile` on refusals.
- `packages/contracts/src/rpc.ts` — Append the key file check and fix RPCs and the services Repair RPC.
- `packages/contracts/src/clientRpcPermissions.ts` — Give making a key file private the environment maintain scope: it reaches host files outside the workspaces that filesystem write covers. Repairing agentd's services gets the same scope: it rewrites host services.
- `packages/contracts/src/settings.ts` — Append the remembered BYOK key file paths per environment.
- `packages/client-runtime/src/state/agentd.ts` — Append the key file check query, fix command and services Repair command.
- `apps/server/src/auth/RpcAuthorization.ts` — Give the key file check the filesystem read scope, as browsing files has.
- `apps/server/src/auth/RpcAuthorization.test.ts` — Check both key file scopes and the Repair scope.
- `apps/server/src/observability/RpcInstrumentation.ts` — Append the two key file RPCs and Repair to the AgentD group.
- `apps/server/src/ws.ts` — Append the thin key file check, fix and Repair handlers; Start's wrong-provider error is made generic for a connection without filesystem read.
- `apps/web/src/clientPersistenceStorage.ts` — Keep stored BYOK key paths under the incoming ones on write, so two tabs can't erase each other's.
- `apps/desktop/src/settings/DesktopClientSettings.ts` — Serialize writes and keep stored BYOK key paths under the incoming ones, so two windows can't erase each other's.
- `apps/desktop/src/settings/DesktopClientSettings.test.ts` — Check two windows' concurrent saves keep both paths.
- `apps/web/src/lib/agentdState.ts` — Append the key file check hook, fix command and Repair command.
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
