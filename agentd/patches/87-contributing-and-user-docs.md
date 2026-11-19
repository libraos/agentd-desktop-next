# 87: Contributing guide and user docs name AgentD Next

`CONTRIBUTING.md` was upstream's: it described another project, turned contributions away, told AI
models to decline pull requests and linked upstream's discussions. `docs/user` named the product
"T3 Code" throughout. Docs only; no code changes.

## Files changed

- `CONTRIBUTING.md`: rewritten for this repository: issues, pull requests and the template, the checks
  from AGENTS.md, where AGENTS.md and agentd/UPSTREAM.md are, the fork and the MIT licence. The
  `one-problem` and `verification` anchors stay, since AGENTS.md links the first.
- `docs/user/*.md`: "T3 Code" as the product is "AgentD Next" ("a" became "an"). Bold UI labels and
  quoted messages use what the app shows today, "AgentD Desktop" (patches 24, 67, 85). Unchanged:
  environment variables (`T3CODE_*`), commands (`t3 ...`), paths, URLs, and upstream install names
  (`T3 Code (Alpha)`, `T3 Code (Beta).app`).
- `agentd/design/upstream-only-docs.txt`: the pages that are, or have sections, about upstream-only
  services (T3 Connect, the hosted app at app.t3.codes, T3 Chat accounts, upstream's store apps and
  release channels). Their upstream-only paragraphs are left as they were, for a keep-or-remove
  decision; the rest of those pages is renamed.

## Not changed

`LICENSE`, `README.md` and the EULA.
