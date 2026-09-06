// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { actor, coverageCompleteFixture, initRepo, sources } from "./migration-import.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

test("migration import commits its prepared members and terminal outcome atomically", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-import-acceptance-")),
    source = path.join(scratch, "legacy"),
    rootDir = path.join(scratch, "repo"),
    repoId = workspaceId("migration-import-acceptance"),
    binding = { actor, source: "local" as const },
    action = { kind: "migrate-import" as const, sourceRoots: sources(source) };
  let armed = false,
    first: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    retry: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    initRepo(rootDir);
    first = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "migration-import-first",
      killpoint: (point) => {
        if (armed && point === "after_event_write") throw new Error("stop before import outcome");
      },
    });
    const before = makeTaskEventReader({ repoId, rootDir }),
      originalEvents = before.read().events,
      originalRevision = before.read().revision;
    await before.drain();
    armed = true;
    const failed = await first.run(action, binding);
    armed = false;
    assert.equal(failed.outcome, "op_rejected", JSON.stringify(failed));
    const rolledBack = makeTaskEventReader({ repoId, rootDir });
    assert.equal(rolledBack.read().revision, originalRevision);
    assert.deepEqual(rolledBack.read().events, originalEvents);
    assert.equal(rolledBack.readCommandOutcome(failed.opId), null);
    await rolledBack.drain();

    await first.close();
    first = undefined;
    retry = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "migration-import-retry",
    });
    const accepted = await retry.run(action, binding);
    assert.equal(accepted.status, "accepted_durable", JSON.stringify(accepted));
    const committed = makeTaskEventReader({ repoId, rootDir }),
      outcome = committed.readCommandOutcome(accepted.opId)!;
    assert.equal(outcome.status, "accepted_durable");
    assert.ok(outcome.memberOpIds.length > 2, JSON.stringify(outcome));
    assert.equal(outcome.firstRevision, originalRevision + 1);
    assert.equal(outcome.lastRevision, originalRevision + outcome.memberOpIds.length);
    assert.equal(committed.read().revision, outcome.lastRevision);
    assert.equal(
      committed.read().events.filter(({ opId }) => outcome.memberOpIds.includes(opId)).length,
      outcome.memberOpIds.length,
    );
    await committed.drain();
  } finally {
    await first?.close();
    await retry?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
