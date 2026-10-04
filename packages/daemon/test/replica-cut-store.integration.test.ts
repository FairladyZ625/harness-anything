// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fleetNodeOwners } from "./fleet-store.fixture.ts";
import {
  decideDocWrite,
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
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { openReplicaCutSource } from "../src/fleet/replica-cut-store.ts";
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
    assert.equal(
      readdirSync(path.join(root, "replica/manifests/sha256"), {
        recursive: true,
        withFileTypes: true,
      }).filter((entry) => entry.isFile() && /^[0-9a-f]{64}$/u.test(entry.name)).length,
      1,
    );
    source.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an active cut pump yields after its 100ms round budget and resumes from the last exact cut", async () => {
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
      ticks = [0, 101, 0, 101, 0],
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
        monotonicNow: () => ticks.shift() ?? 101,
      });
    source.activate();
    source.kick();
    await source.waitForCut(4);
    assert.deepEqual(afters, [null, 1, 2, 3]);
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
    source.activate();
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
    source.close();
  } finally {
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
  try {
    const first = await host.run("replica-repo", { kind: "task-create", taskId: "task-one", title: "One" }, auth);
    assert.equal(first.outcome, "applied");
    const replica = host.replica("replica-repo"),
      bootstrap = replica.activate()!;
    assert.equal(bootstrap.revision, first.revision);
    t.signal.addEventListener("abort", () => replica.close(), { once: true });
    armed = true;
    const writing = host.run("replica-repo", { kind: "task-create", taskId: "task-two", title: "Two" }, auth);
    await reached.promise;
    const target = replica.ledgerCut()!.revision;
    const waiting = replica.waitForCut(target);
    await new Promise<void>((resolve) => setImmediate(resolve));
    release.resolve();
    const second = await writing;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The writer completion notification must wake the host replica without another request.
    assert.equal((await waiting).revision, target);
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
    writeFileSync(
      path.join(repo, ".harness/replica/manifests/sha256", cut.manifest.digest.slice(0, 2), cut.manifest.digest),
      "corrupt",
    );
    const third = await host.run("replica-repo", { kind: "task-create", taskId: "task-three", title: "Three" }, auth);
    assert.equal(third.outcome, "applied");
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

function docEvent(workspaceRevision: number, itemPath: string, prior: Buffer | null, body: Buffer | null): DocEventV1 {
  const actor = { principal: { personId: "person-one" }, executor: null },
    baseBlobSha256 = prior === null ? null : sha256Bytes(prior),
    baseLedgerSha = {
      repoId: "repo-change",
      revision: workspaceRevision - 1,
      headDigest: `sha256:${"a".repeat(64)}`,
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
