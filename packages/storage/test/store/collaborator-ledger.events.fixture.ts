import { compileDecisionWrite, type AgentRuntimeEventV1 } from "@harness-anything/kernel";
import {
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { canonicalEventWritePlan, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { decisionProposal } from "./task-event-store.fixtures.ts";
import { relation } from "./relation-graph-projection.fixtures.ts";

export const alice = "person_alice";
export const bob = "person_bob";
export const edgeA = "edge-a";
export const edgeB = "edge-b";
export const first = "2026-11-19T03:00:00.000Z";
export const second = "2026-11-19T04:00:00.000Z";
const actor = (personId: string) => ({ principal: { personId }, executor: null });
const node = (nodeId: string) => ({ kind: "node" as const, nodeId });
export const awaitRef = "decision/dec_AWAITS_BOB";

export async function appendCollaboratorLedger(
  append: (bundle: CanonicalWriteBundle) => void | Promise<void>,
  nextRevision: () => number,
): Promise<readonly number[]> {
  const envelope = (id: string, person: string, nodeId: string, occurredAt = first) => ({
    eventId: `event-collaborator-${id}`,
    opId: `op-collaborator-${id}`,
    workspaceRevision: nextRevision(),
    occurredAt,
    actor: actor(person),
    source: node(nodeId),
  });

  for (const [decisionId, personId, nodeId] of [
    ["dec_ALICE_ONLY", alice, edgeA],
    ["dec_AWAITS_BOB", alice, edgeA],
    ["dec_BOB_ONLY", bob, edgeB],
  ] as const) {
    const draft = decisionProposal();
    const compiled = compileDecisionWrite({
      event: { ...draft, ...envelope(decisionId, personId, nodeId), decisionId },
      currentDecision: null,
      currentRelations: [],
      currentDocument: null,
      decisionReviewRequirement: "off",
    });
    await append(compiled);
  }
  for (const [ref, nodeId] of [
    [awaitRef, edgeA],
    ["decision/dec_BOB_ONLY", edgeB],
  ] as const) {
    const { strength: _strength, ...record } = relation({ source: ref, target: `person/${bob}`, type: "awaits" }),
      edge = compileRelationCreatedEvent({
        ...envelope(`ask-${nodeId}`, alice, nodeId),
        record: {
          ...record,
          targetObservedVersion: `keycloak-user:${bob}:fixture-bob`,
          rationale: "consent: Review the deployment?",
        },
      });
    await append({ event: edge, plan: relationEventWritePlan(edge), blobs: [] });
  }
  const appendRuntime = (event: AgentRuntimeEventV1) =>
    append({ event, plan: canonicalEventWritePlan(event, event.schema, event.opId), blobs: [] });
  const historicalDispatchRevisions: number[] = [];
  for (const [id, personId, nodeId, at, total] of [
    ["live", alice, edgeA, "2026-11-19T02:00:00.000Z", null],
    ["alice", alice, edgeA, first, 15],
    ["bob", bob, edgeB, second, 27],
  ] as const) {
    const runtimeSessionId = `billing-${id}-session`,
      dispatchId = `billing-${id}-dispatch`,
      identity = {
        runtimeSessionId,
        instanceId: `billing-${id}-instance`,
        installationId: `billing-${id}-installation`,
        kindId: "codex",
        definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
      };
    await appendRuntime({
      ...envelope(`launch-${id}`, personId, nodeId, at),
      schema: "agent-runtime-event/v1",
      type: "runtime_session_started",
      payload: { ...identity, launchGeneration: 1, attachable: false },
    });
    if (id !== "bob") historicalDispatchRevisions.push(nextRevision());
    await appendRuntime({
      ...envelope(`dispatch-${id}`, personId, nodeId, at),
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      payload: {
        ...identity,
        dispatchId,
        dispatchKey: `billing-${id}-key`,
        ...(id === "bob" ? { startedAt: at } : {}),
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: identity.instanceId,
          installationId: identity.installationId,
          kindId: identity.kindId,
          providerId: "openai",
          model: "codex-fixture",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
      },
    });
    if (total === null) continue;
    await appendRuntime({
      ...envelope(`metrics-${id}`, personId, nodeId, at),
      schema: "agent-runtime-event/v1",
      type: "runtime_session_outcome_observed",
      payload: {
        runtimeSessionId,
        dispatchId,
        outcome: "succeeded",
        exitCode: 0,
        resultRef: `artifact:runtime-result/sha256/${"a".repeat(64)}`,
        result: null,
        runtimeMetrics: {
          inputTokens: total - 5,
          cacheReadTokens: 2,
          outputTokens: 5,
          totalTokens: total,
          toolCallCount: 1,
          usageUnavailable: false,
        },
      },
    });
  }
  return historicalDispatchRevisions;
}
