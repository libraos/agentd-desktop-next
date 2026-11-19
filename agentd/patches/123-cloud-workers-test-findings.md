# 123 Cloud Workers test findings

Ten findings from testing 0.1.10-agentd.7 on macOS. Our own files carry most of it (`apps/server/src/agentd/`, `apps/web/src/components/agentd/`). agentd's services are re-registered only through the bundled agentd's own `install` and `dash install`, never by writing plists, units or tasks. The key file prefix check reads ten bytes and returns only the provider's name; agentd-core#978 moves it into agentd, and its answer replaces this one then. agentd has no writable `cloud.anthropic_key_file` / `cloud.openai_key_file`, so the last submitted BYOK paths are kept in app settings.

- `packages/contracts/src/agentd.ts` — Append the key file check, the services repair on status, `unreachable` on cloud setup and `privateFile` on refusals.
- `packages/contracts/src/rpc.ts` — Append the key file check and fix RPCs.
- `packages/contracts/src/clientRpcPermissions.ts` — Give making a key file private the operate scope Start has.
- `packages/contracts/src/settings.ts` — Append the remembered BYOK key file paths per environment.
- `packages/client-runtime/src/state/agentd.ts` — Append the key file check query and fix command.
- `apps/server/src/auth/RpcAuthorization.ts` — Give the key file check the read scope cloud setup has.
- `apps/server/src/observability/RpcInstrumentation.ts` — Append the two key file RPCs to the AgentD group.
- `apps/server/src/ws.ts` — Append the thin key file check and fix handlers.
- `apps/web/src/lib/agentdState.ts` — Append the key file check hook and fix command.
- `apps/web/src/components/chat/useComposerMenuItems.ts` — Show Hand to a worker as `/hand-to-worker`, like every other built-in command.
- `apps/web/src/composer-logic.test.ts` — Check that `/hand` finds it.
- `apps/web/src/i18n/translations/*.json` — Add the new strings in every locale.
