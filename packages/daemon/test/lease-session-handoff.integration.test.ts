// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const binding = (session: string, personId = "person-owner") =>
  withPolicyGroup(
    { actor: { principal: { personId }, executor: { kind: "agent" as const, id: session } }, source: "local" as const },
    "admin",
  );

test("same person explicitly releases another session's lease once, audits the handoff and rejoins", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-session-handoff-")),
    repoId = "lease-session-handoff",
    taskId = "task-session-handoff",
    holder = binding("claude-session:previous"),
    replacement = binding("codex-session:replacement"),
    concurrent = binding("claude-session:concurrent"),
    reason = "Owner handed coordination from Claude to Codex.";
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: rootDir, stdio: "ignore" });
    git("init", "--quiet");
    git("config", "user.name", "Lease Session Fixture");
    git("config", "user.email", "lease-session@example.invalid");
    git("commit", "--allow-empty", "--quiet", "-m", "base");
    cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(rootDir),
      ownerId: repoId,
    });
    const created = await cell.run({ kind: "task-create", taskId, title: "Session handoff" }, holder);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, holder);
    await realizeTaskPlanFixture(rootDir, String((created as Record<string, unknown>).packagePath), (planPath) =>
      cell!.run({ kind: "doc-submit", paths: [planPath] }, holder),
    );
    const started = await cell.run({ kind: "task-start", taskId }, holder);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, holder);
    const show = await cell.run({ kind: "task-show", taskId }, holder),
      before = JSON.parse(String(show.evidence)),
      reader = makeTaskEventReader({ repoId, rootDir }),
      releaseCount = () =>
        reader.read().events.filter((event) => event.schema === "task-event/v1" && event.type === "lease_released")
          .length;
    assert.equal((await cell.run({ kind: "task-release", taskId }, replacement)).code, "lease_conflict");
    assert.equal((await cell.run({ kind: "task-release", taskId, reason: "   " }, replacement)).code, "lease_conflict");
    assert.equal(
      (await cell.run({ kind: "task-release", taskId, reason }, binding("other-session", "person-other"))).code,
      "lease_conflict",
    );
    assert.equal(releaseCount(), 0, "refusals must not publish a release");
    const results = await Promise.all([
      cell.run({ kind: "task-release", taskId, reason }, replacement),
      cell.run({ kind: "task-release", taskId, reason }, concurrent),
    ]);
    assert.equal(results.filter((receipt) => receipt.outcome === "applied").length, 1, JSON.stringify(results));
    assert.equal(results.filter((receipt) => receipt.outcome === "op_rejected").length, 1, JSON.stringify(results));
    const winner = results.find((receipt) => receipt.outcome === "applied")!;
    await waitForFixturePublication(cell, winner.opId, holder);
    assert.equal(releaseCount(), 1);
    const event = reader
      .read()
      .events.find((event) => event.schema === "task-event/v1" && event.type === "lease_released");
    assert.ok(event?.schema === "task-event/v1" && event.type === "lease_released");
    assert.ok([replacement.actor.executor.id, concurrent.actor.executor.id].includes(event.actor.executor!.id));
    assert.equal(event.actor.principal.personId, holder.actor.principal.personId);
    assert.deepEqual(event.payload.releasedLease.actor, holder.actor);
    assert.equal(event.payload.releasedLease.version, before.lease.version);
    assert.equal(event.payload.mutation.reason, reason);
    assert.ok(Number.isFinite(Date.parse(event.occurredAt)));
    const projection = makeTaskProjection({ rootDir, eventStore: reader });
    try {
      projection.rebuild();
      assert.equal(projection.read(taskId).snapshot.lease, null, "release survives canonical replay");
    } finally {
      projection.close();
    }
    const rejoined = await cell.run({ kind: "task-start", taskId }, replacement);
    assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));
    await waitForFixturePublication(cell, rejoined.opId, replacement);
    const after = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, replacement)).evidence));
    assert.deepEqual(after.lease.actor, replacement.actor);
    assert.equal(after.lease.executionId, before.lease.executionId, "handoff retains the current round");
    assert.ok(after.lease.version > before.lease.version);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
