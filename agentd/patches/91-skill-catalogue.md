# 91: Skills catalogue: install pinned Skills for Claude Code and Codex, and remove them

The server can list a catalogue of Skills from public repositories, install one into Claude Code's or Codex's user Skills folder, and remove it again. Each Skill is pinned to one commit. This pass has no UI. The three RPCs are there for the web client and agents.

New, ours:

- `agentd/skills/catalog.json`: the catalogue. Six Apache-2.0 Skills from `anthropics/skills`, each at one commit. `canvas-design` also takes the repository's `THIRD_PARTY_NOTICES.md` (its fonts). The server fetches it from this repository's `main` on GitHub.
- `packages/contracts/src/agentdSkills.ts`: the listing (per agent: `managed`, `manual` or `absent`), the inputs and `AgentdSkillError`.
- `apps/server/src/agentd/skillCatalog.ts`: the pure parts. Catalogue validation (names, `owner/repo`, a 40-hex commit, safe paths, no duplicate). `safeRelativePath` refuses `..`, absolute paths, drives, backslashes, colons, control characters, Windows reserved names, and trailing dots or spaces. It also covers the day rule, the Skills folders and planning the files from the commit's git tree. Planning refuses the whole Skill on a symlink, a submodule, an unsafe path, a case clash or a file named like the manifest, and when git cut the listing short or the Skill passes the size limits.
- `apps/server/src/agentd/AgentdSkills.ts`: the service.
  - **Catalogue.** At most one request a day, counting failed attempts. The result is cached in `<stateDir>/skills/catalog.json`. A failed or invalid fetch serves the cache.
  - **Install.** A managed folder that holds files the catalogue did not write is updated only with `replace`. Lists the commit's tree from `api.github.com` and fetches each file from `raw.githubusercontent.com`. Each file is checked against its git blob id, all in memory. Only then does it write a staging folder beside the target, with the manifest `.agentd-skill.json` that lists every file written. The staging folder is then renamed into place, and a managed folder it replaces is set aside and put back if the rename fails. A folder without our manifest (or a symlink) is `manual`, and install refuses it without `replace`.
  - **Remove.** Deletes only the manifest's files that still resolve inside the folder, then the manifest, then folders left empty.
- `apps/server/src/agentd/skillCatalog.test.ts`, `AgentdSkills.test.ts`: path safety, Windows, Linux and macOS folders, catalogue validation, planning refusals, the day rule with the cache fallback, policy off with no request, conflict and replace, nothing written after a missing commit, a mismatched or failed file, an escaping path or a symlink, an update that fails leaving the old install whole, and remove leaving files it did not write.

Upstream files changed:

- `packages/contracts/src/managedPolicy.ts`: `limits.skillCatalog` (`false` turns the catalogue off), also in the summary clients see.
- `packages/contracts/src/rpc.ts`: `agentd.skillsList`, `agentd.skillsInstall`, `agentd.skillsRemove`.
- `packages/contracts/src/clientRpcPermissions.ts`: install and remove need environment maintain.
- `packages/contracts/src/index.ts`: exports `agentdSkills.ts`.
- `packages/shared/src/managedPolicyFile.ts`: the `SkillCatalog` registry value on Windows.
- `apps/server/src/policy/ManagedPolicy.ts`: `deniedBy` takes `skillCatalog`, and the summary copies it.
- `apps/server/src/policy/policyTemplates.ts`: the administrative template's "Allow the Skills catalogue".
- `apps/server/src/auth/RpcAuthorization.ts`: list needs orchestration read.
- `apps/server/src/observability/RpcInstrumentation.ts`: the three methods under `agentd`.
- `apps/server/src/ws.ts`, `apps/server/src/server.ts`: handlers and the layer.
- `apps/server/src/ws.test.ts`: the service mocked like `AgentdInit`.
- `docs/user/managed-policy.md`: the `skillCatalog` limit.

Paths: Claude Code `CLAUDE_CONFIG_DIR` or `~/.claude`, then `skills`. Codex `~/.agents/skills`, as `install.sh` and patch 55 write them. Paths are built with the host OS's path functions, and the Windows forms are unit-tested on Linux. Not verified on Windows or macOS hardware: the rename into place over an existing folder, which is held open by another process on Windows. Linux: the service tests run against a scratch home.
