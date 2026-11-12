// harness-test-tier: fast
import { completionSnapshot } from "../../kernel/test/domain/completion.fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  sha256Bytes,
  submissionDigest,
  validateMigrationImportEvent,
  type MigrationImportEventV1,
} from "@harness-anything/kernel";
import { validateGuiSubmission } from "../src/protocol/daemon-protocol-validate-entities.ts";
import {
  createSubmissionArtifactReader,
  readSubmissionArtifact,
  readSubmissionArtifactRange,
} from "../src/submission-artifacts.ts";
import { deriveCloseoutSubmission } from "../src/repo-cell-submit.ts";

const repositorySettingsStub = {
  readRepository: () => ({ gates: [] }),
} as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["settings"];
const packagePath = "tasks/task-artifact",
  path = `${packagePath}/artifacts/report.md`,
  cjkPath = `${packagePath}/artifacts/实测报告.md`;
const progressDocumentClaim = {
  path: `${packagePath}/progress.md`,
  sha256: "d".repeat(64),
  size: 0,
  mediaType: "text/markdown",
  policyId: "typed-machine-writer/v1",
};
function fixture(bytes = Buffer.from("Frozen evidence.\n")) {
  const blobSha256 = sha256Bytes(bytes);
  const event = {
    schema: "doc-event/v1",
    workspaceRevision: 7,
    opId: "accepted-7",
    payload: {
      changes: [
        { path, candidate: { sha256: blobSha256, size: bytes.byteLength } },
        { path: cjkPath, candidate: { sha256: blobSha256, size: bytes.byteLength } },
      ],
    },
  };
  const store = {
    readEventAtRevision: (revision: number) =>
      revision === 7
        ? event
        : revision === 8
          ? {
              ...event,
              workspaceRevision: 8,
              opId: "accepted-8",
              payload: { changes: [{ path: `${path}.other`, candidate: { sha256: blobSha256 } }] },
            }
          : null,
    readContentBlob: () => bytes,
    readContentBlobRange: (_blob: string, offset: number, maxBytes: number) =>
      bytes.subarray(offset, offset + maxBytes),
    readContentBlobSize: (_blob: string) => bytes.byteLength,
  };
  const cell = {
    store,
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as Parameters<typeof readSubmissionArtifact>[0];
  return { cell, store, bytes, blobSha256 };
}
function derive(
  summary: string,
  carried?: Parameters<typeof deriveCloseoutSubmission>[7],
  options: {
    paths?: readonly string[];
    store?: Parameters<typeof readSubmissionArtifact>[0]["store"];
    revision?: (path: string) => number;
  } = {},
) {
  const { cell } = fixture();
  const paths = options.paths ?? [path, cjkPath],
    pathSet = new Set(paths);

  const body = `## Summary\n${summary}\n## Verification\nRead evidence.\n## Residual Risk\nNone identified.\n## Same Mechanism Elsewhere\nChecked sibling.\n`;
  const projection = {
    readPresetSnapshot: () => ({ snapshot: completionSnapshot }),
    readDocuments: () => ({ documents: paths.map((path) => ({ path })) }),
    readRuntimeDispatchesByTaskExecution: () => [],
    read: () => ({ watermark: 7, sourceRevision: 7, snapshot: { task: {} }, packagePath }),
    readDocument: (target: string) => ({
      watermark: 7,
      sourceRevision: 7,
      document: {
        workspaceRevision: pathSet.has(target) ? (options.revision?.(target) ?? 7) : undefined,
        body: target.endsWith("task-contract.json")
          ? JSON.stringify({
              documents: [
                {
                  slot: "task.closeout",
                  path: "closeout.md",
                  templateRef: "template://planning/closeout@1",
                  locale: "en-US",
                },
              ],
            })
          : body,
      },
    }),
  } as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["projection"];
  return deriveCloseoutSubmission(
    {
      ...cell,
      ...(options.store ? { store: options.store } : {}),
      rootDir: "/nonexistent",
      projection,
      settings: repositorySettingsStub,
    },
    "task-artifact",
    "execution",
    {
      task: { presetSnapshotDigest: completionSnapshot.digest, completionGateIds: [] },
      executions: [],
      reviews: [],
    } as unknown as Parameters<typeof deriveCloseoutSubmission>[3],
    carried ? new Map(carried.changes.map((change) => [change.path, "Carried evidence.\n"])) : undefined,
    undefined,
    undefined,
    carried,
  );
}

test("accepted artifacts freeze automatically and Summary is only prose", () => {
  const submitted = derive("Delivered reports without a hand-written anchor.");
  assert.deepEqual(submitted.deliverables, [path, cjkPath]);
  assert.equal(submitted.commitSha, null);
  assert.equal(submitted.artifacts?.[0]?.revision, 7);
  assert.deepEqual(validateGuiSubmission(submitted), []);
  for (const prose of [
    "artifact:artifacts/report.md@7.2",
    "artifact:runtime-result/sha256/…",
    "artifact:artifacts/report.md@7 artifact:artifacts/report.md@7",
  ])
    assert.deepEqual(derive(prose).artifacts, submitted.artifacts);
  const changed = { ...submitted, artifacts: [{ ...submitted.artifacts![0]!, revision: 8 }] };
  assert.notEqual(submissionDigest(submitted), submissionDigest(changed));
  const hybrid = { ...submitted, commitSha: "a".repeat(40) };
  assert.deepEqual(validateGuiSubmission(hybrid), []);
  assert.deepEqual(validateGuiSubmission({ ...submitted, artifacts: [] }), []);
  for (const invalid of [
    { ...hybrid, artifacts: [] },
    { ...submitted, artifacts: undefined },
    { ...submitted, artifacts: [{ path, revision: 0, blobSha256: "a".repeat(64) }] },
  ])
    assert.ok(validateGuiSubmission(invalid).length);
});

test("carried documents select new nested artifacts and supersede accepted bytes without local files", () => {
  const nested = `${packagePath}/artifacts/raw/trace.log`,
    blobSha256 = sha256Bytes(Buffer.from("Carried evidence.\n")),
    carried = {
      revision: 9,
      changes: [path, nested].map((target) => ({ path: target, candidate: { sha256: blobSha256 } })),
    } as unknown as NonNullable<Parameters<typeof deriveCloseoutSubmission>[7]>,
    submitted = derive("Delivered this center write's evidence.", carried);
  for (const target of [path, nested])
    assert.deepEqual(
      submitted.artifacts?.find((artifact) => artifact.path === target),
      {
        path: target,
        revision: 9,
        blobSha256,
      },
    );
});

test("accepted binary artifacts retain exact frozen bytes through explicit base64 encoding", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]),
    { cell, blobSha256 } = fixture(bytes),
    frozen = readSubmissionArtifact(cell, packagePath, path, 7);
  assert.equal(frozen.encoding, "base64");
  assert.deepEqual(Buffer.from(frozen.body, frozen.encoding), bytes);
  assert.equal(frozen.anchor.blobSha256, blobSha256);
});

test("only this task's accepted revision and portable artifact path resolve", () => {
  const { cell } = fixture();
  assert.equal(readSubmissionArtifact(cell, packagePath, path, 7).body, "Frozen evidence.\n");
  for (const target of [
    "tasks/other/artifacts/report.md",
    `${packagePath}/artifacts/../closeout.md`,
    `/${path}`,
    `${packagePath}/closeout.md`,
    `${packagePath}/artifacts/missing.md`,
    path.replaceAll("/", "\\"),
  ])
    assert.throws(() => readSubmissionArtifact(cell, packagePath, target, 7), { code: "invalid_submission" });
  for (const revision of [0, 6, 8, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => readSubmissionArtifact(cell, packagePath, path, revision), { code: "invalid_submission" });
});

test("missing or changed frozen content cannot be replaced by latest workspace content", () => {
  const { cell, store } = fixture();
  assert.equal(readSubmissionArtifact(cell, packagePath, path, 7).acceptance, "accepted-7");
  assert.throws(() => readSubmissionArtifact(cell, packagePath, path, 7, "f".repeat(64)), {
    code: "invalid_submission",
  });
  store.readContentBlob = () => Buffer.from("latest content");
  assert.throws(() => readSubmissionArtifact(cell, packagePath, path, 7), { code: "invalid_submission" });
});

test("canonical bootstrap and carried-document acceptances retain the same frozen identity checks", () => {
  const { cell, store, bytes, blobSha256 } = fixture();
  for (const schema of ["task-bootstrap-event/v1", "task-event/v1", "task-progress-event/v1"]) {
    const accepted = {
      ...cell,
      store: {
        ...store,
        readEventAtRevision: (revision: number) => ({
          schema,
          workspaceRevision: revision,
          opId: "atomic-acceptance",
          payload:
            schema === "task-bootstrap-event/v1"
              ? { initialDocumentClaims: [{ path, sha256: blobSha256 }] }
              : {
                  resultDocumentClaim: progressDocumentClaim,
                  carriedDocumentClaims: [{ path, candidate: { sha256: blobSha256 } }],
                },
        }),
      },
    } as unknown as Parameters<typeof readSubmissionArtifact>[0];
    assert.equal(readSubmissionArtifact(accepted, packagePath, path, 7, blobSha256).body, bytes.toString());
    const range = readSubmissionArtifactRange(accepted, packagePath, path, 7, blobSha256, 0, 8);
    assert.deepEqual(range.bytes, bytes.subarray(0, 8));
    assert.equal(range.acceptance, "atomic-acceptance");
    assert.throws(
      () => readSubmissionArtifact(accepted, packagePath, `${path}.absent`, 7),
      /did not accept this path/u,
    );
    assert.throws(() => readSubmissionArtifact(accepted, packagePath, path, 7, "f".repeat(64)), /frozen identity/u);
    assert.throws(() => readSubmissionArtifactRange(accepted, packagePath, path, 7, "f".repeat(64), 0, 8), {
      code: "invalid_submission",
    });
  }
});

test("artifact freeze reads and indexes each acceptance once per submission", () => {
  const counts = (process.env.FLEET_STRESS_ARTIFACT_COUNTS ?? "256").split(",").map(Number),
    observations: { artifacts: number; ms: number; eventReads: number; eventBytes: number }[] = [];
  for (const count of counts) {
    const { bytes, blobSha256 } = fixture(),
      paths = Array.from({ length: count }, (_, i) => `${packagePath}/artifacts/small-${i}.txt`),
      db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE event (revision INTEGER PRIMARY KEY, event_json TEXT)");
      const eventJson = JSON.stringify({
        schema: "doc-event/v1",
        workspaceRevision: 7,
        opId: "accepted-7",
        payload: {
          changes: paths.map((path) => ({
            path,
            candidate: { sha256: blobSha256 },
            // Keep the acceptance event proportional to the real multi-file claim payload.
            expectedBaseSha: null,
            rationale: "accepted small artifact ".repeat(8),
          })),
        },
      });
      db.prepare("INSERT INTO event VALUES (?, ?)").run(7, eventJson);
      const select = db.prepare("SELECT event_json FROM event WHERE revision=?");
      let eventReads = 0;
      const store = {
        readEventAtRevision: (revision: number) => {
          eventReads++;
          const row = select.get(revision);
          return row ? JSON.parse(String(row.event_json)) : null;
        },
        readContentBlob: () => bytes,
      } as unknown as Parameters<typeof readSubmissionArtifact>[0]["store"];
      const start = performance.now(),
        submitted = derive("Indexed accepted artifacts.", undefined, { paths, store });
      observations.push({ artifacts: count, ms: performance.now() - start, eventReads, eventBytes: eventJson.length });
      assert.equal(submitted.artifacts?.length, count);
      assert.ok(submitted.artifacts?.every((anchor) => anchor.revision === 7 && anchor.blobSha256 === blobSha256));
    } finally {
      db.close();
    }
  }
  console.log("artifact-freeze-benchmark", JSON.stringify(observations));
  for (const observation of observations) assert.equal(observation.eventReads, 1);
});

test("distinct acceptance revisions remain isolated and a fresh submission reloads them", () => {
  const { cell, bytes, blobSha256 } = fixture(),
    paths = [path, cjkPath],
    reads: number[] = [],
    store = {
      ...cell.store,
      readEventAtRevision: (revision: number) => {
        reads.push(revision);
        return {
          schema: "task-progress-event/v1",
          workspaceRevision: revision,
          opId: `accepted-${revision}`,
          payload: {
            resultDocumentClaim: progressDocumentClaim,
            carriedDocumentClaims: [{ path: revision === 7 ? path : cjkPath, candidate: { sha256: blobSha256 } }],
          },
        };
      },
      readContentBlob: () => bytes,
    } as unknown as Parameters<typeof readSubmissionArtifact>[0]["store"],
    options = { paths, store, revision: (target: string) => (target === path ? 7 : 8) };
  for (let i = 0; i < 2; i++) {
    const submitted = derive("Separate revisions.", undefined, options);
    assert.deepEqual(submitted.artifacts?.map(({ revision }) => revision).sort(), [7, 8]);
  }
  assert.deepEqual(reads.sort(), [7, 7, 8, 8]);
});

test("a batch indexes claims once while checking each requested blob and identity", () => {
  const { cell, store, bytes, blobSha256 } = fixture();
  for (const schema of ["doc-event/v1", "task-bootstrap-event/v1", "task-event/v1", "task-progress-event/v1"]) {
    let eventReads = 0,
      claimReads = 0,
      blobReads = 0;
    const claims = [path, cjkPath].map((path) => ({
      path,
      get sha256() {
        claimReads++;
        return blobSha256;
      },
      get candidate() {
        claimReads++;
        return { sha256: blobSha256 };
      },
    }));
    const read = createSubmissionArtifactReader({
      ...cell,
      store: {
        ...store,
        readEventAtRevision: () => {
          eventReads++;
          return {
            schema,
            workspaceRevision: 7,
            opId: "batch",
            payload: {
              changes: claims,
              initialDocumentClaims: claims,
              resultDocumentClaim: progressDocumentClaim,
              carriedDocumentClaims: claims,
            },
          };
        },
        readContentBlob: () => {
          blobReads++;
          return bytes;
        },
      },
    } as unknown as Parameters<typeof createSubmissionArtifactReader>[0]);
    assert.equal(read(packagePath, path, 7).anchor.blobSha256, blobSha256);
    assert.equal(read(packagePath, cjkPath, 7).anchor.blobSha256, blobSha256);
    assert.throws(() => read(packagePath, path, 7, "f".repeat(64)), /frozen identity/u);
    assert.throws(() => read(packagePath, `${path}.absent`, 7), /did not accept this path/u);
    assert.equal(eventReads, 1);
    assert.equal(claimReads, 2);
    assert.equal(blobReads, 3);
  }
});

test("carried artifact lookup visits each change a bounded number of times", () => {
  const count = 256,
    blobSha256 = sha256Bytes(Buffer.from("Carried evidence.\n"));
  let pathReads = 0;
  const carried = {
    revision: 9,
    changes: Array.from({ length: count }, (_, index) => ({
      get path() {
        pathReads++;
        return `${packagePath}/artifacts/carried-${index}.txt`;
      },
      candidate: { sha256: blobSha256 },
    })),
  } as unknown as NonNullable<Parameters<typeof deriveCloseoutSubmission>[7]>;
  const submitted = derive("Linear carried changes.", carried, { paths: [] });
  assert.equal(submitted.artifacts?.length, count);
  assert.ok(pathReads <= count * 3, `visited ${pathReads} paths for ${count} changes`);
});

test("historical accepted claims without size remain readable through bounded metadata reads", () => {
  const { cell: source, store, bytes, blobSha256 } = fixture(),
    historical = {
      ...source,
      store: {
        ...store,
        readEventAtRevision: (revision: number) =>
          revision === 7
            ? {
                ...store.readEventAtRevision(7),
                payload: { changes: [{ path, candidate: { sha256: blobSha256 } }] },
              }
            : null,
        readContentBlobSize: (digest: string) => (digest === blobSha256 ? bytes.byteLength : null),
      },
    } as unknown as Parameters<typeof readSubmissionArtifact>[0];
  assert.equal(readSubmissionArtifact(historical, packagePath, path, 7).body, bytes.toString());
  const range = readSubmissionArtifactRange(historical, packagePath, path, 7, blobSha256, 0, 8);
  assert.equal(range.size, bytes.byteLength);
  assert.deepEqual(range.bytes, bytes.subarray(0, 8));
});

test("range reads reject an accepted object whose bytes changed at the same size", () => {
  const bytes = Buffer.from("accepted bytes that must remain immutable\n"),
    { cell, store, blobSha256 } = fixture(bytes);
  store.readContentBlobRange = (_blob: string, offset: number, maxBytes: number) =>
    Buffer.from("CORRUPTED bytes that must remain immutable\n").subarray(offset, offset + maxBytes);
  assert.throws(() => readSubmissionArtifactRange(cell, packagePath, path, 7, blobSha256, 0, 8), {
    code: "content_claim_mismatch",
  });
});

function migrationFixture(
  target = "tasks/task_migrated-evidence/artifacts/report.md",
  content = Buffer.from("Imported canonical evidence.\n"),
) {
  const { cell, store, bytes, blobSha256 } = fixture(content);
  const event: MigrationImportEventV1 = {
    schema: "migration-import-event/v1",
    type: "entity_migrated",
    eventId: "event-migration-artifact",
    workspaceRevision: 7,
    opId: "migration-artifact",
    actor: { principal: { personId: "person_migration" }, executor: null },
    source: "migration-import/v1",
    occurredAt: "2026-08-15T00:00:00.000Z",
    payload: {
      migratedFrom: target,
      generation: "v0",
      entity: {
        kind: "task-document",
        taskId: "task_migrated",
        documentClaim: {
          path: target,
          sha256: blobSha256,
          size: bytes.byteLength,
          mediaType: "text/markdown",
          policyId: MIGRATION_DOCUMENT_POLICY_ID,
        },
      },
    },
  };
  assert.deepEqual(validateMigrationImportEvent(event), []);
  return {
    cell: {
      ...cell,
      store: { ...store, readEventAtRevision: (revision: number) => (revision === 7 ? event : null) },
    } as Parameters<typeof readSubmissionArtifact>[0],
    bytes,
    blobSha256,
    event,
    target,
  };
}

for (const entry of ["whole", "range"] as const) {
  const read = (cell: Parameters<typeof readSubmissionArtifact>[0], owner: string, target: string, revision = 7) =>
    entry === "whole"
      ? readSubmissionArtifact(cell, owner, target, revision)
      : readSubmissionArtifactRange(cell, owner, target, revision, undefined, 0, 8);

  test(`${entry} reads resolve a validated migration-import revision to exact accepted bytes`, () => {
    const { cell, bytes, blobSha256, target } = migrationFixture();
    if (entry === "range") cell.store.readContentBlob = () => assert.fail("range reads must not load the full blob");
    const result = read(cell, "tasks/task_migrated-evidence", target);
    assert.deepEqual(result.anchor, { path: target, revision: 7, blobSha256 });
    assert.equal(result.acceptance, "migration-artifact");
    assert.equal(result.encoding, "utf8");
    assert.throws(
      () =>
        entry === "whole"
          ? readSubmissionArtifact(cell, "tasks/task_migrated-evidence", target, 7, "f".repeat(64))
          : readSubmissionArtifactRange(cell, "tasks/task_migrated-evidence", target, 7, "f".repeat(64), 0, 8),
      { code: "invalid_submission" },
    );
    if ("body" in result) assert.equal(result.body, bytes.toString());
    else {
      assert.equal(result.size, bytes.byteLength);
      assert.deepEqual(result.bytes, bytes.subarray(0, 8));
      const end = readSubmissionArtifactRange(
        cell,
        "tasks/task_migrated-evidence",
        target,
        7,
        blobSha256,
        bytes.byteLength,
        8,
      );
      assert.equal(end.bytes.byteLength, 0);
    }
  });

  test(`${entry} reads keep migration-import acceptance scoped to its path, task and revision`, () => {
    const { cell, target, event } = migrationFixture();
    for (const [owner, requested, revision] of [
      ["tasks/task_migrated-evidence", `${target}.absent`, 7],
      ["tasks/task_other-evidence", target, 7],
      ["tasks/task_other-evidence", "tasks/task_other-evidence/artifacts/report.md", 7],
      ["tasks/task_migrated-evidence", target, 6],
      ["tasks/task_migrated-evidence", target, 8],
    ] as const)
      assert.throws(() => read(cell, owner, requested, revision), { code: "invalid_submission" });
    const outside = migrationFixture("tasks/task_migrated-evidence/closeout.md");
    assert.throws(() => read(outside.cell, "tasks/task_migrated-evidence", outside.target), {
      code: "invalid_submission",
    });
    cell.store.readEventAtRevision = () => ({ ...event, workspaceRevision: 8 });
    assert.throws(() => read(cell, "tasks/task_migrated-evidence", target), { code: "invalid_submission" });
  });

  test(`${entry} reads reject a retirement at its own revision`, () => {
    const { cell, store } = fixture(),
      event = store.readEventAtRevision(7);
    cell.store.readEventAtRevision = () =>
      ({
        ...event,
        payload: { changes: [{ path, candidate: null }] },
      }) as ReturnType<typeof cell.store.readEventAtRevision>;
    assert.throws(() => read(cell, packagePath, path), { code: "invalid_submission" });
  });

  test(`${entry} reads accept task documentClaims alongside carriedDocumentClaims`, () => {
    const { cell, bytes, blobSha256 } = fixture();
    cell.store.readEventAtRevision = () =>
      ({
        schema: "task-event/v1",
        workspaceRevision: 7,
        opId: "task-acceptance",
        payload: {
          documentClaims: [{ path, sha256: blobSha256, size: bytes.byteLength, mediaType: "text/markdown" }],
          carriedDocumentClaims: [{ path: cjkPath, candidate: { sha256: blobSha256, size: bytes.byteLength } }],
        },
      }) as ReturnType<typeof cell.store.readEventAtRevision>;
    for (const target of [path, cjkPath]) {
      const result = read(cell, packagePath, target);
      assert.equal(result.anchor.blobSha256, blobSha256);
      assert.equal(result.acceptance, "task-acceptance");
    }
  });
}

test("migration-import range verification streams bounded chunks across a UTF-8 boundary", () => {
  const content = Buffer.from(`${"x".repeat(64 * 1024 - 1)}证据\n`),
    { cell, bytes, blobSha256, target } = migrationFixture(undefined, content),
    reads: { offset: number; maxBytes: number }[] = [];
  cell.store.readContentBlob = () => assert.fail("stream verification must not load the full blob");
  cell.store.readContentBlobRange = (_digest, offset, maxBytes) => {
    assert.ok(maxBytes <= 64 * 1024);
    reads.push({ offset, maxBytes });
    return bytes.subarray(offset, offset + maxBytes);
  };
  const range = readSubmissionArtifactRange(
    cell,
    "tasks/task_migrated-evidence",
    target,
    7,
    blobSha256,
    64 * 1024 - 1,
    7,
  );
  assert.equal(range.encoding, "utf8");
  assert.equal(range.size, bytes.byteLength);
  assert.equal(Buffer.from(range.bytes).toString(), "证据\n");
  assert.deepEqual(reads, [
    { offset: 0, maxBytes: 64 * 1024 },
    { offset: 64 * 1024, maxBytes: bytes.byteLength - 64 * 1024 },
    { offset: 64 * 1024 - 1, maxBytes: 7 },
  ]);
});
