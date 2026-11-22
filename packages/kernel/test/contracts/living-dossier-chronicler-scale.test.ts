// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { synthesizeDossierDocument, type DossierChangeItem } from "../../src/domain/living-dossier-synthesizer.ts";
import type { DossierSlot } from "../../src/domain/living-dossier.ts";

const atlasSlot: DossierSlot = {
  id: "project-atlas",
  path: "project-atlas.html",
  kind: "html",
  title: "Project Atlas",
  summary: "System architecture topology and entity map.",
  entityKinds: ["task", "decision", "fact", "research"],
  requiredAnchors: ["atlas-topology", "entity-map", "change-ledger"],
  watermarkMetadata: "required",
  triggers: [{ kind: "event-watermark", minimumDelta: 5 }],
};

const pulseSlot: DossierSlot = {
  id: "project-pulse",
  path: "project-pulse.html",
  kind: "html",
  title: "Project Pulse",
  summary: "Cross-work progress flow and risk signals.",
  entityKinds: ["task", "decision", "fact"],
  requiredAnchors: ["pulse-flow", "decision-trail", "risk-signals"],
  watermarkMetadata: "required",
  triggers: [{ kind: "event-watermark", minimumDelta: 5 }],
};

const contextSlot: DossierSlot = {
  id: "context",
  path: "CONTEXT.md",
  kind: "markdown",
  title: "Domain Context",
  summary: "System boundaries and verified facts.",
  entityKinds: ["task", "decision", "fact"],
  requiredAnchors: ["overview", "active-invariants", "recent-changes"],
  watermarkMetadata: "required",
  triggers: [{ kind: "periodic", everyMs: 86_400_000 }],
};

const adrLedgerSlot: DossierSlot = {
  id: "adr-ledger",
  path: "ADR_LEDGER.md",
  kind: "markdown",
  title: "ADR Ledger",
  summary: "Active architectural decisions and supersessions.",
  entityKinds: ["decision", "fact"],
  requiredAnchors: ["active-decisions", "supersession-log"],
  watermarkMetadata: "required",
  triggers: [{ kind: "event-watermark", minimumDelta: 4 }],
};

const workNarrativesSlot: DossierSlot = {
  id: "work-narratives",
  path: "WORK_NARRATIVES.md",
  kind: "markdown",
  title: "Work Narratives",
  summary: "Cross-work delivery arc and task log.",
  entityKinds: ["task", "decision"],
  requiredAnchors: ["delivery-arc", "work-log"],
  watermarkMetadata: "required",
  triggers: [{ kind: "event-watermark", minimumDelta: 6 }],
};

const page1Changes: readonly DossierChangeItem[] = [
  {
    eventId: "evt_001",
    schema: "decision-event/v1",
    type: "decision_accepted",
    occurredAt: "2026-11-22T10:00:00.000Z",
    workspaceRevision: 10,
    decisionId: "dec_001",
    actor: { principal: { personId: "person_zeyu" } },
    payload: { title: "Adopt vertical living dossier contract", modules: ["kernel", "gui"] },
    entityRefs: ["decision/dec_001"],
  },
  {
    eventId: "evt_002",
    schema: "task-event/v1",
    type: "task_completed",
    occurredAt: "2026-11-22T11:00:00.000Z",
    workspaceRevision: 18,
    taskId: "task_002",
    actor: { executor: { id: "worker-1" } },
    payload: { title: "Ship <script>alert(1)</script> escaping guard", taskStatus: "done" },
    entityRefs: ["task/task_002"],
  },
];

test("F-DOSSIER-04: merges decision proposal->accept, retires/replaces relations, and keeps exact Work totals across >128 child tasks", () => {
  // 1. decision_proposed (with title/chosen/modules) stays out of Active Decisions until decision_accepted (rationale only)
  const proposedOnly = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: adrLedgerSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 5,
    changes: [
      {
        eventId: "evt_prop_1",
        schema: "decision-event/v1",
        type: "decision_proposed",
        occurredAt: "2026-11-23T01:00:00.000Z",
        workspaceRevision: 5,
        decisionId: "dec_lifecycle_1",
        actor: { principal: { personId: "person_zeyu" } },
        payload: {
          title: "Adopt split kernel dossier modules",
          chosen: ["CH1: Keep state, HTML and chronicler merge acyclic"],
          modules: ["packages/kernel", "packages/gui"],
        },
        entityRefs: ["decision/dec_lifecycle_1"],
      },
    ],
    synthesizedAt: "2026-11-23T01:00:00.000Z",
  });
  const activeBeforeAccept =
    proposedOnly.split("<!-- dossier-anchor: active-decisions -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  assert.ok(!activeBeforeAccept.includes("dec_lifecycle_1"), "unaccepted proposal must not enter Active Decisions");

  const acceptedMerged = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: adrLedgerSlot,
    previousBody: proposedOnly,
    expectedWatermark: 5,
    targetWatermark: 10,
    changes: [
      {
        eventId: "evt_acc_1",
        schema: "decision-event/v1",
        type: "decision_accepted",
        occurredAt: "2026-11-23T01:05:00.000Z",
        workspaceRevision: 10,
        decisionId: "dec_lifecycle_1",
        actor: { principal: { personId: "person_zeyu" } },
        payload: { reason: "Approved after architecture review" },
        entityRefs: ["decision/dec_lifecycle_1"],
      },
    ],
    synthesizedAt: "2026-11-23T01:05:00.000Z",
  });
  const activeAfterAccept =
    acceptedMerged.split("<!-- dossier-anchor: active-decisions -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  assert.ok(activeAfterAccept.includes("Adopt split kernel dossier modules"));
  assert.ok(activeAfterAccept.includes("CH1: Keep state, HTML and chronicler merge acyclic"));
  assert.ok(activeAfterAccept.includes("packages/kernel, packages/gui"));
  assert.ok(activeAfterAccept.includes("Approved after architecture review"));

  // 2. relation create -> decision_relation_replaced & relation_retired remove stale edges & derived tasks
  const atlasRel1 = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 20,
    changes: [
      {
        eventId: "evt_d1",
        schema: "decision-event/v1",
        type: "decision_accepted",
        occurredAt: "2026-11-23T01:00:00.000Z",
        workspaceRevision: 10,
        decisionId: "dec_rel_1",
        actor: { principal: { personId: "person_zeyu" } },
        payload: { title: "Enforce clean relation graph" },
        entityRefs: ["decision/dec_rel_1"],
      },
      {
        eventId: "evt_rel_a",
        schema: "relation-event/v1",
        type: "relation_created",
        occurredAt: "2026-11-23T01:01:00.000Z",
        workspaceRevision: 12,
        actor: { principal: { personId: "person_zeyu" } },
        payload: {
          relation: {
            relationId: "rel_old_0001",
            source: "decision/dec_rel_1",
            target: "task/task_old_derived",
            relationType: "derives",
            state: "active",
          },
        },
        entityRefs: ["relation/rel_old_0001", "decision/dec_rel_1", "task/task_old_derived"],
      },
      {
        eventId: "evt_rel_b",
        schema: "relation-event/v1",
        type: "relation_created",
        occurredAt: "2026-11-23T01:02:00.000Z",
        workspaceRevision: 14,
        actor: { principal: { personId: "person_zeyu" } },
        payload: {
          relation: {
            relationId: "rel_retire_0002",
            source: "decision/dec_rel_1",
            target: "task/task_retired_derived",
            relationType: "derives",
            state: "active",
          },
        },
        entityRefs: ["relation/rel_retire_0002", "decision/dec_rel_1", "task/task_retired_derived"],
      },
    ],
    synthesizedAt: "2026-11-23T01:05:00.000Z",
  });
  assert.ok(atlasRel1.includes("task/task_old_derived"));
  assert.ok(atlasRel1.includes("task/task_retired_derived"));

  const atlasRel2 = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: atlasRel1,
    expectedWatermark: 20,
    targetWatermark: 30,
    changes: [
      {
        eventId: "evt_rel_replace",
        schema: "decision-event/v1",
        type: "decision_relation_replaced",
        occurredAt: "2026-11-23T01:10:00.000Z",
        workspaceRevision: 24,
        decisionId: "dec_rel_1",
        actor: { principal: { personId: "person_zeyu" } },
        payload: {
          relation: {
            relationId: "rel_new_0003",
            previousRelationId: "rel_old_0001",
            source: "decision/dec_rel_1",
            target: "task/task_new_derived",
            relationType: "derives",
            state: "active",
          },
        },
        entityRefs: ["decision/dec_rel_1", "task/task_new_derived"],
      },
      {
        eventId: "evt_rel_retire",
        schema: "relation-event/v1",
        type: "relation_retired",
        occurredAt: "2026-11-23T01:12:00.000Z",
        workspaceRevision: 28,
        actor: { principal: { personId: "person_zeyu" } },
        payload: {
          relation: { relationId: "rel_retire_0002", state: "retired" },
        },
        entityRefs: ["relation/rel_retire_0002"],
      },
    ],
    synthesizedAt: "2026-11-23T01:15:00.000Z",
  });
  const decTrail = atlasRel2.split('id="decision-trail"')[1]?.split("</section>")[0] ?? "";
  assert.ok(decTrail.includes("task/task_new_derived"), "replacement derived task must appear");
  assert.ok(!decTrail.includes("task/task_old_derived"), "replaced derived task must be removed");
  assert.ok(!decTrail.includes("task/task_retired_derived"), "retired derived task must be removed");

  // 3. Single Work accumulating 135 child tasks across 3 pages (>128 MAX_TRACKED_TASKS cap) retains exact 135/135 rollup
  let pulseBody: string | null = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 1,
    changes: [
      {
        eventId: "evt_big_work",
        schema: "task-event/v1",
        type: "task_created",
        occurredAt: "2026-11-23T01:00:00.000Z",
        workspaceRevision: 1,
        taskId: "work_scale",
        actor: { principal: { personId: "person_zeyu" } },
        payload: {
          title: "Large Scale Work",
          taskClass: "work",
          taskStatus: "active",
          parentTaskId: null,
          packagePath: "tasks/work_scale-large-scale",
        },
        entityRefs: ["task/work_scale"],
      },
    ],
    synthesizedAt: "2026-11-23T01:00:00.000Z",
  });

  for (let page = 0; page < 3; page += 1) {
    const startIdx = page * 45;
    const pageChanges: DossierChangeItem[] = Array.from({ length: 45 }, (_, offset) => {
      const idx = startIdx + offset + 1;
      return {
        eventId: `evt_scale_child_${idx}`,
        schema: "task-event/v1",
        type: "task_completed",
        occurredAt: "2026-11-23T01:30:00.000Z",
        workspaceRevision: 1 + idx,
        taskId: `task_scale_${idx}`,
        actor: { executor: { id: "worker" } },
        payload: {
          title: `Scale child task #${idx}`,
          taskClass: "standard",
          taskStatus: "done",
          parentTaskId: "work_scale",
        },
        entityRefs: [`task/task_scale_${idx}`],
      };
    });
    pulseBody = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: pulseSlot,
      previousBody: pulseBody,
      expectedWatermark: 1 + startIdx,
      targetWatermark: 1 + startIdx + 45,
      changes: pageChanges,
      synthesizedAt: "2026-11-23T01:30:00.000Z",
    });
  }
  assert.ok(pulseBody.includes("135/135"), "Work rollup across 3 pages of 135 child tasks must report exact 135/135");
  assert.ok(pulseBody.includes("tasks/work_scale-large-scale/artifacts/explainer.html"));
});

test("F-DOSSIER-04 (iter3): retires derived task even after >64 intervening relations evict cache and keeps exact Work totals across 129 Works", () => {
  // 1. Decision proposed -> derives edge -> accepted -> 70 unrelated relations evict relations cache -> relation_retired still clears Derived Task
  const initialChanges: readonly DossierChangeItem[] = [
    {
      eventId: "evt_evict_prop",
      schema: "decision-event/v1",
      type: "decision_proposed",
      occurredAt: "2026-11-23T03:00:00.000Z",
      workspaceRevision: 1,
      decisionId: "dec_evict_1",
      actor: { principal: { personId: "person_zeyu" } },
      payload: { title: "Retire evicted relation cleanly", modules: ["packages/kernel"] },
      entityRefs: ["decision/dec_evict_1"],
    },
    {
      eventId: "evt_evict_rel",
      schema: "relation-event/v1",
      type: "relation_created",
      occurredAt: "2026-11-23T03:01:00.000Z",
      workspaceRevision: 2,
      actor: { principal: { personId: "person_zeyu" } },
      payload: {
        relation: {
          relationId: "rel_evicted_0001",
          source: "decision/dec_evict_1",
          target: "task/task_evicted_derived",
          relationType: "derives",
          state: "active",
        },
      },
      entityRefs: ["relation/rel_evicted_0001", "decision/dec_evict_1", "task/task_evicted_derived"],
    },
    {
      eventId: "evt_evict_acc",
      schema: "decision-event/v1",
      type: "decision_accepted",
      occurredAt: "2026-11-23T03:02:00.000Z",
      workspaceRevision: 3,
      decisionId: "dec_evict_1",
      actor: { principal: { personId: "person_zeyu" } },
      payload: { reason: "Approved" },
      entityRefs: ["decision/dec_evict_1"],
    },
  ];
  let pulseDoc = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 3,
    changes: initialChanges,
    synthesizedAt: "2026-11-23T03:02:00.000Z",
  });
  let adrDoc = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: adrLedgerSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 3,
    changes: initialChanges,
    synthesizedAt: "2026-11-23T03:02:00.000Z",
  });
  assert.ok(pulseDoc.includes("task/task_evicted_derived"));
  assert.ok(adrDoc.includes("task_evicted_derived"));

  // Push 70 unrelated relations across two windows (>64 MAX_TRACKED_RELATIONS) to evict rel_evicted_0001 from relations[]
  for (let batch = 0; batch < 2; batch += 1) {
    const start = batch * 35;
    const noiseRelations: DossierChangeItem[] = Array.from({ length: 35 }, (_, idx) => {
      const n = start + idx + 1;
      return {
        eventId: `evt_noise_rel_${n}`,
        schema: "relation-event/v1",
        type: "relation_created",
        occurredAt: "2026-11-23T03:05:00.000Z",
        workspaceRevision: 3 + n,
        actor: { executor: { id: "worker" } },
        payload: {
          relation: {
            relationId: `rel_noise_${n}`,
            source: `fact/F-NOISE-${n}`,
            target: `task/task_noise_${n}`,
            relationType: "informs",
            state: "active",
          },
        },
        entityRefs: [`relation/rel_noise_${n}`, `fact/F-NOISE-${n}`, `task/task_noise_${n}`],
      };
    });
    pulseDoc = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: pulseSlot,
      previousBody: pulseDoc,
      expectedWatermark: 3 + start,
      targetWatermark: 3 + start + 35,
      changes: noiseRelations,
      synthesizedAt: "2026-11-23T03:05:00.000Z",
    });
    adrDoc = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: adrLedgerSlot,
      previousBody: adrDoc,
      expectedWatermark: 3 + start,
      targetWatermark: 3 + start + 35,
      changes: noiseRelations,
      synthesizedAt: "2026-11-23T03:05:00.000Z",
    });
  }

  // Retire rel_evicted_0001 (canonical relation_retired payload carrying only relationId)
  const retireChange: readonly DossierChangeItem[] = [
    {
      eventId: "evt_retire_evicted_rel",
      schema: "relation-event/v1",
      type: "relation_retired",
      occurredAt: "2026-11-23T03:10:00.000Z",
      workspaceRevision: 74,
      actor: { principal: { personId: "person_zeyu" } },
      payload: { relation: { relationId: "rel_evicted_0001", state: "retired" } },
      entityRefs: ["relation/rel_evicted_0001"],
    },
  ];
  pulseDoc = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: pulseDoc,
    expectedWatermark: 73,
    targetWatermark: 74,
    changes: retireChange,
    synthesizedAt: "2026-11-23T03:10:00.000Z",
  });
  adrDoc = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: adrLedgerSlot,
    previousBody: adrDoc,
    expectedWatermark: 73,
    targetWatermark: 74,
    changes: retireChange,
    synthesizedAt: "2026-11-23T03:10:00.000Z",
  });
  const decTrailAfterEvict = pulseDoc.split('id="decision-trail"')[1]?.split("</section>")[0] ?? "";
  assert.ok(!decTrailAfterEvict.includes("task/task_evicted_derived"), "Pulse must clear evicted retired derived task");
  const activeAdrAfterEvict =
    adrDoc.split("<!-- dossier-anchor: active-decisions -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  assert.ok(
    !activeAdrAfterEvict.includes("task_evicted_derived"),
    "ADR_LEDGER must clear evicted retired derived task",
  );

  // 2. 129 Works each with 1 completed child task: earliest Work reactivated later must show 1/1, never 0/0
  let multiWorkPulse: string | null = null;
  let multiWorkMd: string | null = null;
  let cursor = 0;
  for (let start = 1; start <= 129; start += 25) {
    const end = Math.min(129, start + 24);
    const batchChanges: DossierChangeItem[] = [];
    for (let i = start; i <= end; i += 1) {
      const id = String(i).padStart(3, "0");
      batchChanges.push(
        {
          eventId: `evt_mw_work_${id}`,
          schema: "task-event/v1",
          type: "task_created",
          occurredAt: "2026-11-23T03:20:00.000Z",
          workspaceRevision: ++cursor,
          taskId: `work_mw_${id}`,
          actor: { principal: { personId: "person_zeyu" } },
          payload: { title: `Work ${id}`, taskClass: "work", taskStatus: "active", parentTaskId: null },
          entityRefs: [`task/work_mw_${id}`],
        },
        {
          eventId: `evt_mw_child_${id}`,
          schema: "task-event/v1",
          type: "task_completed",
          occurredAt: "2026-11-23T03:21:00.000Z",
          workspaceRevision: ++cursor,
          taskId: `task_mw_child_${id}`,
          actor: { executor: { id: "worker" } },
          payload: { title: `Child ${id}`, taskClass: "standard", taskStatus: "done", parentTaskId: `work_mw_${id}` },
          entityRefs: [`task/task_mw_child_${id}`],
        },
      );
    }
    const prevWatermark = cursor - batchChanges.length;
    multiWorkPulse = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: pulseSlot,
      previousBody: multiWorkPulse,
      expectedWatermark: prevWatermark,
      targetWatermark: cursor,
      changes: batchChanges,
      synthesizedAt: "2026-11-23T03:22:00.000Z",
    });
    multiWorkMd = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: workNarrativesSlot,
      previousBody: multiWorkMd,
      expectedWatermark: prevWatermark,
      targetWatermark: cursor,
      changes: batchChanges,
      synthesizedAt: "2026-11-23T03:22:00.000Z",
    });
  }

  // Reactivate earliest work_mw_001 so it sorts back to the top of Pulse & WORK_NARRATIVES
  const reactivateRev = cursor + 1;
  const reactivateChange: readonly DossierChangeItem[] = [
    {
      eventId: "evt_mw_001_bump",
      schema: "task-event/v1",
      type: "task_transitioned",
      occurredAt: "2026-11-23T03:30:00.000Z",
      workspaceRevision: reactivateRev,
      taskId: "work_mw_001",
      actor: { principal: { personId: "person_zeyu" } },
      payload: { taskStatus: "active" },
      entityRefs: ["task/work_mw_001"],
    },
  ];
  multiWorkPulse = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: multiWorkPulse,
    expectedWatermark: cursor,
    targetWatermark: reactivateRev,
    changes: reactivateChange,
    synthesizedAt: "2026-11-23T03:30:00.000Z",
  });
  multiWorkMd = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: workNarrativesSlot,
    previousBody: multiWorkMd,
    expectedWatermark: cursor,
    targetWatermark: reactivateRev,
    changes: reactivateChange,
    synthesizedAt: "2026-11-23T03:30:00.000Z",
  });
  const workRowMatch = /<tr><td class="refs"><code>work_mw_001<\/code><\/td>[\s\S]*?<\/tr>/u.exec(multiWorkPulse);
  assert.ok(workRowMatch, "work_mw_001 must appear at the top of Pulse work table");
  assert.ok(
    workRowMatch[0].includes('<td class="rev">1/1</td>'),
    `work_mw_001 must retain 1/1, got ${workRowMatch[0]}`,
  );
  assert.ok(multiWorkMd.includes("| `work_mw_001` | Work 001 | `active` | 1/1 |"));
});

test("F-DOSSIER-05/06 (iter3): scrubs ftp/mailto/ws/protocol-relative URIs and trims replaceable appendix on exact-524288 empty r999->r1000 page", () => {
  // 1. Non-HTTP URI schemes & non-fragment links scrubbed across empty and non-empty pages while preserving #anchors
  const legacySchemesHtml = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><meta name="dossier-watermark" content="10"><title>Curated Atlas</title></head>',
    "<body><main>",
    '<section id="atlas-topology"><svg viewBox="0 0 320 100" role="img"><rect x="8" y="8" width="120" height="40"/></svg><a href="#entity-map">Jump</a></section>',
    '<section id="entity-map"><p>Archive: ftp://archive.example.org/notes, ftps://vault.example.org/drop, ws://stream.example.org/v1, //cdn.example.org/bundle and <a href="mailto:docs@example.org">Contact</a>.</p></section>',
    '<section id="change-ledger"><p>Baseline r10.</p></section>',
    "</main></body></html>",
  ].join("\n");

  for (const delta of [[], [page1Changes[0]!]] as const) {
    const out = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: atlasSlot,
      previousBody: legacySchemesHtml,
      expectedWatermark: 10,
      targetWatermark: delta.length === 0 ? 12 : 15,
      changes: delta,
      synthesizedAt: "2026-11-23T03:40:00.000Z",
    });
    assert.doesNotMatch(out, /(?:https?|ftps?|wss?):\/\/|\b(?:mailto|tel):|\/\/cdn\.example\.org/iu);
    assert.ok(out.includes("archive.example.org/notes"));
    assert.ok(out.includes("vault.example.org/drop"));
    assert.ok(out.includes("stream.example.org/v1"));
    assert.ok(out.includes("cdn.example.org/bundle"));
    assert.ok(out.includes("Contact [ref: docs@example.org]"));
    assert.ok(out.includes('<a href="#entity-map">Jump</a>'), "in-page fragment anchors must remain intact");
  }

  // 2. Exact 524,288 UTF-8 byte r999 Markdown & HTML with replaceable appendix advance cleanly across empty r999->r1000 page
  const maxBytes = 524_288;
  const mdPrefix = [
    "<!-- dossier-watermark: 999 -->",
    "# Domain Context",
    "<!-- dossier-anchor: overview -->",
    "## Overview",
    "Curated base narrative ",
  ].join("\n");
  const mdSuffix = [
    "",
    "<!-- dossier-anchor: active-invariants -->",
    "## Active Invariants",
    "Invariants hold.",
    "<!-- dossier-anchor: recent-changes -->",
    "## Recent Changes",
    "Tracked incrementally.",
    "",
    "<!-- dossier-incremental-updates:start -->",
    "## Incremental Updates (through r999)",
    "",
    "| Rev | Event | Entities | Summary | Actor |",
    "| --- | --- | --- | --- | --- |",
    "| r999 | `task_completed` | `task/t999` | Latest shipped slice | `worker` |",
    "| r998 | `task_completed` | `task/t998` | Earlier shipped slice | `worker` |",
    "<!-- dossier-incremental-updates:end -->",
    "",
  ].join("\n");
  const mdPadLen = maxBytes - Buffer.byteLength(mdPrefix, "utf8") - Buffer.byteLength(mdSuffix, "utf8");
  assert.ok(mdPadLen > 0);
  const exactBudgetMd999 = `${mdPrefix}${"m".repeat(mdPadLen)}${mdSuffix}`;
  assert.equal(Buffer.byteLength(exactBudgetMd999, "utf8"), maxBytes);

  const md1000 = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: contextSlot,
    previousBody: exactBudgetMd999,
    expectedWatermark: 999,
    targetWatermark: 1000,
    changes: [],
    synthesizedAt: "2026-11-23T03:45:00.000Z",
  });
  assert.ok(
    Buffer.byteLength(md1000, "utf8") <= maxBytes,
    "empty r999->r1000 Markdown must trim appendix to <= 524288",
  );
  assert.ok(md1000.startsWith("<!-- dossier-watermark: 1000 -->"));
  assert.ok(md1000.includes("Curated base narrative "));

  const htmlPrefix = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="dossier-watermark" content="999"><title>Atlas</title></head>',
    '<body><main><section id="atlas-topology"><svg viewBox="0 0 320 100" role="img"><rect x="8" y="8" width="120" height="40"/></svg></section>',
    '<section id="entity-map"><p>Curated base HTML ',
  ].join("\n");
  const htmlSuffix = [
    "</p></section>",
    '<section id="change-ledger"><p>Baseline r999.</p></section>',
    '<section id="dossier-incremental-appendix" data-dossier-appendix="1" data-dossier-incremental="true">',
    "<h2>Incremental Updates <small>through r999</small></h2>",
    '<div class="table-wrap"><table><thead><tr><th>Rev</th><th>Event</th><th>Entities</th><th>Summary</th><th>Time</th></tr></thead>',
    '<tbody><tr><td class="rev">r999</td><td><code>task_completed</code></td><td class="refs">task/t999</td><td>Latest slice</td><td class="time">2026-11-23 03:40:00</td></tr>',
    '<tr><td class="rev">r998</td><td><code>task_completed</code></td><td class="refs">task/t998</td><td>Earlier slice</td><td class="time">2026-11-23 03:39:00</td></tr></tbody></table></div></section>',
    "</main></body></html>",
  ].join("\n");
  const htmlPadLen = maxBytes - Buffer.byteLength(htmlPrefix, "utf8") - Buffer.byteLength(htmlSuffix, "utf8");
  assert.ok(htmlPadLen > 0);
  const exactBudgetHtml999 = `${htmlPrefix}${"h".repeat(htmlPadLen)}${htmlSuffix}`;
  assert.equal(Buffer.byteLength(exactBudgetHtml999, "utf8"), maxBytes);

  const html1000 = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: exactBudgetHtml999,
    expectedWatermark: 999,
    targetWatermark: 1000,
    changes: [],
    synthesizedAt: "2026-11-23T03:45:00.000Z",
  });
  assert.ok(Buffer.byteLength(html1000, "utf8") <= maxBytes, "empty r999->r1000 HTML must trim appendix to <= 524288");
  assert.match(html1000, /<meta name="dossier-watermark" content="1000">/u);
  assert.ok(html1000.includes("Curated base HTML "));
});

test("F-DOSSIER-04/05/08 (amend): retains exact 1/1 across 256 & 257 Works, marks partial beyond orphan cap, scrubs smb://, and preserves code href prose", () => {
  const at = "2026-11-23T05:00:00.000Z";
  for (const works of [256, 257]) {
    let body: string | null = null;
    let watermark = 0;
    const mkEvent = (
      taskId: string,
      title: string | undefined,
      taskClass: string | undefined,
      taskStatus: string,
      parentTaskId: string | null,
      type: string,
    ): DossierChangeItem => ({
      eventId: `evt_257_${works}_${++watermark}`,
      workspaceRevision: watermark,
      occurredAt: at,
      schema: "task-event/v1",
      type,
      taskId,
      actor: { principal: { personId: "person_zeyu" } },
      payload: {
        ...(title !== undefined ? { title } : {}),
        ...(taskClass !== undefined ? { taskClass } : {}),
        taskStatus,
        parentTaskId,
      },
      entityRefs: [`task/${taskId}`],
    });
    const advance = (changes: readonly DossierChangeItem[]) => {
      body = synthesizeDossierDocument({
        slot: workNarrativesSlot,
        verticalId: "software/coding",
        previousBody: body,
        expectedWatermark: watermark - changes.length,
        targetWatermark: watermark,
        changes,
        synthesizedAt: at,
      });
    };
    for (let n = 1; n <= works; n += 1) {
      advance([
        mkEvent(`work_${n}`, `Work ${n}`, "work", "active", null, "task_created"),
        mkEvent(`child_${n}`, `Child ${n}`, "standard", "active", `work_${n}`, "task_created"),
        mkEvent(`child_${n}`, `Child ${n}`, "standard", "done", `work_${n}`, "task_completed"),
      ]);
    }
    // Transition work_1 without repeating title/taskClass to prove evicted counter preserves both title and 1/1
    advance([mkEvent("work_1", undefined, undefined, "blocked", null, "task_transitioned")]);
    const work1Row = body!.split("\n").find((line) => line.startsWith("| `work_1` |")) ?? "";
    assert.ok(
      work1Row.includes("| `work_1` | Work 1 | `blocked` | 1/1 | 0 |"),
      `works=${works} must retain Work 1 and 1/1, got: ${work1Row}`,
    );
  }

  // SMB URI scrubbing + intact <code>set href="fixture.html" before copying</code> prose across empty and delta pages
  const officeAtlas: DossierSlot = {
    id: "project-atlas",
    path: "project-atlas.html",
    kind: "html",
    title: "Project Atlas",
    summary: "Collaboration topology and entity map.",
    entityKinds: ["task", "decision", "fact", "deliverable", "handoff"],
    requiredAnchors: ["atlas-topology", "entity-map", "change-ledger"],
    watermarkMetadata: "required",
    triggers: [{ kind: "event-watermark", minimumDelta: 5 }],
  };
  const beforeHtml =
    '<!doctype html><html><head><meta name="dossier-watermark" content="10"><title>Atlas</title></head><body>' +
    '<section id="atlas-topology"><svg viewBox="0 0 20 20"><rect width="10" height="10"/></svg></section>' +
    '<section id="entity-map"><p>Handoff archive: smb://files.example.org/project/handoff and s3://bucket.example.org/drop.</p>' +
    '<p>Fixture setup: <code>set href="fixture.html" before copying</code>.</p></section>' +
    '<section id="change-ledger"><p>Baseline.</p></section></body></html>';
  const handoffDelta: DossierChangeItem = {
    eventId: "evt_handoff_12",
    schema: "entity-event/v1",
    type: "created",
    workspaceRevision: 12,
    occurredAt: at,
    actor: {},
    payload: { title: "Handoff", entityKind: "handoff" },
    entityRefs: ["handoff/HANDOFF-001"],
    matchedKinds: ["handoff"],
  };
  for (const changes of [[], [handoffDelta]] as const) {
    const afterHtml = synthesizeDossierDocument({
      slot: officeAtlas,
      verticalId: "office/collab",
      previousBody: beforeHtml,
      expectedWatermark: 10,
      targetWatermark: 12,
      changes,
      synthesizedAt: at,
    });
    assert.doesNotMatch(afterHtml, /\b[a-z][a-z0-9+.-]*:\/\//iu, "no authority scheme:// URI may remain");
    assert.ok(afterHtml.includes("files.example.org/project/handoff"));
    assert.ok(afterHtml.includes("bucket.example.org/drop"));
    assert.ok(
      afterHtml.includes('<code>set href="fixture.html" before copying</code>'),
      `code example prose must stay verbatim, got: ${afterHtml}`,
    );
  }

  // Beyond orphan counter cap (1,296 Works): child-first then root-transition across 2 pages both mark 0/1 (partial)
  let truncatedBody: string | null = null;
  let truncatedWatermark = 0;
  const mkBulk = (taskId: string, type: string, payload: Record<string, unknown>): DossierChangeItem => ({
    eventId: `evt_bulk_${++truncatedWatermark}`,
    workspaceRevision: truncatedWatermark,
    occurredAt: at,
    schema: "task-event/v1",
    type,
    taskId,
    actor: { principal: { personId: "person_probe" } },
    payload,
    entityRefs: [`task/${taskId}`],
  });
  for (let start = 1; start <= 1296; start += 16) {
    const prevW = truncatedWatermark;
    const batch: DossierChangeItem[] = [];
    for (let n = start; n < start + 16; n += 1) {
      const id = `task_${n.toString(16).padStart(24, "0")}`;
      const child = id.replace("task_", "task_a");
      batch.push(
        mkBulk(id, "task_created", {
          title: `Migrate customer reporting pipeline and reconcile monthly delivery milestones for portfolio workstream ${n}`,
          taskClass: "work",
          taskStatus: "active",
          parentTaskId: null,
          packagePath: `tasks/${id}-migrate-customer-reporting-and-reconcile-delivery-milestones`,
        }),
        mkBulk(child, "task_created", {
          title: "Reconcile monthly delivery milestones",
          taskClass: "standard",
          taskStatus: "active",
          parentTaskId: id,
        }),
        mkBulk(child, "task_completed", {
          title: "Reconcile monthly delivery milestones",
          taskClass: "standard",
          taskStatus: "done",
          parentTaskId: id,
        }),
      );
    }
    truncatedBody = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: pulseSlot,
      previousBody: truncatedBody,
      expectedWatermark: prevW,
      targetWatermark: truncatedWatermark,
      changes: batch,
      synthesizedAt: at,
    });
    assert.ok(Buffer.byteLength(truncatedBody, "utf8") <= 524_288, `page ${start} must stay <= 524288 UTF-8 bytes`);
  }
  const oldestId = `task_${"1".padStart(24, "0")}`;
  const newChildId = `task_${"ff00".padStart(24, "0")}`;
  const prevChildW = truncatedWatermark;
  truncatedBody = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: truncatedBody,
    expectedWatermark: prevChildW,
    targetWatermark: truncatedWatermark + 1,
    changes: [
      mkBulk(newChildId, "task_created", {
        title: "New task",
        taskClass: "standard",
        taskStatus: "active",
        parentTaskId: oldestId,
      }),
    ],
    synthesizedAt: at,
  });
  assert.ok(truncatedBody.includes("0/1 (partial)"), "child-first reactivation page must mark 0/1 (partial)");
  const prevRootW = truncatedWatermark;
  truncatedBody = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: truncatedBody,
    expectedWatermark: prevRootW,
    targetWatermark: truncatedWatermark + 1,
    changes: [
      mkBulk(oldestId, "task_transitioned", {
        title: "Work 1",
        taskClass: "work",
        taskStatus: "blocked",
        parentTaskId: null,
      }),
    ],
    synthesizedAt: at,
  });
  assert.ok(truncatedBody.includes("0/1 (partial)"), "subsequent root transition page must retain 0/1 (partial)");
});
