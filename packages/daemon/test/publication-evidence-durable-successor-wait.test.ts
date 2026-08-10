// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text } from "@harness-anything/kernel";
import {
  AuthorityCanonicalPublicationNotFoundError,
  createGitCanonicalPublicationInspector
} from "../src/authority/production/publication-evidence.ts";
import {
  authorityBatchTrailerName,
  buildAuthorityBatchIntegrity
} from "../../kernel/test/authority-batch-fixture.ts";
import { removeTemporaryTestRoot } from "../../../tools/test-temp-root-cleanup.mjs";

test("durable successor lookup waits for its committed merge to reach canonical history", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-successor-wait-"));
  const firstOpId = "namespace:test-delayed-successor-first";
  git(root, "init", "-q", "-b", "master");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", "--", "seed.txt");
  git(root, "commit", "-q", "-m", "seed");
  const base = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "sessions/delayed-successor");
  appendAuthorityBatch(root, firstOpId, "first.txt");
  const session = git(root, "rev-parse", "HEAD");
  const sessionTree = git(root, "rev-parse", "HEAD^{tree}");
  git(root, "checkout", "-q", "master");
  const merge = git(
    root,
    "commit-tree",
    sessionTree,
    "-p",
    base,
    "-p",
    session,
    "-m",
    semanticMessage(firstOpId)
  );

  let waits = 0;
  const inspector = createGitCanonicalPublicationInspector(root, {
    durableSuccessorRetry: {
      maxRetries: 1,
      sleep: async () => {
        waits += 1;
        git(root, "update-ref", "refs/heads/master", merge, base);
      }
    }
  });
  context.after(async () => {
    await inspector.shutdown();
    await removeTemporaryTestRoot(root);
  });

  const evidence = await inspector.findDurableSuccessorPublicationForOperation(firstOpId, merge);

  assert.equal(waits, 1);
  assert.equal(evidence.commitSha, merge);
  assert.equal(evidence.previousCommit, base);
  assert.deepEqual(evidence.opIds, [firstOpId]);
});

test("durable successor lookup rejects a visible merge without a materializer message proof", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-successor-message-"));
  const opId = "namespace:test-successor-message";
  git(root, "init", "-q", "-b", "master");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", "--", "seed.txt");
  git(root, "commit", "-q", "-m", "seed");
  const base = git(root, "rev-parse", "HEAD");

  git(root, "checkout", "-q", "-b", "sessions/invalid-message");
  appendAuthorityBatch(root, opId, "message.txt");
  const session = git(root, "rev-parse", "HEAD");
  const sessionTree = git(root, "rev-parse", "HEAD^{tree}");
  git(root, "checkout", "-q", "master");
  const merge = git(
    root,
    "commit-tree",
    sessionTree,
    "-p",
    base,
    "-p",
    session,
    "-m",
    "ordinary merge without materializer proof"
  );
  git(root, "update-ref", "refs/heads/master", merge, base);

  let waits = 0;
  const inspector = createGitCanonicalPublicationInspector(root, {
    durableSuccessorRetry: {
      maxRetries: 1,
      sleep: async () => {
        waits += 1;
      }
    }
  });
  context.after(async () => {
    await inspector.shutdown();
    await removeTemporaryTestRoot(root);
  });

  await assert.rejects(
    inspector.findDurableSuccessorPublicationForOperation(opId, merge),
    AuthorityCanonicalPublicationNotFoundError
  );
  assert.equal(waits, 0);
});

test("durable successor lookup preserves NOT_FOUND after pending visibility retries are exhausted", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "publication-successor-missing-"));
  const opId = "namespace:test-missing-successor";
  git(root, "init", "-q", "-b", "master");
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(root, "add", "--", "seed.txt");
  git(root, "commit", "-q", "-m", "seed");

  let waits = 0;
  const inspector = createGitCanonicalPublicationInspector(root, {
    durableSuccessorRetry: {
      maxRetries: 1,
      sleep: async () => {
        waits += 1;
      }
    }
  });
  context.after(async () => {
    await inspector.shutdown();
    await removeTemporaryTestRoot(root);
  });

  await assert.rejects(
    inspector.findDurableSuccessorPublicationForOperation(opId, "f".repeat(40)),
    (error) => error instanceof AuthorityCanonicalPublicationNotFoundError
      && error.opId === opId
  );
  assert.equal(waits, 1);
});

function appendAuthorityBatch(root: string, opId: string, fileName: string): void {
  mkdirSync(path.join(root, "tasks", "task_successor"), { recursive: true });
  writeFileSync(path.join(root, "tasks", "task_successor", fileName), `${opId}\n`);
  const attributionPath = path.join(root, "attribution-events", `${sha256Text(opId)}.jsonl`);
  mkdirSync(path.dirname(attributionPath), { recursive: true });
  writeFileSync(attributionPath, `${JSON.stringify({ schema: "attribution-event/v1", opId })}\n`);
  git(root, "add", "--", ".");
  git(root, "commit", "-q", "-m", semanticMessage(opId));
}

function semanticMessage(opId: string): string {
  const integrity = buildAuthorityBatchIntegrity([{
    opId,
    semanticMutationSetDigest: "ab".repeat(32)
  }]);
  return `task(progress-append): task_successor progress.md [${opId}]\n\n${authorityBatchTrailerName}: ${integrity.trailerValue}`;
}

function git(root: string, ...args: ReadonlyArray<string>): string {
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
