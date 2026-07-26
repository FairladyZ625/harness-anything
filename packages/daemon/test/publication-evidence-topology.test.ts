// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createGitCanonicalPublicationInspector } from "../src/authority/production/publication-evidence.ts";
import {
  authorityBatchTrailerName,
  buildAuthorityBatchIntegrity
} from "../../kernel/src/integrity/authority-batch-integrity.ts";

const opId = "namespace-test:publication-topology";

test("publication proof accepts the existing two-parent materializer shape", async (context) => {
  const fixture = publicationFixture(context);
  const inspector = createGitCanonicalPublicationInspector(fixture.root);

  const evidence = await inspector.inspectPublication(fixture.base, [opId], fixture.validMerge);

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
  const inspector = createGitCanonicalPublicationInspector(fixture.root);

  const evidence = await inspector.inspectPublication(fixture.base, [opId], semanticMerge);

  assert.equal(evidence.commitSha, semanticMerge);
  assert.deepEqual(evidence.parentCommits, [fixture.base, fixture.session]);
});

test("first-parent recovery accepts an old-shape merge immediately after its watermark", async (context) => {
  const fixture = publicationFixture(context);
  fixtureGit(fixture.root, "update-ref", "refs/heads/master", fixture.validMerge);
  const inspector = createGitCanonicalPublicationInspector(fixture.root);

  const scan = await inspector.scanFirstParentOperationAnchors({
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
  const inspector = createGitCanonicalPublicationInspector(fixture.root);

  const scan = await inspector.scanFirstParentOperationAnchors({
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
  const inspector = createGitCanonicalPublicationInspector(fixture.root);

  await assert.rejects(
    inspector.inspectPublication(fixture.base, [opId], changedMessage),
    topologyError
  );
  await assert.rejects(
    inspector.inspectPublication(fixture.base, [opId], missingTrailer),
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
    createGitCanonicalPublicationInspector(fixture.root)
      .inspectPublication(fixture.base, [opId], singleParent),
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
    createGitCanonicalPublicationInspector(fixture.root)
      .inspectPublication(fixture.base, [opId], wrongFirstParent),
    topologyError
  );
});

test("publication proof rejects a session commit based on an older trunk", async (context) => {
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

  await assert.rejects(
    createGitCanonicalPublicationInspector(fixture.root)
      .inspectPublication(currentTrunk, [opId], staleSessionMerge),
    topologyError
  );
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
    createGitCanonicalPublicationInspector(fixture.root)
      .inspectPublication(fixture.base, [opId], mismatchedTree),
    topologyError
  );
});

test("publication proof rejects a publication missing its inline attribution shard", async (context) => {
  const fixture = publicationFixture(context, { includeAttribution: false });

  await assert.rejects(
    createGitCanonicalPublicationInspector(fixture.root)
      .inspectPublication(fixture.base, [opId], fixture.validMerge),
    /AUTHORITY_CANONICAL_PUBLICATION_PIPELINE_EVIDENCE_MISMATCH/u
  );
});

function publicationFixture(
  context: Parameters<typeof test>[1] extends (context: infer Context) => unknown ? Context : never,
  options: { readonly includeAttribution?: boolean } = {}
) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-publication-topology-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
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
  return { root, base, baseTree, session, sessionTree, sessionMessage, validMerge };
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
