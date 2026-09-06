// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    secondSource = path.join(scratch, "legacy-second"),
    thirdSource = path.join(scratch, "legacy-third"),
    rootDir = path.join(scratch, "repo"),
    repoId = workspaceId("migration-import-acceptance"),
    binding = { actor, source: "local" as const };
  let armed = false,
    first: Awaited<ReturnType<typeof openRepoCell>> | undefined,
    retry: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    coverageCompleteFixture(secondSource);
    coverageCompleteFixture(thirdSource);
    writeFileSync(path.join(source, "harness/source-alpha.txt"), "alpha source identity\n");
    writeFileSync(path.join(secondSource, "harness/source-beta.txt"), "beta source identity\n");
    writeFileSync(path.join(thirdSource, "harness/source-gamma.txt"), "gamma source identity\n");
    const firstSources = sources(source),
      secondSources = sources(secondSource),
      firstRoot = execFileSync("git", ["-C", source, "rev-list", "--max-parents=0", "HEAD"], {
        encoding: "utf8",
      }).trim(),
      secondRoot = execFileSync("git", ["-C", secondSource, "rev-list", "--max-parents=0", "HEAD"], {
        encoding: "utf8",
      }).trim();
    assert.notEqual(firstRoot, secondRoot);
    const thirdSources = sources(thirdSource);
    execFileSync("git", ["-C", thirdSource, "commit", "--allow-empty", "-m", "distinct third source"]);
    initRepo(rootDir);
    const action = { kind: "migrate-import" as const, sourceRoots: [...firstSources, ...secondSources] };
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
    assert.equal(accepted.acceptance?.revisionFrom, outcome.firstRevision);
    assert.equal(accepted.acceptance?.revisionTo, outcome.lastRevision);
    assert.deepEqual(accepted.acceptance?.memberOpIds, outcome.memberOpIds);
    assert.equal(
      committed.read().events.filter(({ opId }) => outcome.memberOpIds.includes(opId)).length,
      outcome.memberOpIds.length,
    );
    assert.equal(
      committed
        .read()
        .events.filter(
          (event) =>
            outcome.memberOpIds.includes(event.opId) &&
            event.schema === "migration-import-event/v1" &&
            event.payload.entity.kind === "task",
        ).length,
      2,
    );
    await committed.drain();
    const priorRevision = outcome.lastRevision!,
      mixedAction = { kind: "migrate-import" as const, sourceRoots: [...thirdSources, ...sources(secondSource)] },
      trailingNoop = await retry.run(mixedAction, binding);
    assert.equal(trailingNoop.status, "accepted_durable", JSON.stringify(trailingNoop));
    assert.ok(trailingNoop.acceptance!.revisionFrom > priorRevision);
    assert.equal(trailingNoop.acceptance!.revisionTo, trailingNoop.revision);
    assert.equal(trailingNoop.acceptance!.memberOpIds.at(-1), trailingNoop.opId);
    const noChanges = await retry.run(mixedAction, binding),
      repeatedNoChanges = await retry.run(mixedAction, binding);
    assert.equal(noChanges.outcome, "no_changes");
    assert.equal(noChanges.acceptance, null);
    assert.equal(noChanges.opId, repeatedNoChanges.opId);
  } finally {
    await first?.close();
    await retry?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
