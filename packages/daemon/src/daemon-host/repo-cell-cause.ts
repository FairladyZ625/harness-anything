import { VcsCommandError } from "@harness-anything/kernel";
import { cellErrorCode } from "./repo-cell-errors.ts";

const projectionFailurePatterns = [
  /document projection mismatch/iu,
  /projection cache ledger identity mismatch/iu,
  /projection (?:rebuild did not reach|digest refresh lost|snapshot mismatch)/iu,
];
const infrastructureFailurePatterns = [
  /fetch failed/iu,
  /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)/u,
  /(?:network|transport|Keycloak).*(?:unavailable|unreachable|failed)/iu,
];

/**
 * Ledger-shape judgments (layout, projection replay, revision bases) point the repair at the data;
 * Git/lock failures (publication CAS, writer lock) point it at the workspace infrastructure.
 */
export function causeClassOf(error: unknown): "data-shape" | "infrastructure" | "projection" {
  return error instanceof VcsCommandError ||
    ["writer_rejected", "publication_indeterminate", "repo_attach_revoked", "keycloak_admin_rejected"].includes(
      cellErrorCode(error),
    )
    ? "infrastructure"
    : error instanceof Error && infrastructureFailurePatterns.some((pattern) => pattern.test(error.message))
      ? "infrastructure"
      : error instanceof Error && projectionFailurePatterns.some((pattern) => pattern.test(error.message))
        ? "projection"
        : "data-shape";
}

export const latchReprobeThrottleMs = 5_000;
