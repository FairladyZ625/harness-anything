import {
  parseCanonicalEvent,
  serializeCanonicalEventUnchecked,
} from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import {
  compileDecisionWrite,
  MIGRATION_DOCUMENT_POLICY_ID,
  MIGRATION_IMPORT_SOURCE,
  migrationImportWritePlan,
  type AgentRuntimeEventV1,
  type MigrationImportEventV1,
} from "@harness-anything/kernel";
import {
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { canonicalEventWritePlan, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
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

export function historicalBillingDispatchBytes(body: string, legacySource = false): string {
  const event = parseCanonicalEvent(body);
  if (event.schema !== "agent-runtime-event/v1" || event.type !== "runtime_dispatch_requested")
    throw new Error("Expected a billing dispatch");
  const { dispatchId, runtimeSessionId } = event.payload;
  const historical = serializeCanonicalEventUnchecked({
    ...event,
    ...(legacySource && dispatchId !== "billing-millis-dispatch"
      ? { source: `runtime-session/${runtimeSessionId}` as const }
      : {}),
    occurredAt: dispatchId === "billing-alice-dispatch" ? "2026-11-19T11:00:00+08:00" : event.occurredAt,
    payload: {
      ...event.payload,
      ...(dispatchId === "billing-millis-dispatch" ? { startedAt: "2026-11-18T22:00:00.0009-05:00" } : {}),
    },
  });
  parseCanonicalEvent(historical);
  return historical;
}

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
    ["alice", alice, edgeA, "2026-11-19T03:00:00Z", 15],
    ["millis", alice, edgeA, first, 5],
    ["later", alice, edgeA, "2026-11-19T03:00:00.1Z", 8],
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
    if (id === "live" || id === "alice" || id === "millis") historicalDispatchRevisions.push(nextRevision());
    await appendRuntime({
      ...envelope(`dispatch-${id}`, personId, nodeId, at),
      schema: "agent-runtime-event/v1",
      type: "runtime_dispatch_requested",
      payload: {
        ...identity,
        dispatchId,
        dispatchKey: `billing-${id}-key`,
        taskId: id === "millis" ? "billing-task-b" : "billing-task-a",
        ...(id === "live" || id === "alice" ? {} : { startedAt: at }),
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

export function migratedTaskPinBundle(taskId: string, revision: number): CanonicalWriteBundle {
  const packagePath = `tasks/${taskId}-legacy`,
    body = "# Imported task\n",
    blob = { sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown", body },
    task = lifecycleFixture({ taskId }).events[0]!.payload.task,
    event: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      type: "entity_migrated",
      eventId: `migration-event-${taskId}`,
      opId: `migration-op-${taskId}`,
      workspaceRevision: revision,
      actor: actor(alice),
      source: MIGRATION_IMPORT_SOURCE,
      occurredAt: first,
      payload: {
        generation: "v0",
        migratedFrom: taskId,
        entity: {
          kind: "task",
          provenance: "imported_snapshot",
          task: { ...task, pinned: true, createdBy: actor(bob) },
          originalStatus: task.status,
          packagePath,
          documentClaim: {
            path: `${packagePath}/INDEX.md`,
            sha256: blob.sha256,
            size: blob.size,
            mediaType: blob.mediaType,
            policyId: MIGRATION_DOCUMENT_POLICY_ID,
          },
        },
      },
    };
  return { event, plan: migrationImportWritePlan(event), blobs: [blob] };
}
