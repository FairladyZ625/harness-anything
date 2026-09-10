// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { compileDecisionWrite } from "../../src/domain/decision-event-document.ts";
import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { openSqliteEventStore, type SqliteWriterFence } from "../../src/store/sqlite-event-store.ts";
import { assertAuthorizedReplacements } from "../../src/store/task-event-store-replacement-authorization.ts";
import { decisionProposal, eventAt, initRepo } from "./task-event-store.fixtures.ts";

const repoId = "replacement-authorization-delta";
const fence: SqliteWriterFence = { repoId, holder: "writer-a", epoch: 1 };

test("a decision write on a still-unclaimed path reads only the events appended since the last authorization check", (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-replacement-authorization-"));
  initRepo(rootDir);
  const store = openSqliteEventStore({ repoId, rootInput: rootDir });
  try {
    store.claimWriter(fence);
    for (let revision = 1; revision <= 2_000; revision += 1) store.appendCommand(command(revision));
    // Prime the cache: the first authorization check after opening bears the one-time full-history cost.
    assertAuthorizedReplacements(store, rootDir, [decisionBundle("op-decision-a")]);
    for (let revision = 2_001; revision <= 2_050; revision += 1) store.appendCommand(command(revision));

    const eventsAfter = t.mock.method(store, "eventsAfter");
    // The decision path (decisions/decision-dec_STORE/decision.md) has never been claimed, so the
    // old backward scan would walk every one of the 2,050 accepted events to prove that again.
    assertAuthorizedReplacements(store, rootDir, [decisionBundle("op-decision-b")]);
    assert.equal(eventsAfter.mock.calls.length, 1);
    assert.equal((eventsAfter.mock.calls[0]!.result as readonly unknown[]).length, 50);
  } finally {
    store.close();
  }
});

function command(revision: number) {
  const event = eventAt(revision);
  return {
    fence,
    intent: {
      opId: event.opId,
      intentDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
      summary: event.type,
    },
    events: [event],
  } as const;
}

function decisionBundle(opId: string): ReturnType<typeof compileDecisionWrite> {
  const proposal = { ...decisionProposal(), opId, eventId: `event-${opId}` };
  return compileDecisionWrite({ event: proposal, currentDecision: null, currentRelations: [], currentDocument: null });
}
