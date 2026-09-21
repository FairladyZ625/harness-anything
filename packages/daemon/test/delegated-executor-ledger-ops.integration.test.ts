// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateEmptyCanonicalGeneration,
  canonicalEventWritePlan,
  makeTaskEventReader,
  makeTaskEventStore,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { initRepo } from "./migration-import.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const runtimeSessionId = "runtime-ledger-ops",
  taskId = "task-delegated-batch-target",
  issuerPersonId = "person_zeyu",
  delegatedExecutor = { kind: "agent", id: `runtime-session:${runtimeSessionId}` } as const,
  principalBinding = { actor: { principal: { personId: issuerPersonId }, executor: null }, source: "local" as const },
  delegatedAction = () => ({
    kind: "task-amend",
    taskId,
    patches: [{ field: "title", value: "Delegated ledger operations" }],
    executor: delegatedExecutor,
  });

test("a delegated RuntimeSession runs lifecycle Actions on a task it is not bound to", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-delegated-executor-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    await seedRuntimeSession(rootDir);
    let now = "2026-09-19T10:00:00.000Z";
    cell = await openRepoCell({
      repoId: workspaceId("delegated-ledger-ops"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "delegated-executor",
      now: () => now,
    });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId, title: "Batch closeout target" }, principalBinding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "people-delegate",
            tokenId: "det_ledger_ops_1",
            runtimeSessionId,
            action: ["task-amend"],
            expiresAt: "2026-09-19T12:00:00.000Z",
          },
          principalBinding,
        )
      ).outcome,
      "applied",
    );

    const delegated = await cell.run(delegatedAction(), {
      actor: { principal: { personId: issuerPersonId }, executor: null },
      source: "local",
    });
    assert.equal(delegated.outcome, "applied", JSON.stringify(delegated));
    const decision = delegated.authorizationDecision as unknown as {
      readonly actor?: unknown;
      readonly bindingsUsed?: readonly Readonly<Record<string, unknown>>[];
    };
    assert.deepEqual(decision?.actor, {
      principal: { personId: issuerPersonId },
      executor: delegatedExecutor,
    });
    assert.deepEqual(
      decision?.bindingsUsed?.find((binding) => binding.proof === "delegated-execution-token"),
      {
        proof: "delegated-execution-token",
        tokenId: "det_ledger_ops_1",
        issuerPersonId,
        runtimeSessionId,
      },
    );
    const amended = makeTaskEventReader({ repoId: "delegated-ledger-ops", rootDir })
      .read()
      .events.find((event) => event.type === "task_amended" && event.taskId === taskId);
    assert.deepEqual(amended?.actor, {
      principal: { personId: issuerPersonId },
      executor: delegatedExecutor,
    });

    now = "2026-09-19T10:30:00.000Z";
    assert.equal(
      (await cell.run({ kind: "people-revoke-delegation", tokenId: "det_ledger_ops_1" }, principalBinding)).outcome,
      "applied",
    );
    const revokedClaim = await cell.run(delegatedAction(), {
      actor: { principal: { personId: issuerPersonId }, executor: null },
      source: "local",
    });
    assert.equal(revokedClaim.outcome, "op_rejected", JSON.stringify(revokedClaim));
    assert.equal(revokedClaim.code, "executor_binding_invalid");
    assert.match(
      String(revokedClaim.diagnostic?.expectation),
      /det_ledger_ops_1.*revoked at 2026-09-19T10:30:00\.000Z/u,
    );

    const otherSession = await cell.run(
      { ...delegatedAction(), executor: { kind: "agent", id: "runtime-session:unrelated-runtime" } },
      { actor: { principal: { personId: issuerPersonId }, executor: null }, source: "local" },
    );
    assert.equal(otherSession.code, "executor_binding_invalid");
    assert.match(String(otherSession.rejectionExplanation), /not canonically bound/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

async function seedRuntimeSession(rootDir: string): Promise<void> {
  const store = makeTaskEventStore({
      repoId: "delegated-ledger-ops",
      rootDir,
      activationPreflight: activateEmptyCanonicalGeneration,
    }),
    occurredAt = "2026-09-19T09:00:00.000Z",
    common = (revision: number) => ({
      schema: "agent-runtime-event/v1" as const,
      eventId: `event-delegated-${revision}`,
      workspaceRevision: revision,
      opId: `op-delegated-${revision}`,
      actor: { principal: { personId: issuerPersonId }, executor: null },
      source: "local" as const,
      occurredAt,
    }),
    events = [
      {
        ...common(1),
        type: "runtime_installation_observed",
        payload: {
          installationId: "installation-codex",
          kindId: "codex",
          protocolFamily: "codex",
          hostRef: "host:local",
          version: "1.0.0",
          discoverySource: "wrapper",
          capabilities: ["structured_witness", "resume", "attach", "session_identity"],
        },
      },
      {
        ...common(2),
        type: "runtime_dispatch_requested",
        payload: {
          dispatchId: "dispatch_delegated0000000000000001",
          runtimeSessionId,
          instanceId: "delegated-instance",
          installationId: "installation-codex",
          kindId: "codex",
          idempotencyKey: "delegated-ledger-ops-once",
          definitionSnapshotRef: "artifact:runtime-definition/delegated",
          definitionSnapshot: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId: "delegated-instance",
            installationId: "installation-codex",
            kindId: "codex",
            providerId: "openai",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
            baseUrl: null,
            authMode: "subscription",
          },
        },
      },
      {
        ...common(3),
        type: "runtime_session_started",
        payload: {
          runtimeSessionId,
          instanceId: "delegated-instance",
          installationId: "installation-codex",
          kindId: "codex",
          definitionSnapshotRef: "artifact:runtime-definition/delegated",
          launchGeneration: 1,
          attachable: true,
        },
      },
    ] as readonly AgentRuntimeEventV1[];
  for (const event of events)
    store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
  await store.drain();
}
