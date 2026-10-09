// harness-test-tier: integration
import assert from "node:assert/strict";
import { makeTaskEventReader, isTaskEvent } from "@harness-anything/kernel";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { git } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { checkPrBodyBilingual } from "../../../tools/check-pr-body-bilingual.mjs";
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

test("worker PR body is synchronized before submit and the receipt names the frozen body", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-deliver-pr-body-")),
    taskId = "task-pr-delivery",
    executionId = "execution-pr-delivery",
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, ".github"));
  writeFileSync(path.join(rootDir, ".github/pull_request_template.md"), PR_TEMPLATE);
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("deliver-pr-body"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "deliver-pr-body",
  });
  try {
    const created = await cell.run(
      { kind: "task-create", taskId, title: "PR delivery", profileId: "lightweight" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String((created as { readonly packagePath?: string }).packagePath),
      packageRoot = path.join(rootDir, "harness", packagePath),
      bodyPath = `${packagePath}/artifacts/pr-body.md`,
      body = PR_TEMPLATE.replace(
        "## Summary\n\n-",
        "## Summary\n\nThe worker now completes the bilingual pull request body before submitting the local delivery. The owner consumes the frozen document directly without rewriting its content.",
      )
        .replace(
          "## What Changed\n\n-",
          "## What Changed\n\nDispatch instructions assign delivery responsibility and the receipt identifies the accepted document revision.",
        )
        .replace(
          "## 概要\n\n-",
          "## 概要\n\n工作者提交前填写并同步双语正文，提交回执指明已冻结版本，业主可直接使用正文，无需手工重写。",
        )
        .replace("## 改动内容\n\n-", "## 改动内容\n\n派工协议承担填写责任，提交回执展示正文的已接受版本。")
        .replace("- [ ]", "- [x]");
    assert.notEqual(body, PR_TEMPLATE);
    assert.equal(checkPrBodyBilingual(body).ok, true);
    assert.deepEqual(body.match(/^#{1,3} .+$/gmu), PR_TEMPLATE.match(/^#{1,3} .+$/gmu));
    await realizeTaskPlanFixture(rootDir, packagePath, async (planPath) => {
      const result = await cell.run({ kind: "doc-submit", paths: [planPath] }, binding);
      await waitForFixturePublication(cell, result.opId, binding);
      return result;
    });
    const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await waitForFixturePublication(cell, started.opId, binding);
    await cell.settlePendingMaterialization("PR delivery fixture");
    const deliveryRoot = path.join(rootDir, ".worktrees", taskId);
    writeFileSync(path.join(deliveryRoot, "delivery.txt"), "PR body delivery\n");
    git(deliveryRoot, "add", "delivery.txt");
    git(deliveryRoot, "commit", "-qm", "test: PR body delivery");
    const sha = git(deliveryRoot, "rev-parse", "HEAD");
    writeFileSync(path.join(packageRoot, "artifacts/pr-body.md"), body);
    const accepted = await cell.run({ kind: "doc-submit", paths: [bodyPath] }, binding);
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    await waitForFixturePublication(cell, accepted.opId, binding);
    writeFileSync(
      path.join(packageRoot, "closeout.md"),
      `## Summary\nDelivered ${sha} and the accepted PR body.\n## Verification\nBilingual check and template headings passed.\n`,
    );
    let submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    for (let attempt = 0; submitted.outcome === "pending" && attempt < 4; attempt += 1) {
      await waitForFixturePublication(cell, submitted.opId, binding);
      submitted = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    }
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const prBody = (submitted as typeof submitted & { prBody: { path: string; revision: number } }).prBody;
    assert.equal(prBody.path, bodyPath);
    assert.ok(String(submitted.summary).includes(`PR body: harness/${bodyPath}@${String(accepted.revision)}`));
    assert.equal(prBody.revision, accepted.revision);
    await waitForFixturePublication(cell, submitted.opId, binding);
    const replay = await cell.run({ kind: "task-submit", taskId, executionId }, binding);
    assert.deepEqual((replay as typeof submitted & { prBody: unknown }).prBody, prBody);
    writeFileSync(path.join(packageRoot, "artifacts/pr-body.md"), body + "\nChanged after freeze.\n");
    const frozen = await cell.run({ kind: "doc-submit", paths: [bodyPath] }, binding);
    assert.equal(frozen.outcome, "applied", JSON.stringify(frozen));
    await waitForFixturePublication(cell, frozen.opId, binding);
    const reader = makeTaskEventReader({ repoId: workspaceId("deliver-pr-body"), rootDir }),
      event = reader
        .read()
        .events.find((row) => isTaskEvent(row) && row.type === "execution_submitted" && row.taskId === taskId);
    assert.ok(event && isTaskEvent(event) && event.type === "execution_submitted");
    const frozenBody = event.payload.execution.submission?.artifacts?.find((row) => row.path === bodyPath);
    assert.equal(
      frozenBody?.revision,
      prBody.revision,
      "editing the document cannot mutate the submitted artifact cut",
    );
    assert.equal(
      Buffer.from(reader.readContentBlob(frozenBody!.blobSha256)!).toString("utf8"),
      body,
      "the owner can use the exact verified bilingual body from the frozen cut",
    );
    await reader.drain();
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
