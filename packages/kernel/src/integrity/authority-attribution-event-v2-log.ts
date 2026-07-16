import { sha256Text, stableStringify } from "./stable-hash.ts";
import {
  decodeAndVerifyAttributionEventV2,
  type AttributionEventV2
} from "../schemas/attribution-event-union.ts";

export class AuthorityAttributionEventV2ProtocolDamageError extends Error {
  readonly code = "AUTHORITY_ATTRIBUTION_EVENT_V2_PROTOCOL_DAMAGE" as const;

  constructor(message: string) {
    super(message);
    this.name = "AuthorityAttributionEventV2ProtocolDamageError";
  }
}

export function encodeAuthorityAttributionEventV2Bytes(event: AttributionEventV2): Uint8Array {
  const decoded = decodeAndVerifyAttributionEventV2(event);
  return Buffer.from(`${stableStringify(decoded)}\n`, "utf8");
}

export function decodeAuthorityAttributionEventV2Bytes(bytes: Uint8Array): AttributionEventV2 {
  let parsed: unknown;
  try {
    const body = Buffer.from(bytes).toString("utf8");
    const lines = body.trim().split("\n").filter(Boolean);
    if (lines.length !== 1) throw new Error("event shard must contain exactly one row");
    parsed = JSON.parse(lines[0]!);
  } catch (cause) {
    throw authorityAttributionEventV2ProtocolDamage("stored V2 event bytes are not one valid JSON row", cause);
  }
  let event: AttributionEventV2;
  try {
    event = decodeAndVerifyAttributionEventV2(parsed);
  } catch (cause) {
    throw authorityAttributionEventV2ProtocolDamage("stored V2 event failed strict verification", cause);
  }
  if (!authorityAttributionEventV2BytesEqual(bytes, encodeAuthorityAttributionEventV2Bytes(event))) {
    throw authorityAttributionEventV2ProtocolDamage("stored V2 event bytes are not canonical");
  }
  return event;
}

export function authorityAttributionEventV2KeyDigest(workspaceId: string, opId: string): string {
  return sha256Text(stableStringify({
    schema: "authority-attribution-event-v2-key/v1",
    workspaceId,
    opId
  }));
}

export function authorityAttributionEventV2BytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

export function authorityAttributionEventV2ProtocolDamage(
  message: string,
  cause?: unknown
): AuthorityAttributionEventV2ProtocolDamageError {
  const error = new AuthorityAttributionEventV2ProtocolDamageError(message);
  if (cause !== undefined) Object.defineProperty(error, "cause", { value: cause });
  return error;
}
