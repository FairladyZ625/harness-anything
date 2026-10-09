// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes, submissionDigest } from "@harness-anything/kernel";
import { validateGuiSubmission } from "../src/protocol/daemon-protocol-validate-entities.ts";
import { readSubmissionArtifact } from "../src/submission-artifacts.ts";
import { deriveCloseoutSubmission } from "../src/repo-cell-submit.ts";

const repositorySettingsStub = {
  readRepository: () => ({ gates: [], ci: { workflows: [] } }),
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
        { path, candidate: { sha256: blobSha256 } },
        { path: cjkPath, candidate: { sha256: blobSha256 } },
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
  };
  const cell = {
    store,
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as Parameters<typeof readSubmissionArtifact>[0];
  return { cell, store, bytes, blobSha256 };
}
function derive(summary: string, carried?: Parameters<typeof deriveCloseoutSubmission>[7]) {
  const { cell } = fixture();
  const body = `## Summary\n${summary}\n## Verification\nRead evidence.\n## Residual Risk\nNone identified.\n## Same Mechanism Elsewhere\nChecked sibling.\n`;
  const projection = {
    readDocuments: () => ({ documents: [{ path }, { path: cjkPath }] }),
    readRuntimeDispatchesByTaskExecution: () => [],
    read: () => ({ watermark: 7, sourceRevision: 7, snapshot: { task: {} }, packagePath }),
    readDocument: (target: string) => ({
      watermark: 7,
      sourceRevision: 7,
      document: {
        workspaceRevision: [path, cjkPath].includes(target) ? 7 : undefined,
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
    { ...cell, rootDir: "/nonexistent", projection, settings: repositorySettingsStub },
    "task-artifact",
    "execution",
    { executions: [], reviews: [] } as unknown as Parameters<typeof deriveCloseoutSubmission>[3],
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
