// @effect-diagnostics-next-line nodeBuiltinImport:off -- A sync digest keeps argv building a plain function.
import * as NodeCrypto from "node:crypto";

import type { AgentdCloudTaskInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

// A paid cloud offer is reserved per GitHub project as pins, in order: `{id, after, fingerprint}`,
// `{id, attempt: fingerprint, nonce}` before each later offer, `{id, released: true, nonce}` after
// agentd refused that offer ("reserve" for the first), `{id, handoff}` once agentd names the task.
// The id is the offer's --idem and --state marker; a refusal keeps it for other servers' offers.

const SUBMISSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/;
const HANDOFF_ID = /^hof-[0-9a-f]{6,32}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const NONCE = /^[a-z0-9-]{1,64}$/;
/** The attempt a reservation's own offer is, which its release names. */
export const RESERVE_ATTEMPT = "reserve";
export const newAttempt = () => NodeCrypto.randomUUID();

const isSubmissionId = (value: string) => SUBMISSION_ID.test(value);

const submissionDigest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function submissionFingerprint(input: AgentdCloudTaskInput, project: string): string {
  const { budget, modelAccess, anthropicKeyFile, openaiKeyFile } = input.cloud;
  const plan = input.cloud.plan ?? "claude";
  return submissionDigest([
    project,
    input.goal,
    input.accept,
    input.check,
    budget,
    modelAccess,
    modelAccess === "byok" ? (anthropicKeyFile ?? null) : null,
    modelAccess === "byok" ? (openaiKeyFile ?? null) : null,
    // Appended only for subscription, so earlier LibraOS and BYOK reservations keep their digest.
    ...(modelAccess === "subscription"
      ? [plan, (plan === "codex" ? input.cloud.codexAuthFile : input.cloud.claudeTokenFile) ?? null]
      : []),
  ]);
}

export const submissionSession = (project: string) =>
  `desktop-cloud-${submissionDigest(project.toLowerCase()).slice(0, 48)}`;

export function submissionMarker(id: string): string {
  if (!isSubmissionId(id)) throw new Error("not a cloud submission id");
  return `desktop-cloud-${id}`;
}

/** Every window that reads the same reservation picks the same next id, so agentd's --idem keeps one. */
export function nextSubmissionId(session: string, after: string | null): string {
  const hash = submissionDigest([session, after]);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export interface Reservation {
  readonly id: string;
  /** The draft last offered, or about to be, under this id. */
  readonly fingerprint: string;
  readonly handoff: string | null;
  /** agentd refused that draft before making a task; the next Start reuses the id without asking. */
  readonly released: boolean;
}

const Pin = Schema.Struct({ text: Schema.String, session: Schema.optionalKey(Schema.String) });
const decodePins = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)));
const decodePin = Schema.decodeUnknownOption(Pin);
const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ id: Schema.String, handoff: Schema.String }),
      Schema.Struct({
        id: Schema.String,
        released: Schema.Literal(true),
        nonce: Schema.optionalKey(Schema.String),
      }),
      Schema.Struct({
        id: Schema.String,
        attempt: Schema.String,
        nonce: Schema.optionalKey(Schema.String),
      }),
      Schema.Struct({
        id: Schema.String,
        after: Schema.NullOr(Schema.String),
        fingerprint: Schema.String,
      }),
    ]),
  ),
);

export function reserveRecord(id: string, after: string | null, fingerprint: string): string {
  if (!isSubmissionId(id) || (after !== null && !isSubmissionId(after)))
    throw new Error("not a cloud submission id");
  if (!FINGERPRINT.test(fingerprint)) throw new Error("not a submission fingerprint");
  return JSON.stringify({ id, after, fingerprint });
}

export function releaseRecord(id: string, nonce: string): string {
  if (!isSubmissionId(id)) throw new Error("not a cloud submission id");
  if (!NONCE.test(nonce)) throw new Error("not a submission attempt");
  return JSON.stringify({ id, released: true, nonce });
}

export function attemptRecord(id: string, fingerprint: string, nonce: string): string {
  if (!isSubmissionId(id)) throw new Error("not a cloud submission id");
  if (!FINGERPRINT.test(fingerprint)) throw new Error("not a submission fingerprint");
  if (!NONCE.test(nonce) || nonce === RESERVE_ATTEMPT) throw new Error("not a submission attempt");
  return JSON.stringify({ id, attempt: fingerprint, nonce });
}

export function handoffRecord(id: string, handoff: string): string {
  if (!isSubmissionId(id) || !HANDOFF_ID.test(handoff)) throw new Error("not a cloud submission");
  return JSON.stringify({ id, handoff });
}

/**
 * The project's latest reservation, following each record's `after` from the first. When two
 * windows reserve after the same one, the first pin wins. Null for no reservation; undefined when
 * agentd's answer cannot be read, which callers treat as an unknown outcome.
 */
export function currentReservation(
  stdout: string,
  session: string,
): Reservation | null | undefined {
  const pins = decodePins(stdout);
  if (pins._tag === "None") return undefined;
  const successors = new Map<string | null, { id: string; fingerprint: string }>();
  const handoffs = new Map<string, string>();
  const released = new Set<string>();
  // Each id's latest draft, which a release after it applies to.
  const attempts = new Map<string, string>();
  // Each id's latest attempt: a release naming another attempt is about an earlier offer. An
  // attempt pin without a nonce (older versions) can be released only by a release without one.
  const latest = new Map<string, string | null>();
  for (const raw of pins.value) {
    const pin = decodePin(raw);
    if (pin._tag === "None" || (pin.value.session !== undefined && pin.value.session !== session))
      continue;
    const record = decodeRecord(pin.value.text);
    if (record._tag === "None" || !isSubmissionId(record.value.id)) continue;
    const value = record.value;
    if ("released" in value) {
      const attempt = latest.has(value.id) ? latest.get(value.id) : RESERVE_ATTEMPT;
      if (value.nonce === undefined || value.nonce === attempt) released.add(value.id);
    } else if ("attempt" in value) {
      if (FINGERPRINT.test(value.attempt)) {
        attempts.set(value.id, value.attempt);
        latest.set(value.id, value.nonce ?? null);
        released.delete(value.id);
      }
    } else if ("handoff" in value) {
      if (HANDOFF_ID.test(value.handoff) && !handoffs.has(value.id))
        handoffs.set(value.id, value.handoff);
    } else if (FINGERPRINT.test(value.fingerprint) && !successors.has(value.after)) {
      successors.set(value.after, { id: value.id, fingerprint: value.fingerprint });
    }
  }
  let current: { id: string; fingerprint: string } | null = null;
  const seen = new Set<string>();
  for (let next = successors.get(null); next !== undefined; next = successors.get(next.id)) {
    if (seen.has(next.id)) break;
    seen.add(next.id);
    current = next;
  }
  return current === null
    ? null
    : {
        id: current.id,
        fingerprint: attempts.get(current.id) ?? current.fingerprint,
        handoff: handoffs.get(current.id) ?? null,
        released: released.has(current.id),
      };
}

const decodeHits = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ ref: Schema.optionalKey(Schema.String) }))),
);

/** Handoff ids `find` returned; undefined when its answer cannot be read. */
export function foundHandoffs(stdout: string): ReadonlyArray<string> | undefined {
  const hits = decodeHits(stdout);
  if (hits._tag === "None") return undefined;
  return [...new Set(hits.value.flatMap(({ ref }) => (ref && HANDOFF_ID.test(ref) ? [ref] : [])))];
}
