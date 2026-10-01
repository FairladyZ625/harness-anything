// harness-test-tier: integration
import assert from "node:assert/strict";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { writePackage } from "../../preset/test/preset-resolver.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const binding = withRoleBinding(
    {
      actor: { principal: { personId: "person-owner" }, executor: null },
      source: "local" as const,
    },
    "owner",
  ),
  taskId = "task_01KZXSYDTJ3K1YE88294X33QNX";

/**
 * An action that wrote nothing to the ledger has no acceptance to verify. Its receipt must report a
 * definite success rather than being judged against an absent command (acceptance_unknown, a
 * forever-pending outcome, or a rejected status).
 */
function assertDefiniteNoWrite(receipt: Record<string, unknown>, outcome: "applied" | "no_changes"): void {
  const text = JSON.stringify(receipt);
  assert.equal(receipt.outcome, outcome, text);
  assert.notEqual(receipt.code, "acceptance_unknown", text);
  // No ledger acceptance is claimed: a determinate no-write settles as settled_no_write, never unknown.
  assert.equal(receipt.status, "settled_no_write", text);
  assert.equal(receipt.acceptance, null, text);
  assert.equal(receipt.proof, undefined, text);
}

test("actions that write nothing to the ledger settle as a definite success", { timeout: 60_000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-no-write-receipt-"));
  initRepo(rootDir);
  const repoId = "no-write-receipt",
    cell = await openRepoCell({ repoId: workspaceId(repoId), rootDir: canonicalRoot(rootDir), ownerId: repoId });
  try {
    const head = () => makeTaskEventReader({ repoId, rootDir }).readHead()?.revision ?? 0;
    const created = await cell.run(
      { kind: "task-create", taskId, title: "No-write receipts", idempotencyKey: "no-write-key" },
      binding,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    assert.equal(created.status, "accepted_durable", JSON.stringify(created));

    // task-create idempotent reuse: a different invocation with the same key reuses the task.
    const before = head(),
      reused = await cell.run(
        { kind: "task-create", title: "No-write receipts, retried", idempotencyKey: "no-write-key" },
        binding,
      );
    assertDefiniteNoWrite(reused, "no_changes");
    assert.equal((reused as { taskId?: string }).taskId, taskId);
    assert.equal(head(), before, "reuse appends no event");

    // script-run whose plan has no document changes.
    const script = await cell.run(
      {
        schema: "vertical-script-action/v1",
        kind: "script-run",
        scriptId: "vertical:software-coding:decision-conformance",
        taskId,
        inputs: {},
        dryRun: false,
      },
      binding,
    );
    assertDefiniteNoWrite(script, "no_changes");
    assert.equal(head(), before, "an empty script plan appends no event");

    // rematerialize with nothing to re-render.
    const rematerialized = await cell.run({ kind: "decision-rematerialize", all: true }, binding);
    assertDefiniteNoWrite(rematerialized, "no_changes");

    // preset install/seed/uninstall write the local preset store, never the ledger.
    const seeded = await cell.run({ kind: "preset-seed" }, binding);
    assertDefiniteNoWrite(seeded, "applied");
    const source = path.join(rootDir, "preset-source");
    writePackage(source, "no-write-preset");
    const installed = await cell.run(
      { kind: "preset-install", packageSource: path.join(source, "no-write-preset") },
      binding,
    );
    assertDefiniteNoWrite(installed, "applied");
    const uninstalled = await cell.run({ kind: "preset-uninstall", presetId: "no-write-preset" }, binding);
    assertDefiniteNoWrite(uninstalled, "applied");

    // distill-candidate writes a generated candidate file, never a Fact.
    writeFileSync(path.join(rootDir, "notes.md"), "Receipts report what was written.\n");
    const candidate = await cell.run({ kind: "distill-candidate", taskId, inputPath: "notes.md" }, binding);
    assertDefiniteNoWrite(candidate, "applied");
    const candidatePath = (JSON.parse(String(candidate.evidence)) as { candidatePath: string }).candidatePath;
    assert.ok(existsSync(path.join(rootDir, candidatePath)), candidatePath);
    assert.equal(head(), before, "no local-only write appends an event");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "No Write Receipt Test");
  git(rootDir, "config", "user.email", "no-write-receipt@example.invalid");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), "layout:\n  contextRoot: harness/context\n");
  git(rootDir, "add", ".");
  git(rootDir, "commit", "-qm", "base");
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
