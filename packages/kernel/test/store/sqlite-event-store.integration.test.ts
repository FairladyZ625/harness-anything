// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  docSyncWritePlan,
  serializePersistedCanonicalEvent,
  type DocEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  migrateEventsToSqlite,
  openSqliteEventStore,
  sqliteLedgerPath,
  sqliteContentObjectPath,
  type SqliteCommandIntent,
  type SqliteEventStore,
  type SqliteWriterFence,
} from "../../src/store/sqlite-event-store.ts";
import {
  createImmutableLegacyGenerationSnapshot,
  convertLegacyGeneration,
  preflightConvertedGenerationActivation,
} from "../../src/store/legacy-generation-conversion.ts";
import { reconcileSqliteEvents } from "../../src/store/sqlite-ledger-reconcile.ts";
import { decisionProposal, docBundle, eventAt, git, initRepo, repoFileBundle } from "./task-event-store.fixtures.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store-factory.ts";
import { readCertifiedGitFollower } from "../../src/store/task-event-store-factory.ts";

import {
  compileDecisionWrite,
  decisionWritePlan,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
} from "../../src/domain/decision-event.ts";
import { freezeDeclaredWritePlan } from "../../src/domain/write-chain.contract.ts";

const repoId = "sqlite-generation-test";
const fence: SqliteWriterFence = { repoId, holder: "writer-a", epoch: 1 };

test("canonical adapter accepts in SQLite before independently verifying the Git follower", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-canonical-"));
  initRepo(rootDir);
  const event = eventAt(1),
    store = makeTaskEventStore({
      repoId,
      rootDir,
      writerFence: () => ({ repoId, holderId: fence.holder, epoch: fence.epoch }),
    });
  try {
    const unportable = { ...event, opId: "runtime-spawn-abcdef:installation" };
    assert.throws(
      () => store.append({ event: unportable, plan: taskLifecycleWritePlan(unportable), blobs: [] }),
      /cannot be a filename/u,
    );
    assert.equal(store.readEvent(unportable.opId), null);
    assert.equal(store.readCommandOutcome(unportable.opId), null);
    assert.equal(store.currentCut().revision, 0);
    const receipt = store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    await store.settlePendingMaterialization?.("test");
    assert.equal(receipt.status, "applied");
    assert.equal(store.ledgerMetadata().revision, 1);
    assert.deepEqual(store.readCommandOutcome(event.opId)?.memberOpIds, [event.opId]);
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().worktree.status, "verified");
    assert.equal(git(rootDir, "status", "--short", "--untracked-files=all", "--", "harness"), "");
  } finally {
    await store.drain();
  }
});

test("canonical killpoint between events and outcome rolls back the accepting transaction", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-atomic-"));
  initRepo(rootDir);
  const event = eventAt(1),
    store = makeTaskEventStore({
      repoId,
      rootDir,
      writerFence: () => ({ repoId, holderId: fence.holder, epoch: fence.epoch }),
      killpoint: (point) => {
        if (point === "after_event_write") throw new Error("transaction killpoint");
      },
    });
  try {
    assert.throws(() => store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] }), /killpoint/u);
    assert.equal(store.readEvent(event.opId), null);
    assert.equal(store.readCommandOutcome(event.opId), null);
    assert.equal(store.currentCut().revision, 0);
  } finally {
    await store.drain();
  }
});

test("Git can verify an accepted document while a concurrently edited worktree remains pending", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-worktree-"));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/context/published.md"), "local edit\n");
  const store = makeTaskEventStore({
    repoId,
    rootDir,
    writerFence: () => ({ repoId, holderId: fence.holder, epoch: fence.epoch }),
  });
  try {
    store.append(docBundle(store, "# Published\n", 1, "doc-one", "context/published.md"));
    await store.settlePendingMaterialization?.("test");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().worktree.status, "pending");
    assert.equal(readFileSync(path.join(rootDir, "harness/context/published.md"), "utf8"), "local edit\n");
    assert.equal(
      git(rootDir, "status", "--short", "--", "harness/context/published.md"),
      "M harness/context/published.md",
    );
    unlinkSync(path.join(rootDir, "harness/context/published.md"));
    await store.settlePendingMaterialization?.("test recovery");
    assert.equal(store.followerStatus().worktree.status, "verified");
  } finally {
    await store.drain();
  }
});

test("certified reopen resumes from the last physical cut without overwriting later user edits", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-worktree-reopen-"));
  initRepo(rootDir);
  const collision = path.join(rootDir, "harness/context/collision.md"),
    later = path.join(rootDir, "harness/context/later.md");
  const seeded = makeTaskEventStore({ repoId, rootDir });
  seeded.append(docBundle(seeded, "# Physical baseline\n", 1, "reopen-base", "context/base.md"));
  await seeded.settlePendingMaterialization?.("physical baseline");
  await seeded.drain();
  mkdirSync(path.dirname(collision), { recursive: true });
  writeFileSync(collision, "local collision\n");
  const first = makeTaskEventStore({ repoId, rootDir });
  first.append(docBundle(first, "# Canonical collision\n", 2, "reopen-collision", "context/collision.md"));
  await first.settlePendingMaterialization?.("blocked first cut");
  first.append(docBundle(first, "# Canonical later\n", 3, "reopen-later", "context/later.md"));
  await first.settlePendingMaterialization?.("blocked second cut");
  assert.equal(first.followerStatus().worktree.status, "pending");
  await first.drain();

  unlinkSync(collision);
  const reopened = makeTaskEventStore({ repoId, rootDir });
  try {
    await reopened.settlePendingMaterialization?.("resume physical cut");
    assert.equal(reopened.followerStatus().worktree.status, "verified");
    assert.equal(readFileSync(collision, "utf8"), "# Canonical collision\n");
    assert.equal(readFileSync(later, "utf8"), "# Canonical later\n");
  } finally {
    await reopened.drain();
  }

  writeFileSync(later, "real user edit\n");
  const editedReopen = makeTaskEventStore({ repoId, rootDir });
  try {
    await editedReopen.settlePendingMaterialization?.("preserve edit after reopen");
    assert.equal(readFileSync(later, "utf8"), "real user edit\n");
    assert.equal(editedReopen.followerStatus().worktree.status, "pending");
  } finally {
    await editedReopen.drain();
  }
});

test("SQLite content admission reuses exact objects after reopen and rejects corrupt or missing objects atomically", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-content-admission-")),
    body = "# Shared content\n",
    hash = sha256Text(body),
    options = { repoId, rootDir, writerFence: () => ({ repoId, holderId: fence.holder, epoch: fence.epoch }) };
  initRepo(rootDir);
  const first = makeTaskEventStore(options);
  try {
    first.append(docBundle(first, body, 1, "content-first", "context/first.md"));
  } finally {
    await first.drain();
  }
  const reopened = makeTaskEventStore(options),
    objectPath = sqliteContentObjectPath(rootDir, hash);
  try {
    const beforeReuse = statSync(objectPath),
      reused = docBundle(reopened, body, 2, "content-reused", "context/reused.md");
    reopened.append(reused);
    await reopened.settlePendingMaterialization?.("content reuse");
    const afterReuse = statSync(objectPath);
    assert.equal(afterReuse.ino, beforeReuse.ino);
    assert.equal(afterReuse.mtimeMs, beforeReuse.mtimeMs);
    assert.deepEqual(reopened.readContentBlob(hash), Buffer.from(body));
    assert.ok(reopened.readCommandOutcome(reused.event.opId));

    writeFileSync(objectPath, "corrupt object\n");
    const corrupt = docBundle(reopened, body, 3, "content-corrupt", "context/corrupt.md");
    assert.throws(() => reopened.append(corrupt), /content object .* is corrupt/u);
    assert.equal(reopened.readEvent(corrupt.event.opId), null);
    assert.equal(reopened.readCommandOutcome(corrupt.event.opId), null);
    assert.equal(reopened.currentCut().revision, 2);
    writeFileSync(objectPath, body);

    const missingBody = "# Missing input\n",
      missing = docBundle(reopened, missingBody, 3, "content-missing", "context/missing.md");
    assert.throws(
      () => reopened.append({ ...missing, blobs: [] }),
      /doc content inputs must exactly match the frozen write plan/u,
    );
    assert.equal(reopened.readEvent(missing.event.opId), null);
    assert.equal(reopened.readCommandOutcome(missing.event.opId), null);
    assert.equal(reopened.readContentBlob(sha256Text(missingBody)), null);
    assert.equal(reopened.currentCut().revision, 2);
  } finally {
    writeFileSync(objectPath, body);
    await reopened.drain();
  }
});

test("certified Git follower rejects document tampering even when its manifest is intact", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-git-tamper-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({
    repoId,
    rootDir,
    writerFence: () => ({ repoId, holderId: fence.holder, epoch: fence.epoch }),
  });
  try {
    store.append(docBundle(store, "# Canonical\n", 1, "doc-tamper", "context/canonical.md"));
    await store.settlePendingMaterialization?.("test");
    git(rootDir, "reset", "--mixed", "HEAD");
    writeFileSync(path.join(rootDir, "harness/context/canonical.md"), "tampered\n");
    git(rootDir, "add", "harness/context/canonical.md");
    git(rootDir, "commit", "-qm", "tamper authored follower only");
    const sqlite = openSqliteEventStore({ repoId, rootInput: rootDir, readOnly: true });
    try {
      assert.throws(
        () => readCertifiedGitFollower({ rootInput: rootDir, repoId, store: sqlite }),
        /read-back differs/u,
      );
    } finally {
      sqlite.close();
    }
  } finally {
    await store.drain();
  }
});

test("SQLite Decision append refuses a stale canonical document base before recording an outcome", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-decision-base-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir }),
    proposal = decisionProposal(),
    compiled = compileDecisionWrite({
      event: proposal,
      currentDecision: null,
      currentRelations: [],
      currentDocument: null,
    });
  try {
    store.append(compiled);
    const current: Omit<DecisionDocumentState, "relations"> = {
        decisionId: proposal.decisionId,
        state: "proposed",
        title: proposal.payload.title,
        question: proposal.payload.question,
        riskTier: proposal.payload.riskTier,
        urgency: proposal.payload.urgency,
        vertical: proposal.payload.vertical,
        preset: proposal.payload.preset,
        decisionClass: proposal.payload.decisionClass,
        appliesTo: proposal.payload.appliesTo,
        proposer: proposal.actor,
        arbiter: null,
        proposedAt: proposal.occurredAt,
        decidedAt: null,
        workspaceRevision: 1,
        chosen: proposal.payload.chosen,
        rejected: proposal.payload.rejected,
        claims: [],
        provenance: proposal.payload.provenance,
        judgmentConsents: [],
      },
      acceptedDraft: DecisionEventDraftV1 = {
        ...proposal,
        eventId: "event-decision-store-2",
        workspaceRevision: 2,
        opId: "op-decision-store-2",
        type: "decision_accepted",
        actor: { principal: { personId: "person-arbiter" }, executor: null },
        occurredAt: "2026-08-14T00:00:01.000Z",
        payload: {
          rationale: "Independent approval.",
          judgmentOnlyRationale: "Explicit judgment-only approval.",
        },
      },
      accepted = compileDecisionWrite({
        event: acceptedDraft,
        currentDecision: current,
        currentRelations: [],
        currentDocument: {
          blobSha256: compiled.event.payload.decisionDocumentClaim.sha256,
          body: compiled.body,
        },
      }),
      stale = {
        ...accepted.event,
        payload: {
          ...accepted.event.payload,
          baseDocumentSha256: "0".repeat(64),
        },
      };
    assert.throws(
      () => store.append({ ...accepted, event: stale, plan: decisionWritePlan(stale) }),
      /document base changed/u,
    );
    assert.equal(store.currentCut().revision, 1);
    assert.equal(store.readEvent(stale.opId), null);
    assert.equal(store.readCommandOutcome(stale.opId), null);
    store.append(accepted);
    assert.equal(store.currentCut().revision, 2);
    assert.ok(store.readCommandOutcome(accepted.event.opId));
    await store.settlePendingMaterialization!("decision base");
    assert.equal(readFileSync(path.join(rootDir, "harness", accepted.path), "utf8"), accepted.body);
  } finally {
    await store.drain();
  }
});

test("SQLite migration replacement refuses a destination edited after classification", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-preimage-"));
  initRepo(rootDir);
  const target = path.join(rootDir, "harness/context/notes.md"),
    expected = "# Initialized\n",
    edited = "# Edited after dry-run\n";
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, expected);
  git(rootDir, "add", "harness/context/notes.md");
  git(rootDir, "commit", "-qm", "initialized document");
  const store = makeTaskEventStore({ repoId, rootDir }),
    candidate = repoFileBundle("context/notes.md", "# Imported\n", expected);
  try {
    writeFileSync(target, edited);
    assert.throws(() => store.append(candidate), /destination changed.*dry-run/iu);
    assert.equal(store.currentCut().revision, 0);
    assert.equal(store.readEvent(candidate.event.opId), null);
    assert.equal(store.readCommandOutcome(candidate.event.opId), null);
    assert.equal(readFileSync(target, "utf8"), edited);
  } finally {
    await store.drain();
  }
});

test("SQLite retirement keeps a concurrent local edit while Git verifies the canonical deletion", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-retirement-race-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir }),
    logical = "context/temporary.md",
    target = path.join(rootDir, "harness", logical),
    canonical = "# Temporary\n",
    edited = "# Concurrent local edit\n",
    first = docBundle(store, canonical, 1, "retirement-base", logical);
  try {
    store.append(first);
    await store.settlePendingMaterialization!("retirement base");
    writeFileSync(target, edited);
    const event = first.event as DocEventV1,
      retired: DocEventV1 = {
        ...event,
        eventId: "retirement-delete",
        opId: "retirement-delete",
        workspaceRevision: 2,
        payload: {
          ...event.payload,
          baseLedgerSha: store.currentCut(),
          retirementReason: "superseded temporary evidence",
          executionId: null,
          changes: [
            {
              path: logical,
              baseBlobSha256: sha256Text(canonical),
              candidate: null,
              policyId: event.payload.changes[0]!.policyId,
              regionProofs: [],
            },
          ],
        },
      };
    store.append({ event: retired, plan: docSyncWritePlan(retired), blobs: [] });
    await store.settlePendingMaterialization!("retirement race");
    assert.ok(store.readCommandOutcome(retired.opId));
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().worktree.status, "pending");
    assert.equal(readFileSync(target, "utf8"), edited);
    assert.equal(git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`), "");
    assert.equal(git(rootDir, "status", "--short", "--", `harness/${logical}`), `?? harness/${logical}`);
  } finally {
    await store.drain();
  }
});

test("SQLite document admission rejects extra and missing frozen plan targets before acceptance", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-document-plan-"));
  initRepo(rootDir);
  const store = makeTaskEventStore({ repoId, rootDir }),
    candidate = docBundle(store, "# Plan\n", 1, "document-plan", "context/plan.md"),
    plan = candidate.plan;
  try {
    const extra = freezeDeclaredWritePlan(
        {
          commandType: plan.commandType,
          targets: [
            ...plan.targets.filter((target) => target.kind !== "ledger_file"),
            {
              kind: "content_blob",
              sha256: "f".repeat(64),
              size: 1,
              mediaType: "text/plain",
            },
          ],
        },
        [plan.commandType],
      ),
      missing = freezeDeclaredWritePlan(
        {
          commandType: plan.commandType,
          targets: plan.targets.filter((target) => target.kind !== "content_blob" && target.kind !== "ledger_file"),
        },
        [plan.commandType],
      );
    for (const invalid of [extra, missing]) {
      assert.throws(() => store.append({ ...candidate, plan: invalid }), /write plan/iu);
      assert.equal(store.currentCut().revision, 0);
      assert.equal(store.readEvent(candidate.event.opId), null);
      assert.equal(store.readCommandOutcome(candidate.event.opId), null);
    }
    assert.throws(() => (plan.targets as unknown as unknown[]).push(extra.targets.at(-1)));
    store.append(candidate);
    assert.equal(store.currentCut().revision, 1);
    assert.ok(store.readCommandOutcome(candidate.event.opId));
  } finally {
    await store.drain();
  }
});

test("single writer serializes revision allocation and rejects a competing revision", () => {
  const databasePath = scratch("concurrent"),
    first = openSqliteEventStore({ repoId, databasePath }),
    second = openSqliteEventStore({ repoId, databasePath });
  try {
    first.claimWriter(fence);
    assert.equal(first.appendCommand(command(first, 1)).lastRevision, 1);
    assert.throws(() => second.appendCommand(command(second, 1, "second-op")), /allocated revision 2/u);
    assert.equal(second.appendCommand(command(second, 2, "second-op")).lastRevision, 2);
    assert.deepEqual(
      second.events().map((event) => event.workspaceRevision),
      [1, 2],
    );
  } finally {
    first.close();
    second.close();
  }
});

test("a stale holder rolls back before SQLite records an event or outcome", () => {
  const databasePath = scratch("stale-holder"),
    stale = openSqliteEventStore({ repoId, databasePath }),
    successor = openSqliteEventStore({ repoId, databasePath });
  try {
    stale.claimWriter(fence);
    successor.claimWriter({ repoId, holder: "writer-b", epoch: 2 });
    assert.throws(
      () => stale.appendCommand(command(stale, 1)),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "revision_conflict" && /stale/u.test(error.message),
    );
    assert.equal(stale.revision(), 0);
    assert.deepEqual(stale.events(), []);
    assert.equal(stale.outcome(eventAt(1).opId), null);
  } finally {
    successor.close();
    stale.close();
  }
});

test("opening waits for a concurrent writer lock instead of failing with database is locked", async () => {
  const databasePath = scratch("open-under-lock"),
    holdMs = 400,
    holder = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      [
        'import { DatabaseSync } from "node:sqlite";',
        `const db = new DatabaseSync(${JSON.stringify(databasePath)});`,
        'db.exec("BEGIN IMMEDIATE; CREATE TABLE lock_holder(x INTEGER)");',
        'process.stdout.write("locked\\n");',
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});`,
        'db.exec("COMMIT");',
        "db.close();",
      ].join("\n"),
    ]);
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once("data", () => resolve());
      holder.once("exit", (code) => reject(new Error(`lock holder exited early with ${code}`)));
    });
    const startedAt = Date.now(),
      store = openSqliteEventStore({ repoId, databasePath });
    try {
      assert.ok(Date.now() - startedAt >= holdMs / 4, "open must have waited on the busy handler");
      assert.equal(store.revision(), 0);
    } finally {
      store.close();
    }
  } finally {
    holder.kill("SIGKILL");
  }
});

test("SIGKILL after acceptance preserves exact event bytes and the same op_id outcome", () => {
  const databasePath = scratch("reopen"),
    fixture = fileURLToPath(new URL("./sqlite-event-store-kill.fixture.mjs", import.meta.url)),
    killed = spawnSync(process.execPath, [fixture, databasePath, repoId, "after-commit"], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const accepted = JSON.parse(killed.stdout),
    store = openSqliteEventStore({ repoId, databasePath }),
    retry = { ...command(store, 1), fence: { repoId, holder: "replacement-writer", epoch: 2 } };
  try {
    assert.equal(accepted.status, "accepted_durable");
    assert.deepEqual(store.events(), [eventAt(1)]);
    assert.deepEqual(store.readCommandOutcome(eventAt(1).opId), accepted);
    assert.deepEqual(store.appendCommand(retry), accepted);
    assert.throws(
      () =>
        store.appendCommand({
          ...retry,
          intent: { ...intent(1), intentDigest: `sha256:${"f".repeat(64)}` },
        }),
      /another command intent/u,
    );
  } finally {
    store.close();
  }
});

test("event, writer takeover, ledger head, and outcome roll back atomically", () => {
  const databasePath = scratch("rollback"),
    store = openSqliteEventStore({ repoId, databasePath });
  try {
    store.claimWriter(fence);
    assert.throws(
      () =>
        store.appendCommand({
          ...command(store, 1),
          fence: { repoId, holder: "writer-b", epoch: 2 },
          beforeOutcome: () => {
            throw new Error("transaction killpoint");
          },
        }),
      /transaction killpoint/u,
    );
    assert.equal(store.events().length, 0);
    assert.equal(store.outcome(eventAt(1).opId), null);
    assert.equal(store.appendCommand(command(store, 1)).lastRevision, 1);
  } finally {
    store.close();
  }
});

test("one canonical bundle appends preceding events and its terminal event in one command", () => {
  const store = openSqliteEventStore({ repoId, databasePath: scratch("bundle") }),
    events = [eventAt(1), eventAt(2), eventAt(3)],
    eventBytes = events.map(serializePersistedCanonicalEvent),
    outcome = store.appendCommand({
      fence,
      intent: {
        opId: events.at(-1)!.opId,
        intentDigest: `sha256:${sha256Text(JSON.stringify(eventBytes))}`,
        summary: events.at(-1)!.type,
      },
      events,
    });
  try {
    assert.deepEqual(
      { firstRevision: outcome.firstRevision, lastRevision: outcome.lastRevision },
      { firstRevision: 1, lastRevision: 3 },
    );
    assert.deepEqual(store.events(), events);
  } finally {
    store.close();
  }
});

test("SIGKILL recovery discards an uncommitted event and writer takeover", () => {
  const databasePath = scratch("sigkill"),
    store = openSqliteEventStore({ repoId, databasePath });
  store.claimWriter(fence);
  store.close();
  const fixture = fileURLToPath(new URL("./sqlite-event-store-kill.fixture.mjs", import.meta.url)),
    killed = spawnSync(process.execPath, [fixture, databasePath, repoId], { encoding: "utf8" });
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  const reopened = openSqliteEventStore({ repoId, databasePath });
  try {
    assert.equal(reopened.events().length, 0);
    assert.equal(reopened.appendCommand(command(reopened, 1)).lastRevision, 1);
  } finally {
    reopened.close();
  }
});

test("generation migration is byte-exact, idempotent, and reports a bounded throughput sample", (context) => {
  const databasePath = scratch("migration"),
    store = openSqliteEventStore({ repoId, databasePath }),
    events = Array.from({ length: 1_000 }, (_, index) => eventAt(index + 1)),
    started = performance.now();
  try {
    const first = migrateEventsToSqlite({ store, repoId, events, holder: fence.holder, epoch: fence.epoch }),
      elapsedMs = performance.now() - started,
      second = migrateEventsToSqlite({ store, repoId, events, holder: fence.holder, epoch: fence.epoch });
    assert.deepEqual(first, { migrated: 1_000, revision: 1_000 });
    assert.deepEqual(second, { migrated: 0, revision: 1_000 });
    context.diagnostic(
      JSON.stringify({
        events: events.length,
        elapsedMs,
        eventsPerSecond: Math.round(events.length / (elapsedMs / 1_000)),
      }),
    );
  } finally {
    store.close();
  }
});

test("generation paths coexist beneath the local store root", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-path-"));
  assert.equal(sqliteLedgerPath(rootDir, 1), path.join(rootDir, ".harness/store/generations/1/ledger.sqlite"));
  assert.equal(sqliteLedgerPath(rootDir, 2), path.join(rootDir, ".harness/store/generations/2/ledger.sqlite"));
});

test("reconciliation uses immutable source, import evidence, row digests, outcomes and real Git read-back", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-reconcile-"));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness/events"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/events/legacy.json"), "legacy event\n");
  git(rootDir, "add", "harness/events/legacy.json");
  git(rootDir, "commit", "-qm", "legacy generation");
  const databasePath = sqliteLedgerPath(rootDir, 1),
    snapshotPath = path.join(rootDir, ".harness/source.json"),
    events = [eventAt(1), eventAt(2), eventAt(3)];
  createImmutableLegacyGenerationSnapshot({
    repoId,
    snapshotPath,
    source: { read: () => ({ events }), readContentBlob: () => null } as never,
  });
  convertLegacyGeneration({ rootDir, snapshotPath, databasePath });
  assert.equal(git(rootDir, "status", "--short", "--untracked-files=all", "--", "harness"), "");
  preflightConvertedGenerationActivation({ repoId, rootDir, snapshotPath, databasePath });
  const publisher = makeTaskEventStore({ repoId, rootDir });
  await publisher.settlePendingMaterialization!("independent reconcile fixture");
  await publisher.drain();
  const reader = openSqliteEventStore({ repoId, databasePath, readOnly: true });
  const gitReadback = readCertifiedGitFollower({ rootInput: rootDir, repoId, store: reader });
  reader.close();
  const reconcile = () => reconcileSqliteEvents({ repoId, rootDir, databasePath, snapshotPath, gitReadback });
  const exact = reconcile();
  assert.equal(exact.schema, "sqlite-ledger-reconciliation/v2");
  assert.equal(exact.matches, true, JSON.stringify(exact));
  assert.deepEqual(exact.expected, { events: 3, outcomes: 3, objects: 0 });
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("UPDATE event SET event_json=event_json || ? WHERE revision=2").run(" ");
    assert.equal(reconcile().rowDigestMatches, false);
    db.prepare("UPDATE event SET event_json=? WHERE revision=2").run(serializePersistedCanonicalEvent(events[1]!));
    db.prepare("UPDATE command_outcome SET last_revision=3 WHERE first_revision=2").run();
    assert.equal(reconcile().outcomeMatches, false);
    db.prepare("UPDATE command_outcome SET last_revision=2 WHERE first_revision=2").run();
  } finally {
    db.close();
  }
  const markerPath = `${databasePath}.import-source.json`,
    markerBytes = readFileSync(markerPath, "utf8");
  writeFileSync(markerPath, JSON.stringify({ schema: "generation-import-source/v1", sourceDigest: "wrong" }));
  assert.equal(reconcile().metadataMatches, false);
  writeFileSync(markerPath, markerBytes);
  assert.equal(reconcile().matches, true);
});

test("certified reopen retires stale legacy index entries without changing unrelated staged or worktree bytes", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-sqlite-stale-index-"));
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness/events"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/events/legacy.json"), "legacy event\n");
  git(rootDir, "add", "harness/events/legacy.json");
  git(rootDir, "commit", "-qm", "legacy generation");
  const legacyOid = git(rootDir, "rev-parse", "HEAD:harness/events/legacy.json"),
    databasePath = sqliteLedgerPath(rootDir, 1),
    snapshotPath = path.join(rootDir, ".harness/source.json"),
    events = [eventAt(1)];
  createImmutableLegacyGenerationSnapshot({
    repoId,
    snapshotPath,
    source: { read: () => ({ events }), readContentBlob: () => null } as never,
  });
  convertLegacyGeneration({ rootDir, snapshotPath, databasePath });

  git(rootDir, "update-index", "--add", "--cacheinfo", `100644,${legacyOid},harness/events/legacy.json`);
  mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/context/draft.md"), "staged draft\n");
  git(rootDir, "add", "harness/context/draft.md");
  const draftIndexBefore = git(rootDir, "ls-files", "--stage", "harness/context/draft.md");
  writeFileSync(path.join(rootDir, "harness/context/draft.md"), "worktree draft\n");
  writeFileSync(path.join(rootDir, "harness/.gitattributes"), "* -text\n# worktree edit\n");
  const statusBefore = execFileSync(
    "git",
    ["-C", rootDir, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "harness"],
    { encoding: "utf8" },
  );
  assert.ok(statusBefore.split("\0").includes("AD harness/events/legacy.json"), JSON.stringify(statusBefore));
  assert.ok(statusBefore.split("\0").includes("AM harness/context/draft.md"), JSON.stringify(statusBefore));
  assert.ok(statusBefore.split("\0").includes(" M harness/.gitattributes"), JSON.stringify(statusBefore));

  const reopened = makeTaskEventStore({ repoId, rootDir });
  try {
    await reopened.settlePendingMaterialization?.("repair stale legacy index");
    assert.equal(git(rootDir, "ls-files", "--stage", "harness/events/legacy.json"), "");
    assert.equal(git(rootDir, "ls-files", "--stage", "harness/context/draft.md"), draftIndexBefore);
    assert.equal(readFileSync(path.join(rootDir, "harness/context/draft.md"), "utf8"), "worktree draft\n");
    const statusAfter = execFileSync(
      "git",
      ["-C", rootDir, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "harness"],
      { encoding: "utf8" },
    );
    assert.ok(statusAfter.split("\0").includes("AM harness/context/draft.md"), JSON.stringify(statusAfter));
    assert.ok(statusAfter.split("\0").includes(" M harness/.gitattributes"), JSON.stringify(statusAfter));
  } finally {
    await reopened.drain();
  }
  unlinkSync(path.join(rootDir, "harness/events/segments/manifest.json"));
  git(rootDir, "update-index", "--add", "--cacheinfo", `100644,${legacyOid},harness/events/legacy.json`);
  const withoutPhysicalMarker = makeTaskEventStore({ repoId, rootDir });
  try {
    await withoutPhysicalMarker.settlePendingMaterialization?.("index settles independently of physical recovery");
    assert.equal(withoutPhysicalMarker.followerStatus().git.status, "verified");
    assert.equal(withoutPhysicalMarker.followerStatus().worktree.status, "pending");
    assert.equal(git(rootDir, "ls-files", "--stage", "harness/events/legacy.json"), "");
    assert.equal(git(rootDir, "ls-files", "--stage", "harness/context/draft.md"), draftIndexBefore);
    assert.equal(readFileSync(path.join(rootDir, "harness/context/draft.md"), "utf8"), "worktree draft\n");
  } finally {
    await withoutPhysicalMarker.drain();
  }
});

test("50k bootstrap is incremental and subsequent canonical bundles append one command each", (context) => {
  const store = openSqliteEventStore({ repoId, databasePath: scratch("canonical-cost") }),
    sourceEvents = Array.from({ length: 50_000 }, (_, index) => eventAt(index + 1)),
    bootstrapStarted = performance.now();
  try {
    const bootstrapped = migrateEventsToSqlite({
        store,
        repoId,
        events: sourceEvents,
        holder: fence.holder,
        epoch: fence.epoch,
        verifyExact: false,
      }),
      bootstrapMs = performance.now() - bootstrapStarted,
      incremental = migrateEventsToSqlite({
        store,
        repoId,
        events: sourceEvents,
        holder: fence.holder,
        epoch: fence.epoch,
        verifyExact: false,
      }),
      samplesMs: number[] = [],
      appended: ReturnType<typeof eventAt>[] = [];
    assert.deepEqual(bootstrapped, { migrated: 50_000, revision: 50_000 });
    assert.deepEqual(incremental, { migrated: 0, revision: 50_000 });
    for (let revision = 50_001; revision <= 50_100; revision += 1) {
      const event = eventAt(revision),
        eventBytes = [serializePersistedCanonicalEvent(event)],
        started = performance.now();
      store.appendCommand({
        fence,
        intent: {
          opId: event.opId,
          intentDigest: `sha256:${sha256Text(JSON.stringify(eventBytes))}`,
          summary: event.type,
        },
        events: [event],
      });
      samplesMs.push(performance.now() - started);
      appended.push(event);
    }
    samplesMs.sort((left, right) => left - right);
    const p50Ms = percentile(samplesMs, 0.5),
      p99Ms = percentile(samplesMs, 0.99),
      afterAppends = migrateEventsToSqlite({
        store,
        repoId,
        events: [...sourceEvents, ...appended],
        holder: fence.holder,
        epoch: fence.epoch,
        verifyExact: false,
      });
    // Each shadow bundle advances the store by exactly its own events and never re-imports the
    // history; the timings are reported, not asserted (CI runners have no wall-clock budget).
    assert.equal(store.revision(), 50_100);
    assert.deepEqual(afterAppends, { migrated: 0, revision: 50_100 });
    context.diagnostic(JSON.stringify({ sourceEvents: sourceEvents.length, bootstrapMs, p50Ms, p99Ms }));
  } finally {
    store.close();
  }
});

function command(_store: SqliteEventStore, revision: number, opId = eventAt(revision).opId) {
  const event = { ...eventAt(revision), opId };
  return { fence, intent: intentFor(event), events: [event] } as const;
}

function intent(revision: number): SqliteCommandIntent {
  return intentFor(eventAt(revision));
}

function intentFor(event: ReturnType<typeof eventAt>): SqliteCommandIntent {
  return {
    opId: event.opId,
    intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
    summary: event.type,
  };
}

function scratch(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `ha-sqlite-${name}-`)), "ledger.sqlite");
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.ceil(sorted.length * quantile) - 1]!;
}
