// harness-test-tier: fast
import { expect, it, vi } from "vitest";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { collectWork, scopedWorkLineage, scopeWorkActivity } from "../src/renderer/model/work-collections.ts";
import { indexSessionDispatches, type SessionGroup } from "../src/renderer/sessions-model.ts";

it("builds each scoped lineage from its matched tasks and indexed ancestor links", () => {
  const tasks = Array.from({ length: 200 }, (_, index) => {
    const workId = `work-${index}`;
    return [
      { taskId: workId, workId },
      { taskId: `${workId}-branch`, parentTaskId: workId },
      { taskId: `${workId}-first`, parentTaskId: `${workId}-branch`, createdByPersonId: "person_alice" },
      { taskId: `${workId}-second`, parentTaskId: `${workId}-branch`, createdByPersonId: "person_alice" },
      { taskId: `${workId}-other`, parentTaskId: workId, createdByPersonId: "person_bob" },
    ];
  })
    .flat()
    .map((task) => ({ ...task, lastKnownAt: "" }) as TaskRow);
  const { groups } = collectWork(tasks);
  const taskById = new Map(tasks.map((task) => [task.taskId, task] as const));
  const lookup = vi.spyOn(taskById, "get");
  const parents = new Set(tasks.flatMap((task) => (task.parentTaskId ? [task.parentTaskId] : [])));
  for (const raw of groups) {
    const scoped = scopeWorkActivity(
      raw.task,
      raw.members,
      (task) => task.createdByPersonId === "person_alice",
      parents,
      {
        personId: "person_alice",
        nodeId: null,
      },
    )!;
    const root = raw.task.taskId;
    expect(
      scopedWorkLineage({ task: raw.task, ...scoped }, taskById)
        .map(({ taskId }) => taskId)
        .sort(),
    ).toEqual([root, `${root}-branch`, `${root}-first`, `${root}-second`]);
  }
  expect(groups).toHaveLength(200);
  expect(lookup).toHaveBeenCalledTimes(200);
});

it("indexes a mixed dispatch page by canonical membership without reading dispatch task ids", () => {
  let dispatchReads = 0;
  const groups = Array.from(
    { length: 200 },
    (_, index) =>
      ({
        key: `task-${index}`,
        taskId: `task-${index}`,
        kind: "task",
        roundCount: 2,
        sessionCount: 1,
        runningCount: 1,
        runtimeSessionIds: [`task-${index}-session`],
      }) as SessionGroup & { readonly runtimeSessionIds: readonly string[] },
  );
  const dispatches = groups.flatMap(({ key }) =>
    ["latest", "earlier"].map(
      (round) =>
        ({
          get taskId() {
            dispatchReads++;
            return "";
          },
          runtimeSessionId: `${key}-session`,
          dispatchId: `${key}-${round}`,
          status: round === "latest" ? "running" : "succeeded",
          personId: "person_alice",
          startedAt: round === "latest" ? "2026-11-18T12:00:00Z" : "2026-11-17T12:00:00Z",
        }) as TaskDispatchProjectionRow,
    ),
  );
  const indexed = indexSessionDispatches(dispatches, groups);
  expect(dispatchReads).toBe(0);
  expect(indexed.size).toBe(200);
  expect(
    [...indexed.values()].map((rounds) => [
      rounds.length,
      new Set(rounds.map(({ runtimeSessionId }) => runtimeSessionId)).size,
      rounds.filter(({ status }) => status === "running").length,
    ]),
  ).toEqual(Array.from({ length: 200 }, () => [2, 1, 1]));
});
