// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import {
  WORKS_EMPTY,
  agenda,
  mountOverview,
  setupOverviewBoardEnvironment,
  unmountOverview,
} from "./overview-board.fixtures.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

beforeAll(setupOverviewBoardEnvironment);
afterEach(unmountOverview);

function task(taskId: string, personId: string, createdAt: string, parentTaskId?: string): TaskRow {
  return {
    ...projectedTaskFields("active"),
    taskId,
    parentTaskId,
    title: taskId,
    projectId: "probe-repo",
    coordinationStatus: "active",
    rawStatus: "active",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    source: "local-document",
    engine: "local",
    freshness: "fresh",
    createdAt,
    lastKnownAt: createdAt,
    updatedAt: createdAt,
    createdByPersonId: personId,
    activeOrLatestPersonId: personId,
    originNodeId: "center",
    activeOrLatestNodeId: "center",
    gates: [],
    docs: [],
  };
}

it("uses member activity for the recent window, ordering, and the timestamp of pinned work", () => {
  const now = Date.now();
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
  const works = [
    { id: "old", aliceAt: at(120), bobAt: at(1) },
    { id: "pinned", aliceAt: at(144), bobAt: at(1) },
    { id: "earlier", aliceAt: at(48), bobAt: at(1) },
    { id: "later", aliceAt: at(24), bobAt: at(12) },
    { id: "running", aliceAt: at(168), bobAt: at(1) },
  ];
  const container = mountOverview({
    scopePersonId: "person_alice",
    tasks: works.flatMap(({ id, aliceAt, bobAt }) => [
      task(id, "person_bob", bobAt),
      {
        ...task(`${id}-alice`, "person_alice", aliceAt, id),
        ...(id === "old" || id === "running"
          ? {
              activeExecutionId: `execution-${id}`,
              leaseActor: { principal: { personId: id === "old" ? "person_bob" : "person_alice" }, executor: null },
              leaseSource: "local" as const,
            }
          : {}),
      },
      task(`${id}-bob`, "person_bob", bobAt, id),
    ]),
    works: {
      ...WORKS_EMPTY,
      works: works.map(({ id, bobAt }) => ({
        taskId: id,
        title: id,
        status: "active",
        counts: { executing: 2 },
        lastActivityAt: bobAt,
        memberTaskIds: [`${id}-alice`, `${id}-bob`],
      })),
    },
    agenda: agenda({
      pinnedEntities: [{ kind: "task", ref: "task/pinned", title: "pinned", status: "active", pinnedAt: at(2) }],
      attentionItems: [],
      awaitingYou: [],
    }),
  });

  const workCards = [...container.querySelectorAll<HTMLElement>("[data-work-card]")];
  expect({
    order: workCards.map((row) => row.dataset.workCard),
    pinned: workCards.find((row) => row.dataset.workCard === "pinned")?.textContent,
  }).toEqual({
    order: ["running", "pinned", "later", "earlier"],
    pinned: expect.stringContaining("6 天前"),
  });
});
