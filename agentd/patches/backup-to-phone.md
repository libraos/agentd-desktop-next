# Backup to a paired phone (server side)

A paired device asks for a backup of agentd's ledger with `agentd.backupCreate`, naming an age public key (age1...) it made and keeps the private key of. The server runs `agentd backup create --recipient` (agentd-core#1008) into its own `agentd-backups` folder, keeps only the newest backup there, and answers with the file's size, SHA-256 and a signed download URL. No secret reaches this host, and the file opens only with the device's private key.

New files (not upstream): `apps/server/src/agentd/agentdBackup.ts`.

Upstream files changed:

- `packages/contracts/src/assets.ts`: the `agentd-backup` asset resource and its file name pattern.
- `packages/contracts/src/rpc.ts`: the `agentd.backupCreate` method, its RPC and its entry in `WsRpcGroup`.
- `packages/contracts/src/clientRpcPermissions.ts`: `filesystem:read` for `agentd.backupCreate`, since a backup is the whole ledger encrypted to a key the caller chooses.
- `apps/server/src/auth/RpcAuthorization.ts`: `filesystem:read` for an `agentd-backup` asset URL.
- `apps/server/src/assets/AssetAccess.ts`: the `agentd-backup` claim, signed by name and served as a download only while that file is in the backups folder and matches the pattern.
- `apps/server/src/ws.ts`: the handler (bridge, then signed URL) and `agentd-backup` among the assets signed without a thread.
- `apps/server/src/observability/RpcInstrumentation.ts`: the `agentd` trace aggregate for the method.
- `packages/client-runtime/src/state/assets.ts`: an `agentd-backup` asset needs file access, as other host files do.

Not in this change: the phone's screen (key generation and keeping it in the system key store, download, SHA-256 check), restore onto a new computer, and translations. Verified on Linux with agentd built from agentd-core#1008; not verified on Windows or macOS.
