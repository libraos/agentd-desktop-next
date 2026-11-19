# #76 — Windows: no console windows from the app, and installers always carry agentd

## Files changed

Ours:

- `apps/desktop/src/app/DesktopCliCommand.ts` — `windowsHide: true` on the PowerShell that reads and writes the user PATH.
- `apps/desktop/src/backend/agentdInstall.ts` — `windowsHide: true` on the PowerShell that adds agentd's folder to the user PATH after consent.
- `apps/desktop/src/backend/agentdBinary.ts` — `windowsHide: true` on `agentd version`; adds `AGENTD_BUNDLED_ENV` (`AGENTD_DESKTOP_BUNDLED`).
- `apps/server/src/agentd/AgentdTeamNode.ts` — `windowsHide: true` on the team-node worker it starts.
- `apps/server/src/agentd/AgentdBridge.ts` — `AgentdNotFoundError` says `bundled: true` when the desktop app carries agentd.
- `apps/server/src/agentd/AgentdBridge.test.ts` — the not-found case also checks the bundled flag.
- `apps/web/src/components/agentd/AgentdPage.tsx`, `apps/web/src/components/agentd/BackgroundTasksPane.tsx` — with a bundled agentd, say to reinstall AgentD Desktop instead of linking agentd's install guide.

Upstream, one or two lines each:

- `scripts/build-desktop-artifact.ts` — a build without `AGENTD_DIST_DIR` fails before it starts (`AgentdCliMissingError`, which says how to stage agentd) unless `AGENTD_ALLOW_NO_BUNDLE=1`.
- `scripts/build-desktop-artifact.test.ts` — the staging test expects that failure, and the opt-out builds without agentd.
- `packages/contracts/src/agentd.ts` — optional `bundled` on `AgentdNotFoundError`.
- `apps/desktop/src/backend/DesktopBackendConfiguration.ts` — sets `AGENTD_DESKTOP_BUNDLED=1` beside `AGENTD_BIN` when the app carries agentd.
- `apps/server/src/serviceLauncher.ts` — `windowsHide: true` on the PowerShell that reads a legacy owner's start time, and on the runtime child it starts.
- `apps/server/src/speech/native.ts` — `windowsHide: true` on both speech worker spawns.
- `apps/server/src/process/externalLauncher.ts` — editor launches through a `.cmd`/`.bat` shim (`shell: true`) are hidden. Effect turns `windowsHide` off for detached children, and the editor launch is detached.

## Spawn sites checked

Node's `child_process` shows a console window on Windows unless `windowsHide` is set. That happens when a console program starts from a process that has no console of its own, and the desktop backend (Electron with `ELECTRON_RUN_AS_NODE`) has none. Effect's spawner sets `windowsHide: !detached`. Every Effect spawn that is not detached was already hidden: the desktop's spawner, the server's `SpawnWorker` and `NonBlockingSpawner`, `ProcessRunner` (all `AgentdBridge` calls to agentd), `DesktopBackendManager`, WSL, the shell environment probe, the browser-import probes, and `KeepAwake`, `ManagedEndpointRuntime`, `LocalDeviceHost` and the provider spawns.

- Already explicit: `SpawnWorker` taskkill, `ClaudeProvider` and `ClaudeAdapterV2` Windows spawns, `DocumentText`, `GitVcsDriverCore` (detached), the `shell.ts` Windows env probe, `uninstall.ts`, and `serviceLauncher` schtasks.
- Made explicit here, though already hidden by Effect's default: the PATH PowerShell calls in `DesktopCliCommand.ts` and `agentdInstall.ts`, `agentd version` in `agentdBinary.ts`, and the team node in `AgentdTeamNode.ts`.
- Fixed (were not hidden): `serviceLauncher.ts`'s PowerShell `Get-Process` and runtime child, `speech/native.ts`, and editor launches through cmd shims.
- `agentd init` (`agentdInit.ts`) runs in node-pty. On Windows, node-pty uses ConPTY, which creates no window.
- Left as they are, with the reason:
  - `windowsVerbatimSpawn.ts` (explorer `/select`) and detached editor `.exe` launches are GUI programs that make no console. Hiding them could hide the window they exist to show.
  - The snapshot forks (`GlobalShiftShortcutProcess`, `RegionSnapShot`, `SnapShotAccessibilityProcess`) run the app's own Electron executable, a GUI-subsystem binary that never gets a console, and `fork()`'s types take no `windowsHide`.
  - POSIX-only sites never run on Windows: `ClaudeAdapterV2` `/bin/sh`, `noCopyOnWrite`, `envTrampoline`, `os-jank` login shell, `serviceLauncher` systemctl/busctl/cp, the macOS and Linux snapshot helpers, and `hyprctl`.
  - `cli/triage.ts` and `AgentDeviceShim` run from a terminal. `sshDeviceScript` and `deviceToolMaintenance` run on a device host under a node that was started hidden, and their children share its hidden console.
- agentd's own children (workers, PowerShell in agentd) belong to agentd, not this repository.

## Bundled agentd

`agentd/scripts/build-desktop.sh` (#72) already sets `AGENTD_DIST_DIR`, so its builds are unchanged. Any other packaging run now needs `AGENTD_DIST_DIR`, or `AGENTD_ALLOW_NO_BUNDLE=1` for a local development build. With a bundle, the desktop sets `AGENTD_BIN` and `AGENTD_DESKTOP_BUNDLED=1` for its backend. A missing agentd then reads "reinstall AgentD Desktop", not the install guide. A remote environment's server has no such flag and still shows the guide. The bundled install after consent copies the binary, places Skills, and runs `agentd version` and the PATH PowerShell, all hidden.

## Linux and macOS

`windowsHide` is ignored off Windows, so spawn behaviour there is unchanged. The new environment variable and the build requirement apply on every platform.

## Not verified without a Windows desktop

I had no Windows desktop, so I did not see these windows stay hidden. Unverified:

- the PowerShell PATH calls
- the service launcher's PowerShell
- the speech workers
- an editor opened through a cmd shim (does the editor still come to the front, with only cmd.exe hidden?)
- the bundled install after consent
- ConPTY for `agentd init`

The reasoning above rests on Node's and Effect's documented `windowsHide` behaviour. Only the build check and the bundled flag have tests, both run on Linux.
