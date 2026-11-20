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

export const AgentdSkillGroup = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type AgentdSkillGroup = typeof AgentdSkillGroup.Type;

export const AgentdSkillSource = Schema.Struct({
  /** The Skill's git repository. */
  url: Schema.String,
  /** The Skill's folder in that repository. */
  path: Schema.String,
  /** The reviewed commit; only this commit is installed. */
  sha: Schema.String,
  /** Licence and notice files elsewhere in the repository that are installed with the Skill. */
  notices: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type AgentdSkillSource = typeof AgentdSkillSource.Type;

export const AgentdSkillListing = Schema.Struct({
  /** Also the Skill's folder name in each agent's Skills folder. */
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  /** A group id from `groups`. */
  group: Schema.String,
  author: Schema.String,
  /** SPDX identifier of the Skill's licence at the reviewed commit. */
  licence: Schema.String,
  /** The date the reviewed commit was signed off, YYYY-MM-DD. */
  reviewedAt: Schema.String,
  source: AgentdSkillSource,
  /** Only the agents the entry supports, each with its install state. */
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
  groups: Schema.Array(AgentdSkillGroup),
  skills: Schema.Array(AgentdSkillListing),
});
export type AgentdSkills = typeof AgentdSkills.Type;

export const AgentdSkillInput = Schema.Struct({
  id: Schema.String,
  agent: AgentdSkillAgent,
});
export type AgentdSkillInput = typeof AgentdSkillInput.Type;

export const AgentdSkillInstallInput = Schema.Struct({
  id: Schema.String,
  agent: AgentdSkillAgent,
  /** Replace a folder of the same name that the catalogue did not install. */
  replace: Schema.optionalKey(Schema.Boolean),
});
export type AgentdSkillInstallInput = typeof AgentdSkillInstallInput.Type;

export const AgentdSkillErrorReason = Schema.Literals([
  "policy",
  "unknown",
  "unsupported",
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
