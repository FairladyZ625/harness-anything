import { stableStringify } from "@harness-anything/kernel";
import { decodeCanonicalTaskMutationPlan, type CanonicalTaskMutationPlan } from "../task-lifecycle-transition-service.ts";
import { canonicalPayloadDigestV2 } from "./fact-relation-command-v2.ts";
import { bytesEqual, type SemanticMutationEnvelopeV2 } from "./semantic-mutation-envelope-v2.ts";
import { semanticAdmissionV2 } from "./semantic-authority-helpers-v2.ts";

export const taskLifecycleTransitionTypedCommandsV2 = ["task.lifecycle-complete"] as const;

export interface TaskLifecycleTransitionCommandPayloadV2 {
  readonly schema: "task.lifecycle-complete/v1";
  readonly plan: CanonicalTaskMutationPlan;
}

export function encodeTaskLifecycleTransitionCommandPayloadV2(
  payload: TaskLifecycleTransitionCommandPayloadV2
): Uint8Array {
  return Buffer.from(stableStringify(payload), "utf8");
}

export function decodeTaskLifecycleTransitionCommandPayloadV2(
  envelope: SemanticMutationEnvelopeV2
): { readonly payload: TaskLifecycleTransitionCommandPayloadV2; readonly decodedBytes: bigint } {
  if (envelope.intent.kind !== "typed") throw semanticAdmissionV2("SEMANTIC_DIFF_REQUIRED");
  if (envelope.intent.command.registryVersion !== 1
    || envelope.intent.command.version !== 1
    || envelope.intent.command.name !== "task.lifecycle-complete") {
    throw semanticAdmissionV2("TYPED_COMMAND_VERSION_UNSUPPORTED");
  }
  if (envelope.intent.canonicalPayload.kind !== "inline") throw semanticAdmissionV2("AUTHORITY_PAYLOAD_CAS_UNSUPPORTED");
  const bytes = envelope.intent.canonicalPayload.bytes;
  if (envelope.intent.canonicalPayload.size !== BigInt(bytes.length)
    || !bytesEqual(envelope.intent.canonicalPayloadDigest, canonicalPayloadDigestV2(bytes))) {
    throw semanticAdmissionV2("CANONICAL_PAYLOAD_DIGEST_MISMATCH");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  const row = decoded as Record<string, unknown>;
  if (Object.keys(row).length !== 2 || row.schema !== "task.lifecycle-complete/v1" || !Object.hasOwn(row, "plan")) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  }
  let plan: CanonicalTaskMutationPlan;
  try {
    plan = decodeCanonicalTaskMutationPlan(row.plan);
  } catch (error) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID", error instanceof Error ? error.message : String(error));
  }
  const payload = { schema: "task.lifecycle-complete/v1" as const, plan };
  if (!bytesEqual(bytes, encodeTaskLifecycleTransitionCommandPayloadV2(payload))) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_NON_CANONICAL");
  }
  return { payload, decodedBytes: BigInt(bytes.length) };
}
