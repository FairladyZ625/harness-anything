export const shadowPublicationSchema = "shadow-publication/v1" as const;
export const shadowReconciliationSchema = "shadow-reconciliation-report/v1" as const;
export const attributionShadowComparisonSchema = "attribution-shadow-comparison/v1" as const;

export interface CanonicalPublicationObservation {
  readonly commitSha: string;
  readonly previousCommit: string | null;
  readonly opIds: ReadonlyArray<string>;
}

export interface ShadowPublicationRecord extends CanonicalPublicationObservation {
  readonly schema: typeof shadowPublicationSchema;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly observedAt: string;
}

export interface ShadowPublicationLog {
  readonly append: (record: ShadowPublicationRecord) => Promise<void>;
  readonly list: (workspaceId: string) => Promise<ReadonlyArray<ShadowPublicationRecord>>;
}

export type ShadowDifferenceCode =
  | "CANONICAL_COMMIT_MISMATCH"
  | "DUPLICATE_OPERATION"
  | "EXTRA_SHADOW_PUBLICATION"
  | "MISSING_SHADOW_PUBLICATION"
  | "OPERATION_SET_MISMATCH"
  | "PARENT_MISMATCH"
  | "SEQUENCE_GAP";

export interface ShadowDifference {
  readonly code: ShadowDifferenceCode;
  readonly index: number;
  readonly canonicalCommit?: string;
  readonly shadowCommit?: string;
  readonly detail: string;
}

export interface ShadowReconciliationReport {
  readonly schema: typeof shadowReconciliationSchema;
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly canonicalPublications: number;
  readonly shadowPublications: number;
  readonly status: "MATCH" | "DIFFERENT";
  readonly differences: ReadonlyArray<ShadowDifference>;
}

export interface AttributionShadowDigestObservation {
  readonly opId: string;
  readonly semanticMutationSetDigest: string;
  readonly actorAxesBindingDigest: string;
  readonly changeSetDigest: string;
  readonly canonicalEventDigest: string;
}

export type AttributionShadowMismatchField =
  | "semanticMutationSetDigest"
  | "actorAxesBindingDigest"
  | "changeSetDigest"
  | "canonicalEventDigest";

export interface AttributionShadowComparison {
  readonly schema: typeof attributionShadowComparisonSchema;
  readonly workspaceId: string;
  readonly opId: string;
  readonly status: "MATCH" | "MISMATCH";
  readonly mismatches: ReadonlyArray<AttributionShadowMismatchField>;
  readonly observedAt: string;
}

export interface AttributionShadowTelemetry {
  readonly emitMismatch: (comparison: AttributionShadowComparison) => void;
}

/**
 * Pure read-side comparison for one already-admitted operation. The only
 * callback is mismatch telemetry; no cursor, receipt, commit, or authority
 * state is accepted by this API, so comparison cannot advance canonical state.
 */
export function compareAttributionShadow(input: {
  readonly workspaceId: string;
  readonly canonical: AttributionShadowDigestObservation;
  readonly shadow: AttributionShadowDigestObservation;
  readonly telemetry: AttributionShadowTelemetry;
  readonly observedAt?: string;
}): AttributionShadowComparison {
  if (input.canonical.opId !== input.shadow.opId) throw new Error("ATTRIBUTION_SHADOW_OPERATION_MISMATCH");
  const fields = [
    "semanticMutationSetDigest",
    "actorAxesBindingDigest",
    "changeSetDigest",
    "canonicalEventDigest"
  ] as const;
  const mismatches = fields.filter((field) => input.canonical[field] !== input.shadow[field]);
  const comparison: AttributionShadowComparison = {
    schema: attributionShadowComparisonSchema,
    workspaceId: input.workspaceId,
    opId: input.canonical.opId,
    status: mismatches.length === 0 ? "MATCH" : "MISMATCH",
    mismatches,
    observedAt: input.observedAt ?? new Date().toISOString()
  };
  if (comparison.status === "MISMATCH") input.telemetry.emitMismatch(comparison);
  return comparison;
}

export function createInMemoryShadowPublicationLog(): ShadowPublicationLog {
  const records: ShadowPublicationRecord[] = [];
  return {
    append: async (record) => {
      const workspace = records.filter((candidate) => candidate.workspaceId === record.workspaceId);
      const expected = workspace.length + 1;
      if (record.sequence !== expected) throw new Error(`shadow publication sequence gap: expected ${expected}, received ${record.sequence}`);
      if (workspace.some((candidate) => candidate.commitSha === record.commitSha)) throw new Error(`duplicate shadow publication: ${record.commitSha}`);
      records.push(structuredClone(record));
    },
    list: async (workspaceId) => records
      .filter((record) => record.workspaceId === workspaceId)
      .map((record) => structuredClone(record))
  };
}

export function reconcileShadowPublications(input: {
  readonly workspaceId: string;
  readonly canonical: ReadonlyArray<CanonicalPublicationObservation>;
  readonly shadow: ReadonlyArray<ShadowPublicationRecord>;
  readonly generatedAt?: string;
}): ShadowReconciliationReport {
  const differences: ShadowDifference[] = [];
  const count = Math.max(input.canonical.length, input.shadow.length);
  const seenOps = new Set<string>();
  for (let index = 0; index < count; index += 1) {
    const canonical = input.canonical[index];
    const shadow = input.shadow[index];
    if (!canonical && shadow) {
      differences.push(difference("EXTRA_SHADOW_PUBLICATION", index, undefined, shadow, "shadow has no canonical publication at this position"));
      continue;
    }
    if (canonical && !shadow) {
      differences.push(difference("MISSING_SHADOW_PUBLICATION", index, canonical, undefined, "canonical publication has no shadow record"));
      continue;
    }
    if (!canonical || !shadow) continue;
    if (shadow.sequence !== index + 1) differences.push(difference("SEQUENCE_GAP", index, canonical, shadow, `expected sequence ${index + 1}, received ${shadow.sequence}`));
    if (canonical.commitSha !== shadow.commitSha) differences.push(difference("CANONICAL_COMMIT_MISMATCH", index, canonical, shadow, "commit SHA differs"));
    if (canonical.previousCommit !== shadow.previousCommit) differences.push(difference("PARENT_MISMATCH", index, canonical, shadow, "previous commit differs"));
    if (!sameStrings(canonical.opIds, shadow.opIds)) differences.push(difference("OPERATION_SET_MISMATCH", index, canonical, shadow, "ordered operation IDs differ"));
    for (const opId of shadow.opIds) {
      if (seenOps.has(opId)) differences.push(difference("DUPLICATE_OPERATION", index, canonical, shadow, `operation appears more than once: ${opId}`));
      seenOps.add(opId);
    }
  }
  return {
    schema: shadowReconciliationSchema,
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    canonicalPublications: input.canonical.length,
    shadowPublications: input.shadow.length,
    status: differences.length === 0 ? "MATCH" : "DIFFERENT",
    differences
  };
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function difference(
  code: ShadowDifferenceCode,
  index: number,
  canonical: CanonicalPublicationObservation | undefined,
  shadow: ShadowPublicationRecord | undefined,
  detail: string
): ShadowDifference {
  return {
    code,
    index,
    ...(canonical ? { canonicalCommit: canonical.commitSha } : {}),
    ...(shadow ? { shadowCommit: shadow.commitSha } : {}),
    detail
  };
}
