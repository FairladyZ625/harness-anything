/* @slice-activation PLT-Boundary S2 journal outcome projection */
import type { FlushReport } from "../../ports/write-coordinator.ts";
import type { LedgerMaterializerReport } from "../materialization/ledger-materializer.ts";

type KernelFailureReason =
  | "apply_conflict"
  | "visibility_pending"
  | "outcome_unknown";

type ReceiptFailureFamily =
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

interface StructuralRecoveryDirective {
  readonly action: string;
  readonly automation: "allowed" | "operator_required" | "forbidden";
  readonly operationId: "reuse_same" | "create_new_attempt" | "create_new_operation" | "not_applicable";
  readonly effectSafety:
    | "proven_unsent"
    | "proven_not_committed"
    | "committed_do_not_resubmit"
    | "outcome_must_be_queried"
    | "no_effect_replay";
}

export type KernelHonestOutcomeFailureRegistry = Readonly<Record<
  KernelFailureReason,
  {
    readonly family: ReceiptFailureFamily;
    readonly recovery: StructuralRecoveryDirective;
  }
>>;

interface KernelProjectedEvidence {
  readonly kind: "write_watermark" | "materialization_witness" | "projection_read";
  readonly ref: string;
  readonly scope: {
    readonly kind: "authority_store" | "canonical_artifact" | "projection";
    readonly id?: string;
    readonly freshness: "current";
  };
}

type KernelProjectedMoment =
  | {
      readonly status: "confirmed";
      readonly evidence: readonly [KernelProjectedEvidence, ...KernelProjectedEvidence[]];
    }
  | {
      readonly status: "not_reached";
      readonly reason: "pending" | "terminal_failure";
      readonly failureId?: string;
      readonly evidence?: readonly [KernelProjectedEvidence, ...KernelProjectedEvidence[]];
    }
  | {
      readonly status: "unknown";
      readonly reason: "not_observed" | "legacy_unmapped" | "outcome_indeterminate" | "scope_not_proven";
      readonly detail?: string;
    };

interface KernelProjectedFailure<
  Registry extends KernelHonestOutcomeFailureRegistry,
  Reason extends KernelFailureReason = KernelFailureReason
> {
  readonly id: string;
  readonly reason: Reason;
  readonly family: Registry[Reason]["family"];
  readonly at: "committed" | "applied" | "visible";
  readonly recovery: Registry[Reason]["recovery"];
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface KernelProjectedHonestReceiptOutcome<
  Registry extends KernelHonestOutcomeFailureRegistry
> {
  readonly schema: "honest-receipt-outcome/v1";
  readonly operation: {
    readonly namespace: string;
    readonly id: string;
  };
  readonly moments: {
    readonly committed: KernelProjectedMoment;
    readonly applied: KernelProjectedMoment;
    readonly visible: KernelProjectedMoment;
    readonly acked: KernelProjectedMoment;
  };
  readonly failures: ReadonlyArray<KernelProjectedFailure<Registry>>;
  readonly legacy?: {
    readonly schema: string;
    readonly digest: string;
  };
}

export type KernelDurableObservation =
  | {
      readonly status: "confirmed";
      readonly ref: string;
    }
  | {
      readonly status: "malformed" | "unreadable";
      readonly detail: string;
    }
  | {
      readonly status: "not_observed";
    };

export type KernelProjectionReadObservation =
  | {
      readonly status: "visible";
      readonly ref: string;
      readonly scopeId: string;
    }
  | {
      readonly status: "not_visible";
      readonly ref: string;
      readonly scopeId: string;
    };

export interface KernelHonestOutcomeProjectionInput {
  readonly operation: {
    readonly namespace?: string;
    readonly id: string;
  };
  readonly flushReport?: FlushReport;
  readonly durable?: KernelDurableObservation;
  readonly materializer?: {
    readonly report: LedgerMaterializerReport;
    readonly branch: string;
  };
  readonly projectionRead?: KernelProjectionReadObservation;
  readonly legacyDigest?: string;
}

interface ProjectionState<Registry extends KernelHonestOutcomeFailureRegistry> {
  committed: KernelProjectedMoment;
  applied: KernelProjectedMoment;
  visible: KernelProjectedMoment;
  readonly failures: KernelProjectedFailure<Registry>[];
}

export function projectKernelHonestOutcome<
  Registry extends KernelHonestOutcomeFailureRegistry
>(
  input: KernelHonestOutcomeProjectionInput,
  registry: Registry
): KernelProjectedHonestReceiptOutcome<Registry> {
  const state: ProjectionState<Registry> = {
    committed: unknown("not_observed"),
    applied: unknown("legacy_unmapped"),
    visible: unknown("legacy_unmapped"),
    failures: []
  };

  projectDurable(input, registry, state);
  if (state.committed.status === "confirmed") {
    projectMaterializer(input, registry, state);
    projectVisibility(input, registry, state);
  }

  return {
    schema: "honest-receipt-outcome/v1",
    operation: {
      namespace: input.operation.namespace ?? "kernel-write",
      id: input.operation.id
    },
    moments: {
      committed: state.committed,
      applied: state.applied,
      visible: state.visible,
      acked: unknown("not_observed", "kernel has no caller acknowledgement evidence")
    },
    failures: state.failures,
    ...(input.legacyDigest
      ? { legacy: { schema: "kernel-flush-report/v1", digest: input.legacyDigest } }
      : {})
  };
}

function projectDurable<Registry extends KernelHonestOutcomeFailureRegistry>(
  input: KernelHonestOutcomeProjectionInput,
  registry: Registry,
  state: ProjectionState<Registry>
): void {
  const observation = input.durable;
  if (observation?.status === "malformed" || observation?.status === "unreadable") {
    const failure = failureFor(
      input.operation.id,
      "outcome_unknown",
      "committed",
      registry,
      { durableStatus: observation.status, detail: observation.detail }
    );
    state.failures.push(failure);
    state.committed = unknown("outcome_indeterminate", observation.detail);
    state.applied = unknown("outcome_indeterminate");
    state.visible = unknown("outcome_indeterminate");
    return;
  }
  if (observation?.status === "confirmed") {
    state.committed = confirmed({
      kind: "write_watermark",
      ref: observation.ref,
      scope: {
        kind: "authority_store",
        id: input.operation.id,
        freshness: "current"
      }
    });
    return;
  }
  if (input.flushReport?.committed === true && input.flushReport.watermark) {
    state.committed = confirmed({
      kind: "write_watermark",
      ref: input.flushReport.watermark,
      scope: {
        kind: "authority_store",
        id: input.operation.id,
        freshness: "current"
      }
    });
    return;
  }
  state.committed = input.flushReport?.committed === true
    ? unknown("legacy_unmapped", "flush report omitted a durable watermark reference")
    : unknown("not_observed");
}

function projectMaterializer<Registry extends KernelHonestOutcomeFailureRegistry>(
  input: KernelHonestOutcomeProjectionInput,
  registry: Registry,
  state: ProjectionState<Registry>
): void {
  const materializer = input.materializer;
  if (!materializer) return;
  const branch = materializer.report.branches.find((candidate) =>
    candidate.branch === materializer.branch);
  if (!branch) return;
  if (branch.status === "conflict") {
    const failure = failureFor(
      input.operation.id,
      "apply_conflict",
      "applied",
      registry,
      {
        branch: branch.branch,
        conflictPaths: branch.conflictPaths ?? [],
        ...(branch.warning ? { warning: branch.warning } : {})
      }
    );
    state.failures.push(failure);
    state.applied = notReached(failure.id);
    state.visible = notReached(failure.id);
    return;
  }
  if (branch.status === "merged") {
    state.applied = confirmed({
      kind: "materialization_witness",
      ref: [branch.branch, ...branch.commits].join("/"),
      scope: {
        kind: "canonical_artifact",
        id: branch.branch,
        freshness: "current"
      }
    });
    state.visible = unknown("scope_not_proven");
    return;
  }
  if (branch.status === "would_merge") {
    state.applied = { status: "not_reached", reason: "pending" };
    state.visible = { status: "not_reached", reason: "pending" };
  }
}

function projectVisibility<Registry extends KernelHonestOutcomeFailureRegistry>(
  input: KernelHonestOutcomeProjectionInput,
  registry: Registry,
  state: ProjectionState<Registry>
): void {
  if (state.applied.status !== "confirmed" || !input.projectionRead) return;
  const evidence = {
    kind: "projection_read",
    ref: input.projectionRead.ref,
    scope: {
      kind: "projection",
      id: input.projectionRead.scopeId,
      freshness: "current"
    }
  } as const satisfies KernelProjectedEvidence;
  if (input.projectionRead.status === "visible") {
    state.visible = confirmed(evidence);
    return;
  }
  const failure = failureFor(
    input.operation.id,
    "visibility_pending",
    "visible",
    registry,
    { scopeId: input.projectionRead.scopeId }
  );
  state.failures.push(failure);
  state.visible = {
    status: "not_reached",
    reason: "terminal_failure",
    failureId: failure.id,
    evidence: [evidence]
  };
}

function failureFor<
  Registry extends KernelHonestOutcomeFailureRegistry,
  Reason extends KernelFailureReason
>(
  operationId: string,
  reason: Reason,
  at: KernelProjectedFailure<Registry, Reason>["at"],
  registry: Registry,
  detail?: Readonly<Record<string, unknown>>
): KernelProjectedFailure<Registry, Reason> {
  return {
    id: `${operationId}:${reason}`,
    reason,
    family: registry[reason].family,
    at,
    recovery: registry[reason].recovery,
    ...(detail ? { detail } : {})
  };
}

function confirmed(evidence: KernelProjectedEvidence): KernelProjectedMoment {
  return { status: "confirmed", evidence: [evidence] };
}

function notReached(failureId: string): KernelProjectedMoment {
  return {
    status: "not_reached",
    reason: "terminal_failure",
    failureId
  };
}

function unknown(
  reason: Extract<KernelProjectedMoment, { readonly status: "unknown" }>["reason"],
  detail?: string
): KernelProjectedMoment {
  return {
    status: "unknown",
    reason,
    ...(detail ? { detail } : {})
  };
}
