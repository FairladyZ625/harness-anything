// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { actionDeclarations, makeTaskEventStore } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/repo-cell.ts";
import { keycloakRealm, serveKeycloak } from "./keycloak.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

test("runtime spawn production helpers cannot append canonical events outside the catalog commit", () => {
  const source = new URL("../src/", import.meta.url),
    offenders = readdirSync(source)
      .filter((name) => name.startsWith("runtime-spawn-") && name.endsWith(".ts"))
      .filter((name) => /store\.append/u.test(readFileSync(new URL(name, source), "utf8")));
  assert.deepEqual(offenders, []);
});

test("the center queue admits one RuntimeSession adoption generation and rejects its concurrent sibling", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-session-action-")),
    repoId = workspaceId("runtime-session-action"),
    key = "dual-edge-runtime-session",
    hash = createHash("sha256").update(`${repoId}\0${key}`).digest("hex"),
    dispatchId = `dispatch_${hash.slice(0, 24)}`,
    runtimeSessionId = `runtime_${hash.slice(24, 48)}`,
    dispatchOpId = `runtime-spawn-${hash.slice(0, 32)}`,
    source = { kind: "node", nodeId: "edge-a" } as const,
    // Both nodes act for one person who holds every action here, so only the assignment fence can
    // tell the two starts apart.
    served = await serveKeycloak(),
    binding: RepoCellBinding = {
      actor: { principal: { personId: "person-edge" }, executor: null },
      source,
      keycloakAuthorization: {
        center: { url: served.url, realm: keycloakRealm, clientId: "harness-center", accessToken: "center-token" },
      },
      writerEpoch: 7,
    },
    foreignBinding: RepoCellBinding = {
      ...binding,
      source: { kind: "node", nodeId: "edge-b" },
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
  served.keycloak.account("person-edge");
  served.keycloak.permit(
    "person-edge",
    repoId,
    actionDeclarations.map(({ kind }) => kind),
  );
  initRepo(rootDir);
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined = await openRepoCell({
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
        // A remote dispatch declares the admission context the center judges it by; a worker
        // dispatch names its task scope and no reviewer role.
        dispatchContext: { role: null, taskId: null, executionId: null },
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
    assert.equal(attempts.filter(({ status }) => status === "fulfilled").length, 2);
    const receipts = attempts.flatMap((attempt) => (attempt.status === "fulfilled" ? [attempt.value] : [])),
      rejected = receipts.find(({ outcome }) => outcome === "op_rejected");
    assert.equal(receipts.filter(({ outcome }) => outcome === "applied").length, 1);
    assert.equal(rejected?.code, "execution_scope_mismatch");
    assert.deepEqual(rejected?.unmetCriteria, [
      {
        ref: "runtime-session/node-fence",
        failureCode: "execution_scope_mismatch",
        explain: "The authenticated node and owner own the canonical dispatch that created this RuntimeSession.",
      },
    ]);
    served.keycloak.account("person-new-owner");
    served.keycloak.permit(
      "person-new-owner",
      repoId,
      actionDeclarations.map(({ kind }) => kind),
    );
    const changedOwner = await start("runtime-start-new-owner", {
      ...binding,
      actor: { principal: { personId: "person-new-owner" }, executor: null },
    });
    assert.equal(changedOwner.code, "execution_scope_mismatch");
    const stale = await start("runtime-start-stale-generation", binding);
    assert.equal(stale.outcome, "op_rejected");
    assert.equal(stale.code, "runtime_session_adoption_stale");
    assert.deepEqual(stale.unmetCriteria, [
      {
        ref: "runtime-session/adoption-fence",
        failureCode: "runtime_session_adoption_stale",
        explain: "A RuntimeSession start must advance its center-projected launchGeneration.",
      },
    ]);
    await cell.close();
    cell = undefined;
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
    await cell?.close();
    await served.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function monotonicClock(): () => string {
  let tick = 0;
  return () => `2026-09-01T00:00:${String(tick++).padStart(2, "0")}.000Z`;
}
