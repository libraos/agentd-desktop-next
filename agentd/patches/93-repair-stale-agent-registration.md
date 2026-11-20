# 93: Repair an agent's agentd registration whose command is gone

`agentd connect <agent>` writes the path of the agentd that ran it into the agent's user config. When that agentd moves (an earlier product's install folder, `resources/bin/`, against AgentD Next's `resources/agentd/`), the agent can no longer start agentd's MCP server, and `agentd doctor --json` fails the agent's `<agent>-mcp` check with `server NAME runs "PATH", which is not there`.

New, ours:

- `apps/server/src/agentd/agentdJson.ts`: `isStaleCommandDetail`, the one place that matches doctor's detail (the check id alone also fails for "not registered"; the path is Go-quoted, so Windows backslashes come escaped), and `staleRegistrations`, the agents whose `claude-mcp`, `codex-mcp` or `opencode-mcp` check fails that way.
- `apps/server/src/agentd/AgentdBridge.ts`: the status read runs `agentd connect <agent>` with the agentd the server runs, for each such agent, at most once per agent per server run, then reads doctor again. A never-made registration, one whose command is there, and an agentd that is not set up are left alone. A failed connect, or a check that still fails, keeps the needs-attention state and is not tried again. The app reads and writes no agent config itself.
- `apps/server/src/agentd/AgentdBridge.test.ts`: Windows, Linux and macOS path forms repaired once, a failed repair not retried, and passing or never-registered checks (and a stale hook, a different check) left alone.

Upstream files changed:

- `docs/user/install.md`: three sentences on the repair.
