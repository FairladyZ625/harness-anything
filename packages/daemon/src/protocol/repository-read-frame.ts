import type { EdgeReadFreshness } from "@harness-anything/kernel";
import { isJsonObject } from "./json-rpc-types.ts";

/** One completed replica cut; freshness describes replication, never process liveness. */
export interface RepositoryReadFrame {
  readonly cut: { readonly revision: number; readonly headDigest: string };
  readonly freshness: EdgeReadFreshness;
  readonly warning: string | null;
}

export function validateRepositoryReadFrame(value: unknown): readonly string[] {
  if (!isJsonObject(value) || !["cut", "freshness", "warning"].some((key) => Object.hasOwn(value, key))) return [];
  const { cut, freshness, warning } = value;
  return isJsonObject(cut) &&
    nonNegative(cut.revision) &&
    typeof cut.headDigest === "string" &&
    cut.headDigest.length > 0 &&
    isJsonObject(freshness) &&
    (freshness.state === "fresh" || freshness.state === "stale") &&
    nullableNonNegative(freshness.ageMs) &&
    nullableNonNegative(freshness.lagRevisions) &&
    nonNegative(freshness.maxAgeMs) &&
    nonNegative(freshness.maxLagRevisions) &&
    (freshness.confirmedAt === null ||
      (typeof freshness.confirmedAt === "string" && Number.isFinite(Date.parse(freshness.confirmedAt)))) &&
    (warning === null || typeof warning === "string")
    ? []
    : ["result must carry a complete replica cut, freshness and warning"];
}

/** Inner read validators keep their existing closed shape; the frame is validated separately. */
export function repositoryReadData(value: unknown): unknown {
  if (!isJsonObject(value)) return value;
  const { cut: _cut, freshness: _freshness, warning: _warning, ...data } = value;
  return data;
}

function nonNegative(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function nullableNonNegative(value: unknown): boolean {
  return value === null || nonNegative(value);
}
