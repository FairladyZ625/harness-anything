// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileEntityUpsert, ownedContentForDeclarationEvent } from "../../src/domain/entity-event.ts";
import type { CanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";
import { openSqliteEventStore, sqliteLedgerPath } from "../../src/store/sqlite-event-store.ts";
import { makeTaskEventStore, readCertifiedGitFollower } from "../../src/store/task-event-store-factory.ts";
import { git, initRepo } from "./task-event-store.fixtures.ts";

const repoId = "legacy-entity-declaration",
  fence = { repoId, holder: "legacy-import", epoch: 1 } as const;

function agentUpsert() {
  return compileEntityUpsert({
    eventId: "event-legacy-agent",
    opId: "op-legacy-agent",
    workspaceRevision: 1,
    actor: { principal: { personId: "person_synthetic" }, executor: null },
    source: "local",
    occurredAt: "2026-09-10T00:00:00.000Z",
    entityKind: "agent",
    entity: {
      schema: "agent-declaration/v1",
      id: "synthetic-worker",
      name: "Synthetic Worker",
      instructions: "Synthetic fixture agent.",
      runtime_type: "claude",
    },
  });
}

test("a generation-1 ledger holding a pre-manifest entity declaration still certifies its Git follower", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-legacy-entity-")),
    databasePath = sqliteLedgerPath(rootDir, 1),
    current = agentUpsert(),
    blob = current.blobs[0]!,
    // The shape an agent declaration was accepted with before the owned-content manifest existed: the payload
    // states its declaration claim and nothing else. `validateClaim` still admits that shape when parsing
    // history, so a ledger holding one has to stay readable — materializing it is how the repository opens.
    { ownedContent, ...legacyPayload } = current.event.payload,
    legacyEvent = { ...current.event, payload: legacyPayload } as unknown as CanonicalEventV1;
  initRepo(rootDir);
  // The recovered manifest is the one the writer of that same claim recorded, not a fresh reading of today's
  // registry: a derived manifest that differed here would be describing a different event.
  assert.deepEqual(ownedContentForDeclarationEvent(legacyEvent as never), ownedContent);
  const imported = openSqliteEventStore({ repoId, databasePath });
  imported.claimWriter(fence);
  imported.appendCommand({
    fence,
    intent: { opId: legacyEvent.opId, intentDigest: `sha256:${"a".repeat(64)}`, summary: legacyEvent.type },
    events: [legacyEvent],
    blobs: [blob],
  });
  imported.close();

  const store = makeTaskEventStore({ repoId, rootDir });
  try {
    await store.settlePendingMaterialization?.("legacy entity declaration");
    assert.equal(store.followerStatus().git.status, "verified");
    assert.equal(store.followerStatus().worktree.status, "verified");
  } finally {
    await store.drain();
  }
  const reader = openSqliteEventStore({ repoId, databasePath, readOnly: true });
  try {
    const follower = readCertifiedGitFollower({ rootInput: rootDir, repoId, store: reader });
    assert.equal(follower.cut.revision, 1);
    assert.deepEqual(
      follower.documents.map(({ path: target }) => target),
      ["agents/synthetic-worker.json"],
    );
  } finally {
    reader.close();
  }
  assert.equal(readFileSync(path.join(rootDir, "harness/agents/synthetic-worker.json"), "utf8"), String(blob.body));
  assert.equal(git(rootDir, "status", "--short", "--untracked-files=all", "--", "harness"), "");
});
