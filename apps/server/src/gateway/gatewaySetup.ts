import {
  LIBRAOS_GATEWAY_INSTANCE_IDS,
  LIBRAOS_GATEWAY_ORIGIN,
  ProviderDriverKind,
  ProviderInstanceId,
  type CustomModelEntry,
  type LibraosGatewayModel,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// What a connected Gateway key turns into: one provider instance per agent whose environment and
// arguments reach api.libraos.com for that instance's sessions alone. Choosing the instance in the
// model picker is choosing the Gateway; the agent's own instance keeps its own login and config.

const KEY_PREFIX = "lk_";
const KEY_SHAPE = /^lk_[A-Za-z0-9_-]{8,512}$/;
/** Codex reads the key from this variable of its own process (`model_providers.*.env_key`). */
const KEY_ENV = "LIBRAOS_API_KEY";
const PROVIDER_ID = "libraos";
const OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT";
const DISPLAY_SUFFIX = "LibraOS Gateway";
/** The connected key in the server's secret store. */
export const GATEWAY_KEY_SECRET = "libraos-gateway-key";

export const GATEWAY_INSTANCE_IDS = {
  claude: ProviderInstanceId.make(LIBRAOS_GATEWAY_INSTANCE_IDS.claude),
  codex: ProviderInstanceId.make(LIBRAOS_GATEWAY_INSTANCE_IDS.codex),
  opencode: ProviderInstanceId.make(LIBRAOS_GATEWAY_INSTANCE_IDS.opencode),
} as const;

/** A trimmed key of the shape Console issues, or why it is not one. */
export function readGatewayKey(raw: string): { key: string } | { problem: string } {
  const key = raw.trim();
  if (!key.startsWith(KEY_PREFIX)) {
    return { problem: "A LibraOS API key starts with lk_. Copy it from Console's API keys page." };
  }
  if (!KEY_SHAPE.test(key)) return { problem: "That does not look like a whole LibraOS API key." };
  return { key };
}

const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
});
const ErrorBody = Schema.Struct({ error: Schema.Struct({ message: Schema.String }) });
const decodeModelList = Schema.decodeUnknownOption(ModelList);
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export function parseGatewayModels(body: unknown): ReadonlyArray<LibraosGatewayModel> | null {
  const list = decodeModelList(body);
  if (Option.isNone(list)) return null;
  return list.value.data
    .filter((model) => model.id.trim() !== "")
    .map((model) => (model.name ? { id: model.id, name: model.name } : { id: model.id }));
}

const REFUSAL_LIMIT = 200;
// Clients that may only read status see this text, so a credential the Gateway echoes goes.
const CREDENTIAL = /\b(?:lk|sk)[_-][A-Za-z0-9_-]{6,}|\bBearer\s+\S+/gi;

/** The Gateway's one-line reason for a refused request, else its status. */
export function gatewayRefusal(status: number, body: unknown): string {
  const parsed = decodeErrorBody(body);
  const line = Option.isSome(parsed)
    ? (parsed.value.error.message.trim().split(/\r?\n/)[0] ?? "")
    : "";
  const message = line.replace(CREDENTIAL, "[redacted]").trim();
  if (message === "") return `LibraOS Gateway answered HTTP ${status}.`;
  return message.length > REFUSAL_LIMIT ? `${message.slice(0, REFUSAL_LIMIT - 1)}…` : message;
}

/** A key the Gateway will not serve at all, as opposed to a Gateway that is down or busy. */
export const isKeyRefusal = (status: number): boolean => status === 401 || status === 403;

const ownName = (id: string, family: string) => {
  const [owner = "", name = "", ...rest] = id.split("/");
  return owner === family && name !== "" && rest.length === 0 ? name : undefined;
};

// Claude Code swaps these for a model of its own (case-insensitively); the adapter pins only the
// four lowercase family aliases back to themselves (`compileClaudeModelSelection`).
const CLAUDE_CODE_PINNED_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);
const CLAUDE_CODE_REWRITES = /^(?:best|opusplan|opus|sonnet|haiku|fable)$|\[1m\]$/i;
const claudeCodeSendsAsIs = (slug: string) =>
  CLAUDE_CODE_PINNED_ALIASES.has(slug) || !CLAUDE_CODE_REWRITES.test(slug);
// Claude Code otherwise remaps old Opus ids (`claude-opus-4-1`) to its current Opus, and moves a
// Claude model the Gateway calls unavailable down to an older one.
const CLAUDE_CODE_KEEP_MODEL = [
  "CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP",
  "CLAUDE_CODE_NO_MODEL_FALLBACK",
];

// The agent's own family drops its prefix (agentd's workers ask so) to keep its catalog options; a
// slug depends on its id alone, so saved choices survive key changes. A bare id equal to that name
// is the row's own request, and the prefixed id then gets its own row. Other models keep their full
// id, their family and none of the agent's options (Codex would lend them a GPT model's).
export function gatewayAgentModels(models: ReadonlyArray<LibraosGatewayModel>, family: string) {
  // An id the agent would send as another model is not offered, or kept whole when that avoids it.
  const sendsAsIs = family === "anthropic" ? claudeCodeSendsAsIs : () => true;
  const own = (id: string) => {
    const name = ownName(id, family);
    return name !== undefined && sendsAsIs(name) ? name : undefined;
  };
  const ownNames = new Set(models.flatMap((model) => own(model.id) ?? []));
  const ids = new Set(models.map((model) => model.id));
  const ownModels: Array<CustomModelEntry> = [];
  const other: Array<CustomModelEntry> = [];
  const pushOther = (id: string, named: { name?: string }) => {
    const owner = id.split("/")[0] ?? "";
    other.push({
      slug: id,
      ...named,
      ...(owner !== "" && id.includes("/") ? { subProvider: owner } : {}),
      capabilities: { optionDescriptors: [] },
    });
  };
  for (const model of models) {
    const named = model.name ? { name: model.name } : {};
    const name = own(model.id);
    if (name !== undefined) {
      ownModels.push({ slug: name, ...named });
      if (ids.has(name)) pushOther(model.id, named);
      continue;
    }
    if (ownNames.has(model.id) || !sendsAsIs(model.id)) continue;
    pushOther(model.id, named);
  }
  return [...ownModels, ...other];
}

const tomlString = (value: string) => JSON.stringify(value);
// Single quotes keep each `-c key="value"` one argument through the launch-argument tokenizer.
const codexConfigArg = (key: string, value: string) => `-c '${key}=${tomlString(value)}'`;

export function codexGatewayLaunchArgs(): string {
  const prefix = `model_providers.${PROVIDER_ID}`;
  return [
    codexConfigArg("model_provider", PROVIDER_ID),
    codexConfigArg(`${prefix}.name`, DISPLAY_SUFFIX),
    codexConfigArg(`${prefix}.base_url`, `${LIBRAOS_GATEWAY_ORIGIN}/v1`),
    codexConfigArg(`${prefix}.env_key`, KEY_ENV),
    codexConfigArg(`${prefix}.wire_api`, "responses"),
  ].join(" ");
}

/** opencode's inline config: the Gateway as its only provider, the key read from the env. */
function opencodeGatewayConfig(models: ReadonlyArray<LibraosGatewayModel>): string {
  const first = models.find((model) => model.id.startsWith("anthropic/")) ?? models[0];
  return JSON.stringify({
    enabled_providers: [PROVIDER_ID],
    ...(first ? { model: `${PROVIDER_ID}/${first.id}` } : {}),
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: DISPLAY_SUFFIX,
        options: { baseURL: `${LIBRAOS_GATEWAY_ORIGIN}/v1`, apiKey: `{env:${KEY_ENV}}` },
        models: Object.fromEntries(
          models.map((model) => [model.id, model.name ? { name: model.name } : {}]),
        ),
      },
    },
  });
}

const secret = (name: string, value: string) => ({ name, value, sensitive: true });
const plain = (name: string, value: string) => ({ name, value, sensitive: false });

export function gatewayProviderInstances(
  key: string,
  models: ReadonlyArray<LibraosGatewayModel>,
): ReadonlyArray<{
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}> {
  return [
    {
      instanceId: GATEWAY_INSTANCE_IDS.claude,
      instance: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: `Claude Code · ${DISPLAY_SUFFIX}`,
        enabled: true,
        environment: [
          plain("ANTHROPIC_BASE_URL", LIBRAOS_GATEWAY_ORIGIN),
          secret("ANTHROPIC_API_KEY", key),
          ...CLAUDE_CODE_KEEP_MODEL.map((name) => plain(name, "1")),
        ],
        // The key's models replace Claude's catalog: any other model would fail on the Gateway.
        config: { customModels: gatewayAgentModels(models, "anthropic"), onlyCustomModels: true },
      },
    },
    {
      instanceId: GATEWAY_INSTANCE_IDS.codex,
      instance: {
        driver: ProviderDriverKind.make("codex"),
        displayName: `Codex · ${DISPLAY_SUFFIX}`,
        enabled: true,
        environment: [secret(KEY_ENV, key)],
        config: {
          setupMode: "existing",
          launchArgs: codexGatewayLaunchArgs(),
          customModels: gatewayAgentModels(models, "openai"),
          onlyCustomModels: true,
        },
      },
    },
    {
      instanceId: GATEWAY_INSTANCE_IDS.opencode,
      instance: {
        driver: ProviderDriverKind.make("opencode"),
        displayName: `opencode · ${DISPLAY_SUFFIX}`,
        enabled: true,
        environment: [
          secret(KEY_ENV, key),
          plain(OPENCODE_CONFIG_ENV, opencodeGatewayConfig(models)),
        ],
        config: { enabled: true },
      },
    },
  ];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The inline config with only the Gateway provider's models, and a default it lost, replaced. */
function patchOpencodeGatewayConfig(
  current: string | undefined,
  models: ReadonlyArray<LibraosGatewayModel>,
): string {
  const fresh = opencodeGatewayConfig(models);
  let parsed: unknown;
  try {
    parsed = current === undefined ? undefined : JSON.parse(current);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) return fresh;
  const served = JSON.parse(fresh) as { model?: string };
  const providers = isRecord(parsed.provider) ? parsed.provider : {};
  const own = isRecord(providers[PROVIDER_ID]) ? providers[PROVIDER_ID] : {};
  const ownModels = isRecord(own.models) ? own.models : {};
  const next: Record<string, unknown> = { ...parsed };
  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  const lost =
    model === undefined ||
    (model.startsWith(`${PROVIDER_ID}/`) &&
      !models.some((entry) => `${PROVIDER_ID}/${entry.id}` === model));
  if (lost) {
    if (served.model === undefined) delete next.model;
    else next.model = served.model;
  }
  next.provider = {
    ...providers,
    [PROVIDER_ID]: {
      ...own,
      models: Object.fromEntries(
        models.map((entry) => [
          entry.id,
          ownModels[entry.id] ?? (entry.name ? { name: entry.name } : {}),
        ]),
      ),
    },
  };
  return JSON.stringify(next);
}

/** The key the opencode Gateway agent sends, when it is not `connected` (settings with secrets). */
export function opencodeOwnGatewayKey(
  current: ProviderInstanceConfigMap,
  connected: string,
): string | undefined {
  const value = current[GATEWAY_INSTANCE_IDS.opencode]?.environment?.find(
    (variable) => variable.name === KEY_ENV,
  )?.value;
  const key = typeof value === "string" ? value.trim() : undefined;
  return key && key !== connected ? key : undefined;
}

/**
 * Only the Gateway agents' model lists change; `models: null` (not asked yet) keeps them and marks
 * Claude and Codex limited to them. opencode keeps its list in its config, so it takes the list of
 * the key it sends as `opencodeModels`. Returns `current` itself when nothing changes.
 */
export function withGatewayModels(
  current: ProviderInstanceConfigMap,
  models: ReadonlyArray<LibraosGatewayModel> | null,
  opencodeModels: ReadonlyArray<LibraosGatewayModel> | null = models,
): ProviderInstanceConfigMap {
  const next: Record<string, ProviderInstanceConfig> = { ...current };
  let changed = false;
  const set = (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) => {
    if (JSON.stringify(instance) === JSON.stringify(current[instanceId])) return;
    next[instanceId] = instance;
    changed = true;
  };
  for (const [instanceId, family] of [
    [GATEWAY_INSTANCE_IDS.claude, "anthropic"],
    [GATEWAY_INSTANCE_IDS.codex, "openai"],
  ] as const) {
    const existing = current[instanceId];
    if (existing === undefined) continue;
    const config = isRecord(existing.config) ? existing.config : {};
    const environment = existing.environment ?? [];
    // Claude agents connected before these variables existed get them too.
    const missing =
      instanceId === GATEWAY_INSTANCE_IDS.claude
        ? CLAUDE_CODE_KEEP_MODEL.filter(
            (name) => !environment.some((variable) => variable.name === name),
          )
        : [];
    set(instanceId, {
      ...existing,
      ...(missing.length > 0
        ? { environment: [...environment, ...missing.map((name) => plain(name, "1"))] }
        : {}),
      config: {
        ...config,
        ...(models === null ? {} : { customModels: gatewayAgentModels(models, family) }),
        onlyCustomModels: true,
      },
    });
  }
  const opencode = current[GATEWAY_INSTANCE_IDS.opencode];
  if (opencode !== undefined) {
    const config = isRecord(opencode.config) ? opencode.config : {};
    const environment = opencode.environment ?? [];
    const existing = environment.find((variable) => variable.name === OPENCODE_CONFIG_ENV)?.value;
    const value =
      opencodeModels === null
        ? null
        : patchOpencodeGatewayConfig(
            typeof existing === "string" ? existing : undefined,
            opencodeModels,
          );
    set(GATEWAY_INSTANCE_IDS.opencode, {
      ...opencode,
      // Its models live in OPENCODE_CONFIG_CONTENT; an older build let users add custom ones.
      ...(Array.isArray(config.customModels) && config.customModels.length > 0
        ? { config: { ...config, customModels: [] } }
        : {}),
      ...(value === null
        ? {}
        : {
            environment: environment.some((variable) => variable.name === OPENCODE_CONFIG_ENV)
              ? environment.map((variable) =>
                  variable.name === OPENCODE_CONFIG_ENV ? { ...variable, value } : variable,
                )
              : [...environment, plain(OPENCODE_CONFIG_ENV, value)],
          }),
    });
  }
  return changed ? next : current;
}
