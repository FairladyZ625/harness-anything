// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import { actor, initRepo, write } from "./doc-sync-slice-a.fixtures.ts";

// The acceptance form of the unified coordinate: a path printed by `ha doc status` can be pasted
// straight into `ha doc show --path` (and every other doc --path command) from the same root.
test("a doc status row path pastes back into doc show --path from the same workspace root", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-round-trip-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-round-trip"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "round-trip" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin"),
    logical = "context/pasted.md",
    body = "# Pasted\n\nround trip\n";
  try {
    write(rootDir, logical, body);
    const submitted = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));

    const status = (await cell.run({ kind: "doc-status", paths: [logical] }, binding)) as {
      readonly detail?: { readonly paths: readonly { readonly path: string }[] };
    };
    const printed = status.detail?.paths[0]?.path;
    assert.equal(printed, `harness/${logical}`, "the receipt prints the workspace-relative spelling");

    const parsed = parseThinCommand(["doc", "show", "--path", String(printed)], rootDir);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const action = parsed.command.action as { readonly path?: string; readonly pathCoordinate?: string };
    assert.equal(action.path, printed, "the parser hands the pasted spelling to the doc action unchanged");
    assert.equal(action.pathCoordinate, "workspace", "the CLI marks the caller coordinate at the boundary");

    // The parsed action carries the marker, so the daemon entry translates it exactly as an `ha` call does.
    const shown = await cell.run(parsed.command.action, binding);
    assert.equal(shown.outcome, "applied", JSON.stringify(shown));
    assert.equal(shown.evidence, body);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the old authored-relative spelling is rejected at the CLI boundary", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-legacy-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-legacy"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "legacy" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const parsed = parseThinCommand(["doc", "show", "--path", "tasks/task_a/x.md"], rootDir);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const receipt = await cell.run(parsed.command.action, binding);
    assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
    assert.equal(receipt.code, "invalid_field", JSON.stringify(receipt));
    assert.match(JSON.stringify(receipt), /outside the authored ledger root/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a zero-hit selection names the workspace path the caller typed", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-zero-hit-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-zero-hit"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "zero-hit" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const missing = await cell.run(
      { kind: "doc-submit", paths: ["harness/context/missing.md"], pathCoordinate: "workspace" },
      binding,
    );
    assert.equal(missing.outcome, "op_rejected", JSON.stringify(missing));
    assert.equal(missing.code, "document_not_found", JSON.stringify(missing));
    assert.match(String(missing.rejectionExplanation), /harness\/context\/missing\.md/u);
    assert.doesNotMatch(String(missing.rejectionExplanation), /(?:^|\s)context\/missing\.md/u);
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a doc-synced closeout keeps the task submit next after coordinate translation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-doc-path-closeout-next-"));
  initRepo(rootDir);
  const repoId = workspaceId("doc-path-closeout-next"),
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "closeout-next" }),
    binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
  try {
    const created = await cell.run(
      { kind: "task-create", taskId: "task-closeout-next", title: "Closeout next" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String(created.packagePath);
    write(rootDir, `${packagePath}/task_plan.md`, realizedTaskPlan("Closeout next"));
    assert.equal(
      (await cell.run({ kind: "doc-submit", paths: [`${packagePath}/task_plan.md`] }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task-closeout-next", executionId: "exe_closeout_next" }, binding))
        .outcome,
      "applied",
    );
    write(rootDir, `${packagePath}/closeout.md`, "# Closeout\n\n## Summary\n\nDelivered.\n");
    const synced = await cell.run({ kind: "doc-submit", paths: [`${packagePath}/closeout.md`] }, binding);
    assert.equal(synced.outcome, "applied", JSON.stringify(synced));
    assert.match(
      JSON.stringify(synced.next),
      new RegExp(`ha task submit task-closeout-next`, "u"),
      JSON.stringify(synced),
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
