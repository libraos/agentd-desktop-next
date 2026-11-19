// One-line reasons for Cloud Workers refusals and failed jobs, from agentd's own wording. Each
// pattern is anchored to a phrase agentd prints, so a path or project name that happens to contain
// "byok", "cloud-key" or "[cloud]" is not read as a setup or credential problem.

export type CloudProblem = "setup" | "credit" | "repository";

export const CLOUD_REASONS = {
  setup: "Cloud Workers aren’t set up. Check the cloud configuration and account key file.",
  credit: "There is not enough LibraOS credit for this dollar cap.",
  repository: "The repository owner must install the Cloud Workers GitHub App on this repository.",
  keyFile:
    "AgentD couldn’t use the provider key files. Check their paths, contents and permissions.",
  privateFile: "Choose a credential file that only your account can access.",
  subscriptionUnavailable:
    "Running on your Claude subscription isn’t available yet. Use LibraOS or your API key.",
  subscriptionSignIn: "Your Claude subscription sign-in isn’t valid. Set it up again.",
  subscriptionLimit:
    "Your Claude plan reached its usage limit. Wait for it to reset before trying again.",
  subscriptionToken:
    "Your Claude subscription isn’t set up. Run claude setup-token in a terminal and save the token in a private file.",
  subscriptionTokenFormat:
    "Your Claude token file doesn’t hold a token from claude setup-token. Run claude setup-token in a terminal and save the token alone in the file.",
  chatgptUnavailable:
    "Running on your ChatGPT plan isn’t available yet. Use LibraOS or your API key.",
  chatgptSignIn: "Your ChatGPT sign-in for Codex isn’t valid. Run codex login again.",
  chatgptLimit:
    "Your ChatGPT plan reached its usage limit. Wait for it to reset before trying again.",
  chatgptAuth: "Your ChatGPT plan isn’t set up for Codex. Run codex login in a terminal.",
  pickPlan: "Both a Claude and a ChatGPT plan are set up. Choose the plan for this task.",
  teamServer: "Submit cloud tasks from a local AgentD session, not through a team server.",
  providerSignIn:
    "The cloud worker could not sign in to the model provider. Check your model access before trying again.",
  checkFiles:
    "The cloud task changed files used by its check. Review the branch before trying again.",
  check: "The changes did not pass the check.",
  environment: "The cloud worker lost its environment. You can try the task again.",
  time: "The cloud worker ran out of time.",
  push: "The cloud worker could not save its branch to GitHub.",
  submit: "AgentD couldn’t submit this task to Cloud Workers.",
} as const;

const STATE_REASONS: Readonly<Record<string, string>> = {
  failed: "The cloud worker could not finish the task.",
  failed_verification: CLOUD_REASONS.check,
  budget_exceeded: "The task reached its spending limit.",
  settlement_conflict: "Cloud billing could not confirm the final cost.",
  cancelled: "The task was cancelled.",
};

export function cloudSetupProblem(message: string): CloudProblem | null {
  if (
    /GitHub App is not installed|github[ _-]app.*(?:not installed|not configured)|repo(?:sitory)?[ _]not[ _]allowed/i.test(
      message,
    )
  )
    return "repository";
  if (
    /set \[cloud\] url|cloud_not_configured|agentd access revoked|cloud\.key_file\b.*(?:no such file|not found|does not exist|missing|failed to read|cannot be read)|\[cloud\] key_file\b.*(?:no such file|not found|does not exist|missing|failed to read|cannot be read)/i.test(
      message,
    )
  )
    return "setup";
  if (/insufficient[ _]credit/i.test(message)) return "credit";
  return null;
}

/** A specific reason for agentd's message, or null when it names nothing this app recognises. */
export function cloudReason(message: string): string | null {
  const setup = cloudSetupProblem(message);
  if (setup !== null) return CLOUD_REASONS[setup];
  if (/can be read or written by others|belongs to another user/i.test(message))
    return CLOUD_REASONS.privateFile;
  const chatgpt = chatgptReason(message);
  if (chatgpt !== null) return chatgpt;
  if (/must hold the token from claude setup-token/i.test(message))
    return CLOUD_REASONS.subscriptionTokenFormat;
  if (/subscription needs your Claude token|needs cloud\.claude_token_file/i.test(message))
    return CLOUD_REASONS.subscriptionToken;
  if (
    /OAuth access token is invalid|could not sign in with your Claude subscription|subscription sign-?in/i.test(
      message,
    ) ||
    (/\b(?:OAuth|authentication_error)\b/i.test(message) && /\b401\b/.test(message))
  )
    return CLOUD_REASONS.subscriptionSignIn;
  if (/subscription.*(?:not enabled|turned off|disabled|not available)/i.test(message))
    return CLOUD_REASONS.subscriptionUnavailable;
  if (/subscription.*(?:usage limit|rate limit)|usage limit was reached/i.test(message))
    return CLOUD_REASONS.subscriptionLimit;
  if (/not offered through an agentd server|through a team server/i.test(message))
    return CLOUD_REASONS.teamServer;
  if (
    /byok needs at least one provider key|cloud\.(?:anthropic|openai)_key_file\b.*(?:cannot be read|is not a regular file|must hold the key)/i.test(
      message,
    )
  )
    return CLOUD_REASONS.keyFile;
  if (
    /could not sign in|authentication failed|invalid (?:token|api key)|credential.*(?:expired|rejected)/i.test(
      message,
    )
  )
    return CLOUD_REASONS.providerSignIn;
  if (/branch changed files its check runs/i.test(message)) return CLOUD_REASONS.checkFiles;
  if (/check exited|verification failed/i.test(message)) return CLOUD_REASONS.check;
  if (/\brunner\b|environment.*(?:start|stopped)|infrastructure/i.test(message))
    return CLOUD_REASONS.environment;
  if (/timed? ?out|time limit|ran past/i.test(message)) return CLOUD_REASONS.time;
  if (/push.*(?:failed|refused)|could not push/i.test(message)) return CLOUD_REASONS.push;
  return null;
}

// Codex on a ChatGPT plan: agentd names ChatGPT, codex_auth_file or codex login in each refusal.
function chatgptReason(message: string): string | null {
  if (
    /claude_token_file\b.*codex_auth_file\b|codex_auth_file\b.*claude_token_file\b/i.test(message)
  )
    return CLOUD_REASONS.pickPlan;
  // Not "codex" alone: a BYOK job runs Codex on an API key, and its failures are the provider's.
  if (!/chatgpt|codex[_-]auth[_-]file|codex login/i.test(message)) return null;
  if (/subscription.*(?:not enabled|turned off|disabled|not available)/i.test(message))
    return CLOUD_REASONS.chatgptUnavailable;
  if (/usage limit|rate limit/i.test(message)) return CLOUD_REASONS.chatgptLimit;
  if (
    /could not sign in|sign-?in.*(?:expired|revoked|invalid|not valid)|refresh token|\b401\b/i.test(
      message,
    )
  )
    return CLOUD_REASONS.chatgptSignIn;
  if (/needs your (?:ChatGPT|Codex)|codex login|needs cloud\.codex_auth_file/i.test(message))
    return CLOUD_REASONS.chatgptAuth;
  return null;
}

/** One line for an `agentd cloud setup` refusal, from agentd's own wording; the key is never in it. */
export function cloudSetupReason(message: string): string {
  const said = message.replace(/^cloud setup:\s*/i, "").trim();
  if (/refused the account key/i.test(said))
    return "The Job API refused this account key. Copy the whole key and try again.";
  if (/could not reach the Job API|TLS certificate/i.test(said))
    return "AgentD couldn’t reach Cloud Workers. Check this machine’s connection and try again.";
  if (/account balance/i.test(said))
    return "Cloud Workers couldn’t confirm the account balance. Try again in a moment.";
  if (/on one line|too long|could not read the account key/i.test(said))
    return "Paste the account key on one line.";
  return said === "" ? "AgentD couldn’t set up Cloud Workers." : said;
}

/** The reason a finished cloud job shows; null while it is not in a failed state. */
export function cloudFailureReason(
  state: string,
  messages: ReadonlyArray<string | null | undefined>,
): string | null {
  if (!Object.hasOwn(STATE_REASONS, state)) return null;
  for (const message of messages) {
    const reason = message ? cloudReason(message) : null;
    if (reason !== null) return reason;
  }
  return STATE_REASONS[state] ?? null;
}
