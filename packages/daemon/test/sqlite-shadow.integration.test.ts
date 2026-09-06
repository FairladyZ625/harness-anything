// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
// The receipt validator is deliberately internal until the public kernel barrel exports it.
// eslint-disable-next-line no-restricted-imports
import { validateWriteReceipt, WRITE_RECEIPT_SCHEMA } from "../../kernel/src/domain/receipt-domain-registry.ts";
import { initRepo } from "../../kernel/test/store/task-event-store.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

function assertValidWriteReceipt(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const allowed = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]),
    receipt = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)));
  assert.deepEqual(validateWriteReceipt(receipt), []);
}

test("RepoCell accepts in SQLite before independently verified Git and worktree followers", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-sqlite-accept-repo-cell-")),
    rootDir = path.join(parent, "repo"),
    repoId = workspaceId("sqlite-accept-repo-cell");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  mkdirSync(rootDir);
  initRepo(rootDir);
  try {
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-accept-writer" });
    const before = makeTaskEventReader({ repoId, rootDir }).read().revision,
      accepted = await cell.run(
        { kind: "task-create", taskId: "task-sqlite-accept", title: "SQLite accept" },
        {
          actor: { principal: { personId: "sqlite-accept-owner" }, executor: null },
          source: "local",
        },
      );

    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    assert.equal(accepted.status, "accepted_durable");
    assert.equal(accepted.acceptance?.storage, "sqlite");
    assert.equal(accepted.acceptance?.durability, "local_fsync");
    assert.equal(accepted.acceptance?.revisionFrom, before + 1);
    assert.equal(accepted.acceptance?.revisionTo, before + 1);
    assert.deepEqual(accepted.acceptance?.memberOpIds, [accepted.opId]);
    assertValidWriteReceipt(accepted);

    const reader = makeTaskEventReader({ repoId, rootDir });
    try {
      assert.equal(reader.read().revision, before + 1);
      assert.equal(reader.readCommandOutcome(accepted.opId)?.status, "accepted_durable");
    } finally {
      await reader.drain();
    }

    const settled = await cell.run(
      {
        kind: "receipt-show",
        opId: accepted.opId,
        waitFor: ["accepted_durable", "projection_visible", "git_verified", "worktree_visible"],
        timeoutMs: 5_000,
      },
      {
        actor: { principal: { personId: "sqlite-accept-owner" }, executor: null },
        source: "local",
      },
    );
    assert.equal(settled.wait?.state, "timed_out", JSON.stringify(settled));
    assert.deepEqual(settled.wait?.unsatisfied, ["worktree_visible"]);
    assert.equal(settled.git.state, "verified");
    assert.equal(settled.worktree.state, "pending");
    assert.equal(settled.replica.state, "not_configured");
    const manifest = JSON.parse(
      execFileSync("git", ["-C", rootDir, "show", "HEAD:harness/events/segments/manifest.json"], {
        encoding: "utf8",
      }),
    ) as {
      readonly generation: number;
      readonly cut: { readonly repoId: string; readonly revision: number; readonly headDigest: string };
    };
    assert.equal(manifest.generation, 1);
    assert.equal(manifest.cut.repoId, settled.acceptance?.cut.repoId);
    assert.equal(manifest.cut.revision, settled.acceptance?.cut.revision);
    assert.equal(manifest.cut.headDigest, settled.acceptance?.cut.headDigest);
    assert.equal(existsSync(path.join(rootDir, "harness/events/head.json")), false);
  } finally {
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
