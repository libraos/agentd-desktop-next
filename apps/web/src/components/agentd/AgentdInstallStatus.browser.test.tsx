import type { AgentdStatus, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ repair: vi.fn() }));

vi.mock("../../lib/agentdState", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    agentdEnvironment: { repairServices: { permissionAtom: () => allowed } },
    useAgentdCommands: () => ({ repairServices: state.repair }),
  };
});

import { AgentdInstallStatus } from "./AgentdInstallStatus";

const environmentId = "env-1" as EnvironmentId;
const OLD = "/Applications/AgentD Desktop.app/Contents/Resources/bin/agentd";
const NEXT = "/Applications/AgentD Next.app/Contents/Resources/bin/agentd";
const status = (servicesProblem: AgentdStatus["servicesProblem"]): AgentdStatus => ({
  version: "agentd v0.1.14",
  ok: true,
  setUp: true,
  teamServer: null,
  checks: [],
  binary: NEXT,
  servicesProblem,
});

function setup() {
  state.repair.mockReset().mockResolvedValue(AsyncResult.success({ ok: true }));
  return vi.fn();
}

it("shows no services notice while every service runs a working AgentD", async () => {
  setup();
  await using _screen = await render(
    <AgentdInstallStatus
      status={status(null)}
      environmentId={environmentId}
      onRepaired={vi.fn()}
    />,
  );
  await expect.element(page.getByText(NEXT)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Repair…" })).not.toBeInTheDocument();
});

it("repairs the services only once the user confirms what changes", async () => {
  const onRepaired = setup();
  await using _screen = await render(
    <AgentdInstallStatus
      status={status({
        services: [{ name: "watchdog", program: OLD }],
        agentd: NEXT,
        moves: ["watchdog", "dash"],
      })}
      environmentId={environmentId}
      onRepaired={onRepaired}
    />,
  );
  await expect
    .element(page.getByText(/watchdog service runs \/Applications\/AgentD Desktop/))
    .toBeVisible();
  await page.getByRole("button", { name: "Repair…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect
    .element(confirm.getByText(/re-registers both the dashboard and the watchdog/))
    .toBeVisible();
  expect(state.repair).not.toHaveBeenCalled();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect.element(confirm).not.toBeInTheDocument();
  expect(state.repair).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Repair…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Repair", exact: true }).click();
  await vi.waitFor(() => expect(onRepaired).toHaveBeenCalledOnce());
  expect(state.repair).toHaveBeenCalledExactlyOnceWith({ environmentId, input: {} });
});

it("offers no Repair when it would also move a service on the user's own AgentD", async () => {
  setup();
  await using _screen = await render(
    <AgentdInstallStatus
      status={status({
        services: [{ name: "watchdog", program: OLD }],
        agentd: NEXT,
        moves: [],
        kept: ["dash"],
      })}
      environmentId={environmentId}
      onRepaired={vi.fn()}
    />,
  );
  await expect.element(page.getByText(/another runs your own AgentD/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Repair…" })).not.toBeInTheDocument();
});
