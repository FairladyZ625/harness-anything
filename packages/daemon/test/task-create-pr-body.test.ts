// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./doc-sync-slice-a.fixtures.ts";

const PR_TEMPLATE = `# English

## Summary

-

## What Changed

-

---

# 中文

## 概要

-

## 改动内容

-

---

## PR Gate Checklist / PR 门禁清单

- [ ] PR body uses two complete language blocks.
`;

test("task create materializes the repository PR template as the package pr-body skeleton", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-pr-body-"));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, ".github"), { recursive: true });
  writeFileSync(path.join(rootDir, ".github", "pull_request_template.md"), PR_TEMPLATE);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-pr-body"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-pr-body",
  });
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const created = await cell.run({ kind: "task-create", taskId: "task-pr-body", title: "PR Body" }, binding);
    assert.equal(created.outcome, "applied");
    const packagePath = (created as typeof created & { packagePath: string }).packagePath,
      target = path.join(rootDir, "harness", packagePath),
      skeleton = path.join(target, "artifacts", "pr-body.md");
    assert.equal(existsSync(skeleton), true, "create must materialize the PR-body skeleton before returning");
    assert.equal(readFileSync(skeleton, "utf8"), PR_TEMPLATE);
    assert.equal(created.proof?.worktreeVisible, true);
    const contract = JSON.parse(readFileSync(path.join(target, "task-contract.json"), "utf8")) as {
      readonly documents: readonly { readonly slot: string; readonly path: string; readonly owner: string }[];
    };
    const descriptor = contract.documents.find(({ slot }) => slot === "task.pr-body");
    assert.ok(descriptor, "the task contract tracks the materialized skeleton");
    assert.equal(descriptor.owner, "doc-sync");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("task create leaves a task-package preset without a pr-body skeleton", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-create-pr-body-docs-"));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, ".github"), { recursive: true });
  writeFileSync(path.join(rootDir, ".github", "pull_request_template.md"), PR_TEMPLATE);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("create-pr-body-docs"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "create-pr-body-docs",
  });
  const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const created = await cell.run(
      { kind: "task-create", taskId: "task-pr-body-docs", title: "Docs only", presetId: "docs-task" },
      binding,
    );
    assert.equal(created.outcome, "applied");
    const packagePath = (created as typeof created & { packagePath: string }).packagePath;
    assert.equal(
      existsSync(path.join(rootDir, "harness", packagePath, "artifacts", "pr-body.md")),
      false,
      "a docs task's workspace is its own package (task show: does not change repository files); no PR to draft a body for",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
