// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { completionSnapshot } from "../../kernel/test/domain/completion.fixtures.ts";
import { submitTask } from "../src/repo-cell-submit.ts";
import { readCloseoutSubmission } from "../src/repo-cell-submit.ts";

const closeoutBody =
  "## Summary\nReport delivered.\n## Verification\nChecked.\n" +
  "## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nChecked.\n";

/**
 * A task whose digest names a snapshot the projection cannot serve is the historical gap the
 * completion judgment already reports. Submit must answer with that judgment, never read
 * `.completion` from the null snapshot.
 */
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-contract-gap-")),
    git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
    put = (file: string, body: string) => {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), body);
    };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Harness Test");
  git("config", "user.email", "harness@example.test");
  git("config", "commit.gpgsign", "false");
  put("harness/harness.yaml", "settings:\n  gates: []\n");
  git("add", ".");
  git("commit", "-qm", "test: completion contract gap");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("checkout", "-qb", "task-1");
  const snapshot = {
    task: {
      schema: "task/v2",
      taskId: "task-1",
      taskClass: "standard",
      status: "active",
      currentNode: "implementation",
      iteration: 0,
      completionGateIds: [],
      presetSnapshotDigest: completionSnapshot.digest,
      metadata: { presetId: "standard-task" },
    },
    reviews: [],
    executions: [
      {
        schema: "execution/v1",
        executionId: "execution-1",
        taskId: "task-1",
        iteration: 0,
        state: "active",
        deliveryBaseline: { kind: "commit", commitSha: base },
      },
    ],
  } as unknown as Parameters<typeof readCloseoutSubmission>[3];
  const cell = {
    rootDir: root,
    projection: {
      readDocuments: () => ({ documents: [] }),
      // The digest is named but its bytes are unavailable: exactly the null the old path read.
      readPresetSnapshot: () => ({ status: "ready", snapshot: null, watermark: 1, sourceRevision: 1 }),
      readRuntimeDispatchesByTaskExecution: () => [],
      read: () => ({ snapshot, packagePath: "tasks/task-1" }),
      readDocument: (target: string) => ({
        status: "ready",
        watermark: 1,
        sourceRevision: 1,
        document: {
          body: target.endsWith("task-contract.json")
            ? JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] })
            : closeoutBody,
          workspaceRevision: 1,
          blobSha256: `sha256:${"b".repeat(64)}`,
        },
      }),
    },
    settings: { readRepository: () => ({ gates: [] }) },
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as Parameters<typeof readCloseoutSubmission>[0];
  return () =>
    readCloseoutSubmission(cell, "task-1", "execution-1", snapshot, {
      facts: null,
      publicPullRequest: false,
      risk: { ok: true, assessment: undefined },
      assertCurrent: async () => {},
    });
}

test("submit names the unavailable preset snapshot instead of reading completion from null", async (t) => {
  const result = await fixture(t)();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_submission");
  assert.match(result.error.message, /preset snapshot/u);
  assert.match(
    result.error.message,
    /ha task contract migrate --task task-1 --to-preset standard-task --apply/u,
    "the rejection carries the explicit migration command",
  );
});

test("submit returns the explicit migration as the next action for a gap task", async () => {
  const snapshot = {
      task: {
        schema: "task/v2",
        taskId: "task-1",
        taskClass: "standard",
        status: "active",
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "owner" }, executor: null },
        completionGateIds: [],
        presetSnapshotDigest: completionSnapshot.digest,
        presetSnapshotGap: { reason: "snapshot-bytes-unavailable", sourceGeneration: 2, sourceRevision: 1 },
        metadata: { presetId: "standard-task" },
      },
      reviews: [],
      executions: [],
      lease: null,
      revision: 7,
    },
    cell = {
      service: { read: async () => ({ snapshot, packagePath: "tasks/task-1" }) },
      rejected: (opId: string, code: string) => ({ outcome: "op_rejected", opId, code }),
      operationId: () => "op-gap",
      input: { repoId: "repo" },
      requiredCellText: (value: unknown, name: string) => {
        if (typeof value === "string" && value) return value;
        throw new Error(`${name} is required.`);
      },
    },
    receipt = await submitTask(
      cell as unknown as Parameters<typeof submitTask>[0],
      { kind: "task-submit", taskId: "task-1" },
      {} as Parameters<typeof submitTask>[2],
    );
  assert.equal(receipt.code, "document_invalid");
  assert.match(String(receipt.rejectionExplanation), /Historical snapshot gap/u);
  assert.equal(receipt.next?.[0]?.action, "ha task contract migrate --task task-1 --to-preset standard-task --apply");
});
