import { describe, expect, it } from "@effect/vitest";

import { cloudJobNote } from "./agentdCloud.ts";
import { CLOUD_REASONS, cloudReason } from "./cloudFailure.ts";

describe("cloudJobNote", () => {
  it.each([
    ["failed", "OAuth access token is invalid (401)", CLOUD_REASONS.subscriptionSignIn],
    ["failed", "API Error: 401 authentication_error", CLOUD_REASONS.subscriptionSignIn],
    ["failed", "claude subscription jobs are not enabled", CLOUD_REASONS.subscriptionUnavailable],
    ["failed", "ChatGPT subscription jobs are not enabled", CLOUD_REASONS.chatgptUnavailable],
    [
      "failed",
      "Codex could not sign in with your ChatGPT login (expired or revoked)",
      CLOUD_REASONS.chatgptSignIn,
    ],
    ["failed", "your ChatGPT plan's usage limit was reached", CLOUD_REASONS.chatgptLimit],
    // A BYOK job runs Codex on an API key: its sign-in failure is the provider's, not ChatGPT's.
    ["failed", "codex could not sign in: invalid api key", CLOUD_REASONS.providerSignIn],
    ["failed", "the GitHub App is not installed on acme/app", CLOUD_REASONS.repository],
    ["failed", "check exited 1", CLOUD_REASONS.check],
    ["failed", "git push refused by GitHub", CLOUD_REASONS.push],
    ["failed", "Job API 502", "The cloud worker could not finish the task."],
    ["budget_exceeded", "", "The task reached its spending limit."],
    // A path naming byok or cloud-key is not a key or setup problem.
    [
      "failed",
      "wrote /home/me/byok/cloud-key/out.log",
      "The cloud worker could not finish the task.",
    ],
    ["submitting", "402: insufficient credit", CLOUD_REASONS.credit],
    ["running", "runner starting, timed out once", null],
    ["completed", "the GitHub App is not installed on acme/app", CLOUD_REASONS.repository],
  ] as const)("%s: %s", (state, message, note) => {
    expect(cloudJobNote(state, [message])).toBe(note);
  });
});

describe("cloudReason", () => {
  it.each([
    [
      "--model-access subscription needs your Claude token: run claude setup-token on your own machine",
      CLOUD_REASONS.subscriptionToken,
    ],
    [
      "--model-access subscription needs your ChatGPT login: run codex login, then pass --codex-auth-file FILE",
      CLOUD_REASONS.chatgptAuth,
    ],
    [
      "both cloud.claude_token_file and cloud.codex_auth_file are set: pass --claude-token-file or --codex-auth-file",
      CLOUD_REASONS.pickPlan,
    ],
    [
      "cloud.claude_token_file must hold the token from claude setup-token (it starts sk-ant-oat) alone, on one line",
      CLOUD_REASONS.subscriptionTokenFormat,
    ],
  ] as const)("%s", (message, reason) => {
    expect(cloudReason(message)).toBe(reason);
  });
});
