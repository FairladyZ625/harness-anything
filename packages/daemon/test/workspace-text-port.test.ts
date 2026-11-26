// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readAuthoredDocumentBytes } from "../src/daemon-host/authored-document-read-port.ts";
import { workspaceText } from "../src/daemon-host/repo-cell-packets.ts";
import { readWorkspaceText } from "../src/daemon-host/workspace-text-port.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

test("generic workspace text reads reject authored documents; the port is the only reader", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-text-port-")),
    authoredRoot = path.join(root, "harness"),
    planPath = "harness/tasks/example/task_plan.md",
    planBody = "# Plan\n\n## Goal\n",
    packetPath = "harness/input.json",
    packetBody = "{}";
  t.after(() => removeTempRepository(root));
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

test("workspaceText resolves authored task packets when rootDir and fromFile use distinct path aliases", (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-workspace-text-alias-")),
    realRoot = path.join(parent, "real-repo"),
    aliasRoot = path.join(parent, "alias-repo"),
    packetRel = "harness/tasks/example/artifacts/reports/review-1.json",
    packetBody = '{"verdict":"approved"}\n';
  t.after(() => removeTempRepository(parent));
  mkdirSync(path.dirname(path.join(realRoot, packetRel)), { recursive: true });
  writeFileSync(path.join(realRoot, packetRel), packetBody);
  symlinkSync(realRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal(workspaceText(realRoot, path.join(aliasRoot, packetRel), "fromFile"), packetBody);
  assert.equal(workspaceText(aliasRoot, path.join(realRoot, packetRel), "fromFile"), packetBody);
});
