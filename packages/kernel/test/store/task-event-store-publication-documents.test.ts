// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  serializeCanonicalEvent,
  type DocEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import { freezeDeclaredWritePlan } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  contentObjectRelativePath,
  eventObjectRelativePath,
} from "../../src/layout/ledger-object-layout.ts";
import {
  CANONICAL_EVENT_REF,
  makeTaskEventStore,
} from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

import {
  bundle,
  docBundle,
  event,
  git,
  initRepo,
  snapshot,
} from "./task-event-store.fixtures.ts";
test("unified publication advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte", async (context) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft\n");
    writeFileSync(path.join(rootDir, "dirty.txt"), "dirty\n");
    git(rootDir, "add", "harness/context/user.md");
    git(rootDir, "commit", "-qm", "user prose");
    writeFileSync(
      path.join(rootDir, "harness/context/user.md"),
      "draft plus local edit\n",
    );
    const before = snapshot(rootDir),
      head = git(rootDir, "rev-parse", "HEAD"),
      store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      receipt = store.append(bundle(event)),
      after = snapshot(rootDir);
    assert.deepEqual(after.bytes, before.bytes);
    assert.equal(after.status, before.status);
    assert.equal(
      (after.index as string).includes(before.index as string),
      true,
    );
    assert.notEqual(git(rootDir, "rev-parse", "HEAD"), head);
    assert.equal(store.currentCommit().sha, git(rootDir, "rev-parse", "HEAD"));
    assert.equal(existsSync(path.join(rootDir, "harness/events")), true);
    assert.equal(
      git(
        rootDir,
        "show",
        `${CANONICAL_EVENT_REF}:harness/${eventObjectRelativePath(event.opId)}`,
      ),
      serializeCanonicalEvent(event).trimEnd(),
    );
    assert.equal(store.readTaskEvent(event.opId)?.opId, event.opId);
    const reopened = makeTaskEventStore({ repoId: "test-repo", rootDir });
    assert.deepEqual(reopened.append(bundle(event)).metrics.changedPaths, []);
    assert.throws(
      () =>
        reopened.append(
          bundle({
            ...event,
            payload: { task: { ...event.payload.task, title: "different" } },
          }),
        ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "op_conflict");
        return /different event/u.test(String(error));
      },
    );
    assert.equal(receipt.metrics.nodeSyncs, 4);
    context.diagnostic(
      `unified-publisher-git-processes=${receipt.metrics.gitProcesses}`,
    );
  });
});

test("doc event, content blob, and authored file publish in one default-branch canonical commit", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      base = store.currentCut(),
      body = "# Notes\n\nMore prose.\n",
      hash = sha256Text(body);
    const doc: DocEventV1 = {
      schema: "doc-event/v1",
      eventId: "doc-event-1",
      workspaceRevision: 1,
      opId: "doc-op-1",
      type: "documents_written",
      actor: event.actor,
      source: "local",
      occurredAt: event.occurredAt,
      payload: {
        executionId: "execution-1",
        baseLedgerSha: base,
        changes: [
          {
            path: "context/notes.md",
            baseBlobSha256: null,
            policyId: DOC_POLICY_ID,
            candidate: {
              sha256: hash,
              size: Buffer.byteLength(body),
              mediaType: "text/markdown",
            },
            regionProofs: [
              {
                regionId: "heading/notes",
                policyId: DOC_POLICY_ID,
                codecId: DOC_CODEC_ID,
                baseSha256: sha256Text(""),
                candidateSha256: hash,
                insertBytes: Buffer.byteLength(body),
              },
            ],
          },
        ],
      },
    };
    const plan = docSyncWritePlan(doc);
    assert.equal(
      plan.targets.some(
        (target) =>
          (target as { readonly kind: string; readonly path?: string }).kind ===
            "authored_file" &&
          (target as { readonly path?: string }).path === "context/notes.md",
      ),
      true,
    );
    const baseTargets = plan.targets.filter(
      (target) => target.kind !== "local_wal_file",
    );
    const extra = freezeDeclaredWritePlan(
        {
          commandType: "DocSyncSubmit",
          targets: [
            ...baseTargets,
            {
              kind: "content_blob",
              sha256: "f".repeat(64),
              size: 1,
              mediaType: "text/plain",
            },
          ],
        },
        ["DocSyncSubmit"],
      ),
      missing = freezeDeclaredWritePlan(
        {
          commandType: "DocSyncSubmit",
          targets: baseTargets.filter(
            (target) => target.kind !== "content_blob",
          ),
        },
        ["DocSyncSubmit"],
      ),
      before = store.currentCommit();
    assert.throws(
      () =>
        store.append({
          event: doc,
          plan: extra,
          blobs: [
            {
              sha256: hash,
              size: Buffer.byteLength(body),
              mediaType: "text/markdown",
              body,
            },
          ],
        }),
      /write plan/iu,
    );
    assert.deepEqual(store.currentCommit(), before);
    assert.throws(
      () =>
        store.append({
          event: doc,
          plan: missing,
          blobs: [
            {
              sha256: hash,
              size: Buffer.byteLength(body),
              mediaType: "text/markdown",
              body,
            },
          ],
        }),
      /write plan/iu,
    );
    assert.deepEqual(store.currentCommit(), before);
    assert.throws(() =>
      (plan.targets as unknown as unknown[]).push(extra.targets.at(-1)),
    );
    assert.deepEqual(store.currentCommit(), before);
    const receipt = store.append({
      event: doc,
      plan,
      blobs: [
        {
          sha256: hash,
          size: Buffer.byteLength(body),
          mediaType: "text/markdown",
          body,
        },
      ],
    });
    const branchRef = git(rootDir, "symbolic-ref", "HEAD");
    assert.equal(git(rootDir, "rev-parse", branchRef), receipt.commitSha.sha);
    assert.equal(
      git(rootDir, "rev-parse", CANONICAL_EVENT_REF),
      receipt.commitSha.sha,
    );
    assert.deepEqual(store.readEvent(doc.opId), doc);
    assert.equal(
      Buffer.from(store.readContentBlob(hash)!).toString("utf8"),
      body,
    );
    assert.equal(
      git(
        rootDir,
        "show",
        `${receipt.commitSha.sha}:harness/${contentObjectRelativePath(hash)}`,
      ),
      body.trimEnd(),
    );
    assert.equal(
      git(rootDir, "show", `${receipt.commitSha.sha}:harness/context/notes.md`),
      body.trimEnd(),
    );
    assert.equal(
      readFileSync(path.join(rootDir, "harness/context/notes.md"), "utf8"),
      body,
    );
    assert.deepEqual(
      git(
        rootDir,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        receipt.commitSha.sha,
      )
        .split("\n")
        .sort(),
      [
        "harness/context/notes.md",
        `harness/${eventObjectRelativePath(doc.opId)}`,
        "harness/events/head.json",
        `harness/${contentObjectRelativePath(hash)}`,
      ],
    );
    assert.equal(git(rootDir, "status", "--porcelain", "-uall"), "");
    assert.equal(
      git(
        rootDir,
        "ls-tree",
        "--name-only",
        `${receipt.commitSha.sha}^`,
        "harness/context/notes.md",
      ),
      "",
    );
    const clone = path.join(rootDir, "fresh-clone");
    execFileSync("git", ["clone", "-q", rootDir, clone]);
    const cloned = makeTaskEventStore({ repoId: "test-repo", rootDir: clone });
    assert.equal(cloned.currentCommit().sha, git(clone, "rev-parse", "HEAD"));
    assert.deepEqual(cloned.readEvent(doc.opId), doc);
    assert.equal(
      readFileSync(path.join(clone, "harness/context/notes.md"), "utf8"),
      body,
    );
    assert.equal(git(clone, "status", "--porcelain", "-uall"), "");
  });
});

test("document retirement preserves a local edit that races the canonical deletion", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const logical = "context/temporary.md",
      canonical = "# Temporary\n",
      local = "# Concurrent local edit\n",
      store = makeTaskEventStore({ repoId: "retirement-conflict", rootDir });
    store.append(docBundle(store, canonical, 1, "op-retirement-base", logical));
    writeFileSync(path.join(rootDir, "harness", logical), local);
    const retired: DocEventV1 = {
      schema: "doc-event/v1",
      eventId: "event-retirement-delete",
      workspaceRevision: 2,
      opId: "op-retirement-delete",
      type: "documents_written",
      actor: event.actor,
      source: "local",
      occurredAt: event.occurredAt,
      payload: {
        executionId: null,
        baseLedgerSha: store.currentCut(),
        retirementReason: "superseded temporary evidence",
        changes: [
          {
            path: logical,
            baseBlobSha256: sha256Text(canonical),
            candidate: null,
            policyId: DOC_POLICY_ID,
            regionProofs: [],
          },
        ],
      },
    };
    store.append({
      event: retired,
      plan: docSyncWritePlan(retired),
      blobs: [],
    });
    const directory = path.join(rootDir, "harness/context"),
      conflict = readdirSync(directory).find((name) =>
        /^temporary\.conflict-[0-9a-f]{8}\.md$/u.test(name),
      );
    assert.equal(existsSync(path.join(rootDir, "harness", logical)), false);
    assert.ok(conflict);
    assert.equal(readFileSync(path.join(directory, conflict), "utf8"), local);
    assert.equal(
      git(rootDir, "ls-tree", "--name-only", "HEAD", `harness/${logical}`),
      "",
    );
  });
});

test("a reopened store verifies and reuses a reachable content blob", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const body = "# Shared\n",
      hash = sha256Text(body),
      first = makeTaskEventStore({ repoId: "blob-reuse", rootDir });
    first.append(docBundle(first, body, 1, "blob-one", "context/one.md"));
    const reopened = makeTaskEventStore({ repoId: "blob-reuse", rootDir }),
      receipt = reopened.append(
        docBundle(reopened, body, 2, "blob-two", "context/two.md"),
      ),
      objectPath = `harness/${contentObjectRelativePath(hash)}`;
    assert.equal(receipt.metrics.changedPaths.includes(objectPath), false);
    assert.equal(
      git(
        rootDir,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        receipt.commitSha.sha,
      )
        .split("\n")
        .includes(objectPath),
      false,
    );
    assert.equal(
      Buffer.from(reopened.readContentBlob(hash)!).toString("utf8"),
      body,
    );
  });
});
