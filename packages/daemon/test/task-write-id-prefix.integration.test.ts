// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";

function binding(executorId: string) {
  return withPolicyGroup(
    {
      actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: executorId } },
      source: "local" as const,
    },
    "admin",
  );
}

function workspace(name: string): string {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-write-prefix-${name}-`));
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Write Prefix Test");
  git(rootDir, "config", "user.email", "write-prefix@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
  writeFileSync(path.join(rootDir, "README.md"), "# Fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "--quiet", "-m", "fixture delivery");
  return rootDir;
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd: rootDir, encoding: "utf8", windowsHide: true }).trim();
}

test("task write commands resolve short-id prefixes like task show, never projection_unknown", async () => {
  const rootDir = workspace("complete"),
    owner = binding("prefix-owner");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("write-prefix-complete"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "write-prefix-complete",
    });
    const created = await cell.run(
      { kind: "task-create", taskId: "task-prefix-resolve-target", title: "Prefix resolution" },
      owner,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, owner);
    // A unique prefix must reach the same lifecycle judgment the full id gets: the blocker names
    // the resolved task's real next step, never a canonical-projection rebuild complaint.
    const prefixed = (await cell.run({ kind: "task-complete", taskId: "task-prefix-resolve" }, owner)) as Record<
      string,
      unknown
    >;
    assert.equal(prefixed.code, "not_in_review", JSON.stringify(prefixed));
    assert.match(
      ((prefixed.next as readonly { action: string }[]) ?? [])[0]?.action ?? "",
      /ha task start task-prefix-resolve-target/u,
      JSON.stringify(prefixed),
    );

    const firstShared = await cell.run(
      { kind: "task-create", taskId: "task-prefix-shared-one", title: "Shared prefix one" },
      owner,
    );
    const secondShared = await cell.run(
      { kind: "task-create", taskId: "task-prefix-shared-two", title: "Shared prefix two" },
      owner,
    );
    assert.equal(firstShared.outcome, "applied", JSON.stringify(firstShared));
    assert.equal(secondShared.outcome, "applied", JSON.stringify(secondShared));
    await waitForFixturePublication(cell, secondShared.opId, owner);
    const ambiguous = (await cell.run({ kind: "task-complete", taskId: "task-prefix-shared" }, owner)) as Record<
      string,
      unknown
    >;
    assert.equal(ambiguous.code, "task_ambiguous_id", JSON.stringify(ambiguous));
    assert.match(
      String(ambiguous.rejectionExplanation ?? ""),
      /task-prefix-shared-one.*task-prefix-shared-two/su,
      JSON.stringify(ambiguous),
    );

    const missing = (await cell.run({ kind: "task-complete", taskId: "task-absent-unknown" }, owner)) as Record<
      string,
      unknown
    >;
    assert.equal(missing.code, "entity_not_found", JSON.stringify(missing));
    assert.match(String(missing.rejectionExplanation ?? ""), /task-absent-unknown/u, JSON.stringify(missing));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("sibling lifecycle writes resolve the same short-id prefixes", async () => {
  const rootDir = workspace("sibling"),
    owner = binding("prefix-owner");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId("write-prefix-sibling"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "write-prefix-sibling",
    });
    const created = await cell.run(
      { kind: "task-create", taskId: "task-prefix-sibling-target", title: "Sibling prefix" },
      owner,
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, owner);
    const transition = await cell.run(
      { kind: "task-transition", taskId: "task-prefix-sibling", status: "blocked", reason: "prefix resolves" },
      owner,
    );
    assert.equal(transition.outcome, "applied", JSON.stringify(transition));
    // The prefixed write hit the resolved task: completing it now reports the blocked status of
    // task-prefix-sibling-target, naming the full id in its next step.
    const blocked = (await cell.run({ kind: "task-complete", taskId: "task-prefix-sibling" }, owner)) as Record<
      string,
      unknown
    >;
    assert.equal(blocked.code, "task_blocked", JSON.stringify(blocked));
    assert.match(
      ((blocked.next as readonly { action: string }[]) ?? [])[0]?.action ?? "",
      /ha task show task-prefix-sibling-target/u,
      JSON.stringify(blocked),
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
