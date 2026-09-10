// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
} from "../../../packages/kernel/src/domain/doc-sync.contract.ts";
import { freezeDeclaredWritePlan } from "../../../packages/kernel/src/domain/write-chain.contract.ts";
import { sha256Text } from "../../../packages/kernel/src/integrity/stable-hash.ts";
import { contentObjectRelativePath } from "../../../packages/kernel/src/layout/ledger-object-layout.ts";
import { makeTaskProjection } from "../../../packages/kernel/src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../../packages/kernel/src/store/task-event-store.ts";
import { TaskLifecycleContractError } from "../../../packages/kernel/src/domain/task-lifecycle.contract.ts";
import { addWriteTarget } from "../../../packages/kernel/src/domain/task-write-decision.ts";
import { lifecycleHarness } from "../../../packages/application/test/task-lifecycle-test-harness.ts";
import { assertWriteTargetDeclared } from "../../../packages/application/src/task-lifecycle-service.ts";
import { removeTemporaryDirectory } from "../../temporary-directory-cleanup.mjs";

test("G29 compares every published byte change outside the canonical store files with the frozen plan declaration", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    const started = await harness.start("execution-1");
    assert.deepEqual(
      started.frozenPlan.targets.filter((target) => target.kind === "lease_sqlite"),
      [
        { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "reserve" },
        { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "activate" },
        { kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "release" },
      ],
    );
    const artifact = path.join(harness.rootDir, "harness/tasks/task-1/existing.bin");
    const sentinel = path.join(harness.rootDir, "harness/unrelated.bin");
    mkdirSync(path.dirname(artifact), { recursive: true });
    writeFileSync(artifact, Buffer.from([9, 8, 7, 6]));
    writeFileSync(sentinel, Buffer.from([0, 1, 2, 255]));
    await harness.eventStore.settlePendingMaterialization();

    const before = snapshotTree(harness.rootDir);
    const receipt = await harness.submit("execution-1");
    await harness.eventStore.settlePendingMaterialization();
    assert.equal(receipt.outcome, "applied");
    assertChangedPathsDeclared(before, snapshotTree(harness.rootDir), receipt.frozenPlan);
    assert.deepEqual(
      receipt.frozenPlan.targets.filter((target) => target.kind === "lease_sqlite"),
      [{ kind: "lease_sqlite", table: "lease_cas", taskId: "task-1", operation: "release" }],
    );
    assert.deepEqual(readFileSync(artifact), Buffer.from([9, 8, 7, 6]));
    assert.deepEqual(readFileSync(sentinel), Buffer.from([0, 1, 2, 255]));
    assert.throws(
      () =>
        addWriteTarget(receipt.frozenPlan, {
          kind: "content_blob",
          sha256: "a".repeat(64),
          size: 4,
          mediaType: "application/octet-stream",
        }),
      (error) => error instanceof TaskLifecycleContractError && error.code === "frozen_write_plan",
    );
  } finally {
    await harness.cleanup();
  }
});

test("G29 rejects an undeclared write outside the frozen plan", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.eventStore.settlePendingMaterialization();
    const before = snapshotTree(harness.rootDir);
    const receipt = await harness.submit("execution-1");
    await harness.eventStore.settlePendingMaterialization();
    assert.throws(
      () =>
        assertWriteTargetDeclared(receipt.frozenPlan, {
          kind: "content_blob",
          sha256: "b".repeat(64),
          size: 4,
          mediaType: "application/octet-stream",
        }),
      /undeclared_write_target/u,
    );
    const injected = path.join(harness.rootDir, "harness/undeclared-side-effect.bin");
    mkdirSync(path.dirname(injected), { recursive: true });
    writeFileSync(injected, Buffer.from([4, 3, 2, 1]));
    assert.throws(
      () => assertChangedPathsDeclared(before, snapshotTree(harness.rootDir), receipt.frozenPlan),
      /G29 undeclared byte mutation.*harness\/undeclared-side-effect\.bin/iu,
    );
  } finally {
    await harness.cleanup();
  }
});

test("G29 treats a declared SQLite database as its main file plus -wal and -shm, nothing wider", () => {
  const plan = Object.freeze({
    commandType: "LeaseTest",
    targets: Object.freeze([Object.freeze({ kind: "lease_sqlite" })]),
  });
  const sidecars = new Map([
    [".harness/cache/task.sqlite", "main"],
    [".harness/cache/task.sqlite-wal", "wal"],
    [".harness/cache/task.sqlite-shm", "shm"],
  ]);
  assert.doesNotThrow(() => assertChangedPathsDeclared(new Map(), sidecars, plan));
  const widened = new Map([...sidecars, [".harness/cache/task.sqlite.backup", "copy"]]);
  assert.throws(
    () => assertChangedPathsDeclared(new Map(), widened, plan),
    (error) =>
      /G29 undeclared byte mutation: \.harness\/cache\/task\.sqlite\.backup$/u.test(error.message) &&
      !/sqlite-wal|sqlite-shm/u.test(error.message),
  );
});

test("G29 doc publication rejects extra, missing, and late targets before Git or SQLite mutation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g29-doc-"));
  let store, projection;
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "G29");
    git(rootDir, "config", "user.email", "g29@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    store = makeTaskEventStore({ repoId: "test-repo", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    const body = "# Notes\n",
      hash = sha256Text(body),
      base = store.currentCut(),
      baseCommit = store.currentCommit();
    const event = {
      schema: "doc-event/v1",
      eventId: "doc-event",
      workspaceRevision: 1,
      opId: "doc-op",
      type: "documents_written",
      actor: { principal: { personId: "person-1" }, executor: null },
      source: "local",
      occurredAt: "2026-08-12T00:00:00.000Z",
      payload: {
        executionId: "execution-1",
        baseLedgerSha: base,
        changes: [
          {
            path: "context/notes.md",
            baseBlobSha256: null,
            candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" },
            policyId: DOC_POLICY_ID,
            regionProofs: [
              {
                regionId: "heading/notes",
                policyId: DOC_POLICY_ID,
                codecId: DOC_CODEC_ID,
                baseSha256: sha256Text(""),
                candidateSha256: hash,
                insertBytes: Buffer.byteLength(body),
              },
            ],
          },
        ],
      },
    };
    const blob = { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body },
      plan = docSyncWritePlan(event),
      baseTargets = plan.targets,
      extra = freezeDeclaredWritePlan(
        {
          commandType: "DocSyncSubmit",
          targets: [...baseTargets, { kind: "content_blob", sha256: "f".repeat(64), size: 1, mediaType: "text/plain" }],
        },
        ["DocSyncSubmit"],
      ),
      missing = freezeDeclaredWritePlan(
        { commandType: "DocSyncSubmit", targets: baseTargets.filter((target) => target.kind !== "content_blob") },
        ["DocSyncSubmit"],
      );
    for (const invalid of [extra, missing]) {
      assert.throws(() => store.append({ event, plan: invalid, blobs: [blob] }), /write plan/iu);
      assert.deepEqual(store.currentCommit(), baseCommit);
      assert.deepEqual(store.currentCut(), base);
    }
    assert.throws(() => plan.targets.push(extra.targets.at(-1)));
    assert.deepEqual(store.currentCommit(), baseCommit);
    assert.deepEqual(store.currentCut(), base);
    const receipt = store.append({ event, plan, blobs: [blob] });
    assert.deepEqual(projection.apply(event, plan).metrics, { sqliteTransactions: 1, reducedItems: 1 });
    assert.deepEqual(receipt.metrics.changedPaths, []); // Acceptance performs no Git publication.
    await store.settlePendingMaterialization();
    assert.equal(store.followerStatus().git.status, "verified");
    assert.deepEqual(git(rootDir, "diff", "--name-only", baseCommit.sha, "HEAD").split("\n"), [
      "harness/context/notes.md",
      "harness/events/segments/manifest.json",
    ]);
    assert.equal(git(rootDir, "show", "HEAD:harness/context/notes.md"), body.trim());
    assert.equal(projection.readDocument("context/notes.md").document?.blobSha256, hash);
    await store.drain();
  } finally {
    projection?.close();
    await store?.drain();
    await removeTemporaryDirectory(rootDir, { retryDelayMs: 20 });
  }
});

function snapshotTree(rootDir) {
  const snapshot = new Map();
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      if (name === ".git") continue;
      const absolute = path.join(directory, name);
      if (statSync(absolute).isDirectory()) visit(absolute);
      else
        snapshot.set(
          path.relative(rootDir, absolute).split(path.sep).join("/"),
          readFileSync(absolute).toString("base64"),
        );
    }
  };
  visit(rootDir);
  return snapshot;
}

function assertChangedPathsDeclared(before, after, plan) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const changed = [...paths].filter((filePath) => before.get(filePath) !== after.get(filePath));
  const declared = declaredMatchers(plan);
  const undeclared = changed.filter((filePath) => !declared.some((matches) => matches(filePath)));
  if (undeclared.length > 0) throw new Error(`G29 undeclared byte mutation: ${undeclared.join(", ")}`);
}

/** WAL-mode SQLite keeps one logical database in three files; exact suffixes, never a glob. */
function SQLITE_DATABASE_FOOTPRINT(mainFile) {
  return [mainFile, `${mainFile}-wal`, `${mainFile}-shm`];
}

/** Every accepted command appends to the canonical store; its physical files are not plan targets. */
const STORE_FOOTPRINT = [
  ...SQLITE_DATABASE_FOOTPRINT(".harness/store/generations/2/ledger.sqlite"),
  "harness/events/segments/manifest.json",
];

function declaredMatchers(plan) {
  return [
    ...STORE_FOOTPRINT.map(exact),
    ...plan.targets.flatMap((target) => {
      if (target.kind === "event_file" || target.kind === "event_head") return [exact(target.path)];
      if (target.kind === "authored_file") return [exact(`harness/${target.path}`)];
      if (target.kind === "projection_invalidation" || target.kind === "lease_sqlite")
        return SQLITE_DATABASE_FOOTPRINT(".harness/cache/task.sqlite").map(exact);
      if (target.kind !== "content_blob") return [];
      const { sha256 } = target;
      return [
        exact(`harness/${contentObjectRelativePath(sha256)}`),
        exact(`.harness/store/generations/2/objects/sha256/${sha256.slice(0, 2)}/${sha256.slice(2)}`),
      ];
    }),
  ];
}

function exact(expected) {
  return (actual) => actual === expected;
}
function git(rootDir, ...args) {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
