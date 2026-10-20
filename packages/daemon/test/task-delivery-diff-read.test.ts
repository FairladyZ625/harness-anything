// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseGitDiffPatch, readTaskDeliveryDiff } from "../src/task-delivery-diff-read.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function commit(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
}

test("parses delivery patches into file and line models", () => {
  const result = parseGitDiffPatch(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " const before = true;",
      "-const removed = true;",
      "+const added = true;",
      "+const second = true;",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,1 @@",
      "+export const value = 1;",
      "",
    ].join("\n"),
  );
  assert.equal(result.truncated, false);
  assert.deepEqual(result.files, [
    {
      filePath: "src/a.ts",
      lines: [
        { kind: "context", oldLineNo: 1, newLineNo: 1, text: "const before = true;" },
        { kind: "remove", oldLineNo: 2, text: "const removed = true;" },
        { kind: "add", newLineNo: 2, text: "const added = true;" },
        { kind: "add", newLineNo: 3, text: "const second = true;" },
      ],
    },
    {
      filePath: "src/b.ts",
      lines: [{ kind: "add", newLineNo: 1, text: "export const value = 1;" }],
    },
  ]);
});

test("marks a patch as truncated at the explicit line budget", () => {
  const result = parseGitDiffPatch(["diff --git a/a.txt b/a.txt", "@@ -1,0 +1,2 @@", "+one", "+two"].join("\n"), 1);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0]?.lines.length, 1);
});

test("reads the frozen delivery baseline through the daemon Git boundary", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-delivery-diff-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(path.join(root, "reviewed.txt"), "before\n");
  const baseline = commit(root, "baseline");
  writeFileSync(path.join(root, "reviewed.txt"), "before\nafter\n");
  const commitSha = commit(root, "delivery");
  const projection = {
    read: () => ({
      status: "ready",
      snapshot: {
        task: { taskId: "task-delivery", iteration: 0 },
        executions: [
          {
            schema: "execution/v1",
            executionId: "execution-delivery",
            taskId: "task-delivery",
            iteration: 0,
            submission: { commitSha },
            deliveryBaseline: { kind: "commit", commitSha: baseline },
          },
        ],
      },
      packagePath: "harness/tasks/task-delivery",
      watermark: 3,
      sourceRevision: 3,
    }),
  } as never;

  assert.deepEqual(readTaskDeliveryDiff(root, projection, "task-delivery"), {
    ok: true,
    status: "ready",
    taskId: "task-delivery",
    baseline,
    commitSha,
    files: [
      {
        filePath: "reviewed.txt",
        lines: [
          { kind: "context", oldLineNo: 1, newLineNo: 1, text: "before" },
          { kind: "add", newLineNo: 2, text: "after" },
        ],
      },
    ],
    truncated: false,
    watermark: 3,
    sourceRevision: 3,
  });
});
