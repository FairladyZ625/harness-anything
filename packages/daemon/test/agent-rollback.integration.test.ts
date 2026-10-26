// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { parseDaemonGuiReadResult } from "../src/protocol/gui-result-validation.ts";

/**
 * A rollback is "install this retained body again", so it must reuse the install action's own
 * guarantees: a new revision, the exact target bytes, the expectedVersion fence, and the retired
 * refusal. These tests drive that action directly (the CLI composes the same call) and pin the
 * three outcomes the design's acceptance list names.
 */

const binding = withPolicyGroup(
    { actor: { principal: { personId: "person-rollback" }, executor: null }, source: "local" as const },
    "contributor",
  ),
  base = {
    schema: "agent-declaration/v1",
    id: "rollback-agent",
    name: "Rollback Agent",
    instructions: "v1 instructions",
    runtimes: [{ type: "codex" }],
  };

async function withCell(
  run: (context: {
    readonly rootDir: string;
    readonly cell: Awaited<ReturnType<typeof openRepoCell>>;
  }) => Promise<void>,
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-rollback-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("agent-rollback"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "agent-rollback-test",
  });
  try {
    await run({ rootDir, cell });
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("a rollback produces a new revision whose body digest equals the target version", async () => {
  await withCell(async ({ cell }) => {
    const first = await cell.run(
        { kind: "agent-install", declaration: base, expectedVersion: 0, idempotencyKey: "rb-v1" },
        binding,
      ),
      second = await cell.run(
        {
          kind: "agent-install",
          declaration: { ...base, instructions: "v2 instructions" },
          expectedVersion: first.revision,
          idempotencyKey: "rb-v2",
        },
        binding,
      );
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const historyBefore = await ports(cell).history(base.id),
      target = historyBefore.versions.find((row) => row.revision === first.revision);
    assert.ok(target, "the first version is in history");

    // The rollback: read the retained body of the target revision and install it again with the
    // fence the caller holds. Nothing new is invented — this is the same install action.
    const version = await ports(cell).version(base.id, first.revision),
      rolled = await cell.run(
        {
          kind: "agent-install",
          declaration: version.declaration,
          expectedVersion: historyBefore.revision,
          idempotencyKey: `agent-rollback:${base.id}:${first.revision}:${historyBefore.revision}`,
        },
        binding,
      );
    assert.equal(rolled.outcome, "applied", JSON.stringify(rolled));
    assert.equal(rolled.revision, second.revision + 1, "the rollback advances the revision by one");
    const historyAfter = await ports(cell).history(base.id),
      newest = historyAfter.versions[0]!;
    assert.equal(newest.revision, rolled.revision);
    assert.equal(newest.sha256, target.sha256, "the rolled-back body is byte-identical to the target");
    assert.equal(historyAfter.versions.length, historyBefore.versions.length + 1, "history grows; it is not replaced");
    assert.equal(
      (await ports(cell).version(base.id, rolled.revision)).declaration.instructions,
      "v1 instructions",
      "the live declaration is the old body",
    );
  });
});

test("a stale expectedVersion is rejected as revision_conflict and leaves the live body alone", async () => {
  await withCell(async ({ cell }) => {
    const first = await cell.run(
        { kind: "agent-install", declaration: base, expectedVersion: 0, idempotencyKey: "fence-v1" },
        binding,
      ),
      second = await cell.run(
        {
          kind: "agent-install",
          declaration: { ...base, instructions: "v2 instructions" },
          expectedVersion: first.revision,
          idempotencyKey: "fence-v2",
        },
        binding,
      );
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    const version = await ports(cell).version(base.id, first.revision),
      history = await ports(cell).history(base.id),
      stale = await cell.run(
        {
          kind: "agent-install",
          declaration: version.declaration,
          // The caller still holds the revision it read before the second write landed.
          expectedVersion: first.revision,
          idempotencyKey: `agent-rollback-stale:${first.revision}`,
        },
        binding,
      );
    assert.equal(stale.outcome, "op_rejected", JSON.stringify(stale));
    assert.equal(stale.code, "revision_conflict");
    assert.match(
      String(stale.rejectionExplanation ?? ""),
      new RegExp(`expected revision ${first.revision}, current revision is ${second.revision}`, "u"),
      "the conflict names both the held and the current revision",
    );
    const after = await ports(cell).history(base.id);
    assert.equal(after.revision, history.revision, "no revision moved");
    assert.equal(after.versions.length, history.versions.length, "no version was appended");
    assert.equal(
      (await ports(cell).version(base.id, after.revision)).declaration.instructions,
      "v2 instructions",
      "the live body is still the newer one",
    );
  });
});

test("a retired agent refuses a rollback through the install lifecycle gate", async () => {
  await withCell(async ({ cell }) => {
    const installed = await cell.run(
        { kind: "agent-install", declaration: base, expectedVersion: 0, idempotencyKey: "retire-rollback-v1" },
        binding,
      ),
      target = await ports(cell).version(base.id, installed.revision),
      retired = await cell.run(
        { kind: "agent-retire", agentId: base.id, reason: "superseded", idempotencyKey: "retire-rollback" },
        binding,
      );
    assert.equal(retired.outcome, "applied", JSON.stringify(retired));
    const refused = await cell.run(
      {
        kind: "agent-install",
        declaration: target.declaration,
        expectedVersion: installed.revision,
        idempotencyKey: "rollback-after-retire",
      },
      binding,
    );
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.code, "agent_retired");
  });
});

test("rolling back to the live body is a no-op the caller can detect before writing", async () => {
  await withCell(async ({ cell }) => {
    const installed = await cell.run(
        { kind: "agent-install", declaration: base, expectedVersion: 0, idempotencyKey: "noop-v1" },
        binding,
      ),
      history = await ports(cell).history(base.id),
      live = await ports(cell).version(base.id, installed.revision);
    // The install action cannot express this: a byte-identical body still appends and still moves
    // the revision (measured in the design, §1.6①). The rollback command must stop before calling
    // it, and these are the two facts it compares.
    assert.equal(live.current.revision, installed.revision);
    assert.equal(live.current.sha256, live.version.sha256);
    // And if the caller does submit it anyway, that is exactly the fence-invalidating write the
    // no-op check exists to prevent.
    const submitted = await cell.run(
      {
        kind: "agent-install",
        declaration: live.declaration,
        expectedVersion: history.revision,
        idempotencyKey: "noop-submitted",
      },
      binding,
    );
    assert.equal(submitted.outcome, "applied", "the install action does write an identical body");
    assert.equal(submitted.revision, installed.revision + 1, "and that write moves the revision");
  });
});

/** The served read surface, so these tests exercise the same path the CLI and GUI do. */
function ports(cell: Awaited<ReturnType<typeof openRepoCell>>) {
  return {
    history: async (agentId: string, limit?: number) =>
      parseDaemonGuiReadResult(
        "repo.agent.history.read",
        await cell.read("repo.agent.history.read", { agentId, ...(limit === undefined ? {} : { limit }) }),
      ),
    version: async (agentId: string, revision: number) =>
      parseDaemonGuiReadResult(
        "repo.agent.version.read",
        await cell.read("repo.agent.version.read", { agentId, revision }),
      ),
  };
}
