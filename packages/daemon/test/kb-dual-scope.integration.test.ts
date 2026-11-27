// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, openPersistentWriterEpoch, registerDaemonRepo } from "@harness-anything/storage";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { runEdgeLocalKbAction } from "../src/daemon-host/kb-action.ts";
import { signInPolicyTestUser } from "./keycloak-policy.fixtures.ts";
import { signInAt } from "./keycloak.fixtures.ts";
import { seedSettingsEvent } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function git(rootDir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

function createKbRbacFixture() {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-kb-dual-scope-"));
  const rootDir = path.join(parent, "repo");
  const userRoot = path.join(parent, "user");
  const mountDir = path.join(parent, "external-vault");
  const ids = {
    admin: 6101,
    writer: 6102,
    reader: 6103,
    outsider: 6104,
  } as const;
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  mkdirSync(mountDir, { recursive: true });
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "KB Test");
  git(rootDir, "config", "user.email", "kb-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: kb-rbac\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "harness");
  writeFileSync(
    path.join(mountDir, "mounted-note.md"),
    [
      "---",
      "docId: doc_mounted_local",
      'title: "Mounted Local Reference"',
      "tags: [external]",
      "---",
      "# Mounted Reference",
      "",
      "## Section One",
      "",
      "Strictly host-local mounted content.",
    ].join("\n"),
    "utf8",
  );
  return { parent, rootDir, userRoot, mountDir, ids, close: () => removeTempRepository(parent) };
}

function parseEvidence<T>(receipt: unknown): T {
  const rec = receipt as { readonly evidence?: unknown };
  assert.equal(typeof rec.evidence, "string", `Expected JSON evidence in receipt: ${JSON.stringify(receipt)}`);
  return JSON.parse(rec.evidence as string) as T;
}

const MULTI_LEVEL_SHARED_MD = [
  "# Chapter 1: Core Charter",
  "",
  "Constitutional principles for shared knowledge.",
  "",
  "## 1.1 Dual-Scope Boundary",
  "",
  "Local-private never replicates to center-shared.",
  "",
  "### 1.1.1 Strict Isolation",
  "",
  "Zero CanonicalEventStore rows for local-private writes.",
  "",
  "## 1.2 Borrowing Protocol",
  "",
  "Catalog -> Outline -> Complete Chapter Read without 500-token chunking.",
  "",
  "# Chapter 2: Operations",
  "",
  "Operational guidance.",
].join("\n");

test("KB dual-scope positive & negative evidence: local isolation, shared CAS + pre-read RBAC, status filter, outline & chapter read", async () => {
  const fixture = createKbRbacFixture();
  const repoId = "kb-rbac";
  const authority = openPersistentWriterEpoch({
    stateRoot: path.join(fixture.userRoot, "fleet"),
    holderId: "kb-rbac-seed",
  });
  try {
    const lease = authority.acquire(repoId);
    seedSettingsEvent({
      rootDir: fixture.rootDir,
      repoId,
      writerEpochFence: {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot: path.join(fixture.userRoot, "fleet"),
        repoId,
        holderId: lease.holderId,
        epoch: lease.epoch,
      },
    });
  } finally {
    authority.close();
  }

  await signInPolicyTestUser(fixture.userRoot, "admin", [repoId], "admin");
  await signInPolicyTestUser(fixture.userRoot, "writer", [repoId], "contributor");
  await signInPolicyTestUser(fixture.userRoot, "reader", [repoId], "viewer");
  await signInPolicyTestUser(fixture.userRoot, "outsider", ["other-repo"], "viewer");

  const host = await openDaemonHost({ daemonId: "kb-dual-scope", userRoot: fixture.userRoot });
  await host.attachmentsSettled();

  const auth = (person: keyof typeof fixture.ids) => {
    signInAt(fixture.userRoot, person);
    return {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: { ownerUid: fixture.ids[person], source: "unix-socket-filesystem-owner-boundary" },
    } as const;
  };

  const readCanonicalRevision = async (): Promise<number> => {
    const reader = makeTaskEventReader({ repoId, rootDir: fixture.rootDir });
    try {
      return reader.readHead()?.revision ?? 0;
    } finally {
      await reader.drain();
    }
  };

  try {
    await host.admin({ kind: "register", rootDir: fixture.rootDir, repoId }, auth("admin"));

    // --- Control 1: local-private write & mount produce 0 canonical events and 0 replication log entries ---
    const revBeforeLocal = await readCanonicalRevision();
    const replicaHeadBeforeLocal = host.replica(repoId).ledgerCut();

    const localPut = await host.run(
      repoId,
      {
        kind: "kb-put",
        docId: "doc_local_draft",
        scope: "local",
        title: "Local Draft",
        domain: "personal",
        summary: "Private scratchpad.",
        tags: ["draft"],
        content: "# Local Draft\n\n## Scratch\n\nNever leaves this machine.\n",
      },
      auth("writer"),
    );
    assert.equal(localPut.outcome, "applied", JSON.stringify(localPut));
    assert.equal(localPut.status, "settled_no_write");
    assert.equal(localPut.proof, undefined);

    const localRejectedPut = await host.run(
      repoId,
      {
        kind: "kb-put",
        docId: "doc_local_rejected",
        scope: "local",
        title: "Rejected Local Draft",
        domain: "personal",
        summary: "Rejected draft.",
        status: "rejected",
        content: "# Rejected\n\nDo not show by default.\n",
      },
      auth("writer"),
    );
    assert.equal(localRejectedPut.outcome, "applied", JSON.stringify(localRejectedPut));

    const mountAdd = await host.run(
      repoId,
      {
        kind: "kb-mount",
        operation: "add",
        mountId: "vault",
        rootPath: fixture.mountDir,
        mode: "readonly",
        domain: "notes",
      },
      auth("writer"),
    );
    assert.equal(mountAdd.outcome, "applied", JSON.stringify(mountAdd));
    assert.equal(mountAdd.status, "settled_no_write");
    assert.equal(mountAdd.proof, undefined);

    const revAfterLocal = await readCanonicalRevision();
    const replicaHeadAfterLocal = host.replica(repoId).ledgerCut();
    assert.equal(revAfterLocal, revBeforeLocal, "local-private put & mount must produce 0 canonical events");
    assert.deepEqual(
      replicaHeadAfterLocal,
      replicaHeadBeforeLocal,
      "local-private put & mount must produce 0 Fleet replication stream entries",
    );

    // --- Control 2: center-shared write enforces single-writer + CAS & RBAC ---
    const sharedPut = await host.run(
      repoId,
      {
        kind: "kb-put",
        docId: "doc_shared_charter",
        scope: "shared",
        title: "Constitutional Charter",
        domain: "architecture",
        summary: "Shared constitutional architecture specification.",
        tags: ["charter", "s1"],
        expectedVersion: 0,
        content: MULTI_LEVEL_SHARED_MD,
      },
      auth("writer"),
    );
    assert.equal(sharedPut.outcome, "applied", JSON.stringify(sharedPut));
    const sharedPutPayload = parseEvidence<{ readonly scope: string; readonly bundle: { readonly revision: number } }>(
      sharedPut,
    );
    assert.equal(sharedPutPayload.scope, "shared");
    assert.equal(sharedPutPayload.bundle.revision, 1);
    const revAfterShared = await readCanonicalRevision();
    assert.equal(revAfterShared, revBeforeLocal + 1, "center-shared put appends exactly 1 canonical event");

    // Stale expectedVersion (0 instead of 1) must reject with revision_conflict and 0 new canonical events.
    const casConflict = await host.run(
      repoId,
      {
        kind: "kb-put",
        docId: "doc_shared_charter",
        scope: "shared",
        title: "Stale Overwrite",
        domain: "architecture",
        expectedVersion: 0,
        content: "# Stale\n",
      },
      auth("writer"),
    );
    assert.equal(casConflict.code, "revision_conflict", JSON.stringify(casConflict));
    assert.equal(await readCanonicalRevision(), revAfterShared);

    // Viewer cannot write center-shared KB documents (RBAC contributor required).
    const readerWriteDenied = await host.run(
      repoId,
      {
        kind: "kb-put",
        docId: "doc_shared_forbidden",
        scope: "shared",
        title: "Forbidden",
        domain: "architecture",
        expectedVersion: 0,
        content: "# Forbidden\n",
      },
      auth("reader"),
    );
    assert.equal(readerWriteDenied.code, "authorization_denied", JSON.stringify(readerWriteDenied));

    // Outsider without repository-read permission is rejected BEFORE reading catalog/outline/read.
    const outsiderCatalog = await host.run(repoId, { kind: "kb-catalog", scope: "shared" }, auth("outsider"));
    assert.equal(outsiderCatalog.code, "authorization_denied", JSON.stringify(outsiderCatalog));
    const outsiderOutline = await host.run(
      repoId,
      { kind: "kb-outline", docId: "doc_shared_charter", scope: "shared" },
      auth("outsider"),
    );
    assert.equal(outsiderOutline.code, "authorization_denied", JSON.stringify(outsiderOutline));
    const outsiderRead = await host.run(
      repoId,
      { kind: "kb-read", docId: "doc_shared_charter", scope: "shared", full: true },
      auth("outsider"),
    );
    assert.equal(outsiderRead.code, "authorization_denied", JSON.stringify(outsiderRead));

    // Publish a superseded shared document for Control 3.
    const supersededPut = await host.run(
      repoId,
      {
        kind: "kb-put",
        docId: "doc_shared_legacy",
        scope: "shared",
        title: "Legacy Charter",
        domain: "architecture",
        summary: "Superseded charter.",
        status: "superseded",
        supersededBy: "doc_shared_charter",
        expectedVersion: 0,
        content: "# Legacy\n\nOld text.\n",
      },
      auth("writer"),
    );
    assert.equal(supersededPut.outcome, "applied", JSON.stringify(supersededPut));

    // --- Control 3: superseded / rejected hidden by default, visible with --include-archived ---
    const defaultCatalogRes = await host.run(repoId, { kind: "kb-catalog", scope: "all" }, auth("reader"));
    assert.equal(defaultCatalogRes.outcome, "applied", JSON.stringify(defaultCatalogRes));
    const defaultCatalog = parseEvidence<{
      readonly items: readonly { readonly docId: string; readonly scope: string }[];
    }>(defaultCatalogRes);
    assert.deepEqual(
      defaultCatalog.items.map((item) => `${item.scope}:${item.docId}`),
      ["local:doc_local_draft", "local:doc_mounted_local", "shared:doc_shared_charter"],
    );

    const archivedCatalogRes = await host.run(
      repoId,
      { kind: "kb-catalog", scope: "all", includeArchived: true },
      auth("reader"),
    );
    assert.equal(archivedCatalogRes.outcome, "applied", JSON.stringify(archivedCatalogRes));
    const archivedCatalog = parseEvidence<{
      readonly items: readonly { readonly docId: string; readonly scope: string }[];
    }>(archivedCatalogRes);
    assert.deepEqual(
      archivedCatalog.items.map((item) => `${item.scope}:${item.docId}`),
      [
        "local:doc_local_draft",
        "local:doc_local_rejected",
        "local:doc_mounted_local",
        "shared:doc_shared_charter",
        "shared:doc_shared_legacy",
      ],
    );

    // --- Control 4: multi-level Markdown outline + complete chapter read without chunking ---
    const outlineRes = await host.run(
      repoId,
      { kind: "kb-outline", docId: "doc_shared_charter", scope: "shared" },
      auth("reader"),
    );
    assert.equal(outlineRes.outcome, "applied", JSON.stringify(outlineRes));
    const outline = parseEvidence<{
      readonly outline: readonly {
        readonly heading: string;
        readonly level: number;
        readonly startLine: number;
        readonly endLine: number;
      }[];
    }>(outlineRes);
    assert.deepEqual(
      outline.outline.map((h) => ({ heading: h.heading, level: h.level, startLine: h.startLine, endLine: h.endLine })),
      [
        { heading: "Chapter 1: Core Charter", level: 1, startLine: 1, endLine: 16 },
        { heading: "1.1 Dual-Scope Boundary", level: 2, startLine: 5, endLine: 12 },
        { heading: "1.1.1 Strict Isolation", level: 3, startLine: 9, endLine: 12 },
        { heading: "1.2 Borrowing Protocol", level: 2, startLine: 13, endLine: 16 },
        { heading: "Chapter 2: Operations", level: 1, startLine: 17, endLine: 19 },
      ],
    );

    const chapterRes = await host.run(
      repoId,
      { kind: "kb-read", docId: "doc_shared_charter", scope: "shared", section: "1.1 Dual-Scope Boundary" },
      auth("reader"),
    );
    assert.equal(chapterRes.outcome, "applied", JSON.stringify(chapterRes));
    const chapter = parseEvidence<{
      readonly mode: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly content: string;
    }>(chapterRes);
    assert.equal(chapter.mode, "section");
    assert.equal(chapter.startLine, 5);
    assert.equal(chapter.endLine, 12);
    assert.ok(chapter.content.includes("### 1.1.1 Strict Isolation"));
    assert.ok(chapter.content.includes("Zero CanonicalEventStore rows"));
    assert.ok(!chapter.content.includes("## 1.2 Borrowing Protocol"));

    const linesRes = await host.run(
      repoId,
      { kind: "kb-read", docId: "doc_mounted_local", scope: "local", lines: "6..10" },
      auth("reader"),
    );
    assert.equal(linesRes.outcome, "applied", JSON.stringify(linesRes));
    const lines = parseEvidence<{ readonly mode: string; readonly content: string }>(linesRes);
    assert.equal(lines.mode, "lines");
    assert.ok(lines.content.includes("Strictly host-local mounted content."));

    // --- Edge-mode local-private intercept never forwards to Center ---
    const edgeRoot = path.join(fixture.parent, "edge-repo");
    mkdirSync(edgeRoot, { recursive: true });
    registerDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: "kb-edge",
      mode: "remote-edge",
      userRoot: fixture.userRoot,
      createConvenienceLinks: false,
    });
    const edgeLocalPut = await runEdgeLocalKbAction({
      userRoot: fixture.userRoot,
      repoId: "kb-edge",
      action: {
        kind: "kb-put",
        docId: "doc_edge_private",
        scope: "local",
        title: "Edge Private Note",
        domain: "personal",
        content: "# Edge Private\n\nStays on edge.\n",
      },
      auth: { transportKind: "unix-socket" },
      now: () => "2026-11-27T04:00:00.000Z",
      codedError: (code, message) => Object.assign(new Error(message), { code }),
    });
    assert.ok(edgeLocalPut !== null);
    assert.equal(edgeLocalPut!.outcome, "applied");
    assert.equal(edgeLocalPut!.proof?.canonicalVisible, false);

    // Pure shared put on remote-edge returns null so standard via-center-forward runs.
    const edgeSharedPassthrough = await runEdgeLocalKbAction({
      userRoot: fixture.userRoot,
      repoId: "kb-edge",
      action: {
        kind: "kb-put",
        docId: "doc_edge_shared",
        scope: "shared",
        title: "Edge Shared",
        domain: "architecture",
        content: "# Shared\n",
      },
      auth: { transportKind: "unix-socket" },
      now: () => "2026-11-27T04:00:00.000Z",
      codedError: (code, message) => Object.assign(new Error(message), { code }),
    });
    assert.equal(edgeSharedPassthrough, null);
  } finally {
    await host.close();
    fixture.close();
  }
});
