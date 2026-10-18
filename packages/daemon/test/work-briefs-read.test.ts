// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { workBriefsFromProjection } from "../src/work-briefs-read.ts";
import { validateDaemonWorkBriefs } from "../src/protocol/gui-result-validation.ts";
import type { AgendaAwaitsRow } from "../src/protocol/daemon-protocol-gui-types.ts";

const task = (
  taskId: string,
  parentTaskId: string | null,
  status: "planned" | "active" | "submitted" | "in_review" | "blocked" | "done" | "cancelled",
  taskClass: "standard" | "work" = "standard",
  updatedAt = "2026-10-15T00:00:00.000Z",
) => ({
  taskId,
  parentTaskId,
  status,
  taskClass,
  title: `${taskId} 标题`,
  pinned: false,
  workKind: null,
  riskTier: null,
  urgency: null,
  packageDisposition: "active",
  supersededBy: null,
  packagePath: `tasks/${taskId}`,
  updatedAt,
});

const ask = (sourceRef: string, title: string, askKind: AgendaAwaitsRow["askKind"]): AgendaAwaitsRow =>
  ({
    relationId: `rel_${sourceRef}`,
    relationRevision: 1,
    sourceRef,
    title,
    status: "active",
    personId: "person_owner",
    askKind,
    question: `${title} 的提问原文`,
    askedAt: "2026-10-16T00:00:00.000Z",
    askedBy: "agent:x",
  }) as AgendaAwaitsRow;

function projection(input: {
  readonly rows: readonly ReturnType<typeof task>[];
  readonly principals?: Readonly<Record<string, string>>;
  readonly derives?: readonly { readonly sourceRef: string; readonly targetRef: string }[];
}) {
  return {
    readTaskIndex: () => ({
      status: "ready",
      rows: input.rows,
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    }),
    read: (taskId: string) => ({
      snapshot: {
        task: { createdBy: { principal: { personId: input.principals?.[taskId] ?? "person_owner" }, executor: null } },
      },
    }),
    readTaskRelationsByTargets: (targetRefs: readonly string[], relationType: string) => ({
      rows:
        relationType === "derives"
          ? (input.derives ?? [])
              .filter(({ targetRef }) => targetRefs.includes(targetRef))
              .map(({ sourceRef, targetRef }) => ({
                relationId: `rel_${sourceRef}_${targetRef}`,
                workspaceRevision: 1,
                sourceRef,
                targetRef,
                relationType,
                direction: "directed",
                strength: "strong",
                origin: "declared",
                state: "active",
                targetObservedVersion: null,
                currentTargetVersion: null,
                freshness: "current",
              }))
          : [],
      status: "ready",
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    }),
  } as never;
}

function agendaPage(rows: readonly AgendaAwaitsRow[], pages = 1) {
  let call = 0;
  return () => {
    const at = Math.min(call, pages - 1);
    call += 1;
    return {
      ok: true,
      status: "ready",
      awaitingYou: at === pages - 1 ? rows : [],
      page: { nextCursor: at === pages - 1 ? null : `cursor-${at + 1}` },
    } as never;
  };
}

const rows = [
  task("waiting-root", null, "active", "work"),
  task("waiting-leaf", "waiting-root", "active"),
  task("stuck-root", null, "active", "work"),
  task("stuck-leaf", "stuck-root", "blocked", "standard", "2026-10-16T00:00:00.000Z"),
  task("stuck-leaf-2", "stuck-root", "active"),
  task("running-root", null, "active", "work"),
  task("running-leaf", "running-root", "active", "standard", "2026-10-17T00:00:00.000Z"),
  task("review-root", null, "active", "work"),
  task("review-leaf", "review-root", "submitted", "standard", "2026-10-14T00:00:00.000Z"),
  task("unclear-root", null, "planned", "work"),
  task("unclear-leaf", "unclear-root", "planned"),
  task("fresh-done-root", null, "done", "work"),
  task("fresh-done-leaf", "fresh-done-root", "done", "standard", "2026-10-16T12:00:00.000Z"),
  task("old-done-root", null, "done", "work"),
  task("old-done-leaf", "old-done-root", "done", "standard", "2026-09-01T00:00:00.000Z"),
  task("stranger-root", null, "active", "work"),
  task("stranger-leaf", "stranger-root", "active"),
  // 实测回归(PLT-Honest,2026-10-18):根呈 cancelled、子树挂着活跃任务与等你提问。
  task("zombie-root", null, "cancelled"),
  task("zombie-leaf", "zombie-root", "active", "standard", "2026-10-12T00:00:00.000Z"),
  task("retired-root", null, "cancelled", "work"),
  task("retired-leaf", "retired-root", "cancelled", "standard", "2026-10-16T00:00:00.000Z"),
];

test("buckets follow ask > blocked > active > terminal priority and planned-only falls to the honest fallback", () => {
  const read = workBriefsFromProjection({
    projection: projection({ rows, principals: { "stranger-root": "person_stranger" } }),
    agendaPage: agendaPage([ask("task/waiting-leaf", "等待叶子", "question")]),
    principalId: "person_owner",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  assert.equal(read.schema, "daemon.work-briefs/v1");
  assert.deepEqual(
    read.briefs.map(({ taskId, bucket }) => ({ taskId, bucket })),
    [
      { taskId: "waiting-root", bucket: "waiting" },
      { taskId: "stuck-root", bucket: "stuck" },
      { taskId: "running-root", bucket: "running" },
      { taskId: "review-root", bucket: "running" },
      { taskId: "zombie-root", bucket: "running" },
      { taskId: "unclear-root", bucket: "unclear" },
      { taskId: "fresh-done-root", bucket: "done" },
      { taskId: "retired-root", bucket: "done" },
    ],
  );
});

test("a terminal-presented root with live members keeps them visible instead of folding into done (PLT-Honest regression)", () => {
  const read = workBriefsFromProjection({
    projection: projection({ rows }),
    agendaPage: agendaPage([ask("task/zombie-leaf", "治理范围门", "question")]),
    principalId: "person_owner",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  const zombie = read.briefs.find(({ taskId }) => taskId === "zombie-root");
  assert.equal(zombie?.bucket, "waiting");
  assert.deepEqual(zombie?.sentenceParts, [
    { kind: "ask", title: "治理范围门", askKind: "question" },
    { kind: "executing", title: "zombie-leaf 标题" },
  ]);
});

test("roots created by another principal are out of scope; the seven-day fold retires stale done works", () => {
  const read = workBriefsFromProjection({
    projection: projection({ rows, principals: { "stranger-root": "person_stranger" } }),
    agendaPage: agendaPage([]),
    principalId: "person_owner",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  assert.equal(
    read.briefs.some(({ taskId }) => taskId === "stranger-root"),
    false,
  );
  assert.equal(
    read.briefs.some(({ taskId }) => taskId === "old-done-root"),
    false,
  );
  const fresh = read.briefs.find(({ taskId }) => taskId === "fresh-done-root");
  assert.equal(fresh?.deliveredAt, "2026-10-16T12:00:00.000Z");
});

test("sentence parts lead with the ask, cap at two clauses, and a planned-only work says so", () => {
  const read = workBriefsFromProjection({
    projection: projection({ rows }),
    agendaPage: agendaPage([ask("task/waiting-leaf", "等待叶子", "question")]),
    principalId: "person_owner",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  const byId = new Map(read.briefs.map((brief) => [brief.taskId, brief]));
  assert.deepEqual(byId.get("waiting-root")?.sentenceParts, [
    { kind: "ask", title: "等待叶子", askKind: "question" },
    { kind: "executing", title: "waiting-leaf 标题" },
  ]);
  assert.deepEqual(byId.get("stuck-root")?.sentenceParts, [
    { kind: "blocked", title: "stuck-leaf 标题" },
    { kind: "executing", title: "stuck-leaf-2 标题" },
  ]);
  assert.deepEqual(byId.get("unclear-root")?.sentenceParts, [{ kind: "planned" }]);
  assert.deepEqual(byId.get("fresh-done-root")?.sentenceParts, [{ kind: "delivered", title: "fresh-done-leaf 标题" }]);
  assert.deepEqual(byId.get("retired-root")?.sentenceParts, [{ kind: "retired" }]);
  assert.deepEqual(byId.get("review-root")?.sentenceParts, [{ kind: "review", title: "review-leaf 标题" }]);
  assert.equal(byId.get("waiting-root")?.asks.length, 1);
});

test("decision-sourced asks attach through active derives edges into the subtree", () => {
  const read = workBriefsFromProjection({
    projection: projection({
      rows,
      derives: [{ sourceRef: "decision/dec_ABC/CH1", targetRef: "task/running-leaf" }],
    }),
    agendaPage: agendaPage([ask("decision/dec_ABC", "设计裁决", "consent")]),
    principalId: "person_owner",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  const running = read.briefs.find(({ taskId }) => taskId === "running-root");
  assert.equal(running?.bucket, "waiting");
  assert.deepEqual(running?.sentenceParts, [
    { kind: "ask", title: "设计裁决", askKind: "consent" },
    { kind: "executing", title: "running-leaf 标题" },
  ]);
});

test("the full result passes the RPC boundary validator, including the title-less retired part", () => {
  // 实测回归(2026-10-18,真实 canonical 台账 task_9544f281…「产品化激活与对外发布」):全体成员
  // cancelled 的工作落 done 桶、分句只剩 {kind:"retired"},验证器曾因「非 planned 分句必须带
  // 标题」把整份读面拒成 invalid_result——读面契约(planned/retired 均为纯状态分句)与验证器对齐。
  const read = workBriefsFromProjection({
    projection: projection({ rows }),
    agendaPage: agendaPage([]),
    principalId: "person_owner",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  assert.deepEqual(validateDaemonWorkBriefs(read), []);
  const titlelessTitled = structuredClone(read) as unknown as { briefs: { sentenceParts: unknown[] }[] };
  titlelessTitled.briefs[0]!.sentenceParts[0] = { kind: "executing" };
  assert.equal(validateDaemonWorkBriefs(titlelessTitled).length > 0, true);
});

test("the agenda sweep aggregates every page before attributing asks", () => {
  const read = workBriefsFromProjection({
    projection: projection({ rows }),
    agendaPage: agendaPage([ask("task/running-leaf", "第二页提问", "acceptance")], 3),
    principalId: "person_owner",
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  assert.equal(read.briefs.find(({ taskId }) => taskId === "running-root")?.bucket, "waiting");
});

test("the latest task-branch CI run rides along for the drawer", () => {
  const read = workBriefsFromProjection({
    projection: projection({ rows }),
    agendaPage: agendaPage([]),
    principalId: "person_owner",
    ciRuns: [
      { branch: "main", prNumber: null, pass: true, occurredAt: "2026-10-17T00:00:00.000Z" },
      { branch: "task_running-leaf", prNumber: 3700, pass: true, occurredAt: "2026-10-17T09:00:00.000Z" },
      { branch: "task_running-leaf", prNumber: 3700, pass: false, occurredAt: "2026-10-16T09:00:00.000Z" },
    ],
    now: () => new Date("2026-10-18T00:00:00.000Z"),
  });
  const running = read.briefs.find(({ taskId }) => taskId === "running-root");
  assert.deepEqual(running?.pullRequests, [
    {
      taskId: "running-leaf",
      branch: "task_running-leaf",
      prNumber: 3700,
      pass: true,
      occurredAt: "2026-10-17T09:00:00.000Z",
    },
  ]);
});
