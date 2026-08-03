// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  CODE_DOC_RECONCILIATION_DOCUMENT,
  renderCodeDocReconciliationDraft,
  type TaskCompleteTransitionCommand
} from "../../application/src/index.ts";
import {
  decodePrepublishWitnessRef,
  produceCodeDocWitness,
  produceDocumentPublicationWitness,
  verifyTaskCompleteWitnessRefs
} from "../src/authority/production/task-complete-prepublish-witness.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";

test("daemon-produced prepublish witnesses bind immutable publication history, covered blobs, and code intent", () => {
  const fixture = witnessRepository();
  try {
    const document = produceDocumentPublicationWitness(fixture);
    const codeDoc = produceCodeDocWitness(fixture);
    const verified = verifyTaskCompleteWitnessRefs({
      ...fixture,
      requireCodeDoc: true,
      refs: [
        { kind: "document-publication", ref: document.ref },
        { kind: "code-doc-reconciliation", ref: codeDoc.ref }
      ]
    });

    assert.deepEqual(verified, [document, codeDoc]);
    assert.deepEqual(document.coveredTaskRelativePaths, ["closeout.md", CODE_DOC_RECONCILIATION_DOCUMENT]);
    assert.equal(codeDoc.taskId, taskId);
    assert.equal(codeDoc.reconciledCommitRef, fixture.publicCommit);
    assert.deepEqual(codeDoc.normalizedPaths, ["README.md"]);
    assert.deepEqual(codeDoc.publicationOperationIds, ["op_code_doc", "op_document"]);

    const forged = forgeWitnessRef(document.ref, { repositoryCommit: fixture.authoredInitialCommit });
    assert.throws(() => verifyTaskCompleteWitnessRefs({
      ...fixture,
      requireCodeDoc: true,
      refs: [
        { kind: "document-publication", ref: forged },
        { kind: "code-doc-reconciliation", ref: codeDoc.ref }
      ]
    }), /WITNESS_COMMIT_NOT_MATERIALIZED_FIRST_PARENT/u);

    assert.throws(() => verifyTaskCompleteWitnessRefs({
      ...fixture,
      documents: fixture.documents.map((entry) => entry.path === "closeout.md"
        ? { ...entry, body: `${entry.body}\npost-publication mutation\n` }
        : entry),
      requireCodeDoc: true,
      refs: [
        { kind: "document-publication", ref: document.ref },
        { kind: "code-doc-reconciliation", ref: codeDoc.ref }
      ]
    }), /WITNESS_SNAPSHOT_MISMATCH:document-publication/u);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("unpublished document rejection stays bounded with 1011 unrelated first-parent materializations", () => {
  const fixture = unpublishedScaleWitnessRepository(1_011, 11);
  try {
    const startedAt = performance.now();
    assert.throws(
      () => produceDocumentPublicationWitness(fixture),
      /AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED/u
    );
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 5_000, `unpublished witness rejection took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

function witnessRepository() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-prepublish-witness-"));
  const rootDir = path.join(fixtureRoot, "workspace");
  const authoredRoot = path.join(rootDir, "harness");
  const taskRoot = path.join(authoredRoot, "tasks", `${taskId}-witness`);
  mkdirSync(taskRoot, { recursive: true });

  gitInit(rootDir);
  writeFileSync(path.join(rootDir, "README.md"), "# Public code anchor\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-q", "-m", "test: public code anchor");
  const publicCommit = git(rootDir, "rev-parse", "HEAD");

  gitInit(authoredRoot);
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Witness fixture",
    "lifecycle:",
    "  engine: local",
    "  status: in_review",
    "---",
    "",
    "# Witness fixture",
    ""
  ].join("\n"));
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "test: seed witness task");
  const authoredInitialCommit = git(authoredRoot, "rev-parse", "HEAD");

  const closeout = "# Closeout\n\nThe immutable publication covers this accepted delivery.\n";
  const initialDocuments = [{ path: "closeout.md", body: closeout }];
  const codeDoc = renderCodeDocReconciliationDraft({
    taskId,
    documents: initialDocuments,
    sha: publicCommit,
    paths: ["README.md"]
  });
  assert.deepEqual(codeDoc.recordIds, ["closeout"]);
  const documents = [
    { path: CODE_DOC_RECONCILIATION_DOCUMENT, body: codeDoc.body },
    ...initialDocuments
  ];
  const command = completeCommand(publicCommit);

  git(authoredRoot, "checkout", "-q", "-b", "publication");
  for (const document of documents) writeFileSync(path.join(taskRoot, document.path), document.body);
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "authority publication [op_code_doc,op_document]");
  git(authoredRoot, "checkout", "-q", "main");
  git(authoredRoot, "merge", "-q", "--no-ff", "publication", "-m", "materialize [op_code_doc,op_document]");

  return {
    fixtureRoot,
    rootDir,
    authoredRoot,
    taskId,
    documents,
    command,
    publicCommit,
    authoredInitialCommit
  };
}

function unpublishedScaleWitnessRepository(mergeCount: number, documentCount: number) {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-prepublish-witness-scale-"));
  const rootDir = path.join(fixtureRoot, "workspace");
  const authoredRoot = path.join(rootDir, "harness");
  const taskRoot = path.join(authoredRoot, "tasks", `${taskId}-scale`);
  mkdirSync(taskRoot, { recursive: true });
  gitInit(authoredRoot);

  const documents = Array.from({ length: documentCount }, (_, index) => ({
    path: index === 0 ? "task_plan.md" : `artifacts/evidence-${String(index).padStart(2, "0")}.md`,
    body: `# Scale fixture document ${index}\n\nPublished body ${index}.\n`
  }));
  for (const document of documents) {
    const absolutePath = path.join(taskRoot, document.path);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, document.body);
  }
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "test: seed scale witness");
  appendNoopFirstParentMerges(authoredRoot, git(authoredRoot, "rev-parse", "HEAD"), mergeCount);

  const mutatedDocuments = documents.map((document, index) => index === 0
    ? { ...document, body: `${document.body}\nUnpublished mutation.\n` }
    : document);
  writeFileSync(path.join(taskRoot, mutatedDocuments[0]!.path), mutatedDocuments[0]!.body);
  return { fixtureRoot, rootDir, authoredRoot, taskId, documents: mutatedDocuments };
}

function appendNoopFirstParentMerges(rootDir: string, initialCommit: string, mergeCount: number): void {
  const commands = ["feature done\n"];
  let firstParent = initialCommit;
  for (let index = 0; index < mergeCount; index += 1) {
    const sideMark = index * 2 + 1;
    const mergeMark = sideMark + 1;
    commands.push(fastImportCommit("refs/heads/fixture-side", sideMark, `fixture side ${index}`, firstParent));
    commands.push(fastImportCommit(
      "refs/heads/main",
      mergeMark,
      `fixture materialization ${index} [op_fixture_${index}]`,
      firstParent,
      `:${sideMark}`
    ));
    firstParent = `:${mergeMark}`;
  }
  commands.push("done\n");
  execFileSync("git", ["-C", rootDir, "fast-import", "--quiet"], {
    input: commands.join(""),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function fastImportCommit(
  ref: string,
  mark: number,
  message: string,
  from: string,
  merge?: string
): string {
  return [
    `commit ${ref}\n`,
    `mark :${mark}\n`,
    "committer Harness Test <harness@example.test> 1750000000 +0000\n",
    `data ${Buffer.byteLength(message)}\n`,
    `${message}\n`,
    `from ${from}\n`,
    ...(merge ? [`merge ${merge}\n`] : []),
    "\n"
  ].join("");
}

function completeCommand(commitRef: string): TaskCompleteTransitionCommand {
  return {
    kind: "task-complete",
    taskId,
    executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7",
    ciGate: "passed",
    reviewerId: "person_alice",
    evidenceMode: "execution-review",
    commitRef,
    judgment: null,
    approval: {
      executionId: "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7",
      findings: "Witnesses cover the accepted delivery.",
      evidenceChecked: ["ev_witness"],
      rationale: "The immutable Git history proves publication.",
      archiveWarningsAcknowledged: true,
      consentSource: { kind: "asserted-rationale", rationale: "Owner approval was received." },
      consentActions: ["approve_execution", "complete_task"],
      paths: ["README.md"],
      prRef: null
    },
    externalCheckpointRefs: [],
    callerIdempotencyKey: `task-complete-${"4".repeat(64)}`,
    dryRun: false
  };
}

function forgeWitnessRef(ref: string, patch: Record<string, unknown>): string {
  const prefix = "ha-prepublish-witness-v1.";
  const decoded = decodePrepublishWitnessRef(ref);
  const { ref: _ref, ...payload } = decoded;
  return `${prefix}${Buffer.from(JSON.stringify({ ...payload, ...patch }), "utf8").toString("base64url")}`;
}

function gitInit(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true });
  execFileSync("git", ["-C", rootDir, "init", "-q", "-b", "main"]);
  git(rootDir, "config", "user.name", "Harness Test");
  git(rootDir, "config", "user.email", "harness@example.test");
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
