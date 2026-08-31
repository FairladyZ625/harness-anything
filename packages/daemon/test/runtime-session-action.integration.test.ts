// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

test("the center queue admits one RuntimeSession adoption generation and rejects its concurrent sibling", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-session-action-")),
    repoId = workspaceId("runtime-session-action"),
    key = "dual-edge-runtime-session",
    hash = createHash("sha256").update(`${repoId}\0${key}`).digest("hex"),
    dispatchId = `dispatch_${hash.slice(0, 24)}`,
    runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
    dispatchOpId = `runtime-spawn-${hash.slice(0, 32)}`,
    source = { kind: "assignment", nodeId: "edge-a", assignmentId: "assignment-a" } as const,
    binding: RepoCellBinding = {
      actor: { principal: { personId: "person-edge" }, executor: null },
      source,
      assignmentScope: {
        repoId,
        scope: { kind: "task", taskId: "task-runtime-action", executionId: "exe-runtime-action", paths: [] },
      },
      writerEpoch: 7,
    },
    foreignBinding: RepoCellBinding = {
      ...binding,
      source: { kind: "assignment", nodeId: "edge-b", assignmentId: "assignment-b" },
    },
    definition = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "runtime-instance-a",
      installationId: "runtime-installation-a",
      kindId: "codex",
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      baseUrl: null,
      authMode: "subscription",
    } as const;
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId,
    rootDir: canonicalRoot(rootDir),
    ownerId: "runtime-session-action-test",
    mode: "remote-center",
    now: monotonicClock(),
  });
  try {
    const dispatched = await cell.runtimeIngress(
      {
        kind: "event",
        type: "runtime_dispatch_requested",
        opId: dispatchOpId,
        payload: {
          dispatchId,
          runtimeSessionId,
          instanceId: definition.instanceId,
          installationId: definition.installationId,
          kindId: definition.kindId,
          idempotencyKey: key,
          definitionSnapshotRef: "artifact:runtime-definition/action-a",
          definitionSnapshot: definition,
        },
      },
      binding,
    );
    assert.equal(dispatched.outcome, "applied", JSON.stringify(dispatched));
    const start = (opId: string, caller: RepoCellBinding) =>
        cell.runtimeIngress(
          {
            kind: "event",
            type: "runtime_session_started",
            opId,
            payload: {
              runtimeSessionId,
              instanceId: definition.instanceId,
              installationId: definition.installationId,
              kindId: definition.kindId,
              definitionSnapshotRef: "artifact:runtime-definition/action-a",
              launchGeneration: 7,
              attachable: true,
            },
          },
          caller,
        ),
      attempts = await Promise.allSettled([
        start("runtime-start-edge-a", binding),
        start("runtime-start-edge-b", foreignBinding),
      ]);
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = attempts.find(({ status }) => status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected")
      assert.equal((rejected.reason as { readonly code?: unknown }).code, "assignment_scope_mismatch");
    await assert.rejects(
      start("runtime-start-stale-generation", binding),
      (error: unknown) => (error as { readonly code?: unknown }).code === "runtime_session_adoption_stale",
    );
    const store = makeTaskEventStore({ repoId, rootDir });
    assert.equal(
      store
        .read()
        .events.filter(
          (event) => event.type === "runtime_session_started" && event.payload.runtimeSessionId === runtimeSessionId,
        ).length,
      1,
    );
    await store.drain();
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function monotonicClock(): () => string {
  let tick = 0;
  return () => `2026-09-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;
}
