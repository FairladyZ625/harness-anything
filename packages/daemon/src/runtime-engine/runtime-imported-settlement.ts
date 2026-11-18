import { createHash } from "node:crypto";
import { stableStringify, type RuntimeResultClaim, type RuntimeSession } from "@harness-anything/kernel";

/**
 * Genesis replay imports a frozen source repository. A runtime session the source never settled
 * has no process and no dispatch in the destination, so it can never be adopted or settled through
 * the dispatch-fenced RuntimeSession actions. Both replay and first-discovery recovery record the
 * same definitive terminal for it; the shared bytes keep a replayed source and a recovered
 * destination projection identical, so a migration re-run still reconciles as unchanged.
 */
export const IMPORTED_RUNTIME_TERMINAL_BODY =
  "Runtime session was imported from a frozen source generation without a dispatch; it has no process and can never be restored. Its terminal outcome is unknown.";

export function importedRuntimeTerminalResult(): RuntimeResultClaim {
  return {
    sha256: createHash("sha256").update(IMPORTED_RUNTIME_TERMINAL_BODY).digest("hex"),
    size: Buffer.byteLength(IMPORTED_RUNTIME_TERMINAL_BODY),
    mediaType: "text/plain; charset=utf-8",
  };
}

/** The projection a replayed unsettled source session must have in the destination. */
export function importedRuntimeSessionProjection(session: RuntimeSession): RuntimeSession {
  if (session.outcome !== null) return session;
  return {
    ...session,
    liveness: "exited",
    attachable: false,
    outcome: "unknown",
    exitCode: null,
    resultRef: `artifact:runtime-result/sha256/${importedRuntimeTerminalResult().sha256}`,
  };
}

/** The settlement observation time is not entity identity: replay uses the source stamp while
 *  first-discovery recovery stamps now. Compare everything else. */
export function sameImportedRuntimeSessionProjection(existing: RuntimeSession, source: RuntimeSession): boolean {
  if (source.outcome !== null) return false;
  if (existing.outcome !== null && existing.outcome !== "unknown") return false;
  const expected = importedRuntimeSessionProjection(source);
  return stableStringify({ ...existing, lastObservedAt: expected.lastObservedAt }) === stableStringify(expected);
}
