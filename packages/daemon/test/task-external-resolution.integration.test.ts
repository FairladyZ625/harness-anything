// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fixture } from "./task-completion-review.fixture.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// 2026-11-06 / PR #4354, #4351: a task whose goal an already-merged external contribution
// satisfied had no completion path. `--resolved-by` now also names the immutable commit on the
// published default branch; the external commit replaces the sibling's "done source" proof.
test("a commit already on main resolves an open task; unmerged commits and PR URLs are refused", async () => {
  const f = await fixture(false, true, false, false, false, { autoSubmit: false });
  try {
    const merged = git(f.root, "rev-parse", "refs/remotes/origin/main"),
      unmerged = git(f.root, "rev-parse", "HEAD"),
      fact = f.events().find((event) => event.type === "fact_recorded");
    assert.ok(fact?.type === "fact_recorded");
    assert.notEqual(merged, unmerged, "the fixture publishes origin/main at the base commit");
    const resolutionFact = `fact/${fact.factId}`,
      rationale = "Upstream PR #4354 already merged the fix this task asked for",
      command = (target: string, commitSha: string) => ({
        kind: "task-complete" as const,
        taskId: target,
        resolvedBy: commitSha,
        resolutionRationale: rationale,
        resolutionFact,
      });

    await f.createPlannedTask("task-external-merged");
    await f.createPlannedTask("task-external-unmerged");
    await f.createPlannedTask("task-external-pr-url");

    const refused = await f.run(command("task-external-unmerged", unmerged));
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.match(JSON.stringify(refused), /ancestor of main|on main/u);
    assert.equal(
      f.events().filter((event) => event.taskId === "task-external-unmerged" && event.type === "task_completed").length,
      0,
      "a refused external resolution records nothing",
    );

    // The original report passed a PR URL. A URL is mutable routing metadata, not the immutable
    // commit the ledger records, so the refusal must say to pass the merge commit instead.
    const prUrl = await f.run(command("task-external-pr-url", "https://github.com/example/repo/pull/4354"));
    assert.equal(prUrl.outcome, "op_rejected", JSON.stringify(prUrl));
    assert.match(JSON.stringify(prUrl), /commit sha/u);

    let accepted = await f.run(command("task-external-merged", merged));
    if (accepted.outcome === "pending") {
      await f.cell().settlePendingMaterialization("external completion publication");
      accepted = await f.run(command("task-external-merged", merged));
    }
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));

    const events = f.events().filter((event) => event.taskId === "task-external-merged"),
      completed = events.filter((event) => event.type === "task_completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]!.type, "task_completed");
    if (completed[0]!.type !== "task_completed") throw new Error("unreachable");
    assert.equal(completed[0]!.payload.execution, undefined);
    assert.deepEqual(completed[0]!.payload.externalResolution, {
      commitSha: merged,
      rationale,
      factRef: resolutionFact,
    });
    assert.equal(
      events.filter((event) => event.type === "execution_started" || event.type === "review_recorded").length,
      0,
      "external completion invents no target execution or review",
    );

    const replay = await f.run(command("task-external-merged", merged));
    assert.equal(replay.outcome, "applied", JSON.stringify(replay));
    assert.equal(replay.opId, accepted.opId, "the same resolution replays one durable receipt");

    const shown = await f.run({ kind: "task-show", taskId: "task-external-merged" });
    assert.match(JSON.stringify(shown), /externalResolution/u, "the task snapshot carries the external resolver");
    assert.match(JSON.stringify(shown), new RegExp(merged, "u"));
  } finally {
    await f.close();
  }
});
