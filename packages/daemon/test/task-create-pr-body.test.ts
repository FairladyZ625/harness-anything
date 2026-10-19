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

---

# 中文

## 概要

-

---

## PR Gate Checklist / PR 门禁清单

- [ ] PR body uses two complete language blocks.
`;

test("task create ships no PR body slot even when the repository declares a PR template", async () => {
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
      target = path.join(rootDir, "harness", packagePath);
    assert.equal(created.proof?.worktreeVisible, true);
    assert.equal(
      existsSync(path.join(target, "artifacts", "pr-body.md")),
      false,
      "create materializes no PR-body skeleton: the body convention belongs to the delivered repository",
    );
    const contract = JSON.parse(readFileSync(path.join(target, "task-contract.json"), "utf8")) as {
      readonly documents: readonly { readonly slot: string }[];
    };
    assert.equal(
      contract.documents.some(({ slot }) => slot.startsWith("task.pr-body")),
      false,
      "the task contract declares no PR body document slot",
    );
    assert.equal(
      contract.documents.some(({ slot }) => slot === "task.explainer"),
      true,
      "the compiler-owned explainer slot is untouched by the PR body removal",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
