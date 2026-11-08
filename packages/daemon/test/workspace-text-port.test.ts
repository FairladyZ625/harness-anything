// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readAuthoredDocumentBytes } from "../src/authored-document-read-port.ts";
import { workspaceText } from "../src/repo-cell-packets.ts";
import { readWorkspaceText } from "../src/workspace-text-port.ts";

test("generic workspace text reads reject authored documents; the port is the only reader", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-text-port-")),
    authoredRoot = path.join(root, "harness"),
    planPath = "harness/tasks/example/task_plan.md",
    planBody = "# Plan\n\n## Goal\n",
    packetPath = "harness/input.json",
    packetBody = "{}";
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(path.dirname(path.join(root, planPath)), { recursive: true });
  writeFileSync(path.join(root, planPath), planBody);
  writeFileSync(path.join(root, packetPath), packetBody);
  symlinkSync(path.join(root, planPath), path.join(root, "plan-alias.md"));

  for (const requested of [planPath, path.join(root, planPath), "plan-alias.md"]) {
    assert.throws(() => readWorkspaceText(root, requested, "planFile"), /authored-document-read-port/u, requested);
  }

  assert.equal(readAuthoredDocumentBytes(authoredRoot, "tasks/example/task_plan.md").toString("utf8"), planBody);
  assert.equal(workspaceText(root, planPath, "planFile"), planBody);

  // A non-authored workspace packet stays readable through the generic adapter.
  assert.equal(readWorkspaceText(root, packetPath, "fromFile"), packetBody);
});
