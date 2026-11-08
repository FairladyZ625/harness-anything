// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { workspaceText } from "../src/repo-cell-packets.ts";
import { readWorkspaceText } from "../src/workspace-text-port.ts";

test("workspace text reads reject authored paths while packet reads use the authored port", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-text-port-")),
    logicalPath = "harness/tasks/example/artifacts/reports/review.json",
    body = '{"reviewId":"review-example"}';
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(path.dirname(path.join(root, logicalPath)), { recursive: true });
  writeFileSync(path.join(root, logicalPath), body);

  assert.throws(() => readWorkspaceText(root, logicalPath, "reviewPacket"), /readAuthoredDocumentBytes/u);
  assert.equal(workspaceText(root, logicalPath, "reviewPacket"), body);
});
