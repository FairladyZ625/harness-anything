// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId, type DaemonAgendaResult } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

const actor = { principal: { personId: "person-agenda-work" }, executor: { kind: "agent", id: "codex-sol" } } as const;
const binding = withPolicyGroup({ actor, source: "local" as const }, "admin");

/** Two works whose active lanes interleave by task id, with the other work's lanes opening
 * the sort order — the page shape where a post-pagination work filter loses every row. */
const RELEASE_WORK = "task_work_release";
const OTHER_WORK = "task_b_other_work";
const OTHER_LANES = ["task_a_other_lane", "task_c_other_lane"] as const;
const RELEASE_LANES = ["task_work_release_a", "task_work_release_b", "task_work_release_c"] as const;

async function withInterleavedWorks(
  name: string,
  run: (read: (payload?: Record<string, unknown>) => Promise<DaemonAgendaResult>) => Promise<void>,
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `${name}-`)),
    lanePackages = new Map<string, string>();
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId(name),
      rootDir: canonicalRoot(rootDir),
      ownerId: name,
      now: () => "2026-10-08T12:00:00.000Z",
    });
    for (const action of [
      { kind: "task-create", taskId: OTHER_WORK, title: "Other work", taskClass: "work" },
      { kind: "task-create", taskId: RELEASE_WORK, title: "Release work", taskClass: "work" },
      ...OTHER_LANES.map((taskId) => ({
        kind: "task-create",
        taskId,
        title: `Other lane ${taskId}`,
        parentTaskId: OTHER_WORK,
      })),
      ...RELEASE_LANES.map((taskId) => ({
        kind: "task-create",
        taskId,
        title: `Release lane ${taskId}`,
        parentTaskId: RELEASE_WORK,
      })),
    ] as const) {
      const created = await cell.run(action, binding);
      assert.equal(created.outcome, "applied", JSON.stringify(action));
      await waitForFixturePublication(cell, created.opId, binding);
      if ("packagePath" in created) lanePackages.set(action.taskId, String(created.packagePath));
    }
    for (const lane of [...RELEASE_LANES, ...OTHER_LANES]) {
      await realizeTaskPlanFixture(rootDir, lanePackages.get(lane)!, (planPath) =>
        cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      const started = await cell.run({ kind: "task-start", taskId: lane, executionId: `exe_${lane}` }, binding);
      assert.equal(started.outcome, "applied", `task-start ${lane}`);
    }
    await run((payload) => cell.read("repo.agenda.read", payload));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

test("a work-scoped agenda serves that work's in-flight rows at a small limit", async () => {
  await withInterleavedWorks("agenda-work-small-limit", async (read) => {
    const scoped = await read({ work: RELEASE_WORK, limit: 2 });
    // Pre-fix this page held the other work's two lanes and filtered to zero; the release
    // lanes only appeared once the limit covered the whole repository first page.
    assert.deepEqual(
      scoped.inFlight.map(({ taskId }) => taskId),
      ["task_work_release_a", "task_work_release_b"],
    );
    assert.ok(scoped.page.nextCursor, "one release lane still awaits the next page");
    assert.ok(
      scoped.inFlight.every(({ work }) => work?.taskId === RELEASE_WORK),
      "every served row names the release work",
    );
  });
});

test("work-scoped cursor pagination walks every release lane exactly once and then ends", async () => {
  await withInterleavedWorks("agenda-work-cursor-walk", async (read) => {
    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await read({ work: RELEASE_WORK, limit: 1, cursor });
      collected.push(...page.inFlight.map(({ taskId }) => taskId));
      if (page.page.nextCursor === null) break;
      cursor = page.page.nextCursor;
    }
    assert.deepEqual(collected, [...RELEASE_LANES]);
    assert.equal(new Set(collected).size, collected.length, "no lane repeats across pages");
  });
});

test("an unscoped agenda keeps serving the repository-wide page order", async () => {
  await withInterleavedWorks("agenda-work-unscoped-control", async (read) => {
    const unscoped = await read({ limit: 2 });
    assert.deepEqual(
      unscoped.inFlight.map(({ taskId }) => taskId),
      ["task_a_other_lane", "task_c_other_lane"],
    );
  });
});

function initRepo(rootDir: string): void {
  const git = (...args: readonly string[]) => execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf-8" });
  git("init", "-q");
  git("config", "user.name", "Agenda Work Scope Test");
  git("config", "user.email", "agenda-work@example.invalid");
  git("commit", "--allow-empty", "-qm", "base");
}
