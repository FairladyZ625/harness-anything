// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Effect } from "effect";
import {
  CODE_DOC_RECONCILIATION_DOCUMENT,
  renderCodeDocReconciliationDraft,
  type TaskCompleteTransitionCommand
} from "../../application/src/index.ts";
import {
  makeJournaledWriteCoordinator,
  taskEntityId,
  type WriteOp
} from "../../kernel/src/index.ts";
import {
  decodePrepublishWitnessRef,
  produceCodeDocWitness,
  produceDocumentPublicationWitness,
  verifyTaskCompleteWitnessRefs
} from "../src/authority/production/task-complete-prepublish-witness.ts";
import {
  createRepoWriteTelemetryDelivery,
  runWithRepoWriteTelemetry
} from "../src/runtime/repo-write-telemetry-context.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";

test("daemon-produced prepublish witnesses bind immutable publication history, covered blobs, and code intent", async () => {
  const fixture = witnessRepository();
  try {
    const document = await produceDocumentPublicationWitness(fixture);
    const codeDoc = await produceCodeDocWitness(fixture);
    const verified = await verifyTaskCompleteWitnessRefs({
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
    await assert.rejects(() => verifyTaskCompleteWitnessRefs({
      ...fixture,
      requireCodeDoc: true,
      refs: [
        { kind: "document-publication", ref: forged },
        { kind: "code-doc-reconciliation", ref: codeDoc.ref }
      ]
    }), /WITNESS_COMMIT_NOT_PATH_ATTRIBUTED/u);

    await assert.rejects(() => verifyTaskCompleteWitnessRefs({
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

test("one multi-path publication proof reads attribution history in one raw pass", async () => {
  const fixture = witnessRepository();
  try {
    const traced = await withTracedGit(fixture.fixtureRoot, 0, () =>
      Promise.resolve(produceDocumentPublicationWitness(fixture))
    );
    const historyCalls = traced.events.filter((event) =>
      event.event === "start"
      && event.args.includes("log")
      && event.args.includes("--first-parent")
    );
    const treeCalls = traced.events.filter((event) =>
      event.event === "start" && event.args.includes("ls-tree")
    );
    assert.equal(historyCalls.length, 1, JSON.stringify(historyCalls));
    assert.equal(historyCalls[0]!.args.includes("--raw"), true, JSON.stringify(historyCalls));
    assert.equal(treeCalls.length, fixture.documents.length + 1, JSON.stringify(treeCalls));
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("history telemetry is delivered before a delayed Git history call completes", async () => {
  const fixture = witnessRepository();
  try {
    let proofSettled = false;
    let observeHistoryStart!: () => void;
    const historyStart = new Promise<void>((resolve) => { observeHistoryStart = resolve; });
    const delivery = createRepoWriteTelemetryDelivery({
      deliverBatch: async () => undefined,
      deliverStream: async (_phase, _elapsedMs, details) => {
        if (details?.stage === "history-start") observeHistoryStart();
      },
      streamAfterMs: 20
    });
    const traced = withTracedGit(fixture.fixtureRoot, 300, async (tracePath) => {
      const proof = Promise.resolve(runWithRepoWriteTelemetry(delivery.report, () =>
        produceDocumentPublicationWitness(fixture)
      )).finally(() => { proofSettled = true; });
      try {
        await withTimeout(
          historyStart,
          1_000,
          "history-start telemetry was not delivered while Git was running"
        );
        await waitForTraceEvent(tracePath, (event) => event.event === "start" && event.delayed);
        const duringGit = readTraceEvents(tracePath);
        const delayedEnds = duringGit.filter((event) => event.event === "done" && event.delayed);
        assert.equal(proofSettled, false);
        assert.equal(delayedEnds.length, 0);
      } finally {
        await proof;
      }
    });
    await traced;
    await delivery.flush();
    delivery.close();
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("document publication remains verifiable without machine-local write payloads", async () => {
  const fixture = witnessRepository();
  try {
    rmSync(path.join(fixture.rootDir, ".harness", "write-journal", "payloads"), {
      recursive: true,
      force: true
    });

    const document = await produceDocumentPublicationWitness(fixture);
    assert.deepEqual(document.publicationOperationIds, ["op_code_doc", "op_document"]);
    const verified = await verifyTaskCompleteWitnessRefs({
      ...fixture,
      requireCodeDoc: false,
      refs: [{ kind: "document-publication", ref: document.ref }]
    });
    assert.deepEqual(verified.map((entry) => entry.kind), ["document-publication"]);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("committed replay rejects a forged merge whose authority parent never changed the task documents", async () => {
  const fixture = witnessRepository();
  try {
    const document = await produceDocumentPublicationWitness(fixture);
    const taskRoot = path.join(fixture.authoredRoot, "tasks", `${taskId}-witness`);
    const closeout = fixture.documents.find((entry) => entry.path === "closeout.md")!.body;
    writeFileSync(path.join(taskRoot, "closeout.md"), "# Closeout\n\nRaw first-parent rollback.\n");
    git(fixture.authoredRoot, "add", ".");
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: raw first-parent rollback");

    git(fixture.authoredRoot, "checkout", "-q", "-b", "forged-publication");
    writeFileSync(path.join(fixture.authoredRoot, "unrelated.txt"), "second parent never changed task documents\n");
    git(fixture.authoredRoot, "add", ".");
    git(fixture.authoredRoot, "commit", "-q", "-m", "test: unrelated authority parent");
    git(fixture.authoredRoot, "checkout", "-q", "main");
    git(fixture.authoredRoot, "merge", "-q", "--no-ff", "--no-commit", "forged-publication");
    writeFileSync(path.join(taskRoot, "closeout.md"), closeout);
    git(fixture.authoredRoot, "add", ".");
    git(fixture.authoredRoot, "commit", "-q", "-m", "materialize forged task documents [op_forged]");
    const forgedCommit = git(fixture.authoredRoot, "rev-parse", "HEAD");
    const forged = forgeWitnessRef(document.ref, {
      repositoryCommit: forgedCommit,
      publicationOperationIds: ["op_forged"]
    });

    await assert.rejects(() => verifyTaskCompleteWitnessRefs({
      ...fixture,
      requireCodeDoc: false,
      refs: [{ kind: "document-publication", ref: forged }],
      snapshotMode: "committed"
    }), /WITNESS_COMMIT_NOT_PATH_ATTRIBUTED/u);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("unpublished document rejection stays bounded with 1011 unrelated first-parent materializations", async () => {
  const fixture = unpublishedScaleWitnessRepository(1_011, 11);
  try {
    const startedAt = performance.now();
    await assert.rejects(
      () => produceDocumentPublicationWitness(fixture),
      /AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED/u
    );
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 5_000, `unpublished witness rejection took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("unpublished document rejection names only the path whose body is not materialized", async () => {
  const fixture = witnessRepository();
  try {
    const documents = fixture.documents.map((document) => document.path === "closeout.md"
      ? { ...document, body: `${document.body}\nUnpublished mutation.\n` }
      : document);
    await assert.rejects(
      () => produceDocumentPublicationWitness({ ...fixture, documents }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /closeout\.md/u);
        assert.doesNotMatch(message, /code-doc-anchors\.json/u);
        assert.match(message, /content differs from expected/u);
        assert.deepEqual(
          (error as { readonly details?: unknown }).details,
          {
            schema: "task-complete-prepublish-failure/v1",
            code: "task_complete_prepublish_not_materialized",
            files: [{
              path: `tasks/${taskId}-witness/closeout.md`,
              reason: "content differs from expected"
            }]
          }
        );
        return true;
      }
    );
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("a later publication cannot attribute an unchanged raw task document", async () => {
  const fixture = partiallyPublishedWitnessRepository();
  try {
    await assert.rejects(
      () => produceDocumentPublicationWitness(fixture),
      /AUTHORITY_TASK_COMPLETE_PREPUBLISH_NOT_MATERIALIZED:[^\n]*task_plan\.md/u
    );
  } finally {
    rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
});

test("code-doc reconciliation rejection names the approval intent and current anchors", async () => {
  const fixture = witnessRepository();
  try {
    const command = {
      ...fixture.command,
      approval: {
        ...fixture.command.approval!,
        paths: ["src/other.ts"]
      }
    };
    await assert.rejects(
      () => produceCodeDocWitness({ ...fixture, command }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /approval intent/u);
        assert.match(message, /src\/other\.ts/u);
        assert.match(message, /current code-doc/u);
        assert.match(message, /README\.md/u);
        return true;
      }
    );
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

  publishTaskDocumentOps(rootDir, "witness-publication", [
    taskDocumentOp("op_code_doc", "code_doc_reconcile", CODE_DOC_RECONCILIATION_DOCUMENT, codeDoc.body),
    taskDocumentOp("op_document", "doc_write", "closeout.md", closeout)
  ]);

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

function partiallyPublishedWitnessRepository() {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-prepublish-partial-"));
  const rootDir = path.join(fixtureRoot, "workspace");
  const authoredRoot = path.join(rootDir, "harness");
  const taskRoot = path.join(authoredRoot, "tasks", `${taskId}-partial`);
  mkdirSync(taskRoot, { recursive: true });
  gitInit(authoredRoot);

  const taskPlan = "# Plan\n\nRaw task plan that has never entered the governed write road.\n";
  const originalCloseout = "# Closeout\n\nOriginal closeout.\n";
  const publishedCloseout = "# Closeout\n\nGoverned closeout.\n";
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Partial publication fixture",
    "lifecycle:",
    "  engine: local",
    "  status: in_review",
    "---",
    "",
    "# Partial publication fixture",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskRoot, "task_plan.md"), taskPlan);
  writeFileSync(path.join(taskRoot, "closeout.md"), originalCloseout);
  git(authoredRoot, "add", ".");
  git(authoredRoot, "commit", "-q", "-m", "test: raw task documents");

  publishTaskDocumentOps(rootDir, "partial-publication", [
    taskDocumentOp("op_closeout", "doc_write", "closeout.md", publishedCloseout)
  ]);

  return {
    fixtureRoot,
    rootDir,
    authoredRoot,
    taskId,
    documents: [
      { path: "closeout.md", body: publishedCloseout },
      { path: "task_plan.md", body: taskPlan }
    ]
  };
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

function taskDocumentOp(
  opId: string,
  kind: "doc_write" | "code_doc_reconcile",
  documentPath: string,
  body: string
): WriteOp {
  return {
    opId,
    entityId: taskEntityId(taskId),
    kind,
    payload: { path: documentPath, body }
  };
}

function publishTaskDocumentOps(
  rootDir: string,
  sessionId: string,
  operations: ReadonlyArray<WriteOp>
): void {
  const coordinator = makeJournaledWriteCoordinator({
    rootDir,
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person_test" },
        executor: { kind: "agent", id: "witness-fixture" }
      },
      principalSource: {
        kind: "local-configured",
        authority: "harness.yaml",
        authoritySha256: `sha256:${"0".repeat(64)}`
      },
      executorSource: "client-asserted"
    },
    sessionId,
    commitAuthor: { name: "Harness Test", email: "harness@example.test" }
  });
  for (const operation of operations) Effect.runSync(coordinator.enqueue(operation));
  Effect.runSync(coordinator.flush("explicit"));
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

interface GitTraceEvent {
  readonly event: "start" | "done";
  readonly args: ReadonlyArray<string>;
  readonly delayed: boolean;
}

async function withTracedGit<Result>(
  fixtureRoot: string,
  historyDelayMs: number,
  operation: (tracePath: string) => Promise<Result>
): Promise<{ readonly result: Result; readonly events: ReadonlyArray<GitTraceEvent> }> {
  const wrapperRoot = path.join(fixtureRoot, "git-wrapper");
  const wrapperPath = path.join(wrapperRoot, "git");
  const tracePath = path.join(fixtureRoot, "git-trace.jsonl");
  mkdirSync(wrapperRoot, { recursive: true });
  writeFileSync(wrapperPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const delayed = args.includes("log") && args.includes("--first-parent");
appendFileSync(process.env.HA_TEST_GIT_TRACE, JSON.stringify({ event: "start", args, delayed }) + "\\n");
if (delayed && Number(process.env.HA_TEST_GIT_HISTORY_DELAY_MS) > 0) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HA_TEST_GIT_HISTORY_DELAY_MS));
}
const result = spawnSync(process.env.HA_TEST_REAL_GIT, args, { stdio: "inherit" });
appendFileSync(process.env.HA_TEST_GIT_TRACE, JSON.stringify({ event: "done", args, delayed }) + "\\n");
process.exit(result.status ?? 1);
`);
  chmodSync(wrapperPath, 0o755);
  const previous = {
    path: process.env.PATH,
    trace: process.env.HA_TEST_GIT_TRACE,
    realGit: process.env.HA_TEST_REAL_GIT,
    delay: process.env.HA_TEST_GIT_HISTORY_DELAY_MS
  };
  const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
  process.env.PATH = `${wrapperRoot}${path.delimiter}${previous.path ?? ""}`;
  process.env.HA_TEST_GIT_TRACE = tracePath;
  process.env.HA_TEST_REAL_GIT = realGit;
  process.env.HA_TEST_GIT_HISTORY_DELAY_MS = String(historyDelayMs);
  try {
    const result = await operation(tracePath);
    return { result, events: readTraceEvents(tracePath) };
  } finally {
    restoreEnvironment("PATH", previous.path);
    restoreEnvironment("HA_TEST_GIT_TRACE", previous.trace);
    restoreEnvironment("HA_TEST_REAL_GIT", previous.realGit);
    restoreEnvironment("HA_TEST_GIT_HISTORY_DELAY_MS", previous.delay);
  }
}

function readTraceEvents(tracePath: string): ReadonlyArray<GitTraceEvent> {
  try {
    return readFileSync(tracePath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GitTraceEvent);
  } catch {
    return [];
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForTraceEvent(
  tracePath: string,
  predicate: (event: GitTraceEvent) => boolean
): Promise<void> {
  await withTimeout(new Promise<void>((resolve) => {
    const poll = () => {
      if (readTraceEvents(tracePath).some(predicate)) resolve();
      else setTimeout(poll, 5);
    };
    poll();
  }), 1_000, "delayed Git history call did not start");
}

async function withTimeout<Result>(promise: Promise<Result>, timeoutMs: number, message: string): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
