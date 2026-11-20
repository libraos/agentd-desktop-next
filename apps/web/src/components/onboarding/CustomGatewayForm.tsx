import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { CustomGatewayFormat, EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { useId, useState, type FormEvent } from "react";

import { useCustomGatewayCommands } from "../../lib/customGatewayState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const formats: ReadonlyArray<{ readonly id: CustomGatewayFormat; readonly label: string }> = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
];

/** Add a gateway by URL: its agents appear in the model picker under the name it is given. */
export function CustomGatewayForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const id = useId();
  const { canChange, add } = useCustomGatewayCommands(environmentId);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<CustomGatewayFormat>("openai");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The gateway's model list could not be read: the user may type the ids instead.
  const [modelsProblem, setModelsProblem] = useState<string | null>(null);
  const [models, setModels] = useState("");
  const disabled = busy || !canChange;

  const save = async (typed: ReadonlyArray<string> | undefined) => {
    setBusy(true);
    setError(null);
    const result = await add({
      environmentId,
      input: {
        url,
        format,
        ...(key.trim() === "" ? {} : { key }),
        ...(name.trim() === "" ? {} : { name }),
        ...(typed === undefined ? {} : { models: typed }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(thrownErrorMessage(cause, m) || gt("Could not reach this environment."));
      return;
    }
    if (result.value.kind === "modelsProblem") {
      setModelsProblem(result.value.message);
      return;
    }
    setUrl("");
    setKey("");
    setName("");
    setModels("");
    setModelsProblem(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (url.trim() === "") return;
    void save(undefined);
  };

  const typedModels = models
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter((model) => model !== "");

  return (
    <form
      onSubmit={submit}
      aria-label={gt("Custom endpoint")}
      className="space-y-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
    >
      <div className="space-y-1">
        <label htmlFor={`${id}-url`} className="block font-medium text-foreground">
          <T>Endpoint URL</T>
        </label>
        <Input
          id={`${id}-url`}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://gateway.example.com/v1"
          value={url}
          disabled={disabled}
          onChange={(event) => {
            setUrl(event.currentTarget.value);
            setModelsProblem(null);
          }}
        />
      </div>
      <fieldset className="space-y-1">
        <legend className="font-medium text-foreground">
          <T>Format</T>
        </legend>
        <div className="flex flex-wrap gap-2">
          {formats.map((entry) => (
            <label
              key={entry.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 has-checked:border-primary/60"
            >
              <input
                type="radio"
                name={`${id}-format`}
                value={entry.id}
                checked={format === entry.id}
                disabled={disabled}
                onChange={() => setFormat(entry.id)}
                className="accent-primary"
              />
              {entry.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {format === "openai" ? (
            <T>Adds Codex and opencode agents.</T>
          ) : (
            <T>Adds Claude Code and opencode agents.</T>
          )}
        </p>
      </fieldset>
      <div className="space-y-1">
        <label htmlFor={`${id}-key`} className="block font-medium text-foreground">
          <T>Key (optional)</T>
        </label>
        <Input
          id={`${id}-key`}
          // A CSS-masked text field still exposes its value to screen readers.
          type="password"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          value={key}
          disabled={disabled}
          onChange={(event) => setKey(event.currentTarget.value)}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-name`} className="block font-medium text-foreground">
          <T>Name</T>
        </label>
        <Input
          id={`${id}-name`}
          autoComplete="off"
          placeholder={url.trim() || gt("Named after its URL")}
          value={name}
          disabled={disabled}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </div>
      <p className="text-muted-foreground">
        <T>
          The key stays on this environment. Its models are read from the endpoint's model list.
        </T>
      </p>
      {error === null ? null : (
        <p role="alert" className="text-destructive-foreground">
          {error}
        </p>
      )}
      {modelsProblem === null ? (
        <Button type="submit" size="sm" disabled={disabled || url.trim() === ""}>
          {busy ? <T>Checking…</T> : <T>Add gateway</T>}
        </Button>
      ) : (
        <div className="space-y-2">
          <p role="alert" className="text-destructive-foreground">
            <T>
              Could not read the model list: <Var>{modelsProblem}</Var>
            </T>
          </p>
          <label htmlFor={`${id}-models`} className="block font-medium text-foreground">
            <T>Model ids</T>
          </label>
          <Textarea
            id={`${id}-models`}
            spellCheck={false}
            placeholder={gt("One per line, or separated by commas")}
            value={models}
            disabled={disabled}
            onChange={(event) => setModels(event.currentTarget.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || typedModels.length === 0}
              onClick={() => void save(typedModels)}
            >
              <T>Save with these models</T>
            </Button>
            <Button type="submit" variant="outline" size="sm" disabled={disabled}>
              <T>Try again</T>
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
