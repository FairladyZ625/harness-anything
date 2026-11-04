import assert from "node:assert/strict";
import {
  validateCurrentAgentRuntimeEvent,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import type { CanonicalEventStore } from "@harness-anything/kernel";
import { canonicalEventWritePlan } from "../src/store/task-event-store.ts";

/** Provider ids are opaque nonempty strings; the writing boundary accepts this byte sequence. */
export function runtimeProviderEvents(): AgentRuntimeEventV1[] {
  const base = {
    schema: "agent-runtime-event/v1" as const,
    actor: { principal: { personId: "fixture" }, executor: null },
    source: "local" as const,
    occurredAt: "2026-11-05T00:00:00.000Z",
  };
  return [
    {
      ...base,
      eventId: "provider-start",
      opId: "provider-start",
      workspaceRevision: 1,
      type: "runtime_session_started",
      payload: {
        runtimeSessionId: "runtime-provider-bytes",
        instanceId: "worker",
        installationId: "codex-installation",
        kindId: "codex",
        definitionSnapshotRef: "artifact:runtime-definition/test",
        launchGeneration: 1,
        attachable: false,
      },
    },
    {
      ...base,
      eventId: "provider-bound",
      opId: "provider-bound",
      workspaceRevision: 2,
      type: "runtime_session_provider_bound",
      payload: {
        runtimeSessionId: "runtime-provider-bytes",
        providerSessionId: "opaque\0provider",
        transcriptRef: "file:runtime/transcript.jsonl",
      },
    },
  ];
}

export function assertRuntimeProviderBytes(store: CanonicalEventStore): void {
  const events = runtimeProviderEvents();
  for (const event of events) {
    assert.deepEqual(validateCurrentAgentRuntimeEvent(event), []);
    const receipt = store.append({
      event,
      plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
      blobs: [],
    });
    assert.equal(receipt.status, "applied");
  }
  assert.deepEqual(store.readBatch(null, 2).events, events);
}
