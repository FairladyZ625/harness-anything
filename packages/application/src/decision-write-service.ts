import { Effect, Schema } from "effect";
import {
  DecisionPackageSchema,
  decisionEntityId,
  explainDecisionStateTransition,
  type DecisionPackage,
  type DecisionState,
  type ProvenancePayload,
  type WriteCoordinator,
  type WriteError,
  type WriteOpKind
} from "../../kernel/src/index.ts";
import { stablePayloadHash, writeCoordinatedPayload, type PayloadHasher } from "../../kernel/src/write-coordination/write-helpers.ts";
import { bindCreateProvenance, type ProvenanceBindingOptions } from "./provenance-binding.ts";
import type { ProvenanceSessionExporterRejected } from "./provenance-session-exporter.ts";

export interface DecisionWriteServiceOptions extends ProvenanceBindingOptions {
  readonly coordinator: WriteCoordinator;
  readonly hashPayload?: PayloadHasher;
  readonly now?: () => string;
}

export interface DecisionWriteRequest {
  readonly decision: DecisionCreateInput;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export type DecisionCreateInput = Omit<DecisionPackage, "provenance"> & {
  readonly provenance?: DecisionPackage["provenance"];
};

export interface DecisionTransitionRequest {
  readonly current: DecisionPackage;
  readonly arbiter: DecisionPackage["arbiter"];
  readonly decidedAt?: string;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export interface DecisionAmendRequest {
  readonly current: DecisionPackage;
  readonly next: DecisionPackage;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export interface DecisionWriteResult {
  readonly decisionId: string;
  readonly state: DecisionState;
}

export interface DecisionWriteRejected {
  readonly _tag: "DecisionWriteRejected";
  readonly decisionId: string;
  readonly reason: string;
}

export interface DecisionWriteService {
  readonly propose: (request: DecisionWriteRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly accept: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly reject: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly defer: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly supersede: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly amend: (request: DecisionAmendRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly retire: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
}

export function makeDecisionWriteService(options: DecisionWriteServiceOptions): DecisionWriteService {
  const hashPayload = options.hashPayload ?? stablePayloadHash;
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  return {
    propose: (request) => {
      if (request.decision.state !== "proposed") {
        return Effect.fail(rejection(request.decision.decision_id, "decision_propose requires state proposed"));
      }
      return bindDecisionCreateProvenance(options, request.decision, timestamp()).pipe(
        Effect.catchAll((error) => Effect.fail(rejection(request.decision.decision_id, error.reason))),
        Effect.flatMap((decision) => writeDecision(options.coordinator, hashPayload, "decision_propose", decision, request))
      );
    },
    accept: (request) => transitionDecision(options.coordinator, hashPayload, "decision_accept", request, "active", timestamp()),
    reject: (request) => transitionDecision(options.coordinator, hashPayload, "decision_reject", request, "rejected", timestamp()),
    defer: (request) => transitionDecision(options.coordinator, hashPayload, "decision_defer", request, "deferred", timestamp()),
    // M3 has no separate superseded DecisionState; the distinct op records
    // supersede intent while sharing the retired terminal state.
    supersede: (request) => transitionDecision(options.coordinator, hashPayload, "decision_supersede", request, "retired", timestamp()),
    amend: (request) => {
      if (request.current.decision_id !== request.next.decision_id) {
        return Effect.fail(rejection(request.current.decision_id, "decision_amend cannot change decision_id"));
      }
      if (request.current.state !== request.next.state) {
        return Effect.fail(rejection(request.current.decision_id, "decision_amend cannot change decision state"));
      }
      return writeDecision(options.coordinator, hashPayload, "decision_amend", request.next, request);
    },
    retire: (request) => transitionDecision(options.coordinator, hashPayload, "decision_retire", request, "retired", timestamp())
  };
}

function bindDecisionCreateProvenance(
  options: DecisionWriteServiceOptions,
  decision: DecisionCreateInput,
  boundAt: string
): Effect.Effect<DecisionPackage, ProvenanceSessionExporterRejected> {
  return bindCreateProvenance(options, boundAt).pipe(
    Effect.map((provenance) => ({
      ...decision,
      provenance: provenance ? [provenance] : existingProvenance(decision)
    }))
  );
}

function existingProvenance(decision: DecisionCreateInput): ReadonlyArray<ProvenancePayload> {
  return decision.provenance ?? [];
}

function transitionDecision(
  coordinator: WriteCoordinator,
  hashPayload: PayloadHasher,
  kind: WriteOpKind,
  request: DecisionTransitionRequest,
  to: DecisionState,
  fallbackDecidedAt: string
): Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError> {
  const transition = explainDecisionStateTransition(request.current.state, to);
  if (!transition.allowed) {
    return Effect.fail(rejection(request.current.decision_id, `decision state transition ${request.current.state} -> ${to} rejected: ${transition.reason}`));
  }
  const next: DecisionPackage = {
    ...request.current,
    state: to,
    arbiter: request.arbiter,
    decidedAt: request.decidedAt ?? fallbackDecidedAt
  };
  return writeDecision(coordinator, hashPayload, kind, next, request);
}

function writeDecision(
  coordinator: WriteCoordinator,
  hashPayload: PayloadHasher,
  kind: WriteOpKind,
  decision: DecisionPackage,
  request: { readonly body?: string; readonly opIdPrefix?: string }
): Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError> {
  const validation = validateDecisionWrite(decision);
  if (validation) return Effect.fail(validation);
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId: decisionEntityId(decision.decision_id),
    kind,
    payload: {
      decision,
      ...(request.body ? { body: request.body } : {})
    },
    ...(request.opIdPrefix ? { opIdPrefix: request.opIdPrefix } : {})
  }).pipe(Effect.as({ decisionId: decision.decision_id, state: decision.state }));
}

function validateDecisionWrite(decision: DecisionPackage): DecisionWriteRejected | null {
  if (sameActor(decision.proposedBy, decision.arbiter)) {
    return rejection(decision.decision_id, "decision arbiter must differ from proposedBy");
  }
  if (decision.rejected.length === 0 || decision.rejected.some((entry) => entry.why_not.trim().length === 0)) {
    return rejection(decision.decision_id, "decision rejected alternatives require non-empty why_not");
  }
  try {
    Schema.decodeUnknownSync(DecisionPackageSchema)(decision);
    return null;
  } catch (error) {
    return rejection(decision.decision_id, error instanceof Error ? error.message : "decision package schema validation failed");
  }
}

function sameActor(left: DecisionPackage["proposedBy"], right: DecisionPackage["arbiter"]): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function rejection(decisionId: string, reason: string): DecisionWriteRejected {
  return { _tag: "DecisionWriteRejected", decisionId, reason };
}
