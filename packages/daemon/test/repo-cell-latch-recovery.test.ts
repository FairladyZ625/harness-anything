// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import {
  createImmutableLegacyGenerationSnapshot,
  legacyGenerationSnapshotPath,
  makeTaskEventReader,
  openSqliteEventStore,
  serializePersistedCanonicalEvent,
  sha256Text,
} from "../../kernel/src/index.ts";
import {
  contentClaims,
  preflightConvertedGenerationActivation,
} from "../../kernel/test/store/canonical-generation.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { causeClassOf, type RepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { projectedTaskIds } from "../src/repo-cell-receipts.ts";
import { cellCodedError } from "../src/repo-cell-errors.ts";
import { recoveryCommandPolicy } from "../src/recovery-state.ts";

const actor = { principal: { personId: "person-latch" }, executor: null } as const;

test("task identity lookup serves the projection's rows when it is caught up", () => {
  const reads = { count: 0 },
    cell = {
      knownTaskIds: null,
      projection: {
        list: () => {
          reads.count += 1;
          return { watermark: 4, sourceRevision: 4, rows: [{ taskId: "task-projected" }] };
        },
      },
      cellCodedError,
    };
  assert.deepEqual([...projectedTaskIds(cell)], ["task-projected"]);
  assert.deepEqual([...projectedTaskIds(cell)], ["task-projected"]);
  assert.equal(reads.count, 1);
});

test("task identity lookup fails closed while the projection lags", () => {
  const reads = { count: 0 },
    cell = {
      knownTaskIds: null,
      projection: {
        list: () => {
          reads.count += 1;
          return { watermark: 2, sourceRevision: 4, rows: [{ taskId: "task-projected" }] };
        },
      },
      cellCodedError,
    };
  // A lagging projection must not hand task_exists an under-populated (or empty) identity set.
  for (const attempt of [1, 2]) {
    assert.throws(
      () => projectedTaskIds(cell),
      (error: Error & { code?: string }) =>
        error.code === "content_not_ready" && /watermark 2, source revision 4/u.test(error.message),
      `attempt ${String(attempt)}`,
    );
  }
  assert.equal(cell.knownTaskIds, null);
  assert.equal(reads.count, 2);
});

test("projection recovery names and carries the reachable rebuild command", () => {
  assert.equal(causeClassOf(new Error("lifecycle document projection mismatch for INDEX.md")), "projection");
  assert.equal(
    causeClassOf(new Error("projection cache ledger identity mismatch; run daemon projection rebuild")),
    "projection",
  );
  assert.equal(causeClassOf(new Error("kernel projection schema 999 is newer than daemon schema 3")), "data-shape");
  assert.deepEqual(recoveryCommandPolicy("projection-rebuild", "projection"), {
    causes: ["projection"],
    settlesLatch: true,
  });
  assert.equal(recoveryCommandPolicy("projection-rebuild", "data-shape"), null);
  assert.equal(recoveryCommandPolicy("projection-rebuild", "infrastructure"), null);
  assert.equal(recoveryCommandPolicy("ledger-migrate", "data-shape"), null);
  assert.deepEqual(recoveryCommandPolicy("migrate-import", "data-shape"), {
    causes: ["data-shape"],
    settlesLatch: true,
  });
  assert.equal(recoveryCommandPolicy("migrate-import", "projection"), null);
  assert.equal(recoveryCommandPolicy("migrate-import", "infrastructure"), null);
  assert.deepEqual(recoveryCommandPolicy("receipt-show", "infrastructure"), {
    causes: ["data-shape", "infrastructure"],
    settlesLatch: false,
  });
});

test("Git event-layout corruption cannot revoke SQLite acceptance or reads", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-ignores-git-layout-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    const repoId = workspaceId("sqlite-ignores-git-layout"),
      binding = { actor, source: "local" as const };
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-git-one" });
    const accepted = await cell.run(
      { kind: "task-create", taskId: "task_sqlite_truth", title: "SQLite truth" },
      binding,
    );
    assert.equal(accepted.outcome, "applied");
    await cell.close();
    cell = undefined;
    mkdirSync(path.join(rootDir, "harness/events"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/events/legacy-flat.json"), "{}\n");
    git(rootDir, "add", "harness/events/legacy-flat.json");
    git(rootDir, "commit", "-qm", "corrupt retired Git event layout");
    git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-git-two" });
    assert.equal(cell.status().state, "attached");
    const listed = await cell.run({ kind: "task-list" }, binding);
    assert.equal(listed.outcome, "applied", JSON.stringify(listed));
    assert.match(String(listed.evidence), /task_sqlite_truth/u);
    const receipt = await cell.run({ kind: "receipt-show", opId: accepted.opId }, binding);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("SQLite malformed canonical rows fail closed during operator activation validation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-invalid-activation-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    const repoId = workspaceId("sqlite-invalid-activation"),
      binding = { actor, source: "local" as const };
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "sqlite-invalid-one" });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task_before_corruption", title: "Before" }, binding)).outcome,
      "applied",
    );
    await cell.close();
    cell = undefined;
    const source = makeTaskEventReader({ repoId, rootDir, generation: 2 });
    const legacy = openSqliteEventStore({ repoId, rootInput: rootDir, generation: 1 });
    for (const event of source.read().events) {
      const blobs = contentClaims(event).map((claim) => ({
        ...claim,
        body: source.readContentBlob(claim.sha256)!,
      }));
      legacy.appendCommand({
        fence: { repoId, holder: "malformed-fixture", epoch: 1 },
        intent: {
          opId: event.opId,
          intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
          summary: event.type,
        },
        events: [event],
        blobs,
      });
    }
    await source.drain();
    const snapshotPath = legacyGenerationSnapshotPath(rootDir);
    const snapshotSource = {
      read: () => ({
        schema: "canonical-event-stream/v1" as const,
        revision: legacy.revision(),
        events: legacy.events(),
      }),
      readContentBlob: (sha256: string) => legacy.readContentObject(sha256),
    } as unknown as Parameters<typeof createImmutableLegacyGenerationSnapshot>[0]["source"];
    const snapshot = createImmutableLegacyGenerationSnapshot({ repoId, source: snapshotSource, snapshotPath });
    const databasePath = path.join(rootDir, ".harness/store/generations/1/ledger.sqlite");
    writeFileSync(
      `${databasePath}.import-source.json`,
      `${JSON.stringify({ schema: "generation-import-source/v1", sourceDigest: snapshot.sourceDigest })}\n`,
    );
    legacy.close();
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE event SET event_json = ? WHERE revision = 1").run("{}");
    db.close();
    assert.throws(
      () =>
        preflightConvertedGenerationActivation({
          repoId,
          rootDir,
          snapshotPath: legacyGenerationSnapshotPath(rootDir),
          databasePath,
        }),
      /event|canonical|invalid|schema/iu,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("projection rebuild is executable from a projection latch and settles it", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-latch-projection-rebuild-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    const binding = { actor, source: "local" as const };
    cell = await openRepoCell({
      repoId: workspaceId("latch-projection-rebuild"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "latch-projection-rebuild-one",
    });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task_projection_rebuild", title: "Projection rebuild" }, binding))
        .outcome,
      "applied",
    );
    await cell.close();
    cell = undefined;
    const cache = path.join(rootDir, ".harness/cache/task.sqlite"),
      db = new DatabaseSync(cache),
      original = String(
        (
          db.prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?").get("task_projection_rebuild") as {
            readonly snapshot_json: string;
          }
        ).snapshot_json,
      );
    const corrupted = JSON.parse(original) as { task: { schema: string } };
    corrupted.task.schema = "task/broken";
    db.prepare("UPDATE task_snapshot SET snapshot_json = ? WHERE task_id = ?").run(
      JSON.stringify(corrupted),
      "task_projection_rebuild",
    );
    db.close();
    cell = await openRepoCell({
      repoId: workspaceId("latch-projection-rebuild"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "latch-projection-rebuild-two",
    });
    const latched = await cell.run({ kind: "task-list" }, binding);
    assert.equal(latched.outcome, "op_rejected");
    assert.equal(cell.status().state, "unavailable");
    assert.equal(cell.status().causeClass, "projection");
    const blocked = await cell.run({ kind: "task-list" }, binding);
    assert.equal(blocked.code, "repo_unavailable");
    assert.deepEqual(blocked.diagnostic, { kind: "failure", code: "repo_unavailable" });
    const rebuilt = await cell.run({ kind: "projection-rebuild" }, binding);
    assert.equal(rebuilt.outcome, "applied", JSON.stringify(rebuilt));
    assert.equal(cell.status().state, "attached");
    await cell.close();
    cell = undefined;
    const repaired = new DatabaseSync(cache),
      rebuiltSnapshot = repaired
        .prepare("SELECT snapshot_json FROM task_snapshot WHERE task_id = ?")
        .get("task_projection_rebuild") as { readonly snapshot_json: string };
    assert.equal(rebuiltSnapshot.snapshot_json, original);
    repaired.close();
    cell = await openRepoCell({
      repoId: workspaceId("latch-projection-rebuild"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "latch-projection-rebuild-three",
    });
    assert.equal((await cell.run({ kind: "task-list" }, binding)).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a queued write rechecks Cell state after close begins", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cell-close-queue-"));
  let cell: RepoCell | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("cell-close-queue"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "cell-close-queue",
    });
    const binding = { actor, source: "local" as const };
    const headBeforeClose = makeTaskEventReader({ repoId: "cell-close-queue", rootDir }).readHead();
    const pending = cell.run(
        { kind: "task-create", taskId: "task_must_not_publish", title: "Must not publish" },
        binding,
      ),
      closing = cell.close();
    const receipt = await pending;
    assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
    assert.equal(receipt.code, "repo_unavailable");
    await closing;
    cell = undefined;
    assert.deepEqual(makeTaskEventReader({ repoId: "cell-close-queue", rootDir }).readHead(), headBeforeClose);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Latch Recovery Test");
  git(rootDir, "config", "user.email", "latch-recovery@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
