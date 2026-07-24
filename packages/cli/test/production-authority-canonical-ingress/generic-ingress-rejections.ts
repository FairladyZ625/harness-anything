import assert from "node:assert/strict";
import {
  moduleEntityId,
  taskEntityId
} from "../../../kernel/src/index.ts";
import type { DaemonAuthorityCommandSubmissionV2 } from "../../../daemon/src/index.ts";
import { daemonActorAttribution } from "../../src/composition/actor-attribution.ts";

export async function verifyGenericIngressRejections(input: {
  readonly submission: DaemonAuthorityCommandSubmissionV2;
  readonly repoRoot: string;
  readonly actor: Parameters<typeof daemonActorAttribution>[0];
}): Promise<void> {
  await assert.rejects(input.submission.submit({
    ingress: "generic",
    command: {
      rootDir: input.repoRoot,
      action: { kind: "task-claim", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0" }
    },
    attribution: daemonActorAttribution(input.actor, { kind: "agent", id: "codex" }),
    currentSession: { runtime: "codex", sessionId: "session-production", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z" },
    canonicalEntityId: taskEntityId("task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0")
  }), (error: unknown) => {
    const rejected = error as { readonly _tag?: unknown; readonly code?: unknown; readonly reason?: unknown };
    return rejected?._tag === "WriteRejected"
      && rejected.code === "authority_ingress_rejected"
      && rejected.reason === "AUTHORITY_TYPED_COMMAND_UNSUPPORTED:task-claim";
  });
  await assert.rejects(input.submission.submit({
    ingress: "generic",
    command: {
      rootDir: input.repoRoot,
      json: true,
      action: { kind: "progress-append", taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0", text: "entity mismatch evidence", dryRun: false }
    },
    attribution: daemonActorAttribution(input.actor, { kind: "agent", id: "codex" }),
    currentSession: { runtime: "codex", sessionId: "session-mismatch", source: "manual", detectedAt: "2026-07-17T00:00:00.000Z" },
    canonicalEntityId: moduleEntityId("wrong-entity")
  }), (error: unknown) => {
    const rejected = error as { readonly _tag?: unknown; readonly code?: unknown; readonly reason?: unknown };
    return rejected?._tag === "WriteRejected"
      && rejected.code === "authority_ingress_rejected"
      && rejected.reason === "AUTHORITY_CANONICAL_ENTITY_MISMATCH:submittedEntityId=module/wrong-entity;intentEntityId=task/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG0";
  });
}
