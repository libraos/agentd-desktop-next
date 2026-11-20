import type { CustomModelSetting } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** `agentd gateway models --json` (agentd-core#970): what agentd's `[gateway]` key may use. */
export const AgentdGatewayModelsJson = Schema.Struct({
  /** `[gateway] url`'s origin; null without one. */
  gateway: Schema.NullOr(Schema.String),
  /** available | not configured | unreachable | refused */
  status: Schema.String,
  message: Schema.NullOr(Schema.String),
  models: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) })),
});
export type AgentdGatewayModelsJson = typeof AgentdGatewayModelsJson.Type;

export const decodeAgentdGatewayModels = Schema.decodeUnknownOption(
  Schema.fromJsonString(AgentdGatewayModelsJson),
);

/**
 * The models of `family` that agentd's Gateway key allows an agent whose own config sends its
 * requests to `endpoint`; undefined when agentd cannot say (another gateway, none configured,
 * unreachable), so the agent keeps its catalog. A refused key allows none.
 */
export function agentdGatewayEndpointModels(
  answer: AgentdGatewayModelsJson,
  endpoint: string,
  family: "anthropic" | "openai",
): ReadonlyArray<CustomModelSetting> | undefined {
  if (answer.gateway === null || answer.gateway !== endpoint) return undefined;
  if (answer.status === "refused") return [];
  if (answer.status !== "available") return undefined;
  // The Gateway's ids carry the family in front; the agent asks for the bare name.
  return answer.models.flatMap((model) => {
    const [owner, name, ...rest] = model.id.split("/");
    if (owner !== family || !name || rest.length > 0) return [];
    return [{ slug: name, ...(model.name ? { name: model.name } : {}) }];
  });
}

/** The models an endpoint serves the agent, or undefined when nothing says (see above). */
export type EndpointModels = (
  endpoint: string,
) => Effect.Effect<ReadonlyArray<CustomModelSetting> | undefined>;

/**
 * agentd's answer for an agent configured by hand to reach its Gateway; the server provides it from
 * the agentd bridge. Unset (tests, no agentd), every agent keeps its catalog.
 */
export class AgentdGatewayModels extends Context.Reference<
  Effect.Effect<AgentdGatewayModelsJson | null> | undefined
>("t3/gateway/AgentdGatewayModels", { defaultValue: () => undefined }) {}

/** For a driver: its family's models from agentd's answer, asked only for an endpoint it names. */
export const makeEndpointModels = Effect.fn("AgentdGatewayModels.makeEndpointModels")(function* (
  family: "anthropic" | "openai",
) {
  const ask = yield* AgentdGatewayModels;
  const endpointModels: EndpointModels | undefined =
    ask === undefined
      ? undefined
      : (endpoint) =>
          ask.pipe(
            Effect.map((answer) =>
              answer === null ? undefined : agentdGatewayEndpointModels(answer, endpoint, family),
            ),
          );
  return endpointModels;
});
