# A local branch picked as a New worktree base is used

Issue: when a new thread used New worktree and the local default branch was ahead of its remote, the branch control read "From master (remote)". Picking the local `master` did not change the label, and the worktree still started at `origin/master`. The cause is upstream's "Start from remote" switch in the branch picker. It follows the `newWorktreesStartFromOrigin` setting, which is on by default. Picking a local ref left the switch on, and the server fetched and used the remote commit as it is meant to when the switch is on.

The default stays as upstream has it. Only the explicit pick changes:

- **Picking a local branch** as the base turns Start from remote off, so the worktree starts at that branch's local commit. The person can turn the switch back on in the same popup.
- **Picking a remote ref** (`origin/master`) leaves the switch as it was. That is today's behaviour.
- **Label.** A local base reads "From master (local)" when the repository has a remote, and "From master (remote)" while the switch is on. A repository with no remote, and a remote ref, keep "From master".
- **Ahead notice.** When the switch is on and the base is the branch checked out at the project root, the picker's popup says "Local master is N commits ahead of the remote". The count is the project status's ahead count against the branch's upstream. A branch that is not checked out at the root has no count, so it gets no notice.

The server needed no change. With `startFromOrigin: false` it already creates the worktree at the named local branch.

Upstream files changed:

- `apps/web/src/components/BranchToolbar.logic.ts`: `resolveStartFromOriginAfterBasePick`, `resolveLocalBaseAheadCount`, and the "(local)" label in `resolveBranchTriggerLabel` (new optional `hasRemote`).
- `apps/web/src/components/BranchToolbar.logic.test.ts`: rows for the pick rule, the label and the ahead count.
- `apps/web/src/components/BranchToolbarBranchSelector.tsx`: a base pick applies the rule, passes `hasRemote` to the label and shows the ahead notice.
- `apps/web/src/components/WorktreeBaseBranchPicker.tsx` (the scheduled task base picker): the same pick rule and label.
- `apps/web/src/components/WorktreeBaseBranchPicker.browser.test.tsx`: picking local `main` turns the switch off and the label reads local. Picking `origin/main` leaves the switch alone. Remote refs in the fixture are now marked `isRemote`.
- `apps/web/src/i18n/translations/*.json`: two new strings, translated in every locale.

Not verified:

- In a running app. Covered by the picker browser test, the logic tests and typecheck. The composer's call site has no browser test of its own: it uses the same tested rule.
