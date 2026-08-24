// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, sha256Text } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { actor, git, initRepo, write } from "./doc-sync-slice-a.fixtures.ts";

test("WAL flush settles an eligible authored edit and status highlights blocked candidates", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authored-wal-doc-sync-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
    repoId: workspaceId("authored-wal-doc-sync"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "authored-wal-doc-sync-daemon",
  });
  const binding = { actor, source: "local" as const };
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-authored-wal", title: "Authored WAL" }, binding)).outcome,
      "applied",
    );
    write(rootDir, "context/auto.md", "# Settled by WAL\n");

    const tracked = path.join(rootDir, "harness/context/auto.md"),
      deadline = Date.now() + 10_000;
    while (!gitHasPath(rootDir, "harness/context/auto.md") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(gitHasPath(rootDir, "harness/context/auto.md"), true, "eligible edit did not reach HEAD in time");
    assert.equal(readFileSync(tracked, "utf8"), "# Settled by WAL\n");

    write(rootDir, "harness.yaml", "schema: hand-edited\n");
    const status = await cell.run({ kind: "doc-status", paths: ["harness.yaml"] }, binding);
    assert.match(status.summary ?? "", /doc-status: BLOCKED \(1\)/u);
    assert.match(status.summary ?? "", /harness\.yaml\tblocked/u);
  } finally {
    await cell.close();
    assert.equal(git(rootDir, "diff", "--name-only"), "");
    assert.match(git(rootDir, "status", "--porcelain", "-uall"), /\?\? harness\/harness\.yaml/u);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("WAL flush keeps forbidden and unresolved candidates out of an eligible batch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authored-wal-mixed-"));
  initRepo(rootDir);
  const repoId = workspaceId("authored-wal-mixed"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "authored-wal-mixed-daemon",
    }),
    binding = { actor, source: "local" as const };
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-mixed", title: "Mixed WAL" }, binding)).outcome,
      "applied",
    );
    const unresolved = "context/unresolved.md";
    write(rootDir, unresolved, "---\nowner: canonical\n---\n# Unresolved\n\nbase\n");
    assert.equal((await cell.run({ kind: "doc-submit", paths: [unresolved] }, binding)).outcome, "applied");
    await waitForHeadBody(rootDir, unresolved, "---\nowner: canonical\n---\n# Unresolved\n\nbase\n");

    write(rootDir, unresolved, "---\nowner: hand-edit\n---\n# Unresolved\n\nbase\n");
    write(rootDir, "context/eligible.md", "# Eligible\n\nsettled in the same WAL cut\n");
    write(rootDir, "harness.yaml", "schema: hand-edited\n");
    const transition = await cell.run(
      { kind: "task-start", taskId: "task-mixed", executionId: "execution-mixed" },
      binding,
    );
    assert.equal(transition.outcome, "applied", JSON.stringify(transition));
    await waitForHeadBody(rootDir, "context/eligible.md", "# Eligible\n\nsettled in the same WAL cut\n");

    const status = await cell.run(
        { kind: "doc-status", paths: ["context/eligible.md", unresolved, "harness.yaml"] },
        binding,
      ),
      statusRows = JSON.parse((status.evidence ?? "").slice("doc-scan:".length)) as {
        rows: readonly { readonly path: string; readonly state: string }[];
      };
    assert.equal(statusRows.rows.find((row) => row.path === "context/eligible.md")?.state, "clean");
    assert.equal(statusRows.rows.find((row) => row.path === unresolved)?.state, "blocked");
    assert.equal(statusRows.rows.find((row) => row.path === "harness.yaml")?.state, "blocked");
    assert.match(status.summary ?? "", /doc-status: BLOCKED \(2\)/u);
    assert.equal(
      readFileSync(path.join(rootDir, "harness", unresolved), "utf8"),
      "---\nowner: hand-edit\n---\n# Unresolved\n\nbase\n",
    );
    assert.equal(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8"), "schema: hand-edited\n");
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a repeated authored write target settles to the latest WAL claim", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authored-wal-repeat-"));
  initRepo(rootDir);
  const repoId = workspaceId("authored-wal-repeat"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "authored-wal-repeat-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = "context/repeated.md",
    firstBody = "# Repeated\n\nfirst claim\n",
    latestBody = "# Repeated\n\nlatest claim\n";
  try {
    write(rootDir, logical, firstBody);
    const first = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    write(rootDir, logical, latestBody);
    const second = await cell.run({ kind: "doc-submit", paths: [logical] }, binding);
    assert.equal(second.outcome, "applied", JSON.stringify(second));
    await waitForHeadBody(rootDir, logical, latestBody);
    assert.equal(git(rootDir, "show", `HEAD:harness/${logical}`), latestBody.trim());
    const events = makeTaskEventStore({ repoId, rootDir })
      .read()
      .events.filter((event) => event.schema === "doc-event/v1");
    assert.equal(events.length, 2);
    assert.equal(events.at(-1)?.schema, "doc-event/v1");
    if (events.at(-1)?.schema === "doc-event/v1")
      assert.equal(events.at(-1).payload.changes[0]?.candidate?.sha256, sha256Text(latestBody));
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("closing after a state transition drains a settlement event created by the same flush", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authored-wal-close-"));
  initRepo(rootDir);
  const repoId = workspaceId("authored-wal-close"),
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "authored-wal-close-daemon",
    }),
    binding = { actor, source: "local" as const },
    logical = "context/close-settlement.md",
    body = "# Close settlement\n\nflush before close\n";
  try {
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-close", title: "Close settlement" }, binding)).outcome,
      "applied",
    );
    write(rootDir, logical, body);
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task-close", executionId: "execution-close" }, binding)).outcome,
      "applied",
    );
    await cell.close();
    assert.equal(git(rootDir, "show", `HEAD:harness/${logical}`), body.trim());
    assert.equal(git(rootDir, "diff", "--name-only"), "");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function gitHasPath(rootDir: string, target: string): boolean {
  try {
    execFileSync("git", ["-C", rootDir, "ls-files", "--error-unmatch", "--", target], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForHeadBody(rootDir: string, logical: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      gitHasPath(rootDir, `harness/${logical}`) &&
      git(rootDir, "show", `HEAD:harness/${logical}`) === expected.trim()
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(git(rootDir, "show", `HEAD:harness/${logical}`), expected.trim());
}
