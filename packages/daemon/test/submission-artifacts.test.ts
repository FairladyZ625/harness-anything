// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { sha256Bytes, submissionDigest } from "../../kernel/src/index.ts";
import { validateGuiSubmission } from "../src/protocol/daemon-protocol-validate-entities.ts";
import { artifactAnchors, readSubmissionArtifact } from "../src/submission-artifacts.ts";
import { deriveCloseoutSubmission } from "../src/repo-cell-submit.ts";

const packagePath = "tasks/task-artifact",
  path = `${packagePath}/artifacts/report.md`;
function fixture() {
  const bytes = Buffer.from("Frozen evidence.\n"),
    blobSha256 = sha256Bytes(bytes);
  const event = {
    schema: "doc-event/v1",
    workspaceRevision: 7,
    opId: "accepted-7",
    payload: { changes: [{ path, candidate: { sha256: blobSha256 } }] },
  };
  const store = {
    readBatch: (cursor: string) => ({
      events:
        Number(cursor) === 6
          ? [event]
          : Number(cursor) === 7
            ? [
                {
                  ...event,
                  workspaceRevision: 8,
                  opId: "accepted-8",
                  payload: { changes: [{ path: `${path}.other`, candidate: { sha256: blobSha256 } }] },
                },
              ]
            : [],
    }),
    readContentBlob: () => bytes,
  };
  const cell = {
    store,
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as Parameters<typeof readSubmissionArtifact>[0];
  return { cell, store, bytes, blobSha256 };
}
function derive(summary: string) {
  const { cell } = fixture();
  const body = `## Summary\n${summary}\n## Verification\nRead evidence.\n## Residual Risk\nNone identified.\n## Same Mechanism Elsewhere\nChecked sibling.\n`;
  const projection = {
    read: () => ({ watermark: 7, sourceRevision: 7, snapshot: { task: {} }, packagePath }),
    readDocument: (target: string) => ({
      watermark: 7,
      sourceRevision: 7,
      document: {
        body: target.endsWith("task-contract.json")
          ? JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] })
          : body,
      },
    }),
  } as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["projection"];
  return deriveCloseoutSubmission(
    { ...cell, rootDir: "/nonexistent", projection },
    "task-artifact",
    "execution",
    {} as Parameters<typeof deriveCloseoutSubmission>[3],
  );
}

test("artifact submission pins accepted bytes and both validators accept the same union", () => {
  const submitted = derive(`artifact:${path}@7`);
  const multiple = derive(`artifact:${path}@7 artifact:${path}.other@8`);
  assert.equal(multiple.artifacts?.length, 2);
  assert.deepEqual(multiple.deliverables, [path, `${path}.other`]);
  assert.equal(submitted.commitSha, null);
  assert.deepEqual(submitted.deliverables, [path]);
  assert.deepEqual(validateGuiSubmission(submitted), []);
  const changed = { ...submitted, artifacts: [{ ...submitted.artifacts![0]!, revision: 8 }] };
  assert.notEqual(submissionDigest(submitted), submissionDigest(changed));
  for (const invalid of [
    { ...submitted, commitSha: "a".repeat(40) },
    { ...submitted, artifacts: [] },
    { ...submitted, artifacts: [{ path, revision: 0, blobSha256: "a".repeat(64) }] },
  ]) {
    assert.ok(validateGuiSubmission(invalid).length);
  }
});

test("Summary requires exactly one delivery kind and complete unique artifact anchors", () => {
  for (const summary of [
    "no anchor",
    `${"a".repeat(40)} artifact:${path}@7`,
    `artifact:${path}@7 artifact:${path}@7`,
    `artifact:${path}@7.2`,
    `artifact:${path}@7oops`,
    `artifact:${path}@0`,
    `artifact:${path}@-1`,
  ])
    assert.throws(() => derive(summary), { code: "invalid_submission" });
  assert.deepEqual(artifactAnchors(`artifact:${path}@7 artifact:${path}.other@9`), [
    { path, revision: 7 },
    { path: `${path}.other`, revision: 9 },
  ]);
});

test("invalid artifact anchors explain the copyable form and revision source", () => {
  for (const action of [
    () => derive("no anchor"),
    () => derive(`artifact:${path}@7 artifact:${path}@7`),
    () => readSubmissionArtifact(fixture().cell, packagePath, path, 8),
  ])
    assert.throws(action, {
      code: "invalid_submission",
      message: /artifact:artifacts\/report\.md@3.*ha doc sync --submit.*ha doc status/u,
    });
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
