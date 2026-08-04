import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  actorAxesBindingCoreDigestV2,
  canonicalAttributionEventDigestV2,
  physicalChangeSetDigestV2,
  semanticMutationSetDigestV2,
  sha256Text
} from "@harness-anything/kernel";

export function writeLegacyAttributionEvent(opId, eventPath, taskProgressRelativePath, options = {}) {
  mkdirSync(path.dirname(eventPath), { recursive: true });
  writeFileSync(eventPath, `${JSON.stringify({
    schema: "attribution-event/v1",
    eventId: `attribution:${opId}`,
    opId,
    journalRecordSchema: "write-journal/v2",
    entityId: options.entityId ?? "task/task_synthetic_00000",
    kind: options.kind ?? "progress_append",
    actor: {
      principal: { kind: "person", personId: "person_fixture" },
      executor: { kind: "agent", id: "agent-fixture" }
    },
    principalSource: {
      kind: "daemon-authenticated",
      providerId: "fixture",
      credentialFingerprint: "fixture"
    },
    executorSource: "client-asserted",
    at: "2026-08-03T00:00:00.000Z",
    recordedAt: "2026-08-03T00:00:00.100Z",
    payloadHash: `sha256:${"1".repeat(64)}`,
    payloadRef: {
      path: `.harness/write-journal/payloads/${opId}.json`,
      sha256: `sha256:${"1".repeat(64)}`
    }
  })}\n`, "utf8");
  if (!taskProgressRelativePath.endsWith("/progress.md")) {
    throw new Error(`fixture legacy attribution target is not progress.md: ${taskProgressRelativePath}`);
  }
}

export function v2Event(opId, revision, options = {}) {
  const taskId = options.taskId ?? "task_T";
  const action = options.action ?? "create";
  const changedPath = options.path ?? `tasks/${taskId}/${opId}.md`;
  const mutationSet = {
    registryVersion: 1,
    mutations: [{
      entity: {
        registryVersion: 1,
        entityKind: options.taskId ? "task" : "fact",
        canonicalRef: options.taskId ? `task/${taskId}` : `fact/task_T/${opId}`
      },
      action: { registryVersion: 1, action }
    }]
  };
  const actorAxesBinding = {
    bindingId: "binding-synthetic",
    principalPersonId: "person_fixture",
    executorAgentId: "agent-fixture",
    workspaceId: "workspace-synthetic",
    deviceId: "device-synthetic",
    viewId: "view-synthetic",
    sessionId: "session-synthetic",
    schemaTuple: {
      wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
      commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
      localState: 1, applyJournal: 1
    }
  };
  const physicalChanges = [{
    path: changedPath,
    beforeDigest: "11".repeat(32),
    afterDigest: "22".repeat(32)
  }, ...(options.taskId ? [{
    path: `attribution-events/${sha256Text(opId)}.jsonl`,
    beforeDigest: null,
    afterDigest: "33".repeat(32)
  }] : [])];
  const withoutEventDigest = {
    schema: "attribution-event/v2",
    eventId: `attribution:${opId}`,
    workspaceId: "workspace-synthetic",
    opId,
    revision,
    commitSha: "commit-v2",
    previousCommit: "commit-v1",
    outcome: "COMMITTED",
    occurredAt: "2026-08-03T00:00:00.000Z",
    recordedAt: "2026-08-03T00:00:00.100Z",
    actorAxesBinding,
    semanticRequestDigest: "33".repeat(32),
    mutationSet,
    semanticMutationSetDigest: hex(semanticMutationSetDigestV2(mutationSet)),
    actorAxesBindingDigest: hex(actorAxesBindingCoreDigestV2(actorAxesBinding)),
    physicalChanges,
    changeSetDigest: hex(physicalChangeSetDigestV2(physicalChanges))
  };
  return {
    ...withoutEventDigest,
    canonicalEventDigest: hex(canonicalAttributionEventDigestV2(withoutEventDigest))
  };
}

function hex(value) {
  return Buffer.from(value).toString("hex");
}
