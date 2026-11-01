// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openNodeAutoClaimLoop } from "../src/node-auto-claim.ts";
import { writeNodeAutoClaimPolicy } from "../src/node-auto-claim-config.ts";
import { fleetNodeClaimFixture, localAuthFixture } from "./fleet-node-claim.fixtures.ts";

test("two same-owner nodes auto-claim through one canonical task lease", { timeout: 60_000 }, async (t) => {
  const fixture = await fleetNodeClaimFixture(t),
    userRoots = ["node-one", "node-two"].map((nodeId) => mkdtempSync(path.join(tmpdir(), `ha-auto-claim-${nodeId}-`))),
    taskId = "task-auto-claim-race";
  t.after(() => userRoots.forEach((userRoot) => rmSync(userRoot, { recursive: true, force: true })));
  assert.equal(
    (await fixture.command("node-one", { kind: "settings-update", fleetClaimScope: "reserved" })).outcome,
    "applied",
  );
  assert.equal(
    (await fixture.command("node-one", { kind: "task-create", taskId, title: "Auto-claim race" })).outcome,
    "applied",
  );
  const shown = await fixture.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture()),
    snapshot = JSON.parse(String(shown.evidence)),
    expiresAt = new Date(Date.now() + 60_000).toISOString(),
    assigned = await fixture.command("node-one", {
      kind: "task-assign",
      taskId,
      personId: "person-one",
      expiresAt,
      expectedVersion: snapshot.revision,
    });
  assert.equal(assigned.outcome, "applied", JSON.stringify(assigned));

  for (const userRoot of userRoots)
    writeNodeAutoClaimPolicy(userRoot, {
      schema: "node-auto-claim/v1",
      enabled: true,
      allowedSources: { personIds: [], teamIds: [] },
      allowedAgentIds: ["auto-agent"],
      maxConcurrent: 1,
    });

  const started: { readonly nodeId: string; readonly outcome: string; readonly code?: string }[] = [];
  const loops = ["node-one", "node-two"].map((nodeId, index) =>
    openNodeAutoClaimLoop({
      userRoot: userRoots[index]!,
      now: () => new Date().toISOString(),
      ownerPersonIdFor: async () => "person-one",
      repos: () => ["lease-repo"],
      repoIdOf: (repo) => repo,
      candidates: async () => {
        const result = await fixture.host.read(
          "lease-repo",
          "repo.tasks.claimable",
          {},
          fixture.owners.auth({ nodeId }),
        );
        return result.tasks;
      },
      taskIdOf: (candidate) => candidate.taskId,
      assignmentOf: async (candidate) =>
        candidate.taskId === taskId
          ? { taskId, expiresAt, assignedByPersonId: "person-one", assignedByTeamIds: [] }
          : null,
      activeTaskKeys: async () => [],
      agentIds: () => ["auto-agent"],
      claimAndRun: async (_repo, candidate) => {
        const receipt = await fixture.command(nodeId, {
          kind: "task-start",
          taskId: candidate.taskId,
          executionId: `execution-${nodeId}`,
        });
        started.push({ nodeId, outcome: String(receipt.outcome), ...(receipt.code ? { code: receipt.code } : {}) });
      },
    }),
  );
  try {
    const candidates = await Promise.all(
      ["node-one", "node-two"].map((nodeId) =>
        fixture.host.read("lease-repo", "repo.tasks.claimable", {}, fixture.owners.auth({ nodeId })),
      ),
    );
    assert.deepEqual(
      candidates.map((result) => result.tasks.map((task) => task.taskId)),
      [[taskId], [taskId]],
    );
    await Promise.all(loops.map((loop) => loop.trigger("same-replica-candidate")));
    assert.equal(started.filter((row) => row.outcome === "applied").length, 1, JSON.stringify(started));
    assert.equal(started.filter((row) => row.code === "lease_conflict").length, 1, JSON.stringify(started));
    const task = await fixture.host.run("lease-repo", { kind: "task-show", taskId }, localAuthFixture());
    assert.equal(JSON.parse(String(task.evidence)).lease.phase, "held");
  } finally {
    await Promise.all(loops.map((loop) => loop.close()));
  }
});
