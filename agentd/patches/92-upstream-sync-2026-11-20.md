# 92: Upstream sync 2026-11-20

Merges upstream T3 Code `badd5f6d18` (2026-11-19, "fix(relay): parse Hermes stack frames in linear time") into `main` at `efd5d05be7`, with a merge commit. This is the first sync since the fork at `f5f8c8d1`: 383 upstream commits, 266 of ours. Git merged about 1,150 files by itself. 76 conflicted and were resolved by [UPSTREAM.md](../UPSTREAM.md): ours for the name, product profile and hidden features, theirs for everything else with our change put back on top.

## Resolutions by area

- **Product name in server and package strings.** Most conflicts were upstream rewording a sentence we had renamed. Each took upstream's sentence and renamed it again: `KeepAwake.ts` (upstream's new `--what=sleep` inhibitor, `--who=AgentD Next`), `relayResponse.ts` (new key-mismatch hint), `CloudLink.ts` (new Live Activity message), `cli/environment.ts` (new `--from` batch link, `agentd-next pair`), `policyTemplates.ts`, `provider-cursor/adapter.ts` (agent name), `provider-pi/status.ts`, `apps/mobile/app.config.ts` (new `UIViewControllerBasedStatusBarAppearance`).
- **Code upstream moved or deleted.** We had only renamed text inside it, so upstream's version won: `cli/connect.ts` and `cli/project.ts` (session helpers replaced by the new `cli/runningServer.ts`, whose label is now `agentd-next cli`), `cloud/linkChecks.ts` (`canLinkHere` removed), `auth/EnvironmentAuth.ts` (revocation rewritten), `CodexAdapterV2.ts` (the shared `brokenRuntimeError`), `PullRequestWatchReactor.ts` (the shared `pullRequestWatchEndMessage`), `provider-muse/textGeneration.ts` (`museFailureDetail`), and `provider-opencode/OpenCodeRuntime.ts` and `versionProbe.ts` (minimum version now comes from the manifest).
- **Order in `ssh/tunnel.ts`.** Upstream's new `tar` check now runs before our release-source guard, so a host without tar is told so (upstream's test expects that).
- **Both sides added something.** Kept both:
  - managed policy `skillCatalog` (#91) and upstream's `previewTunnel` in `contracts/managedPolicy.ts`, `shared/managedPolicyFile.ts`, `policy/ManagedPolicy.ts`, `policyTemplates.ts` and `docs/user/managed-policy.md`.
  - settings `enableAgentOrchestrationTools` (#6) and `enablePreviewTunnel` in `contracts/settings.ts`.
  - the `DesktopHomeConfig` and `node:crypto` imports in `cli/theme.ts`.
  - our release-source guard and upstream's new `tar` check in `ssh/tunnel.ts`.
  - our `AGENTD_DESKTOP_HOME` reset (#66) and upstream's live-home guard in `scripts/dev-runner.ts`.
- **MCP tool and server names (#85, #86).** Taken from upstream, then renamed again:
  - the `background_wait` handler, which now uses `readsAsCaller`.
  - `mcp__agentd-next__` / `mcp__agentd_next__` in Pi's rewritten alias loading (`mcpExtensionSource.ts`, the alias is now `model-only`) and its tests.
  - `mcp_servers.agentd-next` in the Codex test.
  - `antigravityClientInfo` name `agentd-next`.
- **Web.**
  - `ChatView.tsx`: kept our `showCodeSurfaces` gate (#81) on the desktop menu-action effect, added upstream's `backgroundThread` and `rightPanel.close`.
  - `ThreadDetailsUsage.tsx`: kept both imports.
  - `ChatView.browser.test.tsx`: both new tests kept, ours first, as its comment requires.
- **Tests.**
  - `McpHttpServer.test.ts`: took upstream's forge-aware test and put back our browser-only token case and tool search layer (#6).
  - Replay tests and the eight Muse fixtures: upstream's new text (`resume it with SendMessage`, pull request tool guidance), with every `T3 Code` made `AgentD Next` as before.
  - `CloudLink.test.ts`, `AntigravityAcpSupport.test.ts`, `CodexAdapterV2.test.ts`: renamed again.
  - `agentContextBudget.json`: set to the values measured after the merge.
- **Docs and marketing.**
  - `remote-access.md`, `providers-fx.md`, `providers-antigravity.md`, `permission-modes.md`, `welcome-page.md`, `orchestrator-mcp-server.md`: upstream's new text with our names and without T3 Connect paragraphs.
  - `install.md` and `CONTRIBUTING.md`: ours, because we removed what upstream reworded (AUR/Nix; the model rule, #87).
  - Marketing locales: upstream's new translations, renamed.
  - `.github/triage/PLAYBOOK.md` and `triagePrompt.ts`: upstream's GraphQL template flow with our `<owner/repo>` / `<repo-url>` placeholders, kept byte-identical.
- **Upstream's AUR packaging removed.** `packaging/aur/` and `scripts/aur-release.test.ts` are deleted: the packages' release URLs point at upstream and we do not publish to the AUR.
- **Deleted files upstream changed.** `.github/VOUCHED.td` (#13) and `docs/user/guest-links.md` (#87) stay deleted.
- **Translation catalogs.** For web, mobile and desktop, both sides were merged, then regenerated with `gt generate`. Seven sentences new or renamed in this sync are translated in all nine locales (the hosted-relay scope and permission sentences, and mobile's "Update AgentD Next on {environment}" pair).

## Upstream text renamed after the merge

These lines merged without a conflict but named upstream, so they were renamed by the rules of #24, #67, #85 and #86:

- Agent-facing sender notes in `contracts/orchestrationV2.ts`, now `[AgentD Next: the agent in AgentD Next thread …]`, `[AgentD Next: scheduled task …]` and `… came through AgentD Next's tools …`. Their tests and the `delegated_task_status` Codex fixture follow.
- Server and CLI text in `cli/auth.ts`, `cli/runningServer.ts`, `preview/PreviewTunnel.ts`, `pullRequestWatch.ts`, `AntigravityInstallation.ts`, `provider-core` `compatibility.ts` and `failure.ts`, `provider-muse` and `provider-pi` text generation.
- Hosted relay wording in `shared/authScopeOptions.ts`, `useCloudLinkController.ts`, `SavedEnvironmentRows.tsx`, and mobile `LocalPreviewRouteScreen.tsx`.
- `t3_*` tool names in upstream's new tests (`core.test.ts`, `project/handlers.test.ts`, `RemoteDelegation.test.ts`, `AntigravityAdapterV2.test.ts`, `SelectionRestart.integration.test.ts`), the `project_update` hint in `project/handlers.ts`, and `mcp__agentd-next__` in `evals/mcp-tool-use/run.test.ts`.
- `SECURITY.md` is new upstream: the trust model that upstream's `AGENTS.md` now points to. It is kept, but its first paragraph names our own address for private reports instead of upstream's.

Kept on purpose, as before: Codex's `originator: "T3 Code"` in fixtures, `t3_session`, `<t3_code_instructions>`, `t3_code_orchestration`, the legacy `t3-code` alias cases in `runtimeModel.test.ts` and `htmlRender.test.ts`, `T3 Code · …` peer labels in test data, and `pingdotgg/…` URLs in test data.

## New upstream features and the product profile

`productProfile` is unchanged, and every gate it had still applies (`git grep productProfile.` lists the same places). New upstream features that fall in hidden areas need no new gate:

- The issues list's project chooser (#38799) and a fork's upstream issues (#39159) live on the Issues page, which still redirects while `issues` is off.
- Linking several environments at once (#39426) is the `environment link --from` CLI and Sharing & access, which stays hidden.
- The preview tunnel setting and policy (#39415), and port forwarding from another environment (#39393), are remote features. They stay on, like the rest of remote access.

The thread panel upstream renamed from "Pull requests" to "Linked items" now also lists a thread's linked issues. It appears only when a thread has a linked issue, so it is not gated (see open questions).

## Patches rewritten by this sync

- #24 / #86 in `provider-opencode/OpenCodeRuntime.ts` and `versionProbe.ts`: upstream removed the "requires OpenCode v…" sentences we had renamed, so nothing is left to change. These files are upstream's again.
- #67 / #86 in `cli/project.ts`, and #85 in `cloud/linkChecks.ts`: the renamed code is gone upstream. Its label lives on in `cli/runningServer.ts` (`agentd-next cli`).
- #5 / #81 in `ChatView.tsx`: the menu-action gate is now `!showCodeSurfaces || backgroundThread`.
- #6 in `McpHttpServer.test.ts`: our browser-only case moved into upstream's rewritten test.

## Checks

After the merge these pass: `vp run typecheck`, `pnpm lint`, `node scripts/i18n-check.ts`, web unit tests (5754), server tests (9393 passed, 16 skipped, 539 files) and the tests of the packages touched here (contracts, provider-pi, -muse, -core, -cursor, -opencode, -acp, shared).

`agentContextBudget.json` went up from main's 5918 / 7323 / 52022 bytes to 6233 / 7638 / 57198. The growth is upstream's new agent instructions and tools, and these figures are below upstream's own. In `packages/ssh`, two tunnel tests time out at 5 s ("waits for a boot service between two servers (archive: true)" and "concurrent launches on one remote home …"). They time out on `main` before this merge too, along with a third, so this merge did not cause them. No test was weakened or skipped; changed expectations only carry the product name or the renamed tool names. `EULA*`, `LICENSE` and `README.md` are untouched.

## Open questions

- Should the "Linked items" panel hide linked issues while `productProfile.issues` is off?
- Marketing locales still say "t3.codes is the only official download site". This was already in our tree before the sync and needs its own change.
- `remote-access.md` still says "a machine on an older T3 Code", which was also on our side before. The new upstream docs that merged without a conflict were not swept for the product name.
