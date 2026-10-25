// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readRelationCycleWitnessAtCut } from "../src/entity-action-relation.ts";

test("relation cycle admission fails closed when its canonical projection cut is pending", () => {
  const projection = {
    readRelationQuery: () => ({ status: "pending", rows: [], watermark: 4, sourceRevision: 5 }),
  } as never;
  assert.throws(
    () =>
      readRelationCycleWitnessAtCut({
        projection,
        headRevision: 5,
        candidate: {
          relationId: "candidate",
          sourceRef: "task/a",
          targetRef: "task/b",
          relationType: "depends-on",
          direction: "directed",
          state: "active",
        },
      }),
    (error: unknown) => {
      const failure = error as { readonly code?: string; readonly message?: string };
      assert.equal(failure.code, "content_not_ready");
      assert.match(failure.message ?? "", /status pending, watermark 4, source revision 5, write head 5/u);
      return true;
    },
  );
});

test("relation cycle admission rejects a projection source revision ahead of the write head", () => {
  const projection = {
    readRelationQuery: () => ({ status: "ready", rows: [], watermark: 5, sourceRevision: 6 }),
  } as never;
  assert.throws(
    () =>
      readRelationCycleWitnessAtCut({
        projection,
        headRevision: 5,
        candidate: {
          relationId: "candidate",
          sourceRef: "task/a",
          targetRef: "task/b",
          relationType: "depends-on",
          direction: "directed",
          state: "active",
        },
      }),
    (error: unknown) => (error as { readonly code?: string }).code === "content_not_ready",
  );
});

test("relation cycle admission pages indexed outgoing edges and checks every page at the write cut", () => {
  const queries: Array<Record<string, unknown>> = [],
    sourcePages = new Map<string, number>();
  const projection = {
    readRelationQuery: (query: Record<string, unknown>) => {
      queries.push(query);
      const source = String(query.source),
        pageIndex = sourcePages.get(source) ?? 0;
      sourcePages.set(source, pageIndex + 1);
      if (source === "task/target" && pageIndex === 0)
        return {
          status: "ready",
          rows: [
            {
              relationId: "reachable-1",
              sourceRef: "task/target",
              targetRef: "task/middle",
              relationType: "depends-on",
              direction: "directed",
              state: "active",
            },
          ],
          watermark: 5,
          sourceRevision: 5,
          page: { limit: 100, cursor: null, nextCursor: "page-2" },
        };
      if (source === "task/target")
        return {
          status: "ready",
          rows: [],
          watermark: 5,
          sourceRevision: 5,
          page: { limit: 100, cursor: "page-2", nextCursor: null },
        };
      return {
        status: "ready",
        rows: [
          {
            relationId: "reachable-2",
            sourceRef: "task/middle",
            targetRef: "task/source",
            relationType: "depends-on",
            direction: "directed",
            state: "active",
          },
        ],
        watermark: 5,
        sourceRevision: 5,
        page: { limit: 100, cursor: null, nextCursor: null },
      };
    },
  } as never;
  const witness = readRelationCycleWitnessAtCut({
    projection,
    headRevision: 5,
    candidate: {
      relationId: "candidate",
      sourceRef: "task/source",
      targetRef: "task/target",
      relationType: "depends-on",
      direction: "directed",
      state: "active",
    },
  });

  assert.deepEqual(witness?.relationIds, ["candidate", "reachable-1", "reachable-2"]);
  assert.deepEqual(
    queries.map(({ source, relationType, state, direction, limit, cursor }) => ({
      source,
      relationType,
      state,
      direction,
      limit,
      cursor,
    })),
    [
      {
        source: "task/target",
        relationType: "depends-on",
        state: "active",
        direction: "directed",
        limit: 100,
        cursor: undefined,
      },
      {
        source: "task/target",
        relationType: "depends-on",
        state: "active",
        direction: "directed",
        limit: 100,
        cursor: "page-2",
      },
      {
        source: "task/middle",
        relationType: "depends-on",
        state: "active",
        direction: "directed",
        limit: 100,
        cursor: undefined,
      },
    ],
  );
});

test("relation cycle admission fails closed when a later outgoing page is behind the write cut", () => {
  let page = 0;
  const projection = {
    readRelationQuery: () => {
      page += 1;
      return page === 1
        ? {
            status: "ready",
            rows: [],
            watermark: 5,
            sourceRevision: 5,
            page: { limit: 100, cursor: null, nextCursor: "next" },
          }
        : {
            status: "pending",
            rows: [],
            watermark: 4,
            sourceRevision: 5,
            page: { limit: 100, cursor: "next", nextCursor: null },
          };
    },
  } as never;

  assert.throws(
    () =>
      readRelationCycleWitnessAtCut({
        projection,
        headRevision: 5,
        candidate: {
          relationId: "candidate",
          sourceRef: "task/source",
          targetRef: "task/target",
          relationType: "depends-on",
          direction: "directed",
          state: "active",
        },
      }),
    (error: unknown) => (error as { readonly code?: string }).code === "content_not_ready",
  );
  assert.equal(page, 2);
});
