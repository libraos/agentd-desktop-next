import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { CustomGatewaySummary, EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useId, useState, type FormEvent } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useCustomGatewayCommands, useCustomGateways } from "../../lib/customGatewayState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/** The environment's custom gateways, each with Rename and Remove. Nothing while there are none. */
export function CustomGatewayList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const { data } = useCustomGateways(environmentId);
  const gateways = data?.gateways ?? [];
  if (gateways.length === 0) return null;
  return (
    <section aria-label={gt("Your gateways")} className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">
        <T>Your gateways</T>
      </h2>
      <ul className="space-y-2">
        {gateways.map((gateway) => (
          <GatewayRow key={gateway.id} environmentId={environmentId} gateway={gateway} />
        ))}
      </ul>
    </section>
  );
}

function GatewayRow({
  environmentId,
  gateway,
}: {
  readonly environmentId: EnvironmentId;
  readonly gateway: CustomGatewaySummary;
}) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const { canChange, rename, remove } = useCustomGatewayCommands(environmentId);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(gateway.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || !canChange;

  const failure = (result: Parameters<typeof squashAtomCommandFailure>[0]) =>
    thrownErrorMessage(squashAtomCommandFailure(result), m) ||
    gt("Could not reach this environment.");

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await rename({ environmentId, input: { id: gateway.id, name } });
    setBusy(false);
    if (result._tag === "Failure") {
      setError(failure(result));
      return;
    }
    setRenaming(false);
  };

  const confirmRemove = async () => {
    const confirmed = await (requestConfirmDialog(
      gt("Remove {name}? Its agents and key are removed from this environment.", {
        name: gateway.name,
      }),
      { variant: "destructive" },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    const result = await remove({ environmentId, input: { id: gateway.id } });
    setBusy(false);
    if (result._tag === "Failure") setError(failure(result));
  };

  const format = gateway.format === "openai" ? "OpenAI" : "Anthropic";

  return (
    <li className="space-y-2 rounded-lg border border-border bg-card px-4 py-3 text-sm">
      {renaming ? (
        <form onSubmit={submitRename} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-name`} className="sr-only">
            <T>Name</T>
          </label>
          <Input
            id={`${id}-name`}
            className="min-w-0 flex-1"
            autoComplete="off"
            autoFocus
            placeholder={gateway.url}
            value={name}
            disabled={disabled}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button type="submit" size="sm" disabled={disabled}>
            <T>Save</T>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setName(gateway.name);
              setRenaming(false);
            }}
          >
            <T>Cancel</T>
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-foreground">{gateway.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {gateway.url} · {format} ·{" "}
              {gt("{count, plural, one {{count} model} other {{count} models}}", {
                count: gateway.modelCount,
              })}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => setRenaming(true)}>
            <T>Rename</T>
          </Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={confirmRemove}>
            <T>Remove</T>
          </Button>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
    </li>
  );
}
