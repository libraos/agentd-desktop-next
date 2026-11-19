import "~/index.css";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AgentdCommandError,
  type AgentdCloudPlanState,
  type AgentdCloudSetup,
  type AgentdStartTaskResult,
  type AgentdTaskDefaults,
  type AgentdTaskOther,
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ThreadId,
  type ExecutionEnvironmentPlatformOs,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { hostRightPanel, selectActiveRightPanel, useRightPanelStore } from "~/rightPanelStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { makeThreadFixture } from "~/test-fixtures";
import { render, stubGlobal } from "../../../test/render";
import { ToastProvider } from "../ui/toast";
import { CloudWorkersSetup } from "./CloudWorkersSetup";
import { openStartTaskDialog, StartTaskDialogHost } from "./StartTaskDialog";
import { EMPTY_TASK_FIELDS } from "./startTask.logic";
import { TaskDraftCard } from "./TaskDraftCard";

const state = vi.hoisted(() => ({
  start: vi.fn(),
  configure: vi.fn(),
  cloudRefresh: vi.fn(),
  refresh: vi.fn(),
  branch: "feature/export",
  cloud: null as AgentdCloudSetup | null,
  others: [] as AgentdTaskOther[],
  defaults: { estimate: null, check: null } as AgentdTaskDefaults,
  gateway: false,
  worker: "opencode" as string | null,
  primary: null as EnvironmentId | null,
  os: "unknown" as ExecutionEnvironmentPlatformOs,
}));

vi.mock("~/lib/agentdState", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    agentdEnvironment: {
      startTask: { permissionAtom: () => allowed },
      cloudConfigure: { permissionAtom: () => allowed, label: "cloud-configure" },
    },
    useAgentdStatus: () => ({ data: { defaultWorker: state.worker } }),
    useAgentdTaskDefaults: () => ({ data: state.defaults }),
    useAgentdCloudSetup: (cwd: string | null) => ({
      data: cwd ? state.cloud : null,
      error: null,
      refresh: state.cloudRefresh,
    }),
    useAgentdTaskOthers: () => ({ data: state.others, isPending: false, isSuccess: true }),
  };
});
vi.mock("~/lib/libraosGatewayState", () => ({
  useLibraosGatewayConnected: () => state.gateway,
}));
vi.mock("~/state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => state.primary,
  useEnvironment: () => ({
    serverConfig: { environment: { platform: { os: state.os } } },
  }),
}));
vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => thread,
  useProject: () => ({ workspaceRoot: "/repo" }),
  useThreadProjection: () => null,
}));
vi.mock("~/state/threads", () => ({ threadEnvironment: { startTurn: {} } }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { refreshLocalStatusForPicker: state.refresh, status: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: { isRepo: true, refName: state.branch }, error: null }),
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === state.refresh
      ? state.refresh
      : (command as { label?: string }).label === "cloud-configure"
        ? state.configure
        : state.start,
}));

const thread = makeThreadFixture({ worktreePath: "/repo/worktrees/export" });
const threadRef = scopeThreadRef(thread.environmentId, thread.id);
const parentRef = scopeThreadRef(thread.environmentId, ThreadId.make("parent-thread"));

function setup(
  branch: string,
  open: boolean | typeof drafted = true,
  settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {},
) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...settings });
  state.branch = branch;
  state.cloud = null;
  state.others = [];
  state.defaults = { estimate: null, check: null };
  state.gateway = false;
  state.primary = null;
  state.os = "unknown";
  state.worker = "opencode";
  state.start.mockReset();
  state.configure.mockReset();
  state.cloudRefresh.mockReset();
  state.refresh
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ isRepo: true, refName: branch }));
  useRightPanelStore.setState({ byThreadKey: {} });
  if (open === true) openStartTaskDialog(threadRef);
  else if (open !== false) openStartTaskDialog(threadRef, open);
}

const drafted = {
  ...EMPTY_TASK_FIELDS,
  goal: "Fix export",
  accept: "Keeps the row order",
  check: "pnpm test",
  size: "small" as const,
};
const estimate = { type: "small" as const, low: 1.78, median: 3.11, high: 4.98, jobs: 146 };

function renderDialog() {
  return render(
    <AppAtomRegistryProvider>
      <ToastProvider>
        <StartTaskDialogHost />
      </ToastProvider>
    </AppAtomRegistryProvider>,
  );
}

async function fillTask() {
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await userEvent.fill(page.getByLabelText("Check command"), "pnpm test");
  await userEvent.fill(page.getByLabelText("Budget"), "30m,$2");
}

it("shows what is missing, displays a refusal in full, and opens the tasks pane on success", async () => {
  setup("feature/export");
  state.others = [{ person: "Bob", work: "acme/app#42", activity: null, paths: ["src/export.ts"] }];
  const refusal = "Task refused: worker is not connected.\n  Run setup and try again.";
  state.start
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new AgentdCommandError({ message: refusal, notSetUp: false })),
      ),
    )
    .mockResolvedValueOnce(
      AsyncResult.success({
        id: "hof-123abc",
        started: true,
        note: null,
      } satisfies AgentdStartTaskResult),
    );
  await using _screen = await renderDialog();
  using _host = { [Symbol.dispose]: hostRightPanel(threadRef, parentRef) };
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect.element(start).toBeDisabled();
  await expect
    .element(page.getByRole("checkbox", { name: "Run in the cloud" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByText("Enter a goal.")).toBeVisible();
  await expect.element(page.getByText("Enter a check command.")).toBeVisible();
  await expect.element(page.getByLabelText("Budget")).toHaveValue("60m,$5");
  await expect
    .element(page.getByRole("combobox", { name: "Worker" }))
    .toHaveTextContent("opencode");
  await expect
    .element(page.getByLabelText("Working directory"))
    .toHaveValue("/repo/worktrees/export");

  await fillTask();
  const notice = page.getByRole("status").filter({ hasText: "Others are working here" });
  await expect.element(notice.getByText("Bob: acme/app#42")).toBeVisible();
  await expect.element(notice.getByText("src/export.ts")).toBeVisible();
  await start.click();
  await expect.element(page.getByRole("alert")).toBeVisible();
  expect(page.getByRole("alert").element().textContent).toBe(refusal);
  expect(state.start).toHaveBeenCalledTimes(1);
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, parentRef)).toBeNull();

  await start.click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, parentRef)).toBe(
    "background-tasks",
  );
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: "pnpm test",
      worker: "opencode",
      budget: "30m,$2",
      issue: null,
    },
  });
});

it("starts a cloud task with a dollar cap and a provider key path, without the local branch gate", async () => {
  setup("main");
  state.cloud = {
    supported: true,
    project: "fork-owner/export",
    balanceUsd: 20,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  const option = page.getByRole("checkbox", { name: "Run in the cloud" });
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect.element(option).not.toBeChecked();
  await option.click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await expect.element(page.getByText("Available LibraOS credit: $20.00")).toBeVisible();
  await expect
    .element(page.getByText("Worker time and inference are both billed to LibraOS credits."))
    .toBeVisible();
  await expect.element(page.getByLabelText("Dollar cap (USD)")).toHaveValue("5");
  await expect.element(page.getByLabelText("Time limit in minutes (optional)")).toHaveValue("60");
  await expect.element(start).toBeEnabled();
  await userEvent.fill(page.getByLabelText("Dollar cap (USD)"), "2.50");

  await page.getByRole("combobox", { name: "Model access" }).click();
  await page.getByRole("option", { name: "Your API key" }).click();
  const keyPath = page.getByLabelText("Anthropic key file path");
  const openai = page.getByLabelText("OpenAI key file path");
  await userEvent.fill(openai, "/private/openai.key");
  for (const value of ["sk-example/with-separator", "sk-ant-example", "x".repeat(31)]) {
    await userEvent.fill(keyPath, value);
    await expect.element(keyPath).toHaveAttribute("aria-invalid", "true");
    await expect
      .element(
        page.getByText("This looks like the key itself. Save it in a file and choose that file."),
      )
      .toBeVisible();
    await expect.element(start).toBeDisabled();
    expect(state.start).not.toHaveBeenCalled();
  }
  await userEvent.fill(openai, "");
  await userEvent.fill(keyPath, "/private/key file");
  await expect.element(page.getByText(/Your provider bills inference separately/)).toBeVisible();
  await start.click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.refresh).not.toHaveBeenCalled();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: null,
      cloud: { budget: "60m,$2.50", modelAccess: "byok", anthropicKeyFile: "/private/key file" },
    },
  });
});

it("fills where and with what budget a task runs from Settings → Workers", async () => {
  setup("feature/export", true, { agentdDefaultBudget: "45m,$3" });
  {
    await using _screen = await renderDialog();
    await expect.element(page.getByLabelText("Budget")).toHaveValue("45m,$3");
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  setup("feature/export", true, { agentdDefaultBudget: "45m,$3", agentdRunTasksOn: "cloud" });
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: 20,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  await using _screen = await renderDialog();
  const option = page.getByRole("checkbox", { name: "Run in the cloud" });
  await expect.element(option).toBeChecked();
  await expect.element(page.getByLabelText("Dollar cap (USD)")).toHaveValue("3");
  await expect.element(page.getByLabelText("Time limit in minutes (optional)")).toHaveValue("45");
  await option.click();
  await expect.element(option).not.toBeChecked();
});

it("checks an unknown cloud outcome before retrying and can replace an earlier submission", async () => {
  setup("main");
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: 20,
    balanceText: null,
    defaultBudget: "30m,$2",
    problem: null,
  };
  const earlier = "0123abcd-ef01-8234-8567-89abcdef0123";
  let answer: (value: unknown) => void = () => {};
  const refused = (fields: {
    message: string;
    outcomeUnknown?: true;
    replaceSubmission?: string;
  }) => AsyncResult.failure(Cause.fail(new AgentdCommandError({ notSetUp: false, ...fields })));
  state.start
    .mockResolvedValueOnce(
      refused({ message: "acme/app holds an AgentD reservation.", replaceSubmission: earlier }),
    )
    .mockResolvedValueOnce(
      refused({ message: "AgentD may have created this cloud task.", outcomeUnknown: true }),
    )
    .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText("acme/app holds an AgentD reservation.")).toBeVisible();
  await page.getByRole("button", { name: "Submit this task in its place" }).click();
  const input = { cwd: "/repo/worktrees/export", goal: "Fix export", accept: [], check: null };
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: {
      ...input,
      cloud: { budget: "30m,$5", modelAccess: "libraos", replaceSubmission: earlier },
    },
  });

  const retry = page.getByRole("button", { name: "Check and retry" });
  await retry.click();
  await expect
    .element(page.getByRole("button", { name: "Checking the earlier submission…" }))
    .toBeDisabled();
  expect(state.start).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: { ...input, cloud: { budget: "30m,$5", modelAccess: "libraos" } },
  });
  answer(AsyncResult.success({ id: "hof-aabbcc", started: false, note: "Recorded." }));
  await expect.element(page.getByText(/AgentD saved task hof-aabbcc/)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /Start|Check and retry/ }))
    .not.toBeInTheDocument();
  expect(state.start).toHaveBeenCalledTimes(3);
});

it("turns off cloud start if the checkout’s origin is not a GitHub repository", async () => {
  setup("feature/export");
  state.cloud = {
    supported: true,
    project: null,
    balanceUsd: null,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  await using _screen = await renderDialog();
  await expect.element(page.getByRole("checkbox", { name: "Run in the cloud" })).toBeDisabled();
  await expect
    .element(page.getByText("Cloud Workers require a GitHub repository as the checkout’s origin."))
    .toBeVisible();
});

it("does not contact the worker bridge when the branch changes to main before Start", async () => {
  setup("feature/export");
  state.refresh.mockResolvedValue(AsyncResult.success({ isRepo: true, refName: "main" }));
  await using _screen = await renderDialog();
  await fillTask();
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The working directory is on main. Switch to a different branch first.");
  expect(state.start).not.toHaveBeenCalled();
});

it("shows a drafted task as one summary with Start and its inputs folded under Edit", async () => {
  setup("feature/export", drafted);
  state.defaults = { estimate, check: "go test ./..." };
  state.gateway = true;
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await expect
    .element(page.getByText("opencode · budget up to $5.00 · LibraOS models · check: pnpm test"))
    .toBeVisible();
  await expect
    .element(page.getByText("Budget up to $5.00 (similar tasks cost $1.78–$4.98)."))
    .toBeVisible();
  await expect.element(page.getByLabelText("Goal")).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect.element(page.getByLabelText("Check command")).toHaveValue("pnpm test");
  await expect.element(page.getByLabelText("Budget")).toHaveValue("60m,$5");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: ["Keeps the row order"],
      check: "pnpm test",
      worker: "opencode",
      budget: "60m,$5",
      issue: null,
    },
  });
});

it("suggests an editable check for a hand-filled task", async () => {
  setup("feature/export");
  state.defaults = { estimate: null, check: "go test ./..." };
  await using _screen = await renderDialog();
  const check = page.getByLabelText("Check command");
  await expect.element(check).toHaveValue("go test ./...");
  await expect
    .element(page.getByText("Budget up to $5.00 (agentd has no estimate for similar tasks yet)."))
    .toBeVisible();
  await userEvent.fill(check, "go test ./internal/...");
  await expect.element(check).toHaveValue("go test ./internal/...");
  await userEvent.fill(check, "");
  await expect.element(page.getByText("Enter a check command.")).toBeVisible();
});

it.each([
  ["neither signed in nor the Gateway", false, "byok"],
  ["the Gateway", true, "libraos"],
] as const)("defaults cloud model access with %s", async (_name, gateway, access) => {
  setup("feature/export");
  state.gateway = gateway;
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: null,
    balanceText: null,
    defaultBudget: null,
    problem: "balance",
  };
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByRole("combobox", { name: "Model access" }))
    .toHaveTextContent(access === "byok" ? "Your API key" : "LibraOS");
  const keyPath = page.getByLabelText("Anthropic key file path");
  if (access === "byok") await expect.element(keyPath).toBeVisible();
  else await expect.element(keyPath).not.toBeInTheDocument();
});

it("caps a cloud budget by the balance and says the estimate comes from local runs", async () => {
  setup("feature/export", drafted);
  state.defaults = { estimate: { ...estimate, high: 7.2 }, check: null };
  state.cloud = {
    supported: true,
    project: "acme/app",
    balanceUsd: 3.5,
    balanceText: null,
    defaultBudget: null,
    problem: null,
  };
  await using _screen = await renderDialog();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect.element(page.getByLabelText("Dollar cap (USD)")).toHaveValue("3.50");
  await expect
    .element(
      page.getByText(
        "Budget up to $3.50 (similar tasks cost $1.78–$7.20). The estimate comes from local runs of similar tasks.",
      ),
    )
    .toBeVisible();
  await expect
    .element(
      page.getByText("Cloud Workers · budget up to $3.50 · LibraOS models · check: pnpm test"),
    )
    .toBeVisible();
});

it.each([
  [
    "a protected branch",
    { branch: "main" },
    "The working directory is on main. Switch to a different branch first.",
  ],
  ["no worker", { worker: null }, "Choose a worker. The default is set in agentd."],
  ["no credit", { balanceUsd: 0 }, "There is not enough LibraOS credit for Cloud Workers."],
  [
    "no LibraOS sign-in",
    { balanceUsd: null, access: "libraos" },
    "Sign in to LibraOS or connect the LibraOS Gateway to use LibraOS models.",
  ],
] as const)("shows %s in one line and disables Start", async (_name, problem, line) => {
  setup("branch" in problem ? problem.branch : "feature/export", drafted);
  if ("worker" in problem) state.worker = problem.worker;
  await using _screen = await renderDialog();
  if ("balanceUsd" in problem) {
    state.cloud = {
      supported: true,
      project: "acme/app",
      balanceUsd: problem.balanceUsd,
      balanceText: null,
      defaultBudget: null,
      problem: problem.balanceUsd === null ? "balance" : null,
    };
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    if ("access" in problem) {
      await page.getByRole("combobox", { name: "Model access" }).click();
      await page.getByRole("option", { name: "LibraOS" }).click();
    }
  }
  await expect.element(page.getByText(line)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
});

it("renders a drafted task as a card that starts it or opens the dialog with its fields", async () => {
  setup("feature/export", false);
  state.defaults = { estimate, check: null };
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <ToastProvider>
        <TaskDraftCard threadRef={threadRef} fields={drafted} />
        <StartTaskDialogHost />
      </ToastProvider>
    </AppAtomRegistryProvider>,
  );
  // The dialog atom outlives a test; close one an earlier test left open.
  if (page.getByRole("dialog").query() !== null) {
    await page.getByRole("button", { name: "Cancel" }).click();
  }
  const card = page.getByRole("region", { name: "Drafted task" });
  await expect.element(card.getByText("Fix export")).toBeVisible();
  await expect
    .element(card.getByText("opencode · budget up to $5.00 · check: pnpm test"))
    .toBeVisible();
  await card.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect
    .element(dialog.getByText("opencode · budget up to $5.00 · check: pnpm test"))
    .toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await card.getByRole("button", { name: "Start" }).click();
  await expect.element(card.getByText("Task hof-123abc is in Background tasks.")).toBeVisible();
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: ["Keeps the row order"],
      check: "pnpm test",
      worker: "opencode",
      budget: "60m,$5",
      issue: null,
    },
  });
});

const cloudReady = (fields: Partial<AgentdCloudSetup> = {}): AgentdCloudSetup => ({
  supported: true,
  canConfigure: true,
  setupUrl: "https://cloud-api.libraos.com",
  subscription: null,
  project: "acme/app",
  balanceUsd: 20,
  balanceText: null,
  defaultBudget: null,
  problem: null,
  ...fields,
});
const keyFileEnvironments = [
  { os: "windows", mode: "local", prefix: "C:\\Users\\<you>\\.config\\" },
  { os: "darwin", mode: "remote", prefix: "/Users/<you>/.config/" },
  { os: "linux", mode: "wsl", prefix: "/home/<you>/.config/" },
  { os: "linux", mode: "web", prefix: "/home/<you>/.config/" },
] as const;

it.each(keyFileEnvironments)(
  "uses the $os key file example and offers Browse only on the native desktop ($mode)",
  async ({ os, mode, prefix }) => {
    setup("feature/export");
    state.cloud = cloudReady({ balanceUsd: null });
    state.primary = mode === "remote" ? EnvironmentId.make("other") : thread.environmentId;
    state.os = os;
    const openaiPath = "C:\\Users\\Developer\\.config\\openai.key";
    const pickFiles = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(openaiPath);
    using _bridge = stubGlobal(
      "desktopBridge",
      mode === "web"
        ? undefined
        : {
            pickFiles,
            getLocalEnvironmentBootstraps: () => [
              {
                id: PRIMARY_LOCAL_ENVIRONMENT_ID,
                runningDistro: mode === "wsl" ? "Ubuntu" : null,
                httpBaseUrl: "http://localhost:3773",
                wsBaseUrl: "ws://localhost:3773",
              },
            ],
          },
    );
    await using _screen = await renderDialog();
    await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
    const anthropic = page.getByRole("textbox", { name: "Anthropic key file path" });
    const openai = page.getByRole("textbox", { name: "OpenAI key file path" });
    await expect.element(anthropic).toHaveAttribute("placeholder", prefix + "anthropic.key");
    await expect.element(openai).toHaveAttribute("placeholder", prefix + "openai.key");
    await expect
      .element(
        page.getByText("Save the key on its own line in a text file, then choose that file."),
      )
      .toBeVisible();
    await userEvent.fill(anthropic, prefix + "anthropic.key");
    await expect.element(anthropic).toHaveAttribute("aria-invalid", "false");

    const browse = page.getByRole("button", { name: /^Browse…/ });
    if (mode !== "local") {
      await expect.element(browse).not.toBeInTheDocument();
      return;
    }
    expect(browse.all()).toHaveLength(2);
    await browse.nth(0).click();
    await expect.element(browse.nth(0)).toBeEnabled();
    await expect.element(anthropic).toHaveValue(prefix + "anthropic.key");
    await browse.nth(1).click();
    await expect.element(openai).toHaveValue(openaiPath);
    expect(pickFiles.mock.calls).toEqual([[], []]);
  },
);

const plan = (fields: Partial<AgentdCloudPlanState> = {}): AgentdCloudPlanState => ({
  supported: true,
  configured: true,
  valid: true,
  expiresAbout: null,
  ...fields,
});

it("sets Cloud Workers up from the Start dialog with a pasted key, showing a refusal or the balance", async () => {
  setup("feature/export");
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup" });
  const key = "lcw_live_0123456789abcdefghij";
  state.configure
    .mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(
          new AgentdCommandError({
            message: "The Job API refused this account key. Copy the whole key and try again.",
            notSetUp: false,
          }),
        ),
      ),
    )
    .mockResolvedValueOnce(AsyncResult.success({ balanceUsd: 12.5 }));
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByRole("link", { name: "Create a key in LibraOS Console" }))
    .toHaveAttribute("href", "https://console.libraos.com/agentd");
  const field = page.getByLabelText("Cloud Workers account key");
  await expect.element(field).toHaveAttribute("type", "password");
  const setUp = page.getByRole("button", { name: "Set up Cloud Workers" });

  await userEvent.fill(field, key);
  await setUp.click();
  await expect.element(page.getByText(/refused this account key/)).toHaveAttribute("role", "alert");
  await expect.element(field).toHaveValue("");
  expect(state.cloudRefresh).not.toHaveBeenCalled();

  await userEvent.fill(field, `${key}\n`);
  await setUp.click();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Cloud Workers are set up." }))
    .toHaveTextContent("Cloud Workers are set up. Available LibraOS credit: $12.50");
  const input = { key, url: "https://cloud-api.libraos.com" };
  expect(state.configure.mock.calls).toEqual([
    [{ environmentId: thread.environmentId, input }],
    [{ environmentId: thread.environmentId, input }],
  ]);
  expect(state.cloudRefresh).toHaveBeenCalled();
});

it("names a separately hosted Job API before asking for its key", async () => {
  setup("feature/export");
  const custom = "https://jobs.example.com";
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup", setupUrl: custom });
  state.configure.mockResolvedValueOnce(AsyncResult.success({ balanceUsd: null }));
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByText(/AgentD sends it to https:\/\/jobs\.example\.com to check it/))
    .toBeVisible();
  await expect.element(page.getByText(/A LibraOS Console key won’t work there/)).toBeVisible();
  await expect
    .element(page.getByRole("link", { name: "Create a key in LibraOS Console" }))
    .not.toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Cloud Workers account key"), "custom-key");
  await page.getByRole("button", { name: "Set up Cloud Workers" }).click();
  await expect.element(page.getByText("Cloud Workers are set up.")).toBeVisible();
  expect(state.configure).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { key: "custom-key", url: custom },
  });
});

it("asks for no account key while agentd won't say where it would send one", async () => {
  setup("feature/export");
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup", setupUrl: null });
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect.element(page.getByLabelText("Cloud Workers account key")).not.toBeInTheDocument();
  await expect
    .element(page.getByText(/didn’t say where it would send an account key/))
    .toBeVisible();
});

it("offers no Keep the current key once a replacement key is on its way", async () => {
  setup("feature/export", false);
  let answer: (value: unknown) => void = () => {};
  state.configure.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  const cancel = vi.fn();
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <CloudWorkersSetup
        environmentId={thread.environmentId}
        canConfigure
        setupUrl="https://cloud-api.libraos.com"
        onCancel={cancel}
      />
    </AppAtomRegistryProvider>,
  );
  const keep = page.getByRole("button", { name: "Keep the current key" });
  await expect.element(keep).toBeEnabled();
  await userEvent.fill(page.getByLabelText("Cloud Workers account key"), "new-key");
  await page.getByRole("button", { name: "Set up Cloud Workers" }).click();
  await expect.element(page.getByRole("button", { name: "Setting up…" })).toBeVisible();
  await expect.element(keep).toBeDisabled();
  answer(AsyncResult.success({ balanceUsd: 1 }));
  await expect.element(page.getByText(/Cloud Workers are set up/)).toBeVisible();
  expect(cancel).not.toHaveBeenCalled();
});

it("keeps the Console link and asks for agentd upgrade when agentd has no cloud setup", async () => {
  setup("feature/export");
  state.cloud = cloudReady({ balanceUsd: null, problem: "setup", canConfigure: false });
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await expect
    .element(page.getByRole("link", { name: "Open Cloud Workers setup in LibraOS Console" }))
    .toBeVisible();
  await expect.element(page.getByText(/agentd upgrade$/)).toBeVisible();
  await expect.element(page.getByLabelText("Cloud Workers account key")).not.toBeInTheDocument();
});

it("lists Your subscription as disabled while agentd can't run subscription jobs", async () => {
  setup("feature/export");
  state.cloud = cloudReady();
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await page.getByRole("combobox", { name: "Model access" }).click();
  await expect
    .element(
      page.getByRole("option", { name: "Your subscription (needs AgentD v0.1.14 or later)" }),
    )
    .toHaveAttribute("aria-disabled", "true");
});

it("starts a cloud task on the Claude plan agentd has set up, never choosing it by default", async () => {
  setup("feature/export");
  state.gateway = true;
  state.cloud = cloudReady({
    subscription: {
      claude: plan({ expiresAbout: "2027-11-01" }),
      codex: plan({ supported: false, configured: false, valid: null }),
      setupUnavailable: false,
    },
  });
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  const access = page.getByRole("combobox", { name: "Model access" });
  await expect.element(access).toHaveTextContent("LibraOS");
  await access.click();
  await page.getByRole("option", { name: "Your subscription" }).click();
  await expect
    .element(
      page.getByText("Using the Claude token AgentD has set up. It runs out about Nov 1, 2027."),
    )
    .toBeVisible();
  await expect.element(page.getByText(/^Billed to your Claude plan\./)).toBeVisible();
  await expect.element(page.getByText(/budget up to \$5\.00 · your Claude plan/)).toBeVisible();

  await page.getByRole("combobox", { name: "Plan" }).click();
  await expect
    .element(page.getByRole("option", { name: "ChatGPT (Codex): needs a newer AgentD" }))
    .toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: null,
      cloud: { budget: "60m,$5", modelAccess: "subscription", plan: "claude" },
    },
  });
});

it("says how to set up a plan with no credential, and starts with a chosen file", async () => {
  setup("feature/export");
  state.cloud = cloudReady({
    subscription: {
      claude: plan({ configured: false, valid: null }),
      codex: plan({ configured: false, valid: null }),
      setupUnavailable: false,
    },
  });
  state.start.mockResolvedValue(
    AsyncResult.success({ id: "hof-123abc", started: true, note: null }),
  );
  await using _screen = await renderDialog();
  await page.getByRole("checkbox", { name: "Run in the cloud" }).click();
  await userEvent.fill(page.getByLabelText("Goal"), "Fix export");
  await page.getByRole("combobox", { name: "Model access" }).click();
  await page.getByRole("option", { name: "Your subscription" }).click();
  const start = page.getByRole("button", { name: "Start", exact: true });
  await expect.element(page.getByText(/claude setup-token$/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy command" })).toBeVisible();
  await expect
    .element(page.getByText("Set up your Claude plan, or choose another model access."))
    .toBeVisible();
  await expect.element(start).toBeDisabled();

  await page.getByRole("combobox", { name: "Plan" }).click();
  await page.getByRole("option", { name: "ChatGPT (Codex)" }).click();
  await expect.element(page.getByText(/codex login$/)).toBeVisible();
  await expect
    .element(page.getByText(/absolute path of Codex’s auth.json on that machine/))
    .toBeVisible();
  await expect.element(page.getByText(/^Billed to your ChatGPT plan\./)).toBeVisible();
  await userEvent.fill(
    page.getByLabelText("ChatGPT auth.json path (optional)"),
    "/home/me/.codex/auth.json",
  );
  await expect.element(start).toBeEnabled();
  await start.click();
  await expect.element(page.getByText("Started task hof-123abc.")).toBeVisible();
  expect(state.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: {
      cwd: "/repo/worktrees/export",
      goal: "Fix export",
      accept: [],
      check: null,
      cloud: {
        budget: "60m,$5",
        modelAccess: "subscription",
        plan: "codex",
        codexAuthFile: "/home/me/.codex/auth.json",
      },
    },
  });
});
