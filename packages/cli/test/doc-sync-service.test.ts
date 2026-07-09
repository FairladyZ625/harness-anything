import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sha256Text } from "../../kernel/src/index.ts";
import {
  buildDocSyncReport,
  makeDocSyncService,
  validateDocSyncSubmitRequest
} from "../src/daemon/doc-sync-service.ts";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const registryBody = readFileSync(path.join(repoRoot, "tools/write-road-registry.json"), "utf8");
const commitAuthor = { name: "Harness Test", email: "harness@example.test" };

test("doc sync preview and submit validator classify same-extension prose and frontmatter consistently", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const planPath = path.join(taskRoot, "task_plan.md");
    const indexPath = path.join(taskRoot, "INDEX.md");
    writeFileSync(planPath, "# Plan\n\nUpdated prose.\n", "utf8");
    writeFileSync(indexPath, taskIndex({ urgency: "high" }), "utf8");

    const report = buildDocSyncReport(rootDir);
    assert.equal(report.candidateBlobs.some((entry) => entry.path.endsWith("/task_plan.md")), true);
    assert.equal(report.forbiddenTouches.some((touch) => touch.path.endsWith("/INDEX.md")), true);
    assert.equal(report.readyToSubmitPreview, false);

    const validation = validateDocSyncSubmitRequest({
      rootInput: rootDir,
      request: submitRequest({
        baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
        intentId: "intent-preview-parity",
        changes: [
          inlineChange(`tasks/${taskId}/task_plan.md`, "# Plan\n\nOriginal prose.\n", "# Plan\n\nUpdated prose.\n"),
          inlineChange(`tasks/${taskId}/INDEX.md`, taskIndex({ urgency: "medium" }), taskIndex({ urgency: "high" }))
        ]
      })
    });

    assert.equal(validation.acceptedChanges.some((entry) => entry.path.endsWith("/task_plan.md")), true);
    assert.equal(validation.forbiddenTouches.some((touch) => touch.path.endsWith("/INDEX.md")), true);
    assert.equal(validation.ok, false);
  });
});

test("doc sync submit accepts pure task prose and commits with hermetic author", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir, commitAuthor });
    const baseLedgerSha = git(harnessRoot, "rev-parse", "HEAD");
    const result = await service.submit(submitRequest({
      baseLedgerSha,
      intentId: "intent-prose",
      changes: [
        inlineChange(`tasks/${taskId}/task_plan.md`, "# Plan\n\nOriginal prose.\n", "# Plan\n\nUpdated prose.\n")
      ]
    }));

    assert.equal(result.ok, true);
    assert.equal(result.status, "accepted");
    assert.notEqual(result.appliedLedgerSha, baseLedgerSha);
    assert.match(readFileSync(path.join(harnessRoot, "tasks", taskId, "task_plan.md"), "utf8"), /Updated prose/u);
    assert.equal(git(harnessRoot, "status", "--short"), "");
    assert.equal(git(harnessRoot, "log", "-1", "--format=%an <%ae>"), "Harness Test <harness@example.test>");
  });
});

test("doc sync submit rejects task frontmatter markdown with a focused RPC hint", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir, commitAuthor });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-frontmatter",
      changes: [
        inlineChange(`tasks/${taskId}/INDEX.md`, taskIndex({ urgency: "medium" }), taskIndex({ urgency: "high" }))
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_forbidden_touch");
    assert.equal(result.forbiddenTouches?.length, 1);
    assert.equal(result.forbiddenTouches?.[0]?.hunks.length, 1);
    assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.registryRowId, "task.lifecycle.transition");
    assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.requiredRpc.registryRowId, "task.lifecycle.transition");
    assert.match(readFileSync(path.join(harnessRoot, "tasks", taskId, "INDEX.md"), "utf8"), /urgency: medium/u);
  });
});

test("doc sync submit rejects decision typed records", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot }) => {
    const service = makeDocSyncService({ rootDir, commitAuthor });
    const base = "# Decision\n\n- claim: old\n";
    const next = "# Decision\n\n- claim: new\n";
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-decision",
      changes: [inlineChange("decisions/dec_mrcda9kw.md", base, next)]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_forbidden_touch");
    assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.bearing, "decision");
  });
});

test("doc sync submit rejects disguised prose edits to task fact records", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir, commitAuthor });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-fact-disguised",
      changes: [
        inlineChange(`tasks/${taskId}/facts.md`, "# Facts\n\n- fact: original\n", "# Facts\n\n- fact: structured mutation\n")
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_forbidden_touch");
    assert.equal(result.forbiddenTouches?.[0]?.hunks[0]?.bearing, "task-fact");
  });
});

test("doc sync submit rejects stale base ledger and blob with A2 CAS shape", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const baseLedgerSha = git(harnessRoot, "rev-parse", "HEAD");
    const planPath = path.join(taskRoot, "task_plan.md");
    writeFileSync(planPath, "# Plan\n\nConcurrent edit.\n", "utf8");
    git(harnessRoot, "add", "tasks");
    gitCommit(harnessRoot, "concurrent edit");

    const service = makeDocSyncService({ rootDir, commitAuthor });
    const result = await service.submit(submitRequest({
      baseLedgerSha,
      intentId: "intent-cas",
      changes: [
        inlineChange(`tasks/${taskId}/task_plan.md`, "# Plan\n\nOriginal prose.\n", "# Plan\n\nSubmitted edit.\n")
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result._tag, "WriteRejected");
    assert.equal(result.code, "cas_watermark_mismatch");
    assert.equal(result.expectedWatermark, baseLedgerSha);
    assert.equal(result.currentWatermark, git(harnessRoot, "rev-parse", "HEAD"));
    assert.equal(result.retryable, true);
    assert.equal(result.conflicts?.[0]?.code, "base_blob_changed");
  });
});

test("doc sync post-apply checker fails hard and rolls back rpc-only mutations", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskRoot, taskId }) => {
    const service = makeDocSyncService({
      rootDir,
      commitAuthor,
      afterApplyBeforePostCheck: () => {
        writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex({ urgency: "critical" }), "utf8");
      }
    });

    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-post-apply",
      changes: [
        inlineChange(`tasks/${taskId}/task_plan.md`, "# Plan\n\nOriginal prose.\n", "# Plan\n\nUpdated prose.\n")
      ]
    }));

    assert.equal(result.ok, false);
    assert.equal(result.code, "doc_sync_post_apply_bearing_changed");
    assert.equal(result.postApplyViolations?.[0]?.hunks[0]?.registryRowId, "task.lifecycle.transition");
    assert.match(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"), /urgency: medium/u);
    assert.match(readFileSync(path.join(taskRoot, "task_plan.md"), "utf8"), /Original prose/u);
    assert.equal(git(harnessRoot, "status", "--short"), "");
  });
});

test("doc sync submit accepts non-markdown task prose when registry bearing resolves to doc sync", async () => {
  await withHarnessFixture(async ({ rootDir, harnessRoot, taskId }) => {
    const service = makeDocSyncService({ rootDir, commitAuthor });
    const result = await service.submit(submitRequest({
      baseLedgerSha: git(harnessRoot, "rev-parse", "HEAD"),
      intentId: "intent-non-md",
      changes: [
        inlineChange(`tasks/${taskId}/notes.txt`, "old notes\n", "new notes\n", { mediaType: "text/plain" })
      ]
    }));

    assert.equal(result.ok, true);
    assert.equal(result.appliedChanges[0]?.path, `tasks/${taskId}/notes.txt`);
  });
});

async function withHarnessFixture<T>(fn: (fixture: {
  readonly rootDir: string;
  readonly harnessRoot: string;
  readonly taskRoot: string;
  readonly taskId: string;
}) => T | Promise<T>): Promise<T> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-sync-"));
  const harnessRoot = path.join(rootDir, "harness");
  const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
  const taskRoot = path.join(harnessRoot, "tasks", taskId);
  try {
    mkdirSync(path.join(rootDir, "tools"), { recursive: true });
    writeFileSync(path.join(rootDir, "tools", "write-road-registry.json"), registryBody, "utf8");
    mkdirSync(taskRoot, { recursive: true });
    mkdirSync(path.join(harnessRoot, "decisions"), { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex({ urgency: "medium" }), "utf8");
    writeFileSync(path.join(taskRoot, "task_plan.md"), "# Plan\n\nOriginal prose.\n", "utf8");
    writeFileSync(path.join(taskRoot, "facts.md"), "# Facts\n\n- fact: original\n", "utf8");
    writeFileSync(path.join(taskRoot, "notes.txt"), "old notes\n", "utf8");
    writeFileSync(path.join(harnessRoot, "decisions", "dec_mrcda9kw.md"), "# Decision\n\n- claim: old\n", "utf8");
    initHarnessGit(harnessRoot);
    return await fn({ rootDir, harnessRoot, taskRoot, taskId });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function submitRequest(input: {
  readonly baseLedgerSha: string;
  readonly intentId: string;
  readonly changes: ReadonlyArray<ReturnType<typeof inlineChange>>;
}) {
  return {
    repo: { repoId: "canonical" },
    session: { sessionId: `session-${input.intentId}`, runtime: "codex" as const },
    payload: {
      baseLedgerSha: input.baseLedgerSha,
      intentId: input.intentId,
      declaredIntent: "prose-edit" as const,
      changes: input.changes
    }
  };
}

function inlineChange(pathInput: string, baseBody: string, newBody: string, options: { readonly mediaType?: string } = {}) {
  return {
    path: pathInput,
    baseBlobSha256: sha256Text(baseBody),
    newBlobSha256: sha256Text(newBody),
    mediaType: options.mediaType ?? (pathInput.endsWith(".md") ? "text/markdown" : "text/plain"),
    size: Buffer.byteLength(newBody),
    content: { kind: "inline" as const, body: newBody }
  };
}

function taskIndex(input: { readonly urgency: string }): string {
  return [
    "---",
    "status: active",
    `urgency: ${input.urgency}`,
    "---",
    "# Task",
    ""
  ].join("\n");
}

function initHarnessGit(harnessRoot: string): void {
  git(harnessRoot, "init");
  git(harnessRoot, "config", "user.name", "Harness Test");
  git(harnessRoot, "config", "user.email", "harness@example.test");
  git(harnessRoot, "add", ".");
  gitCommit(harnessRoot, "seed");
}

function gitCommit(harnessRoot: string, message: string): void {
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", message], {
    stdio: "ignore",
    env: {
      ...process.env,
      HOME: path.join(harnessRoot, ".empty-home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test"
    }
  });
}

function git(harnessRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", harnessRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: path.join(harnessRoot, ".empty-home"),
      GIT_CONFIG_GLOBAL: "/dev/null"
    }
  }).trimEnd();
}
