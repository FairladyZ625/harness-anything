// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import test from "node:test";
import { sha256Bytes, submissionDigest } from "@harness-anything/kernel";
import { validateGuiSubmission } from "../src/protocol/daemon-protocol-validate-entities.ts";
import { artifactAnchors, readSubmissionArtifact } from "../src/submission-artifacts.ts";
import { deriveCloseoutSubmission } from "../src/repo-cell-submit.ts";

const repositorySettingsStub = {
  readRepository: () => ({ gates: [], ci: { workflows: [] } }),
} as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["settings"];
const packagePath = "tasks/task-artifact",
  path = `${packagePath}/artifacts/report.md`,
  cjkPath = `${packagePath}/artifacts/实测报告.md`;
function fixture() {
  const bytes = Buffer.from("Frozen evidence.\n"),
    blobSha256 = sha256Bytes(bytes);
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
function derive(summary: string) {
  const { cell } = fixture();
  const body = `## Summary\n${summary}\n## Verification\nRead evidence.\n## Residual Risk\nNone identified.\n## Same Mechanism Elsewhere\nChecked sibling.\n`;
  const projection = {
    readReplicaBasis: () => ({ documents: [] }),
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
  );
}

test("artifact submission pins accepted bytes and both validators accept the same union", () => {
  const submitted = derive(`artifact:${path}`);
  const multiple = derive(`artifact:${path}@7 artifact:${path}.other@8`);
  assert.equal(multiple.artifacts?.length, 2);
  assert.deepEqual(multiple.deliverables, [path, `${path}.other`]);
  assert.equal(submitted.commitSha, null);
  assert.equal(submitted.artifacts?.[0]?.revision, 7);
  assert.deepEqual(submitted.deliverables, [path]);
  assert.deepEqual(validateGuiSubmission(submitted), []);
  const changed = { ...submitted, artifacts: [{ ...submitted.artifacts![0]!, revision: 8 }] };
  assert.notEqual(submissionDigest(submitted), submissionDigest(changed));
  // A commit cut with artifact anchors is the same union: both validators accept it.
  const hybrid = { ...submitted, commitSha: "a".repeat(40) };
  assert.deepEqual(validateGuiSubmission(hybrid), []);
  assert.deepEqual(validateGuiSubmission({ ...submitted, artifacts: [] }), []);
  for (const invalid of [
    { ...hybrid, artifacts: [] },
    { ...submitted, artifacts: undefined },
    { ...submitted, artifacts: [{ path, revision: 0, blobSha256: "a".repeat(64) }] },
  ]) {
    assert.ok(validateGuiSubmission(invalid).length);
  }
});

test("Summary may pair one commit with artifact anchors but never omits both", () => {
  for (const summary of [
    "no anchor",
    `artifact:${path}@7 artifact:${path}@7`,
    `artifact:${path}@7.2`,
    `artifact:${path}@7oops`,
    `artifact:${path}@0`,
    `artifact:${path}@-1`,
  ])
    assert.throws(() => derive(summary), { code: "invalid_submission" });
  assert.deepEqual(artifactAnchors(`artifact:${path}@7 artifact:${path}.other@9`, packagePath), [
    { path, revision: 7 },
    { path: `${path}.other`, revision: 9 },
  ]);
  assert.deepEqual(artifactAnchors(`artifact:${path}`, packagePath), [{ path }]);
});

test("artifact anchors leave trailing prose punctuation outside the path", () => {
  for (const summary of [
    "Delivered artifact:artifacts/report.md.",
    "Delivered artifact:artifacts/report.md, with the receipt.",
    "(artifact:artifacts/report.md)",
    "已交付 artifact:artifacts/report.md。",
  ])
    assert.deepEqual(artifactAnchors(summary, packagePath), [{ path: "artifacts/report.md" }]);
  for (const summary of [
    "Delivered artifact:artifacts/report.md.",
    "Delivered artifact:artifacts/report.md, with the receipt.",
    "(artifact:artifacts/report.md)",
    "已交付 artifact:artifacts/report.md。",
  ])
    assert.deepEqual(
      derive(summary).artifacts?.map((anchor) => anchor.path),
      [path],
    );
  assert.deepEqual(artifactAnchors("artifact:artifacts/x.other/report.md", packagePath), [
    { path: "artifacts/x.other/report.md" },
  ]);
  assert.deepEqual(artifactAnchors("artifact:artifacts/report.md@7.2", packagePath), []);
});

test("anchors break before any CJK or fullwidth punctuation", () => {
  for (const trailing of ["、", "；", "：", "）", "。", "，"])
    assert.deepEqual(artifactAnchors(`已交付 artifact:artifacts/report.md${trailing}回执留档。`, packagePath), [
      { path: "artifacts/report.md" },
    ]);
  // The original mis-parsed closeout: the lazy path used to swallow 「、」 and the next anchor.
  assert.deepEqual(
    artifactAnchors(
      "artifact:artifacts/design.md、artifact:artifacts/report.md 与 artifact:artifacts/prototype/index.html。",
      packagePath,
    ),
    [{ path: "artifacts/design.md" }, { path: "artifacts/report.md" }, { path: "artifacts/prototype/index.html" }],
  );
  for (const trailing of ["、", "；", "：", "）"])
    assert.deepEqual(
      derive(`已交付 artifact:artifacts/report.md${trailing}`).artifacts?.map((a) => a.path),
      [path],
    );
});

test("non-ASCII letters and % stay path characters, so CJK filenames still anchor", () => {
  assert.deepEqual(artifactAnchors("已交付 artifact:artifacts/实测报告.md。", packagePath), [
    { path: "artifacts/实测报告.md" },
  ]);
  assert.deepEqual(artifactAnchors("artifact:artifacts/a2-修复报告.md、回执另存。", packagePath), [
    { path: "artifacts/a2-修复报告.md" },
  ]);
  assert.deepEqual(artifactAnchors("artifact:artifacts/b5v7-cpu-%p.cpuprofile", packagePath), [
    { path: "artifacts/b5v7-cpu-%p.cpuprofile" },
  ]);
  assert.deepEqual(artifactAnchors("artifact:artifacts/实测报告.md@7。", packagePath), [
    { path: "artifacts/实测报告.md", revision: 7 },
  ]);
  // CJK prose directly after an ASCII filename glues onto the path instead of breaking it; the
  // resulting anchor then names a path the center never accepted, which resolution rejects.
  assert.deepEqual(artifactAnchors("artifact:artifacts/report.md的回执。", packagePath), [
    { path: "artifacts/report.md的回执" },
  ]);
  const submitted = derive("已交付 artifact:artifacts/实测报告.md。");
  assert.deepEqual(
    submitted.artifacts?.map((anchor) => [anchor.path, anchor.revision]),
    [[cjkPath, 7]],
  );
});

test("a directory deliverable anchor expands to every file under it, or rejects naming the unfiled count", () => {
  const parent = mkdtempSync(nodePath.join(tmpdir(), "ha-submission-dir-")),
    rawDir = `${packagePath}/artifacts/raw/`,
    filedA = `${packagePath}/artifacts/raw/a.log`,
    filedB = `${packagePath}/artifacts/raw/nested/b.log`;
  const deriveDir = (summary: string, accepted: readonly string[]) => {
    const bytes = Buffer.from("Frozen evidence.\n"),
      blobSha256 = sha256Bytes(bytes),
      event = {
        schema: "doc-event/v1",
        workspaceRevision: 7,
        opId: "accepted-7",
        payload: { changes: accepted.map((target) => ({ path: target, candidate: { sha256: blobSha256 } })) },
      },
      cell = {
        store: { readEventAtRevision: () => event, readContentBlob: () => bytes },
        cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      } as unknown as Parameters<typeof deriveCloseoutSubmission>[0],
      body = `## Summary\n${summary}\n## Verification\nRead evidence.\n## Residual Risk\nNone identified.\n## Same Mechanism Elsewhere\nChecked sibling.\n`,
      projection = {
        read: () => ({ watermark: 7, sourceRevision: 7, snapshot: { task: {} }, packagePath }),
        readDocument: (target: string) => ({
          watermark: 7,
          sourceRevision: 7,
          document: {
            workspaceRevision: accepted.includes(target) ? 7 : undefined,
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
      { ...cell, rootDir: parent, projection, settings: repositorySettingsStub },
      "task-artifact",
      "execution",
      { executions: [], reviews: [] } as unknown as Parameters<typeof deriveCloseoutSubmission>[3],
    );
  };
  try {
    mkdirSync(nodePath.join(parent, "harness", packagePath, "artifacts", "raw", "nested"), { recursive: true });
    writeFileSync(nodePath.join(parent, "harness", packagePath, "artifacts", "raw", "a.log"), "a\n");
    writeFileSync(nodePath.join(parent, "harness", packagePath, "artifacts", "raw", "nested", "b.log"), "b\n");
    // Every file filed: the cut freezes each file at its own accepted revision.
    const submitted = deriveDir(`artifact:${rawDir}`, [filedA, filedB]);
    assert.deepEqual(
      submitted.artifacts?.map((anchor) => [anchor.path, anchor.revision]),
      [
        [filedA, 7],
        [filedB, 7],
      ],
    );
    assert.deepEqual(submitted.deliverables, [filedA, filedB]);
    // An unfiled file rejects the submit naming the count, before the cut can freeze.
    assert.throws(
      () => deriveDir(`artifact:${rawDir}`, [filedA]),
      (error: Error & { readonly code?: string }) =>
        error.code === "invalid_submission" && /1 of 2 file\(s\).*b\.log/u.test(error.message),
    );
    // A @revision pin on a directory deliverable is meaningless and rejected.
    assert.throws(() => deriveDir(`artifact:${rawDir}@7`, [filedA, filedB]), { code: "invalid_submission" });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a prose label ending in 'artifact:' is not counted as a second anchor", () => {
  for (const summary of [
    "Delivery artifact: artifact:artifacts/report.md.",
    `Delivery artifact: artifact:${path}`,
    "Delivered artifact: artifact:artifacts/report.md@7 per the closeout.",
  ])
    assert.deepEqual(
      derive(summary).artifacts?.map((anchor) => anchor.path),
      [path],
    );
  // A label without an anchor names nothing, and a malformed anchor attempt still fails.
  assert.throws(() => derive("Delivery artifact: artifacts/report.md"), { code: "invalid_submission" });
  assert.throws(() => derive(`artifact:${path}@sha256:${"a".repeat(64)}`), { code: "invalid_submission" });
});

test("prose that merely shows an artifact:-shaped reference names no deliverable", () => {
  // 2026-10-01 false rejection (task_435dc27714e8cca3fa17e3602b): the Summary quoted replaced UI
  // text in backticks; `artifact:runtime-result/sha256/…` parsed as a directory deliverable outside
  // the task's artifacts namespace and rejected the submit with "contains no files".
  const incident = "「最近失败」下显示的 `artifact:runtime-result/sha256/…` 引用改成了一个入口";
  assert.deepEqual(artifactAnchors(incident, packagePath), []);
  // A runtime-result reference is another namespace's sigil, whole or truncated.
  assert.deepEqual(artifactAnchors(`回执 artifact:runtime-result/sha256/${"a".repeat(64)} 已失效。`, packagePath), []);
  // Mention text rides along a real anchor without diluting or blocking it.
  const submitted = derive("交付锚：`artifact:artifacts/report.md`。" + incident);
  assert.deepEqual(submitted.deliverables, [path]);
  // Mention-only prose no longer dies on artifact resolution: the fixture's absent ledger and
  // worktree stop it with the ordinary no-deliverables guidance instead.
  assert.throws(() => derive(incident), /No accepted task artifacts were found/u);
  // An anchor naming another task's artifacts is mention text for this task, not a rejection.
  assert.deepEqual(artifactAnchors("artifact:tasks/task-other/artifacts/report.md", packagePath), []);
});

test("invalid artifact anchors explain the copyable form and revision source", () => {
  for (const action of [
    () => derive("no anchor"),
    () => derive(`artifact:${path}@7 artifact:${path}@7`),
    () => readSubmissionArtifact(fixture().cell, packagePath, path, 8),
  ])
    assert.throws(action, {
      code: "invalid_submission",
      message: /artifact:artifacts\/report\.md.*pins the current center-accepted revision/u,
    });
});

test("unparsable artifact anchors are reported with the offending summary text", () => {
  assert.throws(() => derive("artifact:artifacts/report.md@7.2"), {
    code: "invalid_submission",
    message: /is not a parsable anchor: artifact:artifacts\/report\.md@7\.2\./u,
  });
  assert.throws(() => derive("已交付 artifact:：报告.md、"), {
    code: "invalid_submission",
    message: /is not a parsable anchor: artifact:：报告\.md、\./u,
  });
});

test("the guidance's package-relative anchor form resolves and stores the full task-package path", () => {
  const { cell, blobSha256 } = fixture();
  const submitted = derive("artifact:artifacts/report.md");
  assert.equal(submitted.commitSha, null);
  assert.deepEqual(submitted.artifacts, [{ path, revision: 7, blobSha256 }]);
  assert.deepEqual(submitted.deliverables, [path]);
  assert.deepEqual(validateGuiSubmission(submitted), []);
  assert.deepEqual(readSubmissionArtifact(cell, packagePath, "artifacts/report.md", 7).anchor, {
    path,
    revision: 7,
    blobSha256,
  });
  for (const target of ["artifacts/../closeout.md", "tasks/other/artifacts/report.md", "closeout.md"])
    assert.throws(() => readSubmissionArtifact(cell, packagePath, target, 7), { code: "invalid_submission" });
  // Both spellings name the same path, so naming both is the duplicate-path rejection.
  assert.throws(() => derive(`artifact:artifacts/report.md artifact:${path}`), /name each artifact path once/u);
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
