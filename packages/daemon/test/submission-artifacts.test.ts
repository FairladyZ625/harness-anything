// harness-test-tier: fast
import { completionSnapshot } from "../../kernel/test/domain/completion.fixtures.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { sha256Bytes, submissionDigest } from "@harness-anything/kernel";
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

test("artifacts accepted by an old-generation migration import resolve at their import revision", () => {
  const { cell, store, blobSha256 } = fixture();
  const imported = (claimPath: string) => ({
    schema: "migration-import-event/v1",
    workspaceRevision: 7,
    opId: "imported-7",
    payload: {
      entity: {
        kind: "task-document",
        taskId: "task-artifact",
        documentClaim: { path: claimPath, sha256: blobSha256 },
      },
    },
  });
  store.readEventAtRevision = () => imported(path) as never;
  assert.equal(readSubmissionArtifact(cell, packagePath, path, 7).acceptance, "imported-7");
  store.readEventAtRevision = () => imported(`${path}.other`) as never;
  assert.throws(() => readSubmissionArtifact(cell, packagePath, path, 7), { code: "invalid_submission" });
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
              : { carriedDocumentClaims: [{ path, candidate: { sha256: blobSha256 } }] },
        }),
      },
    } as unknown as Parameters<typeof readSubmissionArtifact>[0];
    assert.equal(readSubmissionArtifact(accepted, packagePath, path, 7, blobSha256).body, bytes.toString());
    assert.throws(
      () => readSubmissionArtifact(accepted, packagePath, `${path}.absent`, 7),
      /did not accept this path/u,
    );
    assert.throws(() => readSubmissionArtifact(accepted, packagePath, path, 7, "f".repeat(64)), /frozen identity/u);
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
