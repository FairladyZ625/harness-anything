// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { VersionControlSystem } from "../../kernel/src/index.ts";
import {
  CODE_DOC_RECONCILIATION_DOCUMENT,
  evaluateCodeDocReconciliationGate,
  renderCodeDocReconciliationDraft
} from "../src/code-doc-reconciliation.ts";

const goodSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const missingSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("code-doc reconciliation draft derives canonical ledger records and anchors", () => {
  const draft = renderCodeDocReconciliationDraft({
    taskId: "task-1",
    sha: goodSha,
    paths: ["packages/z.ts", "packages/a.ts", "packages/a.ts"],
    prRef: "https://github.com/example/repo/pull/1",
    documents: [
      { path: "closeout.md", body: "# Closeout" },
      { path: "review.md", body: "# Review" },
      { path: "facts.md", body: "# Facts" }
    ]
  });

  assert.deepEqual(draft.recordIds, ["closeout", "review"]);
  const parsed = JSON.parse(draft.body) as {
    readonly records: ReadonlyArray<{ readonly anchors: ReadonlyArray<Record<string, string>> }>;
  };
  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.records[0]?.anchors, [
    { kind: "commit", sha: goodSha },
    { kind: "path", sha: goodSha, path: "packages/a.ts" },
    { kind: "path", sha: goodSha, path: "packages/z.ts" },
    { kind: "pr", ref: "https://github.com/example/repo/pull/1", sha: goodSha }
  ]);
});

test("code-doc reconciliation accepts commit and path anchors and warns on PR status", () => {
  const result = evaluateCodeDocReconciliationGate({
    taskId: "task-1",
    rootDir: "/repo",
    authoredRoot: "/repo/harness",
    versionControlSystem: versionControlSystem({ commits: [goodSha], paths: [`${goodSha}:packages/app.ts`] }),
    documents: documents([{
      id: "A4-001",
      ledgerPath: "closeout.md",
      kind: "closeout",
      anchors: [
        { kind: "commit", sha: goodSha },
        { kind: "path", sha: goodSha, path: "packages/app.ts" },
        { kind: "pr", ref: "refs/pull/123/merge", sha: goodSha }
      ]
    }])
  });

  assert.equal(result.ok, true);
  assert.equal(result.checkedRecords, 1);
  assert.equal(result.checkedAnchors, 3);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["code_doc_pr_status_unverified"]);
});

test("code-doc reconciliation rejects fabricated shas", () => {
  const result = evaluateCodeDocReconciliationGate({
    taskId: "task-1",
    rootDir: "/repo",
    authoredRoot: "/repo/harness",
    versionControlSystem: versionControlSystem({ commits: [goodSha], paths: [] }),
    documents: documents([{
      id: "A4-001",
      ledgerPath: "closeout.md",
      kind: "closeout",
      anchors: [{ kind: "commit", sha: missingSha }]
    }])
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["code_doc_git_ref_missing"]);
});

test("code-doc reconciliation rejects missing evidence paths at an existing commit", () => {
  const result = evaluateCodeDocReconciliationGate({
    taskId: "task-1",
    rootDir: "/repo",
    authoredRoot: "/repo/harness",
    versionControlSystem: versionControlSystem({ commits: [goodSha], paths: [] }),
    documents: documents([{
      id: "A4-001",
      ledgerPath: "closeout.md",
      kind: "evidence",
      anchors: [{ kind: "path", sha: goodSha, path: "missing/file.ts" }]
    }])
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["code_doc_path_missing"]);
});

test("code-doc reconciliation ignores unrelated package documents but requires the anchor ledger", () => {
  const result = evaluateCodeDocReconciliationGate({
    taskId: "task-1",
    rootDir: "/repo",
    authoredRoot: "/repo/harness",
    versionControlSystem: versionControlSystem({ commits: [goodSha], paths: [] }),
    documents: [{ path: "closeout.md", body: "# Closeout" }]
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["code_doc_anchors_missing"]);
});

function documents(records: ReadonlyArray<Record<string, unknown>>) {
  return [
    { path: "closeout.md", body: "# Closeout" },
    {
      path: CODE_DOC_RECONCILIATION_DOCUMENT,
      body: `${JSON.stringify({
        schema: "code-doc-reconciliation/v1",
        taskId: "task-1",
        records
      }, null, 2)}\n`
    }
  ];
}

function versionControlSystem(input: { readonly commits: ReadonlyArray<string>; readonly paths: ReadonlyArray<string> }): Pick<VersionControlSystem, "normalizePath" | "topLevel" | "commitExists" | "pathExistsAtCommit"> {
  const commits = new Set(input.commits);
  const paths = new Set(input.paths);
  return {
    normalizePath: (inputPath) => inputPath,
    topLevel: (inputPath) => inputPath,
    commitExists: (_repoRoot, sha) => commits.has(sha),
    pathExistsAtCommit: (_repoRoot, sha, relativePath) => paths.has(`${sha}:${relativePath}`)
  };
}
