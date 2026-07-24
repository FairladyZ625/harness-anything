import {
  encodeTaskDecisionModuleCommandPayloadV2,
  type ProductionAuthorityCommand,
  type TaskDecisionModuleCommandPayloadV2
} from "@harness-anything/application";
import {
  decisionEntityId,
  decisionSemanticMutationActions,
  moduleEntityId,
  type DecisionPackage,
  type RegistryEntityRefV2,
  type WriteOp
} from "@harness-anything/kernel";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";
import { hostedSnapshot } from "./semantic-state.ts";

export function canonicalIntent(
  commandName: string,
  payload: Uint8Array,
  mutations: CanonicalAttemptIntent["mutations"],
  baseRefs: ReadonlyArray<RegistryEntityRefV2>,
  portablePaths: ReadonlyArray<string>,
  physicalEntityId: string
): CanonicalAttemptIntent {
  return { commandName, payload, mutations, baseRefs, portablePaths, declaredPathCas: [], physicalEntityId };
}

export function moduleCanonicalIntent(
  commandName: string,
  payload: Uint8Array,
  entity: RegistryEntityRefV2,
  action: string,
  moduleKey: string,
  authoredRoot: string
): CanonicalAttemptIntent {
  const intent = canonicalIntent(
    commandName,
    payload,
    [{ entity, action }],
    [entity],
    ["modules.json"],
    moduleEntityId(moduleKey)
  );
  const snapshot = hostedSnapshot(authoredRoot, "modules.json");
  return { ...intent, declaredPathCas: snapshot ? [{ path: "modules.json", ...snapshot.cas }] : [] };
}

export function registryRef(
  entityKind: string,
  canonicalRef: string
): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

export function decisionTransitionAttemptIntent(
  command: ProductionAuthorityCommand,
  operation: WriteOp,
  authoredRoot: string
): CanonicalAttemptIntent {
  const action = command.action;
  if (action.kind !== "decision-transition") throw new Error("AUTHORITY_DECISION_TRANSITION_COMMAND_REQUIRED");
  const expectedKind = `decision_${action.transition}`;
  if (operation.entityId !== decisionEntityId(action.decisionId) || operation.kind !== expectedKind) {
    throw new Error("AUTHORITY_DECISION_TRANSITION_OPERATION_MISMATCH");
  }
  const raw = operation.payload;
  if (!raw || typeof raw !== "object" || !("decision" in raw)) {
    throw new Error("AUTHORITY_DECISION_TRANSITION_PAYLOAD_INVALID");
  }
  const decision = (raw as { readonly decision?: DecisionPackage }).decision;
  if (!decision || decision.decision_id !== action.decisionId) {
    throw new Error("AUTHORITY_DECISION_TRANSITION_ENTITY_MISMATCH");
  }
  const body = (raw as { readonly body?: unknown }).body;
  if (body !== undefined && typeof body !== "string") {
    throw new Error("AUTHORITY_DECISION_TRANSITION_BODY_INVALID");
  }
  const documentPath = `decisions/decision-${action.decisionId}/decision.md`;
  const snapshot = hostedSnapshot(authoredRoot, documentPath);
  if (!snapshot) throw new Error("AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED: decision transition requires the current Decision document");
  const entity = registryRef("decision", `decision/${action.decisionId}`);
  const payload: TaskDecisionModuleCommandPayloadV2 = {
    schema: "decision.state/v1",
    transition: action.transition,
    decision,
    ...(body === undefined ? {} : { body })
  };
  return {
    ...canonicalIntent(
      "decision.state",
      encodeTaskDecisionModuleCommandPayloadV2(payload),
      [{ entity, action: decisionSemanticMutationActions.state }],
      [entity],
      [documentPath],
      decisionEntityId(action.decisionId)
    ),
    declaredPathCas: [{ path: documentPath, ...snapshot.cas }]
  };
}
