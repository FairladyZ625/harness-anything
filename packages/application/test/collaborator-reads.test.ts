// harness-test-tier: contract
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskIndexProjectionRow, TaskProjection } from "@harness-anything/kernel";
import { personalPinsFromNewest } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import {
  describeSubmittedCloseoutAttention,
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
  activeOrLatestPersonId: createdByPersonId,
  activeOrLatestNodeId: createdByPersonId === bob ? edge : "center",
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
    { decisionId: "dec_PRIVATE", proposer: actor(alice) },
    { decisionId: "dec_WAITING", proposer: actor(alice) },
    { decisionId: "dec_AUTHORED", proposer: actor(bob) },
  ];
  const ask = {
    relationId: "ask",
    sourceRef: "decision/dec_WAITING",
    state: "active",
    strength: "weak",
    freshness: "current",
    rationale: "consent: Approve the draft?",
    workspaceRevision: cut.watermark,
    entity: { createdAt: first, provenance: { actor: actor(alice) } },
  };
  const projection = {
    readCut: () => cut,
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
      assert.deepEqual(query, {
        target: `person/${bob}`,
        relationType: "awaits",
        state: "active",
        limit: storageReadPolicy.defaultValue.pageSizes.standard,
      });
      return { ...cut, rows: [ask], page: null };
    },
    readRelationEdge: () => ask,
    readDecision: () => ({ ...cut, decision: { title: "Waiting", state: "proposed" } }),
    readTaskIndex: () => ({ ...cut, rows: [row("bob-review", "Sign", bob, null, "in_review", first)], warnings: [] }),
  } as unknown as TaskProjection;
  const query = { involvement: "mine", viewerPersonId: bob, limit: 1 } as const;
  const page = readCollaboratorDecisions(projection, query);
  assert.deepEqual(
    page.decisions.map(({ decisionId }) => decisionId),
    ["dec_WAITING"],
  );
  assert.deepEqual(
    readCollaboratorDecisions(projection, { ...query, cursor: page.page!.nextCursor! }).decisions.map(
      ({ decisionId }) => decisionId,
    ),
    ["dec_AUTHORED"],
  );
  assert.equal(readCollaboratorDecisions(projection, { involvement: "all" }).decisions.length, 3);
  assert.deepEqual(readAttestationPool(projection, { involvement: "mine" }).tasks, []);
  assert.deepEqual(
    readAttestationPool(projection, query).tasks.map(({ taskId }) => taskId),
    ["bob-review"],
  );
});

test("cursor-only decision pages fill the default window and refuse mixed cuts", () => {
  const query = { involvement: "mine", viewerPersonId: bob, cursor: "start" } as const;
  let drift = false;
  const projection = {
    readCut: () => cut,
    readRelationQuery: () => ({ ...cut, rows: [] }),
    listDecisions: ({ limit, cursor }: { limit?: number; cursor?: string }) => {
      assert.equal(limit, 100);
      return cursor === "start"
        ? { ...cut, decisions: [{ decisionId: "dec_OTHER", proposer: actor(alice) }], page: { nextCursor: "next" } }
        : {
            ...cut,
            ...(drift ? { watermark: cut.watermark + 1 } : {}),
            decisions: [{ decisionId: "dec_MATCH", proposer: actor(bob) }],
            page: { nextCursor: null },
          };
    },
  } as unknown as TaskProjection;
  const cursorOnly = readCollaboratorDecisions(projection, query);
  assert.deepEqual(cursorOnly, readCollaboratorDecisions(projection, { ...query, limit: 100 }));
  assert.deepEqual(
    cursorOnly.decisions.map(({ decisionId }) => decisionId),
    ["dec_MATCH"],
  );
  assert.deepEqual(cursorOnly.page, { limit: 100, cursor: "start", nextCursor: null });
  drift = true;
  assert.throws(() => readCollaboratorDecisions(projection, query), /spans multiple event projection cuts/);
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
    readCut: () => cut,
    readRelationQuery: () => ({ ...cut, rows: [], page: null }),
    listDecisions: () => ({ ...cut, decisions: [] }),
    readTaskIndex: () => ({
      ...cut,
      rows: [
        row("bob-submitted", "Submitted awaiting merge", bob, null, "submitted", second),
        row("bob-active", "Active implementation", bob, null, "active", first),
        row("alice-submitted", "Alice submitted", alice, null, "submitted", second),
      ],
      warnings: [],
    }),
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
    agenda.submittedTasks.map(({ taskId }) => taskId),
    ["bob-submitted"],
  );
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
      readRuntimeSessionEventsByType: () => [],
      readLatestRuntimeDispatchBySession: ((id: string) => ({
        actor: actor(id),
        payload: {},
        occurredAt: first,
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

test("describeSubmittedCloseoutAttention surfaces delivery, gate, fact retirement, and pending completion actions", () => {
  const delivery = describeSubmittedCloseoutAttention({
    taskId: "task-delivery",
    title: "Unmerged low-risk PR",
    completionBlockerCode: "delivery_missing",
    completionNextAction: "Merge the delivery with node tools/pr-merge.mjs <PR-number-or-url>.",
  });
  assert.equal(delivery.blockerCode, "delivery_missing");
  assert.match(delivery.attentionTitle, /Unmerged low-risk PR — \[delivery_missing\] Merge the delivery/u);
  assert.match(delivery.summaryHint, /下一步 \(delivery_missing\): Merge the delivery/u);

  const fact = describeSubmittedCloseoutAttention({
    taskId: "task-fact",
    title: "Fact disposition needed",
    completionBlockerCode: null,
    completionNextAction: "ha task complete task-fact",
    undischargedFactRefs: ["fact/f1", "fact/f1", "fact/f2"],
  });
  assert.equal(fact.blockerCode, "fact_retirement_undeclared");
  assert.equal(
    fact.nextAction,
    'ha task complete task-fact --fact-holds "fact/f1:<rationale>" --fact-holds "fact/f2:<rationale>"',
  );

  const pending = describeSubmittedCloseoutAttention({
    taskId: "task-pending",
    title: "Awaiting maintainer closeout",
    completionBlockerCode: null,
    completionNextAction: null,
  });
  assert.equal(pending.blockerCode, "completion_pending");
  assert.equal(pending.nextAction, "ha task complete task-pending");
});
