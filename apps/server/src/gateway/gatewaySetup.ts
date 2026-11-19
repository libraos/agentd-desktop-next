import {
  LIBRAOS_GATEWAY_ORIGIN,
  ProviderDriverKind,
  ProviderInstanceId,
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
const DISPLAY_SUFFIX = "LibraOS Gateway";

export const GATEWAY_INSTANCE_IDS = {
  claude: ProviderInstanceId.make("libraosClaude"),
  codex: ProviderInstanceId.make("libraosCodex"),
  opencode: ProviderInstanceId.make("libraosOpencode"),
} as const;

export const isGatewayInstanceId = (instanceId: ProviderInstanceId): boolean =>
  Object.values(GATEWAY_INSTANCE_IDS).includes(instanceId);

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

/** The Gateway's one-line reason for a refused request, else its status. */
export function gatewayRefusal(status: number, body: unknown): string {
  const parsed = decodeErrorBody(body);
  const message = Option.isSome(parsed) ? parsed.value.error.message.trim() : "";
  return message === "" ? `LibraOS Gateway answered HTTP ${status}.` : message;
}

// Claude Code asks for `claude-…` and Codex for `gpt-…`, as agentd's workers do; the Gateway's ids
// carry the model family in front.
function familyModels(models: ReadonlyArray<LibraosGatewayModel>, family: string) {
  return models.flatMap((model) => {
    const [owner, name, ...rest] = model.id.split("/");
    if (owner !== family || !name || rest.length > 0) return [];
    return [{ slug: name, ...(model.name ? { name: model.name } : {}) }];
  });
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
        ],
        // The key's models replace Claude's catalog: any other model would fail on the Gateway.
        config: { customModels: familyModels(models, "anthropic"), onlyCustomModels: true },
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
          customModels: familyModels(models, "openai"),
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
          plain("OPENCODE_CONFIG_CONTENT", opencodeGatewayConfig(models)),
        ],
        config: { enabled: true },
      },
    },
  ];
}

type GatewayInstance = ReturnType<typeof gatewayProviderInstances>[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const plainEnvironment = (instance: ProviderInstanceConfig) =>
  JSON.stringify(
    (instance.environment ?? [])
      .filter((variable) => !variable.sensitive)
      .map((variable) => [variable.name, variable.value]),
  );

/**
 * The Gateway agents still present whose models no longer match the key's list. Each keeps what the
 * user set on it (enabled, colour, other config fields); a removed agent is not brought back.
 */
export function gatewayInstanceUpdates(
  current: ProviderInstanceConfigMap,
  key: string,
  models: ReadonlyArray<LibraosGatewayModel>,
): ReadonlyArray<GatewayInstance> {
  return gatewayProviderInstances(key, models).flatMap(({ instanceId, instance }) => {
    const existing = current[instanceId];
    if (existing === undefined) return [];
    const config = {
      ...(isRecord(existing.config) ? existing.config : {}),
      ...(isRecord(instance.config) ? instance.config : {}),
    };
    const unchanged =
      JSON.stringify(config) === JSON.stringify(existing.config ?? {}) &&
      plainEnvironment(instance) === plainEnvironment(existing);
    if (unchanged) return [];
    return [
      {
        instanceId,
        instance: {
          ...existing,
          environment: instance.environment ?? [],
          config,
        },
      },
    ];
  });
}
