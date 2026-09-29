// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, git, initRepo, rows, write } from "./doc-sync-slice-a.fixtures.ts";

test("a submit without --task or --path is refused and lists its candidates grouped by task", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-submit-scope-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-submit-scope"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "doc-submit-scope-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const createdA = (await cell.run({ kind: "task-create", taskId: "task-scope-a", title: "Scope A" }, binding)) as {
        readonly outcome: string;
        readonly packagePath: string;
      },
      createdB = (await cell.run({ kind: "task-create", taskId: "task-scope-b", title: "Scope B" }, binding)) as {
        readonly outcome: string;
        readonly packagePath: string;
      };
    assert.equal(createdA.outcome, "applied", JSON.stringify(createdA));
    assert.equal(createdB.outcome, "applied", JSON.stringify(createdB));
    const reportA = `${createdA.packagePath}/artifacts/reports/a.md`,
      reportB = `${createdB.packagePath}/artifacts/reports/b.md`;
    write(rootDir, reportA, "# A\n");
    write(rootDir, reportB, "# B\n");
    write(rootDir, "context/shared.md", "# Shared\n");
    const rejected = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as {
      readonly outcome: string;
      readonly code: string;
      readonly summary: string;
      readonly rejectionExplanation?: string;
      readonly detail?: { readonly code?: string };
    };
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "doc_submit_scope_required");
    assert.equal(rejected.detail?.code, "doc_submit_scope_required");
    assert.equal(rejected.rejectionExplanation, rejected.summary);
    const summary = rejected.summary;
    assert.match(summary, /candidates by task:/u);
    assert.match(summary, new RegExp(`task task-scope-a:\\n  ${escapeRegExp(reportA)}\\teligible`, "u"));
    assert.match(summary, new RegExp(`task task-scope-b:\\n  ${escapeRegExp(reportB)}\\teligible`, "u"));
    assert.match(summary, /shared surface \(no owning task\):\n  context\/shared\.md\teligible/u);
    assert.match(summary, /next: rerun ha doc sync --submit with --task <task-id> or --path <path>/u);
    // The refusal published nothing: every candidate is still eligible.
    const statusRows = rows((await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence);
    assert.deepEqual(
      statusRows.filter((row) => row.state === "eligible").map((row) => row.path),
      ["context/shared.md", reportA, reportB],
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the local --all shape rides the same scope refusal", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-submit-scope-all-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-submit-scope-all"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "doc-submit-scope-all-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const created = (await cell.run(
        { kind: "task-create", taskId: "task-scope-all", title: "Scope All" },
        binding,
      )) as { readonly outcome: string; readonly packagePath: string },
      report = `${created.packagePath}/artifacts/reports/all.md`;
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    write(rootDir, report, "# All\n");
    const rejected = (await cell.run({ kind: "doc-submit", paths: [], all: true }, binding)) as {
      readonly outcome: string;
      readonly code: string;
      readonly summary: string;
    };
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "doc_submit_scope_required");
    assert.match(rejected.summary, new RegExp(`task task-scope-all:\\n  ${escapeRegExp(report)}\\teligible`, "u"));
    assert.equal(
      rows((await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence).some(
        (row) => row.path === report && row.state === "eligible",
      ),
      true,
      "the --all refusal must not publish the candidate either",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("--task submits only that task's candidates while the other task's files stay unsubmitted", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-submit-scope-isolation-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-submit-scope-isolation"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "doc-submit-scope-isolation-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const createdA = (await cell.run({ kind: "task-create", taskId: "task-iso-a", title: "Isolation A" }, binding)) as {
        readonly outcome: string;
        readonly packagePath: string;
      },
      createdB = (await cell.run({ kind: "task-create", taskId: "task-iso-b", title: "Isolation B" }, binding)) as {
        readonly outcome: string;
        readonly packagePath: string;
      };
    assert.equal(createdA.outcome, "applied", JSON.stringify(createdA));
    assert.equal(createdB.outcome, "applied", JSON.stringify(createdB));
    const reportA = `${createdA.packagePath}/artifacts/reports/a.md`,
      reportB = `${createdB.packagePath}/artifacts/reports/b.md`;
    write(rootDir, reportA, "# A\n");
    write(rootDir, reportB, "# B\n");
    write(rootDir, "context/shared.md", "# Shared\n");
    const submitted = await cell.run({ kind: "doc-submit", taskId: "task-iso-a" }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    const event = makeTaskEventReader({ repoId, rootDir }).readEvent(submitted.opId);
    assert.equal(event?.schema, "doc-event/v1");
    if (event?.schema === "doc-event/v1")
      assert.deepEqual(
        event.payload.changes.map((change) => change.path),
        [reportA],
        "the task-scoped submit carries only its own package's candidates",
      );
    assert.equal(
      rows((await cell.run({ kind: "doc-status", paths: [] }, binding)).evidence).some(
        (row) => row.path === reportB && row.state === "eligible",
      ),
      true,
      "the other task's file must stay unsubmitted",
    );
    assert.match(git(rootDir, "status", "--porcelain", "-uall"), /context\/shared\.md/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a scopeless submit over a clean workspace still names the missing scope", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-submit-scope-clean-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-submit-scope-clean"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "doc-submit-scope-clean-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    const rejected = (await cell.run({ kind: "doc-submit", paths: [] }, binding)) as {
      readonly outcome: string;
      readonly code: string;
      readonly summary: string;
    };
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "doc_submit_scope_required");
    assert.match(rejected.summary, /candidates: \(none\)/u);
    assert.match(rejected.summary, /next: rerun ha doc sync --submit with --task <task-id> or --path <path>/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
