/* @slice-activation PLT-Boundary S2 honest receipt public vocabulary */
export const honestReceiptOutcomeSchema = "honest-receipt-outcome/v1" as const;

export const receiptMomentNames = [
  "committed",
  "applied",
  "visible",
  "acked"
] as const;

export type ReceiptMomentName = typeof receiptMomentNames[number];

export type ReceiptUnknownReason =
  | "not_observed"
  | "legacy_unmapped"
  | "outcome_indeterminate"
  | "scope_not_proven";

export interface ReceiptEvidenceRef {
  readonly kind:
    | "authority_receipt"
    | "write_watermark"
    | "apply_marker"
    | "materialization_witness"
    | "projection_read"
    | "terminal_ack_journal"
    | "adapter_evidence";
  readonly ref: string;
  readonly scope?: {
    readonly kind:
      | "authority_store"
      | "session_branch"
      | "canonical_artifact"
      | "projection"
      | "origin_view"
      | "caller";
    readonly id?: string;
    readonly cutId?: string;
    readonly freshness?: "current" | "historical_exact_at_cut";
  };
}

export type ReceiptMoment =
  | {
      readonly status: "confirmed";
      readonly evidence: readonly [ReceiptEvidenceRef, ...ReceiptEvidenceRef[]];
    }
  | {
      readonly status: "not_reached";
      readonly reason: "pending" | "blocked" | "terminal_failure";
      readonly failureId?: string;
      readonly evidence?: readonly [ReceiptEvidenceRef, ...ReceiptEvidenceRef[]];
    }
  | {
      readonly status: "unknown";
      readonly reason: ReceiptUnknownReason;
      readonly detail?: string;
    };

export type CoreFailureReason =
  | "capability_mismatch"
  | "request_rejected"
  | "start_failed"
  | "lease_lost"
  | "activity_timeout"
  | "evidence_rejected"
  | "not_committed_retryable"
  | "apply_conflict"
  | "apply_blocked"
  | "superseded"
  | "visibility_pending"
  | "view_unavailable"
  | "outcome_unknown"
  | "protocol_integrity_failed"
  | "cancelled";

export type ExtensionFailureReason =
  | `adapter:${string}/${string}`
  | `provider:${string}/${string}`;

export type ReceiptFailureReason = CoreFailureReason | ExtensionFailureReason;

export type RecoveryActionName =
  | "upgrade_or_select_capable_target"
  | "correct_request_then_submit_new_operation"
  | "repair_start_precondition_then_start_fresh_attempt"
  | "reconcile_lease_outcome_then_start_fresh_attempt_if_uncommitted"
  | "inspect_activity_then_extend_or_cancel"
  | "repair_and_resubmit_evidence_only"
  | "retry_same_operation_after_backoff"
  | "resolve_conflict_then_reapply_committed_operation"
  | "repair_apply_precondition_then_reapply_committed_operation"
  | "refresh_and_review_without_resubmit"
  | "run_materializer_then_recheck_visibility"
  | "reattach_or_materialize_then_query"
  | "query_operation_outcome"
  | "resync_protocol_then_query"
  | "stop_without_automatic_retry";

export interface RecoveryDirectiveV1 {
  readonly action: RecoveryActionName;
  readonly automation: "allowed" | "operator_required" | "forbidden";
  readonly operationId:
    | "reuse_same"
    | "create_new_attempt"
    | "create_new_operation"
    | "not_applicable";
  readonly effectSafety:
    | "proven_unsent"
    | "proven_not_committed"
    | "committed_do_not_resubmit"
    | "outcome_must_be_queried"
    | "no_effect_replay";
}

export type ReceiptFailureFamily =
  | "admission"
  | "dispatch"
  | "ownership"
  | "observation"
  | "evidence"
  | "commit"
  | "apply"
  | "visibility"
  | "protocol"
  | "control"
  | "extension";

export interface ReceiptFailureV1 {
  readonly id: string;
  readonly reason: ReceiptFailureReason;
  readonly family: ReceiptFailureFamily;
  readonly at: ReceiptMomentName | "before_commit";
  readonly recovery: RecoveryDirectiveV1;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface HonestReceiptOutcomeV1 {
  readonly schema: typeof honestReceiptOutcomeSchema;
  readonly operation: {
    readonly namespace: string;
    readonly id: string;
  };
  readonly moments: {
    readonly committed: ReceiptMoment;
    readonly applied: ReceiptMoment;
    readonly visible: ReceiptMoment;
    readonly acked: ReceiptMoment;
  };
  readonly failures: ReadonlyArray<ReceiptFailureV1>;
  readonly legacy?: {
    readonly schema: string;
    readonly digest: string;
  };
}

export interface HonestReceiptProjectionEnvelopeV1<LegacyReceipt = unknown> {
  readonly legacyReceipt: LegacyReceipt;
  readonly outcome: HonestReceiptOutcomeV1;
}

export interface ReceiptFailureExtensionRegistrationV1 {
  readonly reason: ExtensionFailureReason;
  readonly owner: string;
  readonly rawCodeMappingVersion: string;
  readonly family: "extension";
  readonly recovery: RecoveryDirectiveV1;
}

export const coreFailureRegistry = {
  capability_mismatch: {
    family: "admission",
    recovery: directive("upgrade_or_select_capable_target", "operator_required", "reuse_same", "proven_unsent")
  },
  request_rejected: {
    family: "admission",
    recovery: directive("correct_request_then_submit_new_operation", "forbidden", "create_new_operation", "proven_not_committed")
  },
  start_failed: {
    family: "dispatch",
    recovery: directive("repair_start_precondition_then_start_fresh_attempt", "operator_required", "create_new_attempt", "proven_unsent")
  },
  lease_lost: {
    family: "ownership",
    recovery: directive("reconcile_lease_outcome_then_start_fresh_attempt_if_uncommitted", "forbidden", "create_new_attempt", "outcome_must_be_queried")
  },
  activity_timeout: {
    family: "observation",
    recovery: directive("inspect_activity_then_extend_or_cancel", "operator_required", "not_applicable", "no_effect_replay")
  },
  evidence_rejected: {
    family: "evidence",
    recovery: directive("repair_and_resubmit_evidence_only", "operator_required", "reuse_same", "no_effect_replay")
  },
  not_committed_retryable: {
    family: "commit",
    recovery: directive("retry_same_operation_after_backoff", "allowed", "reuse_same", "proven_not_committed")
  },
  apply_conflict: {
    family: "apply",
    recovery: directive("resolve_conflict_then_reapply_committed_operation", "operator_required", "reuse_same", "committed_do_not_resubmit")
  },
  apply_blocked: {
    family: "apply",
    recovery: directive("repair_apply_precondition_then_reapply_committed_operation", "operator_required", "reuse_same", "committed_do_not_resubmit")
  },
  superseded: {
    family: "apply",
    recovery: directive("refresh_and_review_without_resubmit", "forbidden", "not_applicable", "committed_do_not_resubmit")
  },
  visibility_pending: {
    family: "visibility",
    recovery: directive("run_materializer_then_recheck_visibility", "allowed", "reuse_same", "committed_do_not_resubmit")
  },
  view_unavailable: {
    family: "visibility",
    recovery: directive("reattach_or_materialize_then_query", "operator_required", "reuse_same", "committed_do_not_resubmit")
  },
  outcome_unknown: {
    family: "commit",
    recovery: directive("query_operation_outcome", "forbidden", "not_applicable", "outcome_must_be_queried")
  },
  protocol_integrity_failed: {
    family: "protocol",
    recovery: directive("resync_protocol_then_query", "forbidden", "not_applicable", "outcome_must_be_queried")
  },
  cancelled: {
    family: "control",
    recovery: directive("stop_without_automatic_retry", "forbidden", "create_new_operation", "no_effect_replay")
  }
} as const satisfies Record<
  CoreFailureReason,
  {
    readonly family: ReceiptFailureFamily;
    readonly recovery: RecoveryDirectiveV1;
  }
>;

export function isHonestReceiptOutcomeV1(value: unknown): value is HonestReceiptOutcomeV1 {
  if (!isRecord(value)
    || !honestOutcomeExactKeys(value, ["schema", "operation", "moments", "failures"], ["legacy"])
    || value.schema !== honestReceiptOutcomeSchema
    || !validOperation(value.operation)
    || !validMoments(value.moments)
    || !Array.isArray(value.failures)
    || !value.failures.every(validFailure)
    || !validLegacy(value.legacy)) return false;

  const failures = value.failures as ReadonlyArray<ReceiptFailureV1>;
  if (new Set(failures.map((failure) => failure.id)).size !== failures.length) return false;
  const moments = value.moments as HonestReceiptOutcomeV1["moments"];
  if (moments.applied.status === "confirmed" && moments.committed.status !== "confirmed") return false;
  if (moments.visible.status === "confirmed") {
    if (moments.applied.status !== "confirmed") return false;
    if (!moments.visible.evidence.some((evidence) =>
      evidence.kind === "projection_read"
      && evidence.scope !== undefined
      && evidence.scope.freshness !== undefined)) return false;
  }
  const failureIds = new Set(failures.map((failure) => failure.id));
  return receiptMomentNames.every((name) => {
    const moment = moments[name];
    return moment.status !== "not_reached"
      || moment.reason !== "terminal_failure"
      || (typeof moment.failureId === "string" && failureIds.has(moment.failureId));
  });
}

function directive(
  action: RecoveryActionName,
  automation: RecoveryDirectiveV1["automation"],
  operationId: RecoveryDirectiveV1["operationId"],
  effectSafety: RecoveryDirectiveV1["effectSafety"]
): RecoveryDirectiveV1 {
  return { action, automation, operationId, effectSafety };
}

function validOperation(value: unknown): boolean {
  return isRecord(value)
    && honestOutcomeExactKeys(value, ["namespace", "id"], [])
    && nonEmptyString(value.namespace)
    && nonEmptyString(value.id);
}

function validMoments(value: unknown): boolean {
  return isRecord(value)
    && honestOutcomeExactKeys(value, [...receiptMomentNames], [])
    && receiptMomentNames.every((name) => validMoment(value[name]));
}

function validMoment(value: unknown): boolean {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "confirmed") {
    return honestOutcomeExactKeys(value, ["status", "evidence"], [])
      && Array.isArray(value.evidence)
      && value.evidence.length > 0
      && value.evidence.every(validEvidence);
  }
  if (value.status === "not_reached") {
    return honestOutcomeExactKeys(value, ["status", "reason"], ["failureId", "evidence"])
      && includes(["pending", "blocked", "terminal_failure"] as const, value.reason)
      && (value.failureId === undefined || nonEmptyString(value.failureId))
      && (value.evidence === undefined
        || (Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.every(validEvidence)));
  }
  return value.status === "unknown"
    && honestOutcomeExactKeys(value, ["status", "reason"], ["detail"])
    && includes(["not_observed", "legacy_unmapped", "outcome_indeterminate", "scope_not_proven"] as const, value.reason)
    && (value.detail === undefined || typeof value.detail === "string");
}

function validEvidence(value: unknown): boolean {
  if (!isRecord(value)
    || !honestOutcomeExactKeys(value, ["kind", "ref"], ["scope"])
    || !includes([
      "authority_receipt",
      "write_watermark",
      "apply_marker",
      "materialization_witness",
      "projection_read",
      "terminal_ack_journal",
      "adapter_evidence"
    ] as const, value.kind)
    || !nonEmptyString(value.ref)) return false;
  if (value.scope === undefined) return true;
  return isRecord(value.scope)
    && honestOutcomeExactKeys(value.scope, ["kind"], ["id", "cutId", "freshness"])
    && includes([
      "authority_store",
      "session_branch",
      "canonical_artifact",
      "projection",
      "origin_view",
      "caller"
    ] as const, value.scope.kind)
    && (value.scope.id === undefined || nonEmptyString(value.scope.id))
    && (value.scope.cutId === undefined || nonEmptyString(value.scope.cutId))
    && (value.scope.freshness === undefined
      || includes(["current", "historical_exact_at_cut"] as const, value.scope.freshness));
}

function validFailure(value: unknown): boolean {
  if (!isRecord(value)
    || !honestOutcomeExactKeys(value, ["id", "reason", "family", "at", "recovery"], ["detail"])
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.reason)
    || !includes([
      "admission",
      "dispatch",
      "ownership",
      "observation",
      "evidence",
      "commit",
      "apply",
      "visibility",
      "protocol",
      "control",
      "extension"
    ] as const, value.family)
    || !includes([...receiptMomentNames, "before_commit"] as const, value.at)
    || !validRecovery(value.recovery)
    || (value.detail !== undefined && !isRecord(value.detail))) return false;
  const reason = value.reason as string;
  if (reason in coreFailureRegistry) {
    const registered = coreFailureRegistry[reason as CoreFailureReason];
    return value.family === registered.family
      && sameRecovery(value.recovery as RecoveryDirectiveV1, registered.recovery);
  }
  return /^(adapter|provider):[^/]+\/[^/]+$/u.test(reason) && value.family === "extension";
}

function validRecovery(value: unknown): boolean {
  return isRecord(value)
    && honestOutcomeExactKeys(value, ["action", "automation", "operationId", "effectSafety"], [])
    && includes([
      "upgrade_or_select_capable_target",
      "correct_request_then_submit_new_operation",
      "repair_start_precondition_then_start_fresh_attempt",
      "reconcile_lease_outcome_then_start_fresh_attempt_if_uncommitted",
      "inspect_activity_then_extend_or_cancel",
      "repair_and_resubmit_evidence_only",
      "retry_same_operation_after_backoff",
      "resolve_conflict_then_reapply_committed_operation",
      "repair_apply_precondition_then_reapply_committed_operation",
      "refresh_and_review_without_resubmit",
      "run_materializer_then_recheck_visibility",
      "reattach_or_materialize_then_query",
      "query_operation_outcome",
      "resync_protocol_then_query",
      "stop_without_automatic_retry"
    ] as const, value.action)
    && includes(["allowed", "operator_required", "forbidden"] as const, value.automation)
    && includes(["reuse_same", "create_new_attempt", "create_new_operation", "not_applicable"] as const, value.operationId)
    && includes([
      "proven_unsent",
      "proven_not_committed",
      "committed_do_not_resubmit",
      "outcome_must_be_queried",
      "no_effect_replay"
    ] as const, value.effectSafety);
}

function validLegacy(value: unknown): boolean {
  return value === undefined || (isRecord(value)
    && honestOutcomeExactKeys(value, ["schema", "digest"], [])
    && nonEmptyString(value.schema)
    && nonEmptyString(value.digest));
}

function sameRecovery(left: RecoveryDirectiveV1, right: RecoveryDirectiveV1): boolean {
  return left.action === right.action
    && left.automation === right.automation
    && left.operationId === right.operationId
    && left.effectSafety === right.effectSafety;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function honestOutcomeExactKeys(
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function includes<const Values extends readonly string[]>(
  values: Values,
  value: unknown
): value is Values[number] {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
