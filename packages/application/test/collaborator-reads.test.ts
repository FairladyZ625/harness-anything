// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskIndexProjectionRow, TaskProjection } from "@harness-anything/kernel";
import { personalPinsFromNewest } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import {
  readAttestationPool,
  readCollaboratorAgenda,
  readCollaboratorArtifacts,
  readCollaboratorCadence,
  readCollaboratorDecisions,
  readCollaboratorEntities,
  readCollaboratorLiveFloor,
  readCollaboratorSchedules,
  readCollaboratorTokenUsage,
  readRepositoryCollaboration,
  readViewerTodos,
  workBriefsFromProjection,
  workIndexFromProjection,
  workspaceScopeFromProjection,
} from "@harness-anything/application/queries";

const alice = "person_alice",
  bob = "person_bob",
  edge = "edge-bob";
const cut = { watermark: 10, sourceRevision: 10, status: "ready" } as const;
const first = "2026-11-18T00:00:00.000Z",
  second = "2026-11-19T00:00:00.000Z";
const actor = (personId: string) => ({ principal: { personId }, executor: null });
const row = (
  taskId: string,
  title: string,
  createdByPersonId: string,
  parentTaskId: string | null,
  status: TaskIndexProjectionRow["status"],
  updatedAt: string,
): TaskIndexProjectionRow => ({
  taskId,
  title,
  createdByPersonId,
  parentTaskId,
  status,
  updatedAt,
  originNodeId: createdByPersonId === bob ? edge : "center",
  taskClass: parentTaskId === null ? "work" : "standard",
  packagePath: `tasks/${taskId}`,
  packageDisposition: "active",
  pinned: false,
  workKind: null,
  urgency: null,
  riskTier: null,
  supersededBy: null,
});

test("shared Work counts, brief and workspace are calculated from the selected member's tasks", () => {
  const rows = [
      row("shared", "Defect fixes", alice, null, "active", second),
      row("alice-active", "Alice private active title", alice, "shared", "active", second),
      row("bob-done", "Bob finished", bob, "shared", "done", first),
    ],
    scopes: unknown[] = [];
  const projection = {
    readTaskIndex: () => ({ ...cut, rows, warnings: [] }),
    listPinnedEntities: () => [],
    readTaskRelationsByTargets: () => ({ ...cut, rows: [] }),
    readEventSummaries: (_after: number, _limit: number, scope: unknown) => {
      scopes.push(scope);
      return { ...cut, events: [], hasMore: false };
    },
  } as unknown as TaskProjection;
  const scope = { scopePersonId: bob, filterNodeId: edge },
    index = workIndexFromProjection(projection, scope);
  assert.deepEqual(
    index.works.map((work) => [work.taskId, work.counts.executing, work.counts.done, work.lastActivityAt]),
    [["shared", 0, 1, first]],
  );
  const briefs = workBriefsFromProjection({
    ...scope,
    projection,
    now: () => new Date(second),
    agendaPage: ({ scopePersonId }) => {
      assert.equal(scopePersonId, bob);
      return { page: { cursor: null, nextCursor: null, limit: 500 }, awaitingYou: [] };
    },
  }).briefs;
  assert.equal(briefs[0]?.bucket, "done");
  assert.deepEqual(briefs[0]?.sentenceParts, [{ kind: "delivered", title: "Bob finished" }]);
  assert.doesNotMatch(JSON.stringify(briefs), /Alice private active title/u);
  const workspace = workspaceScopeFromProjection(projection, { ...scope, rootTaskId: "shared", limit: 1 });
  assert.deepEqual(
    workspace.tasks.map(({ taskId }) => taskId),
    ["bob-done"],
  );
  assert.equal(workspace.counts.executing, 0);
  assert.deepEqual(scopes, [{ taskIds: ["shared", "bob-done"], actorPersonId: bob, nodeId: edge }]);
});

test("decision involvement includes the proposer and the target of an active awaits relation", () => {
  const decisions = [
    { decisionId: "private", proposer: actor(alice) },
    { decisionId: "waiting", proposer: actor(alice) },
    { decisionId: "authored", proposer: actor(bob) },
  ];
  const projection = {
    listDecisions: ({ limit, cursor }: { limit?: number; cursor?: string }) => {
      const start = Number(cursor ?? 0),
        end = start + (limit ?? decisions.length);
      return {
        ...cut,
        decisions: decisions.slice(start, end),
        ...(limit === undefined ? {} : { page: { nextCursor: end < decisions.length ? String(end) : null } }),
      };
    },
    readRelationQuery: (query: object) => {
      assert.deepEqual(query, { target: `person/${bob}`, relationType: "awaits", state: "active", limit: 100 });
      return { ...cut, rows: [{ sourceRef: "decision/waiting" }], page: null };
    },
    readTaskIndex: () => ({ ...cut, rows: [row("bob-review", "Sign", bob, null, "in_review", first)], warnings: [] }),
  } as unknown as TaskProjection;
  const query = { involvement: "mine", viewerPersonId: bob, limit: 1 } as const;
  const page = readCollaboratorDecisions(projection, query);
  assert.deepEqual(
    page.decisions.map(({ decisionId }) => decisionId),
    ["waiting"],
  );
  assert.deepEqual(
    readCollaboratorDecisions(projection, { ...query, cursor: page.page!.nextCursor! }).decisions.map(
      ({ decisionId }) => decisionId,
    ),
    ["authored"],
  );
  assert.equal(readCollaboratorDecisions(projection, { involvement: "all" }).decisions.length, 3);
  assert.deepEqual(readAttestationPool(projection, { involvement: "mine" }).tasks, []);
  assert.deepEqual(
    readAttestationPool(projection, query).tasks.map(({ taskId }) => taskId),
    ["bob-review"],
  );
});

test("legacy ownerless todos remain in mine and an administrator's agenda uses the selected member", () => {
  const rows = [null, alice, bob].map((createdByPersonId, i) => ({
    id: `todo-${i}`,
    createdByPersonId,
    originNodeId: createdByPersonId === bob ? edge : "center",
    value: { id: `todo-${i}`, text: `Todo ${i}`, completed: false, archived: false },
  }));
  const projection = {
    listEntities: () => rows,
    readRelationQuery: () => ({ ...cut, rows: [], page: null }),
    listDecisions: () => ({ ...cut, decisions: [] }),
    readTaskIndex: () => ({ ...cut, rows: [], warnings: [] }),
    listPinnedEntities: (personId: string) => [{ entityRef: `task/${personId}`, pinnedBy: personId, pinnedAt: first }],
  } as unknown as TaskProjection;
  assert.deepEqual(
    readViewerTodos(projection, { viewerPersonId: bob }).map(({ id }) => id),
    ["todo-0", "todo-2"],
  );
  assert.deepEqual(
    readViewerTodos(projection, { viewerPersonId: alice, scope: { personId: bob } }).map(({ id }) => id),
    ["todo-2"],
  );
  const agenda = readCollaboratorAgenda(projection, { viewerPersonId: alice, scopePersonId: bob });
  assert.equal(agenda.personId, bob);
  assert.deepEqual(
    agenda.pinnedEntities.map(({ pinnedBy }) => pinnedBy),
    [bob],
  );
  assert.deepEqual(
    agenda.todos.map(({ id }) => id),
    ["todo-0", "todo-2"],
  );
  assert.deepEqual(
    readCollaboratorEntities(projection, "todo", { filterNodeId: edge }).map(({ id }) => id),
    ["todo-2"],
  );
  assert.equal(readCollaboratorSchedules(projection, { filterNodeId: edge }).length, 1);

  const current = { personId: alice, pinned: true, entityRef: "task/shared", pinnedAt: first };
  assert.equal(personalPinsFromNewest([{ ...current, personId: null, pinned: false }, current], alice).length, 1);
  assert.deepEqual(personalPinsFromNewest([current], bob), []);
});

test("node filters reach the artifact and cadence projection ahead of pagination", () => {
  const projected = (query: unknown) => query as never;
  assert.deepEqual(
    readCollaboratorArtifacts(
      { readArtifactTimelinePage: projected },
      { kind: "raw", limit: 1, scopePersonId: bob, filterNodeId: edge },
    ),
    { kind: "raw", limit: 1, actorPersonId: bob, nodeId: edge },
  );
  assert.deepEqual(
    readCollaboratorCadence({ readEventList: projected }, { limit: 1, scopePersonId: bob, filterNodeId: edge }),
    { limit: 1, actorPersonId: bob, nodeId: edge },
  );
  const live = readCollaboratorLiveFloor(
    {
      readRuntimeSessions: (() => [{ runtimeSessionId: alice }, { runtimeSessionId: bob }]) as never,
      readLatestRuntimeDispatchBySession: ((id: string) => ({
        actor: actor(id),
        source: id === bob ? { kind: "node", nodeId: edge } : "local",
      })) as never,
    },
    { scopePersonId: bob, filterNodeId: edge },
  );
  assert.deepEqual(
    live.map(({ session }) => session.runtimeSessionId),
    [bob],
  );
  assert.equal(
    readRepositoryCollaboration({ mode: "local", members: [{ personId: alice }], nodes: [] }).effectiveMode,
    "local",
  );
  assert.equal(
    readRepositoryCollaboration({ mode: "local", members: [{ personId: alice }, { personId: bob }], nodes: [] })
      .effectiveMode,
    "center",
  );
  assert.equal(
    readRepositoryCollaboration({ mode: "local", members: [], nodes: [{ kind: "edge" }] }).effectiveMode,
    "center",
  );
});

test("token bill groups by the dispatch principal and source across pages", () => {
  const dispatch = (personId: string, source: unknown, totalTokens: number) => ({
    event: { actor: actor(personId), source, occurredAt: first, payload: {} },
    metrics: {
      totalTokens,
      inputTokens: totalTokens - 1,
      cacheReadTokens: 0,
      outputTokens: 1,
      toolCallCount: 0,
      usageUnavailable: false,
    },
  });
  const projection = {
    readCut: () => cut,
    readRuntimeDispatchPage: ({ cursor }: { cursor?: unknown }) =>
      cursor
        ? { rows: [dispatch(bob, { kind: "node", nodeId: edge }, 12)], done: true, nextCursor: null }
        : { rows: [dispatch(alice, "local", 7)], done: false, nextCursor: { startedAt: first, dispatchId: "d1" } },
  } as unknown as TaskProjection;
  const all = readCollaboratorTokenUsage(projection, { startedAtGte: first });
  assert.equal(all.totals.totalTokens, 19);
  assert.deepEqual(
    all.byPerson.map(({ personId, totalTokens }) => [personId, totalTokens]),
    [
      [alice, 7],
      [bob, 12],
    ],
  );
  assert.deepEqual(
    all.byNode.map(({ nodeId, totalTokens }) => [nodeId, totalTokens]),
    [
      ["center", 7],
      [edge, 12],
    ],
  );
  assert.equal(
    readCollaboratorTokenUsage(projection, { startedAtGte: first, scopePersonId: alice, filterNodeId: edge }).totals
      .totalTokens,
    0,
  );
});
