import type { PersistedCanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { storageReadPolicy, validateStorageReadWindow } from "../domain/storage-read-policy.ts";

export const CANONICAL_EVENT_PAGE_SCHEMA = "canonical-event-page/v1";
export const CANONICAL_EVENT_WAIT_MAX_MS = 25_000;

export interface CanonicalEventReadRequest {
  readonly afterRevision: number;
  readonly limit: number;
  readonly waitMs?: number;
}

export interface CanonicalEventPage {
  readonly schema: typeof CANONICAL_EVENT_PAGE_SCHEMA;
  readonly ok: true;
  readonly repoId: string;
  readonly events: readonly PersistedCanonicalEventV1[];
  readonly headRevision: number;
  readonly nextAfterRevision: number;
  readonly hasMore: boolean;
}

export class CanonicalEventReadError extends Error {
  readonly code: "invalid_cursor" | "invalid_request";

  constructor(code: CanonicalEventReadError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export function canonicalEventReadRequest(payload: Readonly<Record<string, unknown>>): CanonicalEventReadRequest {
  const { afterRevision, limit, waitMs } = payload,
    maximum = storageReadPolicy.defaultValue.pageSizes.standard;
  if (typeof afterRevision !== "number" || !validateStorageReadWindow(1, maximum, afterRevision))
    throw new CanonicalEventReadError("invalid_cursor", "afterRevision must be a nonnegative safe integer.");
  if (typeof limit !== "number" || !validateStorageReadWindow(limit, maximum))
    throw new CanonicalEventReadError("invalid_request", `limit must be an integer between 1 and ${maximum}.`);
  if (
    waitMs !== undefined &&
    (typeof waitMs !== "number" || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > CANONICAL_EVENT_WAIT_MAX_MS)
  )
    throw new CanonicalEventReadError(
      "invalid_request",
      `waitMs must be an integer between 0 and ${CANONICAL_EVENT_WAIT_MAX_MS}.`,
    );
  return { afterRevision, limit, ...(waitMs === undefined ? {} : { waitMs }) };
}
