import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useLocale, Var } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";
import { type FormEvent, type MouseEvent, useId, useRef, useState } from "react";

import { isElectron } from "../../env";
import { agentdEnvironment } from "../../lib/agentdState";
import { ensureLocalApi } from "../../localApi";
import { useAtomCommand } from "../../state/use-atom-command";
import { CommandBlock } from "../CommandBlock";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

const CONSOLE_URL = "https://console.libraos.com/agentd";

function CloudWorkersSetupLink() {
  return (
    <a href={CONSOLE_URL} target="_blank" rel="noreferrer" className="underline">
      <T>Open Cloud Workers setup in LibraOS Console</T>
    </a>
  );
}

function ConsoleButton() {
  // The desktop opens Console in the system browser; the web build follows the link.
  const open = isElectron
    ? (event: MouseEvent) => {
        event.preventDefault();
        void ensureLocalApi().shell.openExternal(CONSOLE_URL);
      }
    : undefined;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={CONSOLE_URL} target="_blank" rel="noopener noreferrer" />}
      onClick={open}
    >
      <T>Create a key in LibraOS Console</T>
      <ExternalLinkIcon aria-hidden />
    </Button>
  );
}

/**
 * Set up Cloud Workers: create an account key in Console, paste it, and agentd installs it with
 * `agentd cloud setup`. The key is read from the field at submit and kept in no React state.
 */
export function CloudWorkersSetup({
  environmentId,
  canConfigure,
  onConfigured,
}: {
  readonly environmentId: EnvironmentId;
  /** agentd has `cloud setup` (v0.1.15+); older agentd keeps the Console link. */
  readonly canConfigure: boolean;
  readonly onConfigured?: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const allowed = useAtomValue(agentdEnvironment.cloudConfigure.permissionAtom(environmentId));
  const configure = useAtomCommand(agentdEnvironment.cloudConfigure, {
    reportFailure: false,
    reportDefect: false,
  });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly ok: true; readonly balanceUsd: number | null }
    | { readonly ok: false; readonly reason: string }
    | null
  >(null);

  if (!canConfigure) {
    return (
      <div className="space-y-1.5 text-xs">
        <CloudWorkersSetupLink />
        <p>
          <T>
            To set up Cloud Workers here, AgentD needs an upgrade. Run this, then reopen this view:
          </T>
        </p>
        <CommandBlock command="agentd upgrade" />
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="space-y-1 text-xs">
        <p>
          <T>This connection can’t set up Cloud Workers.</T>
        </p>
        <CloudWorkersSetupLink />
      </div>
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = field.current;
    const key = input?.value.trim() ?? "";
    if (input === null || key === "" || busy) return;
    input.value = "";
    setBusy(true);
    setOutcome(null);
    const result = await configure({ environmentId, input: { key } });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setOutcome({
        ok: false,
        reason:
          cause instanceof Error && cause.message
            ? cause.message.replaceAll(key, "[redacted]")
            : gt("AgentD couldn’t set up Cloud Workers."),
      });
      return;
    }
    setOutcome({ ok: true, balanceUsd: result.value.balanceUsd });
    onConfigured?.();
  }

  const balance =
    outcome?.ok === true && outcome.balanceUsd !== null
      ? new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
          outcome.balanceUsd,
        )
      : null;
  return (
    <form className="space-y-2 text-xs" autoComplete="off" onSubmit={submit}>
      <p className="font-medium">
        <T>Set up Cloud Workers</T>
      </p>
      <ol className="list-decimal space-y-1 ps-4">
        <li>
          <T>Create a Cloud Workers account key in LibraOS Console.</T>
        </li>
        <li>
          <T>
            Paste the key here. AgentD saves it in a private file on this environment’s machine.
          </T>
        </li>
      </ol>
      <ConsoleButton />
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-key`}>
          <T>Cloud Workers account key</T>
        </Label>
        <Input
          nativeInput
          id={`${id}-key`}
          ref={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={4096}
          disabled={busy}
          aria-invalid={outcome?.ok === false}
          onChange={() => setOutcome(null)}
        />
      </div>
      <Button type="submit" size="xs" disabled={busy}>
        {busy ? <T>Setting up…</T> : <T>Set up Cloud Workers</T>}
      </Button>
      {outcome?.ok === true ? (
        <p role="status">
          {balance === null ? (
            <T>Cloud Workers are set up.</T>
          ) : (
            <T>
              Cloud Workers are set up. Available LibraOS credit: <Var>{balance}</Var>
            </T>
          )}
        </p>
      ) : outcome?.ok === false ? (
        <p role="alert" className="wrap-anywhere text-destructive">
          {outcome.reason}
        </p>
      ) : null}
    </form>
  );
}
