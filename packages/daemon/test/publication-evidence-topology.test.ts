// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scanFirstParentPublicationMetadata } from "../src/authority/production/publication-history.ts";
import { assertVerifiedGitObjectContent } from "../src/authority/production/publication-object-reader.ts";
import { useGitCanonicalPublicationInspector } from "../../../tools/publication-inspector-test-fixture.mjs";
import {
  authorityBatchTrailerName,
  buildAuthorityBatchIntegrity
} from "../../kernel/test/authority-batch-fixture.ts";

const opId = "namespace-test:publication-topology";
const posixTest = process.platform === "win32" ? test.skip : test;

test("publication object verification rejects same-size offset bytes", () => {
  const expected = Buffer.from("publication object\n");
  const requestedOid = createHash("sha1")
    .update(`blob ${expected.length}\0`)
    .update(expected)
    .digest("hex");
  const offset = Buffer.concat([expected.subarray(1), expected.subarray(0, 1)]);

  assert.throws(
    () => assertVerifiedGitObjectContent({
      requestedOid,
      objectType: "blob",
      declaredSize: expected.length,
      content: offset,
      trailingByte: 0x0a
    }),
    /AUTHORITY_GIT_OBJECT_HASH_MISMATCH/u
  );
});

test("publication object verification requires LF immediately after content", () => {
  const content = Buffer.from("publication object\n");
  const requestedOid = createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");

  assert.throws(
    () => assertVerifiedGitObjectContent({
      requestedOid,
      objectType: "blob",
      declaredSize: content.length,
      content,
      trailingByte: 0x00
    }),
    /AUTHORITY_GIT_OBJECT_TRAILING_LF_MISSING/u
  );
});

test("publication proof accepts the existing two-parent materializer shape", async (context) => {
  const fixture = publicationFixture(context);

  const evidence = await fixture.inspector.inspectPublication(fixture.base, [opId], fixture.validMerge);

  assert.equal(evidence.commitSha, fixture.validMerge);
  assert.deepEqual(evidence.parentCommits, [fixture.base, fixture.session]);
  assert.deepEqual(evidence.pipelineGeneratedPaths, [attributionPath(opId)]);
});

test("publication proof accepts a two-parent semantic merge with the complete session message", async (context) => {
  const fixture = publicationFixture(context);
  const semanticMerge = commitTree(
    fixture.root,
    fixture.sessionTree,
    [fixture.base, fixture.session],
    fixture.sessionMessage
  );
  const evidence = await fixture.inspector.inspectPublication(fixture.base, [opId], semanticMerge);

  assert.equal(evidence.commitSha, semanticMerge);
  assert.deepEqual(evidence.parentCommits, [fixture.base, fixture.session]);
});

test("publication proof accepts two interleaved sessions from their captured trunk", async (context) => {
  const fixture = publicationFixture(context);
  const interleavedOpId = "namespace-test:interleaved-publication";
  fixtureGit(fixture.root, "checkout", "-q", "--detach", fixture.base);
  mkdirSync(path.join(fixture.root, "tasks/task_topology"), { recursive: true });
  writeFileSync(path.join(fixture.root, "tasks/task_topology/progress.md"), "interleaved\n");
  const interleavedAttributionPath = attributionPath(interleavedOpId);
  mkdirSync(path.dirname(path.join(fixture.root, interleavedAttributionPath)), { recursive: true });
  writeFileSync(path.join(fixture.root, interleavedAttributionPath), "{\"schema\":\"attribution-event/v1\"}\n");
  fixtureGit(fixture.root, "add", "--", ".");
  fixtureGit(fixture.root, "commit", "-q", "-m", semanticMessage(interleavedOpId));
  const interleavedSession = fixtureGit(fixture.root, "rev-parse", "HEAD");
  const interleavedTree = fixtureGit(fixture.root, "rev-parse", "HEAD^{tree}");
  fixtureGit(fixture.root, "checkout", "-q", "master");
  const interleavedMerge = commitTree(
    fixture.root,
    interleavedTree,
    [fixture.base, interleavedSession],
    "materializer: merge session interleaved"
  );
  const [firstEvidence, interleavedEvidence] = await Promise.all([
    fixture.inspector.inspectPublication(fixture.base, [opId], fixture.validMerge),
    fixture.inspector.inspectPublication(fixture.base, [interleavedOpId], interleavedMerge)
  ]);

  assert.equal(firstEvidence.commitSha, fixture.validMerge);
  assert.equal(interleavedEvidence.commitSha, interleavedMerge);
  assert.deepEqual(interleavedEvidence.pipelineGeneratedPaths, [interleavedAttributionPath]);
  assert.equal(interleavedEvidence.physicalChanges.some((change) => change.path === attributionPath(opId)), false);
});

test("first-parent recovery accepts an old-shape merge immediately after its watermark", async (context) => {
  const fixture = publicationFixture(context);
  fixtureGit(fixture.root, "update-ref", "refs/heads/master", fixture.validMerge);
  const scan = await fixture.inspector.scanFirstParentOperationAnchors({
    exclusiveCommit: fixture.base,
    interestedOpIds: new Set([opId]),
    progressBatchSize: 1
  });

  assert.equal(scan.headCommit, fixture.validMerge);
  assert.equal(scan.scannedCommitCount, 1);
  assert.deepEqual(scan.anchors, [{
    commitSha: fixture.validMerge,
    previousCommit: fixture.base,
    opIds: [opId]
  }]);
});

test("first-parent recovery crosses an old merge to semantic merge watermark boundary", async (context) => {
  const fixture = publicationFixture(context);
  const nextOpId = "namespace-test:semantic-boundary";
  const nextSession = commitTree(
    fixture.root,
    fixture.sessionTree,
    [fixture.validMerge],
    semanticMessage(nextOpId)
  );
  const nextMerge = commitTree(
    fixture.root,
    fixture.sessionTree,
    [fixture.validMerge, nextSession],
    semanticMessage(nextOpId)
  );
  fixtureGit(fixture.root, "update-ref", "refs/heads/master", nextMerge);
  const scan = await fixture.inspector.scanFirstParentOperationAnchors({
    exclusiveCommit: fixture.validMerge,
    interestedOpIds: new Set([nextOpId]),
    progressBatchSize: 1
  });

  assert.equal(scan.headCommit, nextMerge);
  assert.deepEqual(scan.anchors, [{
    commitSha: nextMerge,
    previousCommit: fixture.validMerge,
    opIds: [nextOpId]
  }]);
});

test("semantic merge rejects a changed or incomplete authority message", async (context) => {
  const fixture = publicationFixture(context);
  const changedMessage = commitTree(
    fixture.root,
    fixture.sessionTree,
    [fixture.base, fixture.session],
    `${fixture.sessionMessage}\n\nunexpected`
  );
  const missingTrailer = commitTree(
    fixture.root,
    fixture.sessionTree,
    [fixture.base, fixture.session],
    `task(progress-append): task_topology progress.md [${opId}]`
  );
  await assert.rejects(
    fixture.inspector.inspectPublication(fixture.base, [opId], changedMessage),
    topologyError
  );
  await assert.rejects(
    fixture.inspector.inspectPublication(fixture.base, [opId], missingTrailer),
    topologyError
  );
});

test("publication proof rejects a single-parent publication", async (context) => {
  const fixture = publicationFixture(context);
  const singleParent = commitTree(
    fixture.root,
    fixture.sessionTree,
    [fixture.base],
    "materializer: merge session topology"
  );

  await assert.rejects(
    fixture.inspector.inspectPublication(fixture.base, [opId], singleParent),
    topologyError
  );
});

test("publication proof rejects a merge whose first parent is not the expected trunk", async (context) => {
  const fixture = publicationFixture(context);
  const intervening = commitTree(
    fixture.root,
    fixture.baseTree,
    [fixture.base],
    "intervening trunk commit"
  );
  const wrongFirstParent = commitTree(
    fixture.root,
    fixture.sessionTree,
    [intervening, fixture.session],
    "materializer: merge session topology"
  );

  await assert.rejects(
    fixture.inspector.inspectPublication(fixture.base, [opId], wrongFirstParent),
    topologyError
  );
});

test("publication proof accepts a strongly matched session based on an older trunk", async (context) => {
  const fixture = publicationFixture(context);
  const currentTrunk = commitTree(
    fixture.root,
    fixture.baseTree,
    [fixture.base],
    "current trunk"
  );
  const staleSessionMerge = commitTree(
    fixture.root,
    fixture.sessionTree,
    [currentTrunk, fixture.session],
    "materializer: merge session topology"
  );

  const evidence = await fixture.inspector.inspectPublication(currentTrunk, [opId], staleSessionMerge);

  assert.equal(evidence.commitSha, staleSessionMerge);
  assert.deepEqual(evidence.parentCommits, [currentTrunk, fixture.session]);
  assert.deepEqual(
    new Set(evidence.physicalChanges.map((change) => change.path)),
    new Set(["tasks/task_topology/progress.md", attributionPath(opId)])
  );
  for (const change of evidence.physicalChanges) {
    assert.equal(change.beforeDigest, null, `${change.path} is absent from the older publication base`);
    assert.match(change.afterDigest ?? "", /^[a-f0-9]{64}$/u);
  }
});

test("exact topology lookup accepts a byte-identical session delta over an advanced canonical parent", async (context) => {
  const fixture = publicationFixture(context);
  writeFileSync(path.join(fixture.root, "prior-evidence.txt"), "prior evidence\n");
  fixtureGit(fixture.root, "add", "--", "prior-evidence.txt");
  fixtureGit(fixture.root, "commit", "-q", "-m", "authority: prior evidence");
  const currentTrunk = fixtureGit(fixture.root, "rev-parse", "HEAD");
  fixtureGit(
    fixture.root,
    "merge",
    "--no-ff",
    "sessions/topology",
    "-m",
    fixture.sessionMessage
  );
  const merged = fixtureGit(fixture.root, "rev-parse", "HEAD");

  const evidence = await fixture.inspector.findDurableSuccessorTopologyForOperation!(opId, merged);

  assert.deepEqual(evidence.parentCommits, [currentTrunk, fixture.session]);
  assert.deepEqual(evidence.physicalChanges, []);
});

test("exact topology lookup retains every operation from a multi-commit session branch", async (context) => {
  const fixture = publicationFixture(context);
  const nextOpId = "namespace-test:publication-topology-next";
  fixtureGit(fixture.root, "checkout", "-q", "sessions/topology");
  writeFileSync(path.join(fixture.root, "tasks/task_topology/progress.md"), "publication\nnext\n");
  const nextAttributionPath = attributionPath(nextOpId);
  writeFileSync(path.join(fixture.root, nextAttributionPath), "{\"schema\":\"attribution-event/v1\"}\n");
  fixtureGit(fixture.root, "add", "--", ".");
  fixtureGit(fixture.root, "commit", "-q", "-m", semanticMessage(nextOpId));
  fixtureGit(fixture.root, "checkout", "-q", "master");
  fixtureGit(fixture.root, "merge", "--no-ff", "sessions/topology", "-m", "materializer: merge multi-commit session");
  const merged = fixtureGit(fixture.root, "rev-parse", "HEAD");

  const evidence = await fixture.inspector.findDurableSuccessorTopologyForOperation!(opId, merged);

  assert.deepEqual(evidence.opIds, [opId, nextOpId]);
  assert.deepEqual(evidence.physicalChanges, []);
});

test("publication proof rejects a merge tree that differs from the session tree", async (context) => {
  const fixture = publicationFixture(context);
  const mismatchedTree = commitTree(
    fixture.root,
    fixture.baseTree,
    [fixture.base, fixture.session],
    "materializer: merge session topology"
  );

  await assert.rejects(
    fixture.inspector.inspectPublication(fixture.base, [opId], mismatchedTree),
    topologyError
  );
});

test("indexed publication lookup preserves message and tree topology checks", async (context) => {
  const fixture = publicationFixture(context);
  const changedMessage = commitTree(
    fixture.root,
    fixture.sessionTree,
    [fixture.base, fixture.session],
    `${fixture.sessionMessage}\n\nunexpected`
  );
  fixtureGit(fixture.root, "update-ref", "refs/heads/master", changedMessage);

  await assert.rejects(
    fixture.inspector.findPublicationForOperation(opId),
    topologyError
  );

  const mismatchedTree = commitTree(
    fixture.root,
    fixture.baseTree,
    [fixture.base, fixture.session],
    "materializer: merge session topology"
  );
  fixtureGit(fixture.root, "update-ref", "refs/heads/master", mismatchedTree);

  await assert.rejects(
    fixture.inspector.findPublicationForOperation(opId),
    topologyError
  );
});

posixTest("missing indexed session metadata preserves the Git message fallback", async (context) => {
  const fixture = publicationFixture(context);
  fixtureGit(fixture.root, "update-ref", "refs/heads/master", fixture.validMerge);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const binDir = mkdtempSync(path.join(tmpdir(), "ha-publication-git-wrapper-"));
  context.after(() => rmSync(binDir, { recursive: true, force: true }));
  const wrapperPath = path.join(binDir, "git");
  writeFileSync(wrapperPath, [
    "#!/bin/sh",
    "for arg in \"$@\"; do",
    "  if [ \"$arg\" = \"--no-walk=unsorted\" ]; then exit 0; fi",
    "done",
    `exec ${JSON.stringify(realGit)} "$@"`,
    ""
  ].join("\n"));
  chmodSync(wrapperPath, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
  let commits;
  try {
    commits = await scanFirstParentPublicationMetadata({
      rootDir: fixture.root,
      headCommit: fixture.validMerge
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  const metadata = commits.find((commit) => commit.commitSha === fixture.validMerge);
  assert.ok(metadata);
  let fallbackObserved = false;
  const sessionMessage = metadata.sessionMessage ?? (() => {
    fallbackObserved = true;
    return fixture.sessionMessage;
  })();
  assert.equal(fallbackObserved, true);
  assert.equal(sessionMessage, fixture.sessionMessage);
});

test("publication proof rejects a publication missing its inline attribution shard", async (context) => {
  const fixture = publicationFixture(context, { includeAttribution: false });

  await assert.rejects(
    fixture.inspector.inspectPublication(fixture.base, [opId], fixture.validMerge),
    /AUTHORITY_CANONICAL_PUBLICATION_PIPELINE_EVIDENCE_MISMATCH/u
  );
});

function publicationFixture(
  context: Parameters<typeof test>[1] extends (context: infer Context) => unknown ? Context : never,
  options: { readonly includeAttribution?: boolean } = {}
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-publication-topology-"));
  const inspector = useGitCanonicalPublicationInspector(context, { rootDir: root });
  fixtureGit(root, "init", "-q", "-b", "master");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  fixtureGit(root, "add", "--", "seed.txt");
  fixtureGit(root, "commit", "-q", "-m", "seed");
  const base = fixtureGit(root, "rev-parse", "HEAD");
  const baseTree = fixtureGit(root, "rev-parse", "HEAD^{tree}");

  fixtureGit(root, "checkout", "-q", "-b", "sessions/topology");
  mkdirSync(path.join(root, "tasks/task_topology"), { recursive: true });
  writeFileSync(path.join(root, "tasks/task_topology/progress.md"), "publication\n");
  if (options.includeAttribution !== false) {
    const relativePath = attributionPath(opId);
    mkdirSync(path.dirname(path.join(root, relativePath)), { recursive: true });
    writeFileSync(path.join(root, relativePath), "{\"schema\":\"attribution-event/v1\"}\n");
  }
  fixtureGit(root, "add", "--", ".");
  const sessionMessage = semanticMessage(opId);
  fixtureGit(root, "commit", "-q", "-m", sessionMessage);
  const session = fixtureGit(root, "rev-parse", "HEAD");
  const sessionTree = fixtureGit(root, "rev-parse", "HEAD^{tree}");
  fixtureGit(root, "checkout", "-q", "master");

  const validMerge = commitTree(
    root,
    sessionTree,
    [base, session],
    "materializer: merge session topology"
  );
  return { root, inspector, base, baseTree, session, sessionTree, sessionMessage, validMerge };
}

function semanticMessage(value: string): string {
  const integrity = buildAuthorityBatchIntegrity([{
    opId: value,
    semanticMutationSetDigest: "ab".repeat(32)
  }]);
  return `task(progress-append): task_topology progress.md [${value}]\n\n${authorityBatchTrailerName}: ${integrity.trailerValue}`;
}

function attributionPath(value: string): string {
  return `attribution-events/${createHash("sha256").update(value).digest("hex")}.jsonl`;
}

function commitTree(
  root: string,
  tree: string,
  parents: ReadonlyArray<string>,
  message: string
): string {
  return fixtureGit(
    root,
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    message
  );
}

function topologyError(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith("AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR;");
}

function fixtureGit(root: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-C", root,
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness@example.test",
    "-c", "commit.gpgSign=false",
    ...args
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  }).trim();
}
