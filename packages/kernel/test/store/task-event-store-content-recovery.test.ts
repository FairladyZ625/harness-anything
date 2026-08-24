// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  type DocEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import {
  compileDecisionWrite,
  decisionWritePlan,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
} from "../../src/domain/decision-event.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  serializeTaskEvent,
  type TaskCreatedEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import {
  freezeDeclaredWritePlan,
  serializeEventHead,
} from "../../src/domain/write-chain.contract.ts";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "../../src/domain/migration-import-event.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  contentObjectRelativePath,
  eventObjectRelativePath,
} from "../../src/layout/ledger-object-layout.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import {
  CANONICAL_EVENT_REF,
  makeTaskEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

import {
  bundle,
  decisionProposal,
  docBundle,
  event,
  eventAt,
  flatLedgerFixture,
  git,
  incrementalObjectBytes,
  initRepo,
  median,
  mixedLedgerFixture,
  repoFileBundle,
  repoLinkBundle,
  snapshot,
} from "./task-event-store.fixtures.ts";
test("a reachable content blob is validated before reuse", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const body = "# Valid\n",
      hash = sha256Text(body),
      objectPath = path.join(
        rootDir,
        "harness",
        contentObjectRelativePath(hash),
      );
    mkdirSync(path.dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, "corrupt\n");
    git(rootDir, "add", "harness/objects");
    git(rootDir, "commit", "-qm", "corrupt fixture");
    const store = makeTaskEventStore({ repoId: "blob-corrupt", rootDir });
    assert.throws(
      () =>
        store.append(
          docBundle(store, body, 1, "blob-corrupt", "context/corrupt.md"),
        ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_store");
        return /content blob.*corrupt/u.test(String(error));
      },
    );
  });
});

test("a committed symbolic link is replaced without a hidden conflict copy", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const directory = path.join(rootDir, "harness/context"),
      target = path.join(directory, "latest.md");
    mkdirSync(directory, { recursive: true });
    symlinkSync("old.md", target);
    git(rootDir, "add", "harness/context/latest.md");
    git(rootDir, "commit", "-qm", "committed link");
    const store = makeTaskEventStore({ repoId: "symlink-store", rootDir });
    store.append(repoLinkBundle("context/latest.md", "new.md"));
    assert.equal(readlinkSync(target), "new.md");
    assert.equal(
      readdirSync(directory).some((name) => name.includes(".conflict-")),
      false,
    );
  });
});

test("a symbolic link changed after its parent commit still gets a conflict copy", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const directory = path.join(rootDir, "harness/context"),
      target = path.join(directory, "latest.md");
    mkdirSync(directory, { recursive: true });
    symlinkSync("old.md", target);
    git(rootDir, "add", "harness/context/latest.md");
    git(rootDir, "commit", "-qm", "committed link");
    unlinkSync(target);
    symlinkSync("local-edit.md", target);
    const store = makeTaskEventStore({
      repoId: "symlink-conflict-store",
      rootDir,
    });
    store.append(repoLinkBundle("context/latest.md", "new.md"));
    const conflict = readdirSync(directory).find((name) =>
      name.includes(".conflict-"),
    );
    assert.equal(readlinkSync(target), "new.md");
    assert.ok(conflict);
    assert.equal(readlinkSync(path.join(directory, conflict)), "local-edit.md");
  });
});

test("an authorized migration replacement rejects a destination that changed after classification", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const directory = path.join(rootDir, "harness/context"),
      target = path.join(directory, "notes.md"),
      expected = "# Initialized\n",
      changed = "# Edited after dry-run\n";
    mkdirSync(directory, { recursive: true });
    writeFileSync(target, expected);
    git(rootDir, "add", "harness/context/notes.md");
    git(rootDir, "commit", "-qm", "initialized document");
    const store = makeTaskEventStore({ repoId: "preimage-store", rootDir });
    writeFileSync(target, changed);
    assert.throws(
      () =>
        store.append(
          repoFileBundle("context/notes.md", "# Legacy\n", expected),
        ),
      /destination changed.*dry-run/iu,
    );
    assert.equal(store.read().revision, 0);
    assert.equal(readFileSync(target, "utf8"), changed);
    assert.equal(
      readdirSync(directory).some((name) => name.includes(".conflict-")),
      false,
    );
    assert.equal(
      git(
        rootDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/ha-event-prepared/",
      ),
      "",
    );
  });
});

test("recovery rechecks the durable destination preimage instead of creating a hidden backup", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const directory = path.join(rootDir, "harness/context"),
      target = path.join(directory, "notes.md"),
      expected = "# Initialized\n",
      changed = "# Edited after preparation\n";
    mkdirSync(directory, { recursive: true });
    writeFileSync(target, expected);
    git(rootDir, "add", "harness/context/notes.md");
    git(rootDir, "commit", "-qm", "initialized document");
    const interrupted = makeTaskEventStore({
      repoId: "preimage-recovery",
      rootDir,
      killpoint: (point) => {
        if (point === "after_head_write") throw new Error("crash");
      },
    });
    assert.throws(
      () =>
        interrupted.append(
          repoFileBundle("context/notes.md", "# Legacy\n", expected),
        ),
      /crash/u,
    );
    writeFileSync(target, changed);
    const recovered = makeTaskEventStore({
      repoId: "preimage-recovery",
      rootDir,
    }).recover();
    assert.equal(recovered.status, "indeterminate");
    assert.equal(readFileSync(target, "utf8"), changed);
    assert.equal(
      readdirSync(directory).some((name) => name.includes(".conflict-")),
      false,
    );
    assert.equal(
      git(rootDir, "rev-parse", CANONICAL_EVENT_REF),
      git(rootDir, "rev-parse", "HEAD"),
    );
  });
});

test("recovery accepts the authorized result after refs and worktree replacement completed", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const directory = path.join(rootDir, "harness/context"),
      target = path.join(directory, "notes.md"),
      expected = "# Initialized\n",
      migrated = "# Legacy\n";
    mkdirSync(directory, { recursive: true });
    writeFileSync(target, expected);
    git(rootDir, "add", "harness/context/notes.md");
    git(rootDir, "commit", "-qm", "initialized document");
    const interrupted = makeTaskEventStore({
      repoId: "preimage-published-recovery",
      rootDir,
      killpoint: (point) => {
        if (point === "after_worktree_rename") throw new Error("crash");
      },
    });
    assert.throws(
      () =>
        interrupted.append(
          repoFileBundle("context/notes.md", migrated, expected),
        ),
      /crash/u,
    );
    const recovered = makeTaskEventStore({
      repoId: "preimage-published-recovery",
      rootDir,
    }).recover();
    assert.equal(recovered.status, "already_committed");
    assert.equal(readFileSync(target, "utf8"), migrated);
    assert.equal(
      readdirSync(directory).some((name) => name.includes(".conflict-")),
      false,
    );
    assert.equal(
      git(
        rootDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/ha-event-prepared/",
      ),
      "",
    );
  });
});
