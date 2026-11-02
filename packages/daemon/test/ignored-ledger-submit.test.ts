// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { completionSnapshot } from "../../kernel/test/domain/completion.fixtures.ts";
import { deriveCloseoutSubmission, readCloseoutSubmission } from "../src/repo-cell-submit.ts";

function fixture(t: TestContext, ledgerRoot = "harness", leakedAtBaseline = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-ignored-ledger-submit-")),
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
  put(".gitignore", `/${ledgerRoot}/\n`);
  if (ledgerRoot !== "harness") put("harness/harness.yaml", `layout:\n  authoredRoot: ${ledgerRoot}\n`);
  git("add", ".");
  if (leakedAtBaseline) {
    put(`${ledgerRoot}/old.md`, "Previously leaked.\n");
    git("add", "-f", `${ledgerRoot}/old.md`);
  }
  git("commit", "-qm", "test: ledger exclusions");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git("checkout", "-qb", "task-1");
  const snapshot = {
    task: { taskId: "task-1", taskClass: "standard", presetSnapshotDigest: completionSnapshot.digest },
    reviews: [],
    executions: [
      { schema: "execution/v1", executionId: "execution-1", deliveryBaseline: { kind: "commit", commitSha: base } },
    ],
  } as unknown as Parameters<typeof deriveCloseoutSubmission>[3];
  const cell = {
    rootDir: root,
    projection: {
      readDocuments: () => ({ documents: [] }),
      readPresetSnapshot: () => ({ snapshot: { ...completionSnapshot, profile: { outputShape: "repository-diff" } } }),
      readRuntimeDispatchesByTaskExecution: () => [],
      read: () => ({ snapshot, packagePath: "tasks/task-1" }),
      readDocument: (target: string) => ({
        document: {
          body: target.endsWith("task-contract.json")
            ? JSON.stringify({
                documents: [
                  {
                    slot: "task.closeout",
                    path: "closeout.md",
                    templateRef: "template://planning/closeout@1",
                    locale: "en-US",
                  },
                ],
              })
            : "## Summary\nReport delivered.\n## Verification\nChecked.\n## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nChecked.\n",
        },
      }),
    },
    settings: { readRepository: () => ({ gates: [] }) },
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as Parameters<typeof deriveCloseoutSubmission>[0];
  return {
    git,
    put,
    derive: async () => {
      const result = await readCloseoutSubmission(
        cell,
        "task-1",
        "execution-1",
        snapshot,
        undefined,
        git("rev-parse", "HEAD"),
      );
      if (!result.ok) throw result.error;
      return result.submission;
    },
  };
}

for (const ledgerRoot of ["harness", "private-ledger"])
  test(`submit refuses force-added ignored ledger paths under ${ledgerRoot}`, async (t) => {
    const { git, put, derive } = fixture(t, ledgerRoot),
      report = `${ledgerRoot}/tasks/task-1/artifacts/report.md`;
    put(report, "Private evidence.\n");
    git("add", "-f", report);
    git("commit", "-qm", "test: forced report");
    await assert.rejects(derive, (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error);
      assert.equal(error.code, "ignored_ledger_delivery");
      assert.ok(error.message.includes(report));
      return true;
    });
  });

test("submit still freezes normal repository documentation and code", async (t) => {
  const { git, put, derive } = fixture(t);
  put("src/code.ts", "export const answer = 42;\n");
  put("docs/research.md", "Public research.\n");
  git("add", ".");
  git("commit", "-qm", "test: public delivery");
  const submission = await derive();
  assert.equal(submission.commitSha, git("rev-parse", "HEAD"));
  assert.deepEqual(submission.changedFiles, ["docs/research.md", "src/code.ts"]);
});

test("submit allows a deletion that cleans an ignored ledger path already on the baseline", async (t) => {
  const { git, derive } = fixture(t, "harness", true);
  git("rm", "harness/old.md");
  git("commit", "-qm", "test: clean old leak");
  assert.deepEqual((await derive()).changedFiles, ["harness/old.md"]);
});

test("submit respects repositories that intentionally track their ledger", async (t) => {
  const { git, put, derive } = fixture(t);
  put(".gitignore", "");
  put("harness/tasks/task-1/report.md", "Versioned by repository policy.\n");
  git("add", ".");
  git("commit", "-qm", "test: versioned ledger policy");
  assert.deepEqual((await derive()).changedFiles, [".gitignore", "harness/tasks/task-1/report.md"]);
});
