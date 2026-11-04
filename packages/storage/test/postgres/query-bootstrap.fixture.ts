import assert from "node:assert/strict";
import type { ActorIdentity } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import {
  taskBootstrapWritePlan,
  taskBootstrapPackagePath,
  type TaskBootstrapEventV1,
} from "@harness-anything/kernel/internal/domain/task-bootstrap-event.ts";
import { compileEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { sha256Text, stableStringify } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { taskCreated } from "../store/relation-graph-projection.fixtures.ts";
import type { CanonicalWriteBundle } from "../../src/store/task-event-store.ts";

export async function appendBootstrapQueryFixture(
  append: (candidate: CanonicalWriteBundle) => Promise<void>,
  revision: () => number,
  actor: ActorIdentity,
): Promise<string> {
  const bootstrapTaskId = "task-bootstrap-projection",
    bootstrapTaskBase = taskCreated(revision(), bootstrapTaskId),
    presetValue = { schema: "preset-snapshot/v1", id: "projection-replay" },
    presetDigest = `sha256:${sha256Text(stableStringify(presetValue))}` as const,
    presetBody = `${stableStringify({ ...presetValue, digest: presetDigest })}\n`,
    bootstrapDocumentBody = "# Projection bootstrap\n",
    bootstrapDocumentPath = `tasks/${bootstrapTaskId}-projection-bootstrap/task_plan.md`,
    bootstrapEvent: TaskBootstrapEventV1 = {
      schema: "task-bootstrap-event/v1",
      eventId: "pg-bootstrap-projection",
      workspaceRevision: revision(),
      opId: "pg-bootstrap-projection",
      taskId: bootstrapTaskId,
      type: "task_bootstrapped",
      actor: actor,
      source: "local",
      occurredAt: "2026-08-11T00:21:00.000Z",
      payload: {
        task: { ...bootstrapTaskBase.payload.task, presetSnapshotDigest: presetDigest },
        presetSnapshotClaim: {
          digest: presetDigest,
          sha256: sha256Text(presetBody),
          size: Buffer.byteLength(presetBody),
          mediaType: "application/json",
        },
        initialDocumentClaims: [
          {
            path: bootstrapDocumentPath,
            sha256: sha256Text(bootstrapDocumentBody),
            size: Buffer.byteLength(bootstrapDocumentBody),
            mediaType: "text/markdown",
            owner: "doc-sync",
            policyId: "markdown-body-replaceable/v1",
          },
        ],
      },
    };
  assert.equal(taskBootstrapPackagePath(bootstrapEvent), `tasks/${bootstrapTaskId}-projection-bootstrap`);
  await append({
    event: bootstrapEvent,
    plan: taskBootstrapWritePlan(bootstrapEvent),
    blobs: [
      {
        sha256: bootstrapEvent.payload.presetSnapshotClaim.sha256,
        size: bootstrapEvent.payload.presetSnapshotClaim.size,
        mediaType: "application/json",
        body: presetBody,
      },
      {
        sha256: sha256Text(bootstrapDocumentBody),
        size: Buffer.byteLength(bootstrapDocumentBody),
        mediaType: "text/markdown",
        body: bootstrapDocumentBody,
      },
    ],
  });
  const bootstrapStartBase = lifecycleFixture({
      taskId: bootstrapTaskId,
      executionId: "execution-bootstrap",
    }).events.find((value) => value.type === "execution_started")!,
    bootstrapStart = {
      ...bootstrapStartBase,
      eventId: "pg-bootstrap-start",
      opId: "pg-bootstrap-start",
      workspaceRevision: revision(),
    };
  await append({ event: bootstrapStart, plan: taskLifecycleWritePlan(bootstrapStart), blobs: [] });
  const pinned = compileEntityPinEvent({
    entityRef: `task/${bootstrapTaskId}`,
    pinned: true,
    eventId: "pg-bootstrap-pin",
    opId: "pg-bootstrap-pin",
    workspaceRevision: revision(),
    actor: actor,
    source: "local",
    occurredAt: "2026-08-11T00:22:00.000Z",
  });
  await append(pinned);

  return bootstrapTaskId;
}
