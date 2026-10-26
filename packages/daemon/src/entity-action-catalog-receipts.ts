import { createHash } from "node:crypto";
import {
  decisionReviewContentDigest,
  decisionWritePlan,
  type AuthorizationDecision,
  type CanonicalEventCut,
  type DecisionEventV1,
  type FactEventV1,
  type RepositorySettingsV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { reject } from "./entity-action-relation.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

/** Receipt shaping for the entity action catalog: durable write receipts, dry-run previews,
 *  read receipts, and the Decision list filter/summary projections. The executor keeps
 *  orchestration; this module keeps the wire shapes. */

export function factReceipt(
  result: {
    readonly revision: number;
    readonly watermark: number;
    readonly commitSha: string | null;
    readonly cut: CanonicalEventCut;
    readonly path: string;
    readonly fact: { readonly factId: string; readonly evidenceSource: string };
  },
  event: FactEventV1,
): WriteReceipt & {
  readonly path: string;
  readonly commitSha: string | null;
  readonly cut: CanonicalEventCut;
  readonly worktreeVisible: true;
  readonly factId: string;
} {
  const canonicalVisible =
      result.cut.opId === event.opId &&
      result.cut.revision === result.revision &&
      result.revision === event.workspaceRevision,
    base = {
      opId: event.opId,
      revision: result.revision,
      evidence: JSON.stringify({
        ...result.fact,
        path: result.path,
        eventId: event.eventId,
        commitSha: result.commitSha,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: result.revision,
        appliedCut: result.watermark,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: true as const,
      },
      path: result.path,
      commitSha: result.commitSha,
      cut: result.cut,
      worktreeVisible: true as const,
      factId: result.fact.factId,
    };
  return canonicalVisible
    ? { outcome: "applied", ...base }
    : {
        outcome: "pending",
        ...base,
      };
}

export function decisionReceipt(
  result: {
    readonly revision: number;
    readonly watermark: number;
    readonly commitSha: string | null;
    readonly cut: CanonicalEventCut;
    readonly path: string;
    readonly documentSha256: string;
    readonly decision: unknown;
  },
  event: DecisionEventV1,
  authorizationDecision: AuthorizationDecision,
  defaultedFields: readonly string[] = [],
  reviewRequirement: RepositorySettingsV1["decisionReviewRequirement"],
): WriteReceipt {
  const consentId = "judgmentConsent" in event.payload ? event.payload.judgmentConsent.consentId : null,
    relationReplacement =
      event.type === "decision_relation_replaced"
        ? { retiredRelationId: event.payload.relationId, replacementRelationId: event.payload.replacement.relation_id }
        : null,
    canonicalVisible =
      result.cut.opId === event.opId &&
      result.cut.revision === result.revision &&
      result.revision === event.workspaceRevision,
    base = {
      opId: event.opId,
      decisionId: event.decisionId,
      revision: result.revision,
      evidence: JSON.stringify({
        ...(result.decision as object),
        path: result.path,
        eventId: event.eventId,
        commitSha: result.commitSha,
        cut: result.cut,
        documentSha256: result.documentSha256,
        consentId,
        ...(defaultedFields.length ? { defaultedFields } : {}),
        ...(relationReplacement ? { relationReplacement } : {}),
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: result.revision,
        appliedCut: result.watermark,
        durable: canonicalVisible,
        canonicalVisible,
        worktreeVisible: true as const,
      },
      path: result.path,
      commitSha: result.commitSha,
      cut: result.cut,
      documentSha256: result.documentSha256,
      worktreeVisible: true as const,
      consentId,
      authorizationDecision,
    },
    nextActions = decisionReceiptNextActions(event, result.decision, reviewRequirement),
    receipt = { ...base, ...(nextActions.length ? { nextActions } : {}) };
  return canonicalVisible ? { outcome: "applied", ...receipt } : { outcome: "pending", ...receipt };
}

function decisionReceiptNextActions(
  event: DecisionEventV1,
  value: unknown,
  requirement: RepositorySettingsV1["decisionReviewRequirement"],
): readonly string[] {
  if (
    !["decision_proposed", "decision_amended", "decision_review_responded"].includes(event.type) ||
    !value ||
    typeof value !== "object" ||
    !("body" in value)
  )
    return [];
  const decision = value as Parameters<typeof decisionReviewContentDigest>[0] & {
      readonly body: { readonly body: string } | null;
    },
    required =
      requirement === "all" ||
      (requirement === "high" && decision.riskTier === "high") ||
      (requirement === "medium_and_high" && decision.riskTier !== "low");
  if (!required || !decision.body) return [];
  const digest = decisionReviewContentDigest(decision, decision.body.body);
  return [`ha decision dispatch-review ${decision.decisionId} --expected-digest ${digest}`];
}

/** The one dry-run envelope: nothing is appended, so the proof commits to the current head and
 *  names the preview opId derived from the write it stands in for. */
export function previewReceipt(
  opId: string,
  revision: number,
  evidence: string,
  authorizationDecision?: AuthorizationDecision,
): WriteReceipt {
  return {
    outcome: "pending",
    opId: `preview:${createHash("sha256").update(opId).digest("hex")}`,
    revision,
    evidence,
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: revision,
      durable: false,
      canonicalVisible: false,
      worktreeVisible: false,
    },
    ...(authorizationDecision ? { authorizationDecision } : {}),
  };
}

export function decisionPreview(event: DecisionEventV1, revision: number): WriteReceipt {
  return previewReceipt(
    event.opId,
    revision,
    JSON.stringify({
      schema: "decision-write-preview/v1",
      decisionId: event.decisionId,
      eventType: event.type,
      targetRevision: event.workspaceRevision,
      document: event.payload.decisionDocumentClaim,
      writePlan: decisionWritePlan(event),
      dryRun: true,
    }),
  );
}

export function factPreview(
  event: FactEventV1,
  revision: number,
  authorizationDecision: AuthorizationDecision,
): WriteReceipt {
  return previewReceipt(
    event.opId,
    revision,
    JSON.stringify({
      schema: "fact-write-preview/v1",
      factId: event.factId,
      eventType: event.type,
      targetRevision: event.workspaceRevision,
      dryRun: true,
    }),
    authorizationDecision,
  );
}

export function preparedEntityReport(action: RepoTaskAction): Readonly<Record<string, unknown>> {
  const prepared = action.preparedEntityAction;
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) return {};
  const report = (prepared as Readonly<Record<string, unknown>>).report;
  return report && typeof report === "object" && !Array.isArray(report)
    ? (report as Readonly<Record<string, unknown>>)
    : {};
}

/**
 * The prepared report's non-blocking warnings as receipt warnings. The report nests them under
 * `warnings`, where the human renderer cannot reach them, so `ha agent install` used to emit
 * `agent_runtime_instance_ambiguous` only in the machine payload while `ha agent validate` printed
 * it. Lifting them to the receipt's top-level `warnings` puts the same sentence on both surfaces
 * and on the CLI's existing `warning:` channel; the code stays in the line so it stays greppable.
 */
export function preparedEntityWarnings(action: RepoTaskAction): readonly string[] {
  const warnings = preparedEntityReport(action).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const { code, message } = entry as { readonly code?: unknown; readonly message?: unknown };
    return typeof message === "string" && message.length > 0
      ? [typeof code === "string" && code.length > 0 ? `${code}: ${message}` : message]
      : [];
  });
}

export function readReceipt<
  T extends { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number },
>(command: string, read: T): WriteReceipt {
  const base = {
    opId: `read:${command}`,
    revision: read.sourceRevision,
    evidence: JSON.stringify(read),
    visibility: "center" as const,
    proof: {
      committedRevision: read.sourceRevision,
      appliedCut: read.watermark,
      durable: true,
      canonicalVisible: read.status === "ready",
      worktreeVisible: null,
    },
  };
  return read.status === "ready" ? { outcome: "applied", ...base } : { outcome: "pending", ...base };
}

export function decisionFilters(action: Readonly<Record<string, unknown>>) {
  const allowed = ["kind", "search", "legacyId", "legacyRange", "state", "module", "productLine", "limit", "cursor"],
    range = action.legacyRange === undefined ? null : object(action.legacyRange, "legacyRange");
  if (
    Object.keys(action).some((field) => !allowed.includes(field)) ||
    (action.limit !== undefined &&
      (typeof action.limit !== "number" ||
        !Number.isSafeInteger(action.limit) ||
        action.limit < 1 ||
        action.limit > 500)) ||
    (action.cursor !== undefined && (typeof action.cursor !== "string" || !action.cursor.trim())) ||
    ["search", "module", "productLine"].some(
      (field) => action[field] !== undefined && (typeof action[field] !== "string" || !String(action[field]).trim()),
    ) ||
    (action.legacyId !== undefined &&
      (typeof action.legacyId !== "string" || !/^E[1-9][0-9]*$/u.test(action.legacyId))) ||
    (action.state !== undefined &&
      !["proposed", "in_effect", "rejected", "deferred", "superseded", "outcome_retired"].includes(
        String(action.state),
      )) ||
    (range &&
      (Object.keys(range).length !== 2 ||
        !Number.isInteger(range.start) ||
        !Number.isInteger(range.end) ||
        Number(range.start) < 1 ||
        Number(range.end) < Number(range.start)))
  )
    reject("invalid_command", "Decision list filters are invalid or unknown.");
  return {
    ...(typeof action.search === "string" ? { search: action.search } : {}),
    ...(typeof action.legacyId === "string" ? { legacyId: action.legacyId } : {}),
    ...(range ? { legacyRange: range as { readonly start: number; readonly end: number } } : {}),
    ...(typeof action.state === "string" ? { state: action.state as never } : {}),
    ...(typeof action.module === "string" ? { module: action.module } : {}),
    ...(typeof action.productLine === "string" ? { productLine: action.productLine } : {}),
    ...(typeof action.limit === "number" ? { limit: action.limit } : {}),
    ...(typeof action.cursor === "string" ? { cursor: action.cursor } : {}),
  };
}

export function decisionSummary(row: {
  readonly decisionId: string;
  readonly legacyId?: string;
  readonly state: string;
  readonly title: string;
  readonly question: string;
  readonly chosen: readonly unknown[];
  readonly rejected: readonly unknown[];
  readonly path: string;
  readonly workspaceRevision: number;
}) {
  return {
    decisionId: row.decisionId,
    ...(row.legacyId ? { legacyId: row.legacyId } : {}),
    state: row.state,
    title: row.title,
    question: row.question,
    chosen: row.chosen,
    rejected: row.rejected,
    path: row.path,
    workspaceRevision: row.workspaceRevision,
  };
}

function object(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
  reject("invalid_command", `${field} must be an object.`);
}
