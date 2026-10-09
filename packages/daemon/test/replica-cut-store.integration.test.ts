// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import {
  decideDocWrite,
  READ_MODEL_SCHEMA_GENERATION,
  stableStringify,
  makeTaskProjection,
  DOC_POLICY_ID,
  parseDocWriteIntent,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  serializeEventHead,
  sha256Bytes,
  sha256Text,
  type DocEventV1,
  type ReplicaProjectionBasis,
  type EdgeReadModelRows,
  artifactEntityContractSnapshot,
  canonicalSourceIdentity,
  compileVerticalContract,
  deriveArtifactContentVersion,
  mintArtifactEntityId,
  ARTIFACT_ENTITY_ID_BYTES,
  artifactObservationId,
  artifactImportOperationId,
  type EntityStoreKindContract,
  compileEntityUpsert,
  compileEntityDeleted,
  compileEntityContentObserved,
  compileEntityUpdated,
  compileScheduleDefinitionEvent,
  createScheduleV1,
  compileFactWrite,
  compileFactArchiveWrite,
  type FactEventDraftV1,
  artifactMutationOperationId,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
import { compileScheduleDeletedEvent } from "@harness-anything/kernel/internal/domain/schedule-event";
import { registerBootstrappedDaemonRepo as registerDaemonRepo } from "./repo-settings.fixture.ts";

test("activation bootstraps one repo cut from the exact L2 manifest and reads content from L1 CAS", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-cut-"));
  try {
    const body = Buffer.from("# Replica\n"),
      blobSha256 = sha256Bytes(body),
      event = lifecycleFixture().events[0]!,
      basis: ReplicaProjectionBasis = {
        watermark: 1,
        sourceRevision: 1,
        headEvent: event,
        events: [],
        documents: [
          {
            path: "context/replica.md",
            blobSha256,
            size: body.byteLength,
            mediaType: "text/markdown",
          },
        ],
      };
    const source = openReplicaCutSource({
      repoId: "repo-one",
      localRoot: root,
      readBasis: () => basis,
      readContentBlob: (sha256) => (sha256 === blobSha256 ? body : null),
    });
    const cut = source.activate();
    assert.deepEqual(cut, {
      repoId: "repo-one",
      revision: 1,
      headDigest: `sha256:${sha256Text(serializeEventHead({ revision: 1, opId: event.opId, eventDigest: `sha256:${sha256Text(serializeCanonicalEvent(event))}` }))}`,
      manifest: {
        digest: cut?.manifest.digest,
        entryCount: 1,
        totalBytes: body.byteLength,
      },
    });
    assert.deepEqual(source.manifest(1), [
      {
        path: "context/replica.md",
        blob: {
          sha256: blobSha256,
          size: body.byteLength,
          mediaType: "text/markdown",
        },
      },
    ]);
    assert.deepEqual(
      source.content({
        sha256: blobSha256,
        size: body.byteLength,
        mediaType: "text/markdown",
      }),
      body,
    );
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a cut requires its complete read model and a published cut is immutable on reopen", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-read-model-existing-"));
  try {
    const event = lifecycleFixture().events[0]!;
    const basis: ReplicaProjectionBasis = {
      watermark: 1,
      sourceRevision: 1,
      headEvent: event,
      events: [],
      documents: [],
    };
    const open = (
      model: {
        readonly sourceRevision: number;
        readonly rootThreshold: number;
        readonly rows: EdgeReadModelRows;
      } | null,
    ) =>
      openReplicaCutSource({
        repoId: "repo-existing-read-model",
        localRoot: root,
        readBasis: () => basis,
        readContentBlob: () => null,
        readEdgeReadModel: (read) => read(model),
      });
    const source = open(null);
    assert.throws(() => source.activate(), /Read model is unavailable/u);
    assert.equal(source.latest(), null);
    source.close();
    const model = {
      sourceRevision: 1,
      rootThreshold: 0,
      rows: {
        tasks: [],
        taskGeneration: [],
        taskProgress: [],
        entities: [],
        leases: [],
        relations: [],
        decisions: [],
        facts: [],
        presetSnapshots: [],
        repository: [],
      },
    };
    let passes = 0;
    const broken = open({
      ...model,
      rows: {
        ...model.rows,
        repository: {
          *[Symbol.iterator]() {
            if (++passes === 1) return;
            yield {
              table: "pinned_entities" as const,
              values: { entity_ref: "task/one", pinned_at: "now", pinned_by: "owner" },
            };
            throw new Error("row serialization failed");
          },
        },
      },
    });
    assert.throws(() => broken.activate(), /row serialization failed/u);
    assert.equal(broken.latest(), null);
    broken.close();
    const store = new DatabaseSync(
      path.join(
        root,
        "replica/repos/repo-existing-read-model",
        `g${READ_MODEL_SCHEMA_GENERATION}`,
        "checkpoints.sqlite",
      ),
    );
    try {
      assert.equal(
        store.prepare("SELECT count(*) AS n FROM read_model_blob").get()?.n,
        0,
        "failed cut rolls back already serialized row blobs along with its metadata",
      );
    } finally {
      store.close();
    }
    const reopened = open(model);
    assert.deepEqual(reopened.activate()?.manifest.entryCount, 1);
    assert.deepEqual(
      reopened.manifest(1)?.map((entry) => entry.path),
      [".read-model/meta.json"],
    );
    const published = reopened.latest();
    reopened.close();
    const again = open({ ...model, rootThreshold: 99 });
    assert.deepEqual(again.activate(), published, "local model changes never replace an accepted revision's manifest");
    const meta = again.manifest(1)![0]!;
    assert.equal(JSON.parse(Buffer.from(again.content(meta.blob)).toString("utf8")).rootThreshold, 0);
    again.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("activation publishes no cut until the L2 watermark exactly matches the L1 source revision", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-exact-"));
  try {
    const [first, second] = lifecycleFixture().events,
      basis: { value: ReplicaProjectionBasis } = {
        value: {
          watermark: 1,
          sourceRevision: 2,
          headEvent: first!,
          events: [],
          documents: [],
        },
      },
      source = openReplicaCutSource({
        repoId: "repo-exact",
        localRoot: root,
        readBasis: () => basis.value,
        readContentBlob: () => null,
      });
    assert.equal(source.activate(), null);
    assert.equal(source.latest(), null);
    basis.value = {
      watermark: 2,
      sourceRevision: 2,
      headEvent: second!,
      events: [],
      documents: [],
    };
    assert.equal(source.activate()?.revision, 2);
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("first activation at revision 10,000 reads only the current L2 basis and does not backfill history", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-bootstrap-"));
  try {
    const original = lifecycleFixture().events[0]!,
      event = {
        ...original,
        opId: "op-current-10000",
        eventId: "event-current-10000",
        workspaceRevision: 10_000,
        occurredAt: "2026-08-14T10:00:00.000Z",
      },
      calls: Array<number | null> = [],
      basis: ReplicaProjectionBasis = {
        watermark: 10_000,
        sourceRevision: 10_000,
        headEvent: event,
        events: [],
        documents: [],
      },
      source = openReplicaCutSource({
        repoId: "repo-bootstrap",
        localRoot: root,
        readBasis: (after) => {
          calls.push(after);
          if (after !== null) throw new Error("activation scanned history");
          return basis;
        },
        readContentBlob: () => null,
      });
    assert.equal(source.activate()?.revision, 10_000);
    assert.deepEqual(calls, [null]);
    assert.deepEqual(source.changeLog(), []);
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an activated source persists zero-change revisions as exact cuts with an empty changelog", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-zero-"));
  try {
    const [first, second] = lifecycleFixture().events,
      body = Buffer.from("same"),
      blobSha256 = sha256Bytes(body),
      documents = [
        {
          path: "context/same.md",
          blobSha256,
          size: body.byteLength,
          mediaType: "text/plain",
        },
      ],
      basis: { value: ReplicaProjectionBasis } = {
        value: {
          watermark: 1,
          sourceRevision: 1,
          headEvent: first!,
          events: [],
          documents,
        },
      };
    const source = openReplicaCutSource({
      repoId: "repo-zero",
      localRoot: root,
      readBasis: (after) =>
        after === null
          ? basis.value
          : {
              ...basis.value,
              events: basis.value.events.filter((event) => event.workspaceRevision > after),
            },
      readContentBlob: () => body,
    });
    const one = source.activate()!;
    basis.value = {
      watermark: 2,
      sourceRevision: 2,
      headEvent: second!,
      events: [second!],
      documents,
    };
    source.kick();
    const two = await source.waitForCut(2);
    assert.equal(two.revision, 2);
    assert.equal(two.manifest.digest, one.manifest.digest);
    assert.notEqual(two.headDigest, one.headDigest);
    assert.deepEqual(source.changeLog(), []);
    const stored = new DatabaseSync(
      path.join(root, "replica/repos/repo-zero", `g${READ_MODEL_SCHEMA_GENERATION}`, "checkpoints.sqlite"),
    );
    try {
      assert.equal(stored.prepare("SELECT count(DISTINCT manifest_digest) AS n FROM manifest_entry").get()?.n, 1);
    } finally {
      stored.close();
    }
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active cut pump publishes the fixed snapshot endpoint without intermediate cuts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-round-"));
  try {
    const first = lifecycleFixture().events[0]!,
      itemPath = "context/round.txt",
      one = Buffer.from("one"),
      two = Buffer.from("two"),
      three = Buffer.from("three"),
      four = Buffer.from("four"),
      events = [docEvent(2, itemPath, one, two), docEvent(3, itemPath, two, three), docEvent(4, itemPath, three, four)],
      initial: ReplicaProjectionBasis = {
        watermark: 1,
        sourceRevision: 1,
        headEvent: first,
        events: [],
        documents: [
          {
            path: itemPath,
            blobSha256: sha256Bytes(one),
            size: one.byteLength,
            mediaType: "text/plain",
          },
        ],
      },
      current: ReplicaProjectionBasis = {
        watermark: 4,
        sourceRevision: 4,
        headEvent: events.at(-1)!,
        events,
        documents: [
          {
            path: itemPath,
            blobSha256: sha256Bytes(four),
            size: four.byteLength,
            mediaType: "text/plain",
          },
        ],
      },
      afters: Array<number | null> = [],
      source = openReplicaCutSource({
        repoId: "repo-round",
        localRoot: root,
        readBasis: (after) => {
          afters.push(after);
          return after === null
            ? initial
            : {
                ...current,
                events: current.events.filter((event) => event.workspaceRevision > after),
              };
        },
        readContentBlob: () => null,
      });
    source.activate();
    source.kick();
    await source.waitForCut(4);
    assert.deepEqual(afters, [null, 1]);
    assert.equal(source.cut(2), null);
    assert.equal(source.cut(3), null);
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("document revisions persist only adjacent path/blob changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-change-"));
  try {
    const first = lifecycleFixture().events[0]!,
      oldBody = Buffer.from("old"),
      newBody = Buffer.from("new"),
      oldSha = sha256Bytes(oldBody),
      newSha = sha256Bytes(newBody),
      itemPath = "context/change.md",
      event = docEvent(2, itemPath, oldBody, newBody),
      basis: { value: ReplicaProjectionBasis } = {
        value: {
          watermark: 1,
          sourceRevision: 1,
          headEvent: first,
          events: [],
          documents: [
            {
              path: itemPath,
              blobSha256: oldSha,
              size: oldBody.byteLength,
              mediaType: "text/plain",
            },
          ],
        },
      };
    const source = openReplicaCutSource({
      repoId: "repo-change",
      localRoot: root,
      readBasis: (after) =>
        after === null
          ? basis.value
          : {
              ...basis.value,
              events: basis.value.events.filter((candidate) => candidate.workspaceRevision > after),
            },
      readContentBlob: (sha256) => (sha256 === oldSha ? oldBody : sha256 === newSha ? newBody : null),
    });
    source.activate();
    basis.value = {
      watermark: 2,
      sourceRevision: 2,
      headEvent: event,
      events: [event],
      documents: [
        {
          path: itemPath,
          blobSha256: newSha,
          size: newBody.byteLength,
          mediaType: "text/plain",
        },
      ],
    };
    source.kick();
    await source.waitForCut(2);
    const change = {
      op: "put" as const,
      path: itemPath,
      blob: {
        sha256: newSha,
        size: newBody.byteLength,
        mediaType: "text/plain",
      },
    };
    assert.deepEqual(source.changeLog(), [{ fromRevision: 1, toRevision: 2, change }]);
    assert.deepEqual(source.changes(1, 2), [change]);
    assert.deepEqual(source.manifest(2), [{ path: itemPath, blob: change.blob }]);
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention keeps exactly 64 cuts and 63 adjacent changelogs per repo", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-retention-"));
  let derived: DatabaseSync | undefined;
  try {
    const first = lifecycleFixture().events[0]!,
      itemPath = "context/retained.txt",
      initial = Buffer.from("revision-1"),
      blobs = new Map([[sha256Bytes(initial), initial]]),
      basis: { value: ReplicaProjectionBasis } = {
        value: {
          watermark: 1,
          sourceRevision: 1,
          headEvent: first,
          events: [],
          documents: [
            {
              path: itemPath,
              blobSha256: sha256Bytes(initial),
              size: initial.byteLength,
              mediaType: "text/plain",
            },
          ],
        },
      };
    const source = openReplicaCutSource({
      repoId: "repo-retention",
      localRoot: root,
      readBasis: (after) =>
        after === null
          ? basis.value
          : {
              ...basis.value,
              events: basis.value.events.filter((event) => event.workspaceRevision > after),
            },
      readContentBlob: (sha256) => blobs.get(sha256) ?? null,
    });
    const firstCut = source.activate()!;
    const currentRoot = path.join(root, "replica/repos/repo-retention", `g${READ_MODEL_SCHEMA_GENERATION}`);
    const historicalRoot = path.join(root, "replica/repos/repo-retention", `g${READ_MODEL_SCHEMA_GENERATION - 1}`);
    const historicalManifest = path.join(
      historicalRoot,
      "manifests/sha256",
      firstCut.manifest.digest.slice(0, 2),
      firstCut.manifest.digest,
    );
    mkdirSync(path.dirname(historicalManifest), { recursive: true });
    const manifestBytes = Buffer.from(stableStringify(source.manifest(firstCut.revision)));
    writeFileSync(historicalManifest, manifestBytes);
    const historicalBlob = path.join(
      historicalRoot,
      "read-model-blobs",
      sha256Bytes(Buffer.from("historical derived bytes")),
    );
    mkdirSync(path.dirname(historicalBlob), { recursive: true });
    writeFileSync(historicalBlob, "historical derived bytes");
    const currentOrphan = sha256Bytes(Buffer.from("historical derived bytes"));
    derived = new DatabaseSync(path.join(currentRoot, "checkpoints.sqlite"));
    derived
      .prepare("INSERT INTO read_model_blob VALUES (?, ?)")
      .run(currentOrphan, Buffer.from("historical derived bytes"));
    let previous = initial;
    for (let revision = 2; revision <= 66; revision += 1) {
      const body = Buffer.from(`revision-${revision}`),
        event = docEvent(revision, itemPath, previous, body),
        sha256 = sha256Bytes(body);
      blobs.set(sha256, body);
      basis.value = {
        watermark: revision,
        sourceRevision: revision,
        headEvent: event,
        events: [event],
        documents: [
          {
            path: itemPath,
            blobSha256: sha256,
            size: body.byteLength,
            mediaType: "text/plain",
          },
        ],
      };
      source.kick();
      await source.waitForCut(revision);
      previous = body;
    }
    assert.equal(source.manifest(2), null);
    assert.equal(source.changeLog().length, 63);
    assert.equal(source.changeLog()[0]?.fromRevision, 3);
    assert.equal(source.changeLog().at(-1)?.toRevision, 66);
    assert.equal(source.changes(2, 66), null);
    assert.equal(source.changes(3, 66)?.length, 1);
    assert.deepEqual(
      readFileSync(historicalManifest),
      manifestBytes,
      "current pruning cannot unlink another generation's manifest",
    );
    assert.equal(readFileSync(historicalBlob, "utf8"), "historical derived bytes");
    assert.equal(
      derived.prepare("SELECT 1 FROM read_model_blob WHERE sha256 = ?").get(currentOrphan),
      undefined,
      "current-generation orphan collection still runs",
    );
    source.close();
  } finally {
    derived?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manifest that drifts from the exact L2 basis cannot publish a cut", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-drift-"));
  try {
    const first = lifecycleFixture().events[0]!,
      itemPath = "context/drift.txt",
      oldBody = Buffer.from("old"),
      newBody = Buffer.from("new"),
      oldSha = sha256Bytes(oldBody),
      event = docEvent(2, itemPath, oldBody, newBody),
      basis: { value: ReplicaProjectionBasis } = {
        value: {
          watermark: 1,
          sourceRevision: 1,
          headEvent: first,
          events: [],
          documents: [
            {
              path: itemPath,
              blobSha256: oldSha,
              size: oldBody.byteLength,
              mediaType: "text/plain",
            },
          ],
        },
      },
      source = openReplicaCutSource({
        repoId: "repo-drift",
        localRoot: root,
        readBasis: (after) =>
          after === null
            ? basis.value
            : {
                ...basis.value,
                events: basis.value.events.filter((candidate) => candidate.workspaceRevision > after),
              },
        readContentBlob: () => oldBody,
      });
    source.activate();
    basis.value = {
      watermark: 2,
      sourceRevision: 2,
      headEvent: event,
      events: [event],
      documents: [
        {
          path: itemPath,
          blobSha256: oldSha,
          size: oldBody.byteLength,
          mediaType: "text/plain",
        },
      ],
    };
    source.kick();
    await assert.rejects(source.waitForCut(2), /manifest drift/u);
    assert.equal(source.latest()?.revision, 1);
    assert.deepEqual(source.changeLog(), []);
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RepoCell wakes a pending replica cut when its projection catches up", { timeout: 15_000 }, async (t) => {
  t.diagnostic("stage: setup");
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-cell-")),
    repo = path.join(root, "repo"),
    userRoot = path.join(root, "user");
  mkdirSync(path.join(repo, "harness"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Replica Test");
  git(repo, "config", "user.email", "replica@example.invalid");
  writeFileSync(
    path.join(repo, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: replica-repo\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(repo, "add", "harness");
  git(repo, "commit", "-qm", "base");
  registerDaemonRepo({
    canonicalRoot: repo,
    repoId: "replica-repo",
    userRoot,
    createConvenienceLinks: false,
  });
  let armed = false;
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  t.diagnostic("stage: opening host");
  const host = await openDaemonHost({
      daemonId: "replica-test",
      userRoot,
      openCell: (input) =>
        openRepoCell({
          ...input,
          killpoint: async (point) => {
            if (armed && point === "after_sqlite_commit") {
              armed = false;
              reached.resolve();
              await release.promise;
            }
          },
        }),
    }),
    owners = await fleetNodeOwners({ userRoot, owners: { "node-one": "person-one" }, repoIds: ["replica-repo"] }),
    auth = owners.auth({ nodeId: "node-one" });
  await host.attachmentsSettled();
  t.diagnostic("stage: attachments settled");
  try {
    const first = await host.run("replica-repo", { kind: "task-create", taskId: "task-one", title: "One" }, auth);
    t.diagnostic("stage: first write accepted");
    assert.equal(first.outcome, "applied");
    const replica = host.replica("replica-repo"),
      bootstrap = (await replica.prepare())!;
    assert.equal(bootstrap.revision, first.revision);
    t.signal.addEventListener("abort", () => replica.close(), { once: true });
    armed = true;
    const writing = host.run("replica-repo", { kind: "task-create", taskId: "task-two", title: "Two" }, auth);
    t.diagnostic("stage: waiting for commit killpoint");
    await reached.promise;
    t.diagnostic("stage: killpoint reached");
    const target = replica.ledgerCut()!.revision;
    const waiting = replica.waitForCut(target);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    const second = await writing;
    t.diagnostic("stage: second write accepted");
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The writer completion notification must wake the host replica without another request.
    t.diagnostic("stage: waiting for projection wake");
    assert.equal((await waiting).revision, target);
    t.diagnostic("stage: projection wake observed");
    assert.equal(second.outcome, "applied");
    assert.equal(replica.latest()?.revision, second.revision);
    const cut = await replica.waitForCut(second.revision!);
    assert.equal(cut.revision, second.revision);
    assert.equal(
      replica.manifest(cut.revision)?.some((entry) => entry.path.includes("task-one")),
      true,
    );
    assert.equal(
      replica.manifest(cut.revision)?.some((entry) => entry.path.includes("task-two")),
      true,
    );
    const corrupt = new DatabaseSync(
      path.join(repo, ".harness/replica/repos/replica-repo", `g${READ_MODEL_SCHEMA_GENERATION}`, "checkpoints.sqlite"),
    );
    try {
      corrupt.prepare("UPDATE manifest_entry SET entry_json = '{}' WHERE manifest_digest = ?").run(cut.manifest.digest);
    } finally {
      corrupt.close();
    }
    const third = await host.run("replica-repo", { kind: "task-create", taskId: "task-three", title: "Three" }, auth);
    assert.equal(third.outcome, "applied");
    t.diagnostic("stage: waiting for corrupt-manifest rejection");
    await assert.rejects(replica.waitForCut(third.revision!), /manifest .* corrupt/u);
    assert.equal((await host.read("replica-repo", "repo.tasks.list", {}, auth)).status, "ready");
    assert.equal(
      (await host.run("replica-repo", { kind: "task-create", taskId: "task-four", title: "Four" }, auth)).outcome,
      "applied",
    );
  } finally {
    await host.close();
    await owners.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("retired audit documents survive cold replay for both retained cuts and fresh replicas", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-audit-")),
    historical = parseCanonicalEvent(
      readFileSync(
        new URL("../../kernel/fixtures/canonical-events/people-event-v1/accepted.json", import.meta.url),
        "utf8",
      ),
    );
  assert.equal(historical.schema, "people-event/v1");
  const body = Buffer.from(JSON.stringify(historical.payload.roster, null, 2) + "\n"),
    blob = { sha256: sha256Bytes(body), size: body.byteLength, mediaType: "application/yaml" },
    audit = {
      ...historical,
      workspaceRevision: 1,
      payload: {
        ...historical.payload,
        peopleDocumentClaim: {
          ...historical.payload.peopleDocumentClaim,
          ...blob,
          mediaType: "application/yaml" as const,
        },
      },
    },
    nextBody = Buffer.from("next"),
    next = docEvent(2, "context/change.md", null, nextBody),
    events = [audit, next],
    serialized = events.map((event) => JSON.stringify(event)),
    projection = makeTaskProjection({
      rootDir: root,
      eventStore: {
        readHead: () => ({ revision: 2 }),
        readContentBlob: (sha) => (sha === blob.sha256 ? body : nextBody),
        readBatch: (cursor) => ({
          sourceRevision: 2,
          events: cursor === "2" ? [] : events,
          cursor: "2",
          done: true,
          accessedItems: cursor === "2" ? 0 : events.length,
          prefetchContent: () =>
            new Map([
              [blob.sha256, body],
              [sha256Bytes(nextBody), nextBody],
            ]),
        }),
      },
    });
  const expected = [
    {
      path: "context/change.md",
      blob: { sha256: sha256Bytes(nextBody), size: nextBody.byteLength, mediaType: "text/plain" },
    },
    { path: "people.yaml", blob },
  ];
  // The retained pre-upgrade cut includes the canonical audit claim, as it did before People retirement.
  const retained = openReplicaCutSource({
    repoId: "repo-audit",
    localRoot: root,
    readBasis: () => ({
      watermark: 1,
      sourceRevision: 1,
      headEvent: lifecycleFixture().events[0]!,
      events: [],
      documents: [{ path: "people.yaml", blobSha256: blob.sha256, size: blob.size, mediaType: blob.mediaType }],
    }),
    readContentBlob: () => body,
  });
  retained.activate();
  retained.close();
  const source = openReplicaCutSource({
      repoId: "repo-audit",
      localRoot: root,
      readBasis: projection.readReplicaBasis,
      readContentBlob: (sha) => (sha === blob.sha256 ? body : nextBody),
    }),
    fresh = openReplicaCutSource({
      repoId: "repo-fresh",
      localRoot: root,
      readBasis: projection.readReplicaBasis,
      readContentBlob: (sha) => (sha === blob.sha256 ? body : nextBody),
    });
  try {
    assert.equal(projection.rebuild().watermark, 2);
    source.activate();
    const cut = await source.waitForCut(2);
    assert.deepEqual(source.manifest(2), expected);
    assert.deepEqual(source.changes(1, 2), [{ op: "put", ...expected[0] }]);
    assert.equal(fresh.activate()?.manifest.digest, cut.manifest.digest);
    assert.deepEqual(fresh.manifest(2), expected);
    assert.deepEqual(source.content(blob), body);
    assert.deepEqual(
      events.map((event) => JSON.stringify(event)),
      serialized,
    );
    assert.equal(projection.readEntityVersionWitness("person/person-fixture").currentVersion, null);
  } finally {
    source.close();
    fresh.close();
    projection.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a canonical document deletion removes retained and fresh replica entries", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-replica-delete-")),
    itemPath = "context/retired.md",
    body = Buffer.from("retired"),
    create = docEvent(1, itemPath, null, body),
    retire = docEvent(2, itemPath, body, null),
    events = [create, retire],
    original = events.map((event) => JSON.stringify(event)),
    projection = makeTaskProjection({
      rootDir: root,
      eventStore: {
        readHead: () => ({ revision: 2 }),
        readContentBlob: (sha) => (sha === sha256Bytes(body) ? body : null),
        readBatch: (cursor) => ({
          sourceRevision: 2,
          events: cursor === "2" ? [] : events,
          cursor: "2",
          done: true,
          accessedItems: cursor === "2" ? 0 : events.length,
          prefetchContent: () => new Map([[sha256Bytes(body), body]]),
        }),
      },
    });
  const firstBasis: ReplicaProjectionBasis = {
    watermark: 1,
    sourceRevision: 1,
    headEvent: create,
    events: [],
    documents: [{ path: itemPath, blobSha256: sha256Bytes(body), size: body.byteLength, mediaType: "text/plain" }],
  };
  let current = false;
  const retained = openReplicaCutSource({
      repoId: "retained",
      localRoot: root,
      readBasis: (after) => (current ? projection.readReplicaBasis(after) : firstBasis),
      readContentBlob: () => body,
    }),
    fresh = openReplicaCutSource({
      repoId: "fresh",
      localRoot: root,
      readBasis: projection.readReplicaBasis,
      readContentBlob: () => body,
    });
  try {
    assert.deepEqual(retained.manifest(retained.activate()!.revision), [
      {
        path: itemPath,
        blob: { sha256: sha256Bytes(body), size: body.byteLength, mediaType: "text/plain" },
      },
    ]);
    assert.equal(projection.rebuild().watermark, 2);
    assert.deepEqual(projection.readReplicaBasis(null).documents, []);
    current = true;
    retained.kick();
    const cut = await retained.waitForCut(2);
    assert.deepEqual(retained.manifest(2), []);
    assert.deepEqual(retained.changes(1, 2), [{ op: "delete", path: itemPath }]);
    assert.deepEqual(retained.changeLog(), [
      { fromRevision: 1, toRevision: 2, change: { op: "delete", path: itemPath } },
    ]);
    assert.equal(fresh.activate()?.manifest.digest, cut.manifest.digest);
    assert.deepEqual(fresh.manifest(2), []);
    assert.deepEqual(
      events.map((event) => JSON.stringify(event)),
      original,
    );
    retained.close();
    const reopened = openReplicaCutSource({
      repoId: "retained",
      localRoot: root,
      readBasis: projection.readReplicaBasis,
      readContentBlob: () => body,
    });
    assert.deepEqual(reopened.manifest(2), []);
    assert.deepEqual(reopened.changes(1, 2), [{ op: "delete", path: itemPath }]);
    reopened.close();
  } finally {
    retained.close();
    fresh.close();
    projection.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("entity deletion, schedule deletion and fact archive retire canonical replica documents", async () => {
  const actor = { principal: { personId: "person-replica" }, executor: null } as const,
    envelope = (revision: number) => ({
      eventId: `event-retirement-${revision}`,
      opId: `op-retirement-${revision}`,
      workspaceRevision: revision,
      actor,
      source: "local" as const,
      occurredAt: "2026-08-26T10:00:00.000Z",
    }),
    entity = compileEntityUpsert({
      ...envelope(1),
      entityKind: "agent",
      entity: {
        schema: "agent-declaration/v1",
        id: "replica-worker",
        name: "Replica Worker",
        instructions: "Replica fixture agent.",
        runtimes: [{ type: "claude" }],
      },
    }),
    entityDelete = compileEntityDeleted({
      ...envelope(2),
      entityKind: "agent",
      entityId: "replica-worker",
      baseBlobSha256: entity.blobs[0].sha256,
      reason: "Retired fixture agent",
    }),
    schedule = createScheduleV1({
      scheduleId: "schedule-replica",
      name: "Replica fixture",
      mode: "detect",
      spec: {
        trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-08-26T10:00:00.000Z" },
        target: { kind: "agent", agentId: "codex", runtimeInstanceId: "runtime-local" },
        mission: "Check replica.",
      },
      actor,
      occurredAt: envelope(1).occurredAt,
    }),
    scheduleCreate = compileScheduleDefinitionEvent({ ...envelope(1), type: "schedule_created", schedule }),
    scheduleDelete = compileScheduleDeletedEvent({
      ...envelope(2),
      type: "schedule_deleted",
      schedule,
      baseBlobSha256: scheduleCreate.blobs[0].sha256,
      reason: "Retired fixture schedule",
    }),
    factDraft = (revision: number, type: "fact_recorded" | "fact_archived"): FactEventDraftV1 => ({
      schema: "fact-event/v1",
      ...envelope(revision),
      taskId: "task-replica",
      factId: "F-ABCDEFGH",
      type,
      payload: {
        statement: "Replica fixture fact.",
        evidenceSource: "replica test",
        observedAt: envelope(revision).occurredAt,
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: [],
        provenance: [{ runtime: "human", sessionId: "replica-fixture", boundAt: envelope(1).occurredAt }],
        ...(type === "fact_archived" ? { archiveReason: "Retired fixture fact" } : {}),
      },
    }),
    fact = compileFactWrite({ event: factDraft(1, "fact_recorded") }),
    factArchive = compileFactArchiveWrite({
      event: factDraft(2, "fact_archived"),
      retiredDocumentSha256: fact.blobs[0].sha256,
    });
  for (const [name, created, retired, bytes, itemPath] of [
    [
      "entity",
      entity.event,
      entityDelete.event,
      Buffer.from(entity.blobs[0].body),
      entity.event.payload.declarationDocumentClaim.path,
    ],
    [
      "schedule",
      scheduleCreate.event,
      scheduleDelete.event,
      Buffer.from(scheduleCreate.blobs[0].body),
      scheduleCreate.event.payload.declarationDocumentClaim.path,
    ],
    ["fact", fact.event, factArchive.event, Buffer.from(fact.blobs[0].body), fact.path],
  ] as const) {
    await verifyCanonicalRetirement(name, created, retired, bytes, itemPath);
  }
});

for (const scenario of [
  {
    mutation: "update",
    policyId: "markdown-body-replaceable/v1",
    mediaType: "text/markdown",
    bytes: Buffer.from("Old source file"),
  },
  {
    mutation: "delete",
    policyId: "raw-artifact-bytes/v1",
    mediaType: "application/octet-stream",
    bytes: Buffer.from([0xff, 0x00, 0x80]),
  },
  {
    mutation: "update",
    policyId: "opaque-textual-whole-file/v1",
    mediaType: "text/x-harness-opaque",
    bytes: Buffer.from("\ufeffopaque source"),
  },
] as const)
  test(`entity ${scenario.mutation} retires its initial ${scenario.policyId} source through production replica basis`, async () => {
    const vertical = JSON.parse(
        readFileSync(new URL("../../kernel/fixtures/schemas/vertical-definition/valid.json", import.meta.url), "utf8"),
      ) as Record<string, unknown> & { entityKinds: unknown[]; projectionSchemas: unknown[] },
      artifact = compileVerticalContract({
        ...vertical,
        id: "custom/engineering",
        entityKinds: [
          ...vertical.entityKinds,
          {
            kindId: "KND-1f5c0a7e9b3d4c6a8e2f0b1d3c5a7e94",
            id: "architecture-decision-record",
            entityType: "artifact",
            schemaVersions: [{ version: 1, attributes: {} }],
            idPrefix: "ADR",
            display: { singular: "ADR", plural: "ADRs" },
            descriptorSchemaRef: "schema://artifact-descriptor",
            store: { pathTemplate: "entities/adrs/{id}.json" },
            locatorKinds: ["repository-path", "url", "external-key"],
            relations: [],
          },
        ],
        projectionSchemas: [
          ...vertical.projectionSchemas,
          { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
        ],
      }).artifactKinds[0]!,
      contract = artifact.entityKindContract as EntityStoreKindContract,
      snapshot = artifactEntityContractSnapshot({ ...artifact, kindVersion: 1 }),
      source = canonicalSourceIdentity({ kind: "repository-path", repositoryId: "canonical", path: "docs/adr.md" }),
      descriptor = {
        schema: "schema://artifact-descriptor" as const,
        typeIdentity: artifact.typeIdentity,
        kindVersion: 1,
        entityId: mintArtifactEntityId({
          idPrefix: artifact.declaration.idPrefix,
          randomBytes: new Uint8Array(ARTIFACT_ENTITY_ID_BYTES).fill(7),
        }),
        title: "ADR One",
        locator: { kind: "repository-path" as const, value: "docs/adr.md" },
        contentVersion: deriveArtifactContentVersion({ kind: "content", content: "# ADR One\n" }),
        attributes: {},
        source,
      },
      actor = { principal: { personId: "person-replica" }, executor: null } as const,
      oldFile = scenario.bytes,
      oldFileClaim = {
        relativePath: "notes/old.md",
        sha256: sha256Bytes(oldFile),
        size: oldFile.byteLength,
        mediaType: scenario.mediaType,
        policyId: scenario.policyId,
        body: oldFile,
      },
      observed = compileEntityContentObserved({
        contract,
        contractSnapshot: snapshot,
        descriptor,
        resolver: "repository:canonical",
        observationId: artifactObservationId({
          entityId: descriptor.entityId,
          locator: descriptor.locator,
          resolution: descriptor.contentVersion,
        }),
        sourceContent: [oldFileClaim],
        eventId: "event-replica-observed",
        opId: artifactImportOperationId({
          entityKind: descriptor.typeIdentity,
          sourceIdentity: descriptor.source,
          locator: descriptor.locator,
          resolution: descriptor.contentVersion,
        }),
        workspaceRevision: 1,
        actor,
        source: "local",
        occurredAt: "2026-09-02T00:00:00.000Z",
      }),
      oldPath = observed.event.payload.ownedContent.bindings.find(({ path: target }) =>
        target.endsWith("notes/old.md"),
      )!.path,
      updated =
        scenario.mutation === "delete"
          ? compileEntityDeleted({
              contract,
              entityKind: contract.kind,
              entityId: descriptor.entityId,
              baseBlobSha256: observed.blobs[0].sha256,
              contentRetirements: [{ path: oldPath, baseBlobSha256: oldFileClaim.sha256 }],
              reason: "retire replica fixture",
              eventId: "event-replica-deleted",
              opId: "op-replica-deleted",
              workspaceRevision: 2,
              actor,
              source: "local",
              occurredAt: "2026-09-02T00:01:00.000Z",
            })
          : compileEntityUpdated({
              contract,
              contractSnapshot: snapshot,
              descriptor: { ...descriptor, title: "ADR One revised" },
              retirements: [{ path: oldPath, baseBlobSha256: oldFileClaim.sha256 }],
              eventId: "event-replica-updated",
              opId: artifactMutationOperationId({
                mutation: "update",
                entityId: descriptor.entityId,
                expectedVersion: 1,
                request: { entityKind: descriptor.typeIdentity, title: "ADR One revised" },
              }),
              workspaceRevision: 2,
              actor,
              source: "local",
              occurredAt: "2026-09-02T00:01:00.000Z",
            }),
      root = mkdtempSync(path.join(tmpdir(), "ha-replica-entity-update-")),
      events = [observed.event, updated.event],
      historicalBytes = events.map(serializeCanonicalEvent),
      blobs = new Map([
        ...observed.blobs.map((blob) => [blob.sha256, Buffer.from(blob.body)] as const),
        ...updated.blobs.map((blob) => [blob.sha256, Buffer.from(blob.body)] as const),
      ]);
    let revision = 1;
    const makeProjection = () =>
      makeTaskProjection({
        rootDir: root,
        eventStore: {
          readHead: () => ({ revision }),
          readContentBlob: (sha) => blobs.get(sha) ?? null,
          readBatch: (cursor) => {
            const selected = events.slice(cursor === null ? 0 : Number(cursor), revision);
            return {
              sourceRevision: revision,
              events: selected,
              cursor: String(revision),
              done: true,
              accessedItems: selected.length,
              prefetchContent: () => blobs,
            };
          },
        },
      });
    let projection = makeProjection();
    const retained = openReplicaCutSource({
        repoId: "retained",
        localRoot: root,
        readBasis: (after) => projection.readReplicaBasis(after),
        readContentBlob: (sha) => blobs.get(sha) ?? null,
      }),
      fresh = openReplicaCutSource({
        repoId: "fresh",
        localRoot: root,
        readBasis: (after) => projection.readReplicaBasis(after),
        readContentBlob: (sha) => blobs.get(sha) ?? null,
      });
    try {
      assert.equal(projection.rebuild().watermark, 1);
      assert.deepEqual(
        projection.readReplicaBasis(null).documents.map(({ path: target }) => target),
        [observed.event.payload.declarationDocumentClaim.path, oldPath].sort(),
      );
      assert.equal(
        projection.readDocument(oldPath).document?.body,
        scenario.mutation === "delete" ? "" : oldFile.toString("utf8"),
      );
      // Reopen the previous cache shape: replay must restore omitted owned documents.
      projection.close();
      const stale = new DatabaseSync(path.join(root, ".harness/cache/task.sqlite"));
      stale.prepare("DELETE FROM document WHERE path = ?").run(oldPath);
      stale.exec("UPDATE projection_meta SET schema_version = 26");
      stale.close();
      projection = makeProjection();
      assert.equal(projection.catchUp().watermark, 1);
      assert.equal(retained.activate()?.manifest.entryCount, 2);
      assert.deepEqual(
        retained.content({ sha256: oldFileClaim.sha256, size: oldFileClaim.size, mediaType: oldFileClaim.mediaType }),
        oldFile,
      );
      revision = 2;
      assert.equal(projection.catchUp().watermark, 2);
      const next =
          scenario.mutation === "delete"
            ? []
            : [
                {
                  path: observed.event.payload.declarationDocumentClaim.path,
                  blob: {
                    sha256: updated.blobs[0].sha256,
                    size: updated.blobs[0].size,
                    mediaType: "application/json",
                  },
                },
              ],
        changes = [
          ...(scenario.mutation === "delete"
            ? [{ op: "delete" as const, path: observed.event.payload.declarationDocumentClaim.path }]
            : next.map((entry) => ({ op: "put" as const, ...entry }))),
          { op: "delete" as const, path: oldPath },
        ].sort((a, b) => a.path.localeCompare(b.path));
      assert.deepEqual(
        projection.readReplicaBasis(null).documents.map(({ path: target }) => target),
        next.map(({ path: target }) => target),
      );
      assert.equal(projection.readDocument(oldPath).document, null);
      assert.equal(projection.rebuild().watermark, 2);
      retained.kick();
      const cut = await retained.waitForCut(2);
      assert.deepEqual(retained.manifest(2), next);
      assert.deepEqual(retained.changes(1, 2), changes);
      assert.deepEqual(
        retained.changeLog().map(({ change }) => change),
        changes,
      );
      assert.equal(fresh.activate()?.manifest.digest, cut.manifest.digest);
      assert.deepEqual(fresh.manifest(2), next);
      retained.close();
      const reopened = openReplicaCutSource({
        repoId: "retained",
        localRoot: root,
        readBasis: (after) => projection.readReplicaBasis(after),
        readContentBlob: (sha) => blobs.get(sha) ?? null,
      });
      assert.deepEqual(reopened.manifest(2), next);
      assert.deepEqual(reopened.changes(1, 2), changes);
      reopened.close();
      assert.deepEqual(events.map(serializeCanonicalEvent), historicalBytes);
    } finally {
      retained.close();
      fresh.close();
      projection.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

async function verifyCanonicalRetirement(
  name: string,
  created: Parameters<typeof serializeCanonicalEvent>[0],
  retired: Parameters<typeof serializeCanonicalEvent>[0],
  bytes: Buffer,
  itemPath: string,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), `ha-replica-${name}-`)),
    events = [created, retired],
    historicalBytes = events.map(serializeCanonicalEvent);
  let revision = 1;
  const projection = makeTaskProjection({
      rootDir: root,
      eventStore: {
        readHead: () => ({ revision }),
        readContentBlob: (sha) => (sha === sha256Bytes(bytes) ? bytes : null),
        readBatch: (cursor) => {
          const start = cursor === null ? 0 : Number(cursor),
            selected = events.slice(start, revision);
          return {
            sourceRevision: revision,
            events: selected,
            cursor: String(revision),
            done: true,
            accessedItems: selected.length,
            prefetchContent: () => new Map([[sha256Bytes(bytes), bytes]]),
          };
        },
      },
    }),
    retained = openReplicaCutSource({
      repoId: "retained",
      localRoot: root,
      readBasis: projection.readReplicaBasis,
      readContentBlob: (sha) => (sha === sha256Bytes(bytes) ? bytes : null),
    }),
    fresh = openReplicaCutSource({
      repoId: "fresh",
      localRoot: root,
      readBasis: projection.readReplicaBasis,
      readContentBlob: (sha) => (sha === sha256Bytes(bytes) ? bytes : null),
    });
  try {
    assert.equal(projection.rebuild().watermark, 1, name);
    const before = [
      {
        path: itemPath,
        blob: {
          sha256: sha256Bytes(bytes),
          size: bytes.byteLength,
          mediaType: name === "entity" || name === "schedule" ? "application/json" : "text/markdown",
        },
      },
    ];
    assert.deepEqual(
      projection.readReplicaBasis(null).documents.map(({ path: target }) => target),
      [itemPath],
      name,
    );
    assert.deepEqual(retained.manifest(retained.activate()!.revision), before, name);
    revision = 2;
    assert.equal(projection.rebuild().watermark, 2, name);
    assert.deepEqual(projection.readReplicaBasis(null).documents, [], name);
    retained.kick();
    const cut = await retained.waitForCut(2);
    assert.deepEqual(retained.manifest(2), [], name);
    assert.deepEqual(retained.changes(1, 2), [{ op: "delete", path: itemPath }], name);
    assert.deepEqual(
      retained.changeLog(),
      [{ fromRevision: 1, toRevision: 2, change: { op: "delete", path: itemPath } }],
      name,
    );
    assert.equal(fresh.activate()?.manifest.digest, cut.manifest.digest, name);
    assert.deepEqual(fresh.manifest(2), [], name);
    retained.close();
    const reopened = openReplicaCutSource({
      repoId: "retained",
      localRoot: root,
      readBasis: projection.readReplicaBasis,
      readContentBlob: (sha) => (sha === sha256Bytes(bytes) ? bytes : null),
    });
    assert.deepEqual(reopened.manifest(2), [], name);
    assert.deepEqual(reopened.changes(1, 2), [{ op: "delete", path: itemPath }], name);
    reopened.close();
    assert.deepEqual(events.map(serializeCanonicalEvent), historicalBytes, name);
  } finally {
    retained.close();
    fresh.close();
    projection.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function docEvent(workspaceRevision: number, itemPath: string, prior: Buffer | null, body: Buffer | null): DocEventV1 {
  const actor = { principal: { personId: "person-one" }, executor: null },
    baseBlobSha256 = prior === null ? null : sha256Bytes(prior),
    baseLedgerSha = {
      repoId: "repo-change",
      revision: workspaceRevision - 1,
      headDigest: `sha256:${sha256Bytes(Buffer.from("historical derived bytes"))}`,
    },
    intent = parseDocWriteIntent(
      {
        schema: "doc-write-intent/v1",
        executionId: null,
        baseLedgerSha,
        changes: [
          {
            path: itemPath,
            baseBlobSha256,
            policyId: DOC_POLICY_ID,
            candidate:
              body === null
                ? null
                : {
                    ref: `doc-sync-claims/${sha256Bytes(body)}`,
                    sha256: sha256Bytes(body),
                    size: body.byteLength,
                    mediaType: "text/plain",
                  },
          },
        ],
      },
      "repo-change",
    ),
    decision = decideDocWrite({
      intent,
      opId: `op-doc-${workspaceRevision}`,
      eventId: `event-doc-${workspaceRevision}`,
      workspaceRevision,
      actor,
      source: "local",
      occurredAt: new Date(Date.UTC(2026, 7, 14, 0, 0, workspaceRevision)).toISOString(),
      currentLedgerSha: intent.baseLedgerSha,
      lease: null,
      authorizationDecision: null,
      documents:
        prior === null
          ? [null]
          : [
              {
                path: intent.changes[0]!.path,
                blobSha256: baseBlobSha256,
                body: prior.toString(),
                size: prior.byteLength,
                mediaType: "text/plain",
                policyId: DOC_POLICY_ID,
                workspaceRevision: workspaceRevision - 1,
              },
            ],
      claims: body === null ? [] : [body],
      resolvedTaskIds: [null],
      ...(body === null ? { retirementReason: "Retired document" } : {}),
    });
  if (!decision.accepted) throw new Error(decision.code);
  return decision.event;
}
function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
