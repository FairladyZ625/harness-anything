/* @slice-activation PLT-Boundary S2 compound receipt sidecar projection */
import type { AuthorityOperationReceipt } from "../authority/index.ts";
import type {
  CompoundOperationReceipt,
  OriginResolution
} from "./types.ts";
import type {
  CompoundOperationReceiptV2,
  OriginResolutionV2
} from "./v2-types.ts";
import { isCompoundOperationReceiptV2 } from "./validation-v2.ts";
import { isCompoundOperationReceipt } from "./validation.ts";
import type { CompoundReceiptWireFrameV1 } from "./wire-v1.ts";

type CompoundFailureReason =
  | "request_rejected"
  | "not_committed_retryable"
  | "apply_conflict"
  | "apply_blocked"
  | "superseded"
  | "view_unavailable"
  | "outcome_unknown"
  | "protocol_integrity_failed";

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

export type CompoundHonestOutcomeFailureRegistry = Readonly<Record<
  CompoundFailureReason,
  {
    readonly family: ReceiptFailureFamily;
    readonly recovery: StructuralRecoveryDirective;
  }
>>;

interface ProjectedEvidenceRef {
  readonly kind:
    | "authority_receipt"
    | "materialization_witness"
    | "terminal_ack_journal"
    | "adapter_evidence";
  readonly ref: string;
  readonly scope?: {
    readonly kind: "authority_store" | "origin_view" | "caller";
    readonly id?: string;
    readonly cutId?: string;
    readonly freshness?: "current" | "historical_exact_at_cut";
  };
}

type ProjectedMoment =
  | {
      readonly status: "confirmed";
      readonly evidence: readonly [ProjectedEvidenceRef, ...ProjectedEvidenceRef[]];
    }
  | {
      readonly status: "not_reached";
      readonly reason: "pending" | "terminal_failure";
      readonly failureId?: string;
    }
  | {
      readonly status: "unknown";
      readonly reason: "not_observed" | "legacy_unmapped" | "outcome_indeterminate" | "scope_not_proven";
      readonly detail?: string;
    };

interface ProjectedFailure<
  Registry extends CompoundHonestOutcomeFailureRegistry,
  Reason extends CompoundFailureReason = CompoundFailureReason
> {
  readonly id: string;
  readonly reason: Reason;
  readonly family: Registry[Reason]["family"];
  readonly at: "committed" | "applied" | "visible" | "acked" | "before_commit";
  readonly recovery: Registry[Reason]["recovery"];
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ProjectedHonestReceiptOutcome<
  Registry extends CompoundHonestOutcomeFailureRegistry
> {
  readonly schema: "honest-receipt-outcome/v1";
  readonly operation: {
    readonly namespace: string;
    readonly id: string;
  };
  readonly moments: {
    readonly committed: ProjectedMoment;
    readonly applied: ProjectedMoment;
    readonly visible: ProjectedMoment;
    readonly acked: ProjectedMoment;
  };
  readonly failures: ReadonlyArray<ProjectedFailure<Registry>>;
  readonly legacy?: {
    readonly schema: string;
    readonly digest: string;
  };
}

export interface CompoundHonestOutcomeProjectionOptions {
  readonly legacyDigest?: string;
}

type CompoundReceipt = CompoundOperationReceipt | CompoundOperationReceiptV2;
type Origin = OriginResolution | OriginResolutionV2;
type AuthorityByTag<Tag extends AuthorityOperationReceipt["tag"]> =
  Extract<AuthorityOperationReceipt, { readonly tag: Tag }>;
type OriginByTag<Tag extends Origin["tag"]> = Extract<Origin, { readonly tag: Tag }>;

interface ProjectionState<Registry extends CompoundHonestOutcomeFailureRegistry> {
  committed: ProjectedMoment;
  applied: ProjectedMoment;
  visible: ProjectedMoment;
  acked: ProjectedMoment;
  failures: ProjectedFailure<Registry>[];
}

interface ProjectionContext<Registry extends CompoundHonestOutcomeFailureRegistry> {
  readonly receipt: CompoundReceipt;
  readonly registry: Registry;
  readonly state: ProjectionState<Registry>;
}

type AuthorityProjectors = {
  readonly [Tag in AuthorityOperationReceipt["tag"]]: <Registry extends CompoundHonestOutcomeFailureRegistry>(
    authority: AuthorityByTag<Tag>,
    context: ProjectionContext<Registry>
  ) => void;
};

type OriginProjectors = {
  readonly [Tag in Origin["tag"]]: <Registry extends CompoundHonestOutcomeFailureRegistry>(
    origin: OriginByTag<Tag>,
    context: ProjectionContext<Registry>
  ) => void;
};

type WireFrameByKind<Kind extends CompoundReceiptWireFrameV1["kind"]> =
  Extract<CompoundReceiptWireFrameV1, { readonly kind: Kind }>;

type WireProjectors = {
  readonly [Kind in CompoundReceiptWireFrameV1["kind"]]: <
    Registry extends CompoundHonestOutcomeFailureRegistry
  >(
    frame: WireFrameByKind<Kind>,
    registry: Registry
  ) => ProjectedHonestReceiptOutcome<Registry>;
};

export function projectCompoundReceiptHonestOutcome<
  Registry extends CompoundHonestOutcomeFailureRegistry
>(
  receipt: CompoundReceipt,
  registry: Registry,
  options: CompoundHonestOutcomeProjectionOptions = {}
): ProjectedHonestReceiptOutcome<Registry> {
  const state: ProjectionState<Registry> = {
    committed: unknown("not_observed"),
    applied: unknown("not_observed"),
    visible: unknown("not_observed"),
    acked: unknown("not_observed"),
    failures: []
  };
  const context = { receipt, registry, state };
  const valid = receipt.schema === "compound-operation-receipt/v2"
    ? isCompoundOperationReceiptV2(receipt)
    : isCompoundOperationReceipt(receipt);
  if (!valid) {
    addFailure(context, "protocol_integrity_failed", "committed", {
      legacySchema: receipt.schema
    });
    state.committed = unknown("outcome_indeterminate", "legacy receipt failed integrity validation");
    state.applied = unknown("outcome_indeterminate");
    state.visible = unknown("outcome_indeterminate");
    state.acked = notReached(state.failures[0]!.id);
    return outcome(receipt, state, options);
  }

  if (receipt.authority) projectAuthority(receipt.authority, context);
  if (receipt.authority?.tag === "COMMITTED" && receipt.origin) {
    projectOrigin(receipt.origin, context);
  }
  projectDelivery(context);
  return outcome(receipt, state, options);
}

export function projectCompoundReceiptEnvelope<
  Registry extends CompoundHonestOutcomeFailureRegistry,
  Receipt extends CompoundReceipt
>(
  legacyReceipt: Receipt,
  registry: Registry,
  options: CompoundHonestOutcomeProjectionOptions = {}
): {
  readonly legacyReceipt: Receipt;
  readonly outcome: ProjectedHonestReceiptOutcome<Registry>;
} {
  return {
    legacyReceipt,
    outcome: projectCompoundReceiptHonestOutcome(legacyReceipt, registry, options)
  };
}

export function projectCompoundWireFrameHonestOutcome<
  Registry extends CompoundHonestOutcomeFailureRegistry
>(
  frame: CompoundReceiptWireFrameV1,
  registry: Registry
): ProjectedHonestReceiptOutcome<Registry> {
  const projector = wireProjectors[frame.kind] as (
    candidate: typeof frame,
    candidateRegistry: Registry
  ) => ProjectedHonestReceiptOutcome<Registry>;
  return projector(frame, registry);
}

const authorityProjectors = {
  COMMITTED: (authority, { state }) => {
    state.committed = confirmed({
      kind: "authority_receipt",
      ref: [
        authority.workspaceId,
        authority.opId,
        authority.revision,
        authority.commitSha
      ].join("/"),
      scope: {
        kind: "authority_store",
        id: authority.workspaceId,
        freshness: "historical_exact_at_cut"
      }
    });
  },
  REJECTED: (authority, context) => {
    const failure = addFailure(context, "request_rejected", "before_commit", {
      reason: authority.reason
    });
    context.state.committed = notReached(failure.id);
    context.state.applied = notReached(failure.id);
    context.state.visible = notReached(failure.id);
  },
  RETRYABLE_NOT_COMMITTED: (authority, context) => {
    const failure = addFailure(context, "not_committed_retryable", "before_commit", {
      reason: authority.reason
    });
    context.state.committed = notReached(failure.id);
    context.state.applied = notReached(failure.id);
    context.state.visible = notReached(failure.id);
  },
  INDETERMINATE: (authority, context) => {
    addFailure(context, "outcome_unknown", "committed", {
      reason: authority.reason,
      ...(authority.commitSha ? { commitSha: authority.commitSha } : {})
    });
    context.state.committed = unknown("outcome_indeterminate");
    context.state.applied = unknown("outcome_indeterminate");
    context.state.visible = unknown("outcome_indeterminate");
  }
} satisfies AuthorityProjectors;

const originProjectors = {
  APPLIED_EXACT_AT_CUT: (origin, { state }) => {
    state.applied = confirmed({
      kind: "materialization_witness",
      ref: [origin.viewId, origin.opId, origin.cutId, origin.version].join("/"),
      scope: {
        kind: "origin_view",
        id: origin.viewId,
        cutId: origin.cutId,
        freshness: "historical_exact_at_cut"
      }
    });
    state.visible = unknown("scope_not_proven");
  },
  SUPERSEDED: (origin, context) => {
    const failure = addFailure(context, "superseded", "applied", {
      committedVersion: origin.committedVersion,
      visibleVersion: origin.visibleVersion
    });
    context.state.applied = notReached(failure.id);
    context.state.visible = notReached(failure.id);
  },
  LOCAL_CONFLICT: (origin, context) => {
    const failure = addFailure(context, "apply_conflict", "applied", {
      conflictIds: origin.conflictIds
    });
    context.state.applied = notReached(failure.id);
    context.state.visible = notReached(failure.id);
  },
  APPLY_BLOCKED: (origin, context) => {
    const failure = addFailure(context, "apply_blocked", "applied", {
      reasons: origin.reasons
    });
    context.state.applied = notReached(failure.id);
    context.state.visible = notReached(failure.id);
  },
  NONQUIESCENT: (origin, context) => {
    const failure = addFailure(context, "apply_blocked", "applied", {
      subtype: "NONQUIESCENT",
      writerSetReason: origin.writerSetReason
    });
    context.state.applied = notReached(failure.id);
    context.state.visible = notReached(failure.id);
  },
  VIEW_UNAVAILABLE: (origin, context) => {
    const failure = addFailure(context, "view_unavailable", "visible", {
      reason: origin.reason
    });
    context.state.applied = unknown("not_observed");
    context.state.visible = notReached(failure.id);
  }
} satisfies OriginProjectors;

const wireProjectors = {
  OPEN_WAITER: (frame, registry) => unknownWireOutcome(frame.opId, registry),
  WAITER_OPENED: (frame, registry) => unknownWireOutcome(frame.opId, registry),
  RESULT_PREPARED: (frame, registry) =>
    projectCompoundReceiptHonestOutcome(frame.receipt, registry),
  DELIVERY_ACK: (frame, registry) => unknownWireOutcome(frame.opId, registry),
  ACK_COMMITTED: (frame, registry) => {
    const projected = projectCompoundReceiptHonestOutcome(frame.receipt, registry);
    const acknowledgement = frame.receipt.acknowledgement;
    if (acknowledgement
      && frame.receipt.delivery === "ACK_COMMITTED"
      && frame.receipt.terminalLSN === frame.terminalLSN
      && acknowledgement.preparedSequence === frame.preparedSequence
      && acknowledgement.preparedReceiptDigest === frame.preparedReceiptDigest) return projected;
    return protocolDamagedWireOutcome(projected, frame.opId, registry);
  },
  GET_WAITER: (frame, registry) => unknownWireOutcome(frame.opId, registry),
  WAITER_STATE: (frame, registry) =>
    frame.state === "RECEIPT" && frame.receipt
      ? projectCompoundReceiptHonestOutcome(frame.receipt, registry)
      : unknownWireOutcome(`request:${frame.requestId}`, registry)
} satisfies WireProjectors;

function projectAuthority<Registry extends CompoundHonestOutcomeFailureRegistry>(
  authority: AuthorityOperationReceipt,
  context: ProjectionContext<Registry>
): void {
  const projector = authorityProjectors[authority.tag] as (
    candidate: typeof authority,
    candidateContext: ProjectionContext<Registry>
  ) => void;
  projector(authority, context);
}

function projectOrigin<Registry extends CompoundHonestOutcomeFailureRegistry>(
  origin: Origin,
  context: ProjectionContext<Registry>
): void {
  const projector = originProjectors[origin.tag] as (
    candidate: typeof origin,
    candidateContext: ProjectionContext<Registry>
  ) => void;
  projector(origin, context);
}

function projectDelivery<Registry extends CompoundHonestOutcomeFailureRegistry>(
  context: ProjectionContext<Registry>
): void {
  const { receipt, state } = context;
  if (receipt.delivery === "PENDING") {
    state.acked = unknown("not_observed");
    return;
  }
  if (receipt.delivery === "RESULT_PREPARED") {
    state.acked = { status: "not_reached", reason: "pending" };
    return;
  }
  if (receipt.delivery === "ACK_COMMITTED" && receipt.acknowledgement && receipt.terminalLSN !== undefined) {
    state.acked = confirmed({
      kind: "terminal_ack_journal",
      ref: [
        receipt.workspaceId,
        receipt.viewId,
        receipt.opId,
        receipt.waiterId,
        receipt.terminalLSN
      ].join("/"),
      scope: {
        kind: "caller",
        id: receipt.waiterId,
        freshness: "current"
      }
    });
    return;
  }
  const reason = receipt.delivery === "DETACHED"
    ? "view_unavailable"
    : "protocol_integrity_failed";
  const failure = addFailure(context, reason, "acked", {
    delivery: receipt.delivery
  });
  state.acked = notReached(failure.id);
}

function addFailure<
  Registry extends CompoundHonestOutcomeFailureRegistry,
  Reason extends CompoundFailureReason
>(
  context: ProjectionContext<Registry>,
  reason: Reason,
  at: ProjectedFailure<Registry, Reason>["at"],
  detail?: Readonly<Record<string, unknown>>
): ProjectedFailure<Registry, Reason> {
  const registered = context.registry[reason];
  const failure: ProjectedFailure<Registry, Reason> = {
    id: `${context.receipt.opId}:${reason}`,
    reason,
    family: registered.family,
    at,
    recovery: registered.recovery,
    ...(detail ? { detail } : {})
  };
  context.state.failures.push(failure);
  return failure;
}

function outcome<Registry extends CompoundHonestOutcomeFailureRegistry>(
  receipt: CompoundReceipt,
  state: ProjectionState<Registry>,
  options: CompoundHonestOutcomeProjectionOptions
): ProjectedHonestReceiptOutcome<Registry> {
  return {
    schema: "honest-receipt-outcome/v1",
    operation: {
      namespace: "compound-operation",
      id: [receipt.workspaceId, receipt.viewId, receipt.opId, receipt.waiterId].join("/")
    },
    moments: {
      committed: state.committed,
      applied: state.applied,
      visible: state.visible,
      acked: state.acked
    },
    failures: state.failures,
    ...(options.legacyDigest
      ? { legacy: { schema: receipt.schema, digest: options.legacyDigest } }
      : {})
  };
}

function confirmed(evidence: ProjectedEvidenceRef): ProjectedMoment {
  return { status: "confirmed", evidence: [evidence] };
}

function notReached(failureId: string): ProjectedMoment {
  return { status: "not_reached", reason: "terminal_failure", failureId };
}

function unknown(
  reason: Extract<ProjectedMoment, { readonly status: "unknown" }>["reason"],
  detail?: string
): ProjectedMoment {
  return { status: "unknown", reason, ...(detail ? { detail } : {}) };
}

function unknownWireOutcome<Registry extends CompoundHonestOutcomeFailureRegistry>(
  operationId: string,
  _registry: Registry
): ProjectedHonestReceiptOutcome<Registry> {
  return {
    schema: "honest-receipt-outcome/v1",
    operation: { namespace: "compound-wire", id: operationId },
    moments: {
      committed: unknown("not_observed"),
      applied: unknown("not_observed"),
      visible: unknown("not_observed"),
      acked: unknown("not_observed")
    },
    failures: []
  };
}

function protocolDamagedWireOutcome<Registry extends CompoundHonestOutcomeFailureRegistry>(
  projected: ProjectedHonestReceiptOutcome<Registry>,
  operationId: string,
  registry: Registry
): ProjectedHonestReceiptOutcome<Registry> {
  const failure = {
    id: `${operationId}:protocol_integrity_failed`,
    reason: "protocol_integrity_failed",
    family: registry.protocol_integrity_failed.family,
    at: "acked",
    recovery: registry.protocol_integrity_failed.recovery,
    detail: { source: "ACK_COMMITTED frame mismatch" }
  } as const satisfies ProjectedFailure<Registry, "protocol_integrity_failed">;
  return {
    ...projected,
    moments: {
      ...projected.moments,
      acked: notReached(failure.id)
    },
    failures: [
      ...projected.failures.filter((candidate) => candidate.id !== failure.id),
      failure
    ]
  };
}
