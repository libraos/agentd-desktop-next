import * as Schema from "effect/Schema";

// The Skills catalogue: Skills from public repositories, each pinned to one commit, that the app
// can install into Claude Code's and Codex's user Skills folders and remove again.

export const AgentdSkillAgent = Schema.Literals(["claude", "codex"]);
export type AgentdSkillAgent = typeof AgentdSkillAgent.Type;

/** managed: installed by the catalogue (its manifest is there); manual: a folder put there by hand. */
export const AgentdSkillInstallState = Schema.Literals(["managed", "manual", "absent"]);
export type AgentdSkillInstallState = typeof AgentdSkillInstallState.Type;

export const AgentdSkillAgentState = Schema.Struct({
  agent: AgentdSkillAgent,
  state: AgentdSkillInstallState,
  /** The commit a managed install came from; it differs from the catalogue's after an update. */
  commit: Schema.optionalKey(Schema.String),
});
export type AgentdSkillAgentState = typeof AgentdSkillAgentState.Type;

export const AgentdSkillListing = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  repository: Schema.String,
  commit: Schema.String,
  agents: Schema.Array(AgentdSkillAgentState),
});
export type AgentdSkillListing = typeof AgentdSkillListing.Type;

export const AgentdSkillCatalogSource = Schema.Literals(["fetched", "cache", "none", "off"]);
export type AgentdSkillCatalogSource = typeof AgentdSkillCatalogSource.Type;

export const AgentdSkills = Schema.Struct({
  /** fetched today, the cache (fresh, or the fetch failed), none (no cache and the fetch failed), off (policy). */
  source: AgentdSkillCatalogSource,
  /** When the catalogue served was fetched, ISO 8601. */
  fetchedAt: Schema.optionalKey(Schema.String),
  /** The organization whose policy turned the catalogue off. */
  organization: Schema.optionalKey(Schema.String),
  skills: Schema.Array(AgentdSkillListing),
});
export type AgentdSkills = typeof AgentdSkills.Type;

export const AgentdSkillInput = Schema.Struct({
  name: Schema.String,
  agent: AgentdSkillAgent,
});
export type AgentdSkillInput = typeof AgentdSkillInput.Type;

export const AgentdSkillInstallInput = Schema.Struct({
  name: Schema.String,
  agent: AgentdSkillAgent,
  /** Replace a folder of the same name that the catalogue did not install. */
  replace: Schema.optionalKey(Schema.Boolean),
});
export type AgentdSkillInstallInput = typeof AgentdSkillInstallInput.Type;

export const AgentdSkillErrorReason = Schema.Literals([
  "policy",
  "unknown",
  "conflict",
  "download",
  "unsafe",
  "filesystem",
]);
export type AgentdSkillErrorReason = typeof AgentdSkillErrorReason.Type;

export class AgentdSkillError extends Schema.TaggedError<AgentdSkillError>()("AgentdSkillError", {
  reason: AgentdSkillErrorReason,
  message: Schema.String,
}) {}
