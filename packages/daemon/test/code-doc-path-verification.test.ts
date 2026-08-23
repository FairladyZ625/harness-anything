// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyCodeDocCommitPaths } from "../src/code-doc-path-verification.ts";

test("code-doc paths are resolved in the Git root that owns the bound commit", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-code-doc-paths-")), authoredRoot = path.join(rootDir, "harness");
  try {
    mkdirSync(path.join(rootDir, "packages"), { recursive: true });
    writeFileSync(path.join(rootDir, "packages/public.ts"), "export const publicPath = true;\n");
    initRepo(rootDir, "public fixture");
    mkdirSync(path.join(authoredRoot, "tasks/task-ledger/artifacts"), { recursive: true });
    writeFileSync(path.join(authoredRoot, "harness.yaml"), "layout:\n  authoredRoot: harness\n  localRoot: .harness\n");
    writeFileSync(path.join(authoredRoot, "tasks/task-ledger/artifacts/report.md"), "# Ledger report\n");
    initRepo(authoredRoot, "authored fixture");
    const publicSha = git(rootDir, "rev-parse", "HEAD"), authoredSha = git(authoredRoot, "rev-parse", "HEAD");

    assert.equal(verifyCodeDocCommitPaths({ rootDir, commitSha: publicSha, paths: ["packages/public.ts"] }).ok, true);
    assert.equal(verifyCodeDocCommitPaths({ rootDir, commitSha: authoredSha, paths: ["tasks/task-ledger/artifacts/report.md"] }).ok, true);
    assert.deepEqual(verifyCodeDocCommitPaths({ rootDir, commitSha: authoredSha, paths: ["harness/tasks/task-ledger/artifacts/report.md"] }), { ok: false, code: "paths_not_found", commitSha: authoredSha, missingPaths: ["harness/tasks/task-ledger/artifacts/report.md"] });
    assert.deepEqual(verifyCodeDocCommitPaths({ rootDir, commitSha: publicSha, paths: ["packages/missing.ts"] }), { ok: false, code: "paths_not_found", commitSha: publicSha, missingPaths: ["packages/missing.ts"] });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function initRepo(rootDir: string, message: string): void {
  git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Code Doc Test"); git(rootDir, "config", "user.email", "code-doc@example.invalid"); git(rootDir, "add", "."); git(rootDir, "commit", "-qm", message);
}
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
