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

const page2Changes: readonly DossierChangeItem[] = [
  {
    eventId: "evt_003",
    schema: "decision-event/v1",
    type: "decision_superseded",
    occurredAt: "2026-11-22T12:00:00.000Z",
    workspaceRevision: 24,
    decisionId: "dec_002",
    actor: { principal: { personId: "person_zeyu" } },
    payload: { title: "Supersede legacy static docs", reason: "Replaced by living dossier" },
    entityRefs: ["decision/dec_002"],
  },
];

test("synthesizeDossierDocument builds offline light/dark SVG HTML and merges incremental windows", () => {
  const first = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 18,
    changes: page1Changes,
    synthesizedAt: "2026-11-22T11:30:00.000Z",
  });

  assert.match(first, /^<!doctype html>/iu);
  assert.match(first, /<meta name="dossier-watermark" content="18">/u);
  assert.match(first, /<svg\b[^>]*role="img"/u);
  assert.match(first, /@media\(prefers-color-scheme:dark\)/u);
  assert.doesNotMatch(first, /<(?:script|iframe|link|base|embed|object|frame|portal)\b/iu);
  assert.doesNotMatch(first, /https?:\/\//iu);
  assert.ok(first.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "payload HTML must be escaped");
  for (const anchor of atlasSlot.requiredAnchors) {
    assert.ok(first.includes(`id="${anchor}"`), `missing required anchor ${anchor}`);
  }

  const second = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: first,
    expectedWatermark: 18,
    targetWatermark: 24,
    changes: page2Changes,
    synthesizedAt: "2026-11-22T12:30:00.000Z",
  });

  assert.match(second, /<meta name="dossier-watermark" content="24">/u);
  assert.ok(second.includes("Adopt vertical living dossier contract"), "prior page entry must be retained");
  assert.ok(second.includes("Supersede legacy static docs"), "new page entry must be merged");
  assert.ok(second.includes("total 3 changes"), "cumulative count must reflect both windows");

  const pulse = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 24,
    changes: [...page1Changes, ...page2Changes],
    synthesizedAt: "2026-11-22T12:30:00.000Z",
  });
  assert.match(pulse, /<svg\b[^>]*revision pulse/u);
  assert.ok(pulse.includes('id="pulse-flow"'));
  assert.ok(pulse.includes('id="decision-trail"'));
  assert.ok(pulse.includes('id="risk-signals"'));
  assert.ok(pulse.includes("Supersede legacy static docs"));
});

test("synthesizeDossierDocument builds anchored Markdown and deduplicates replayed events", () => {
  const first = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: contextSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 18,
    changes: page1Changes,
    synthesizedAt: "2026-11-22T11:30:00.000Z",
  });
  assert.equal(first.split("\n", 1)[0], "<!-- dossier-watermark: 18 -->");
  for (const anchor of contextSlot.requiredAnchors) {
    assert.ok(first.includes(`<!-- dossier-anchor: ${anchor} -->`), `missing anchor ${anchor}`);
  }
  assert.ok(first.includes("Adopt vertical living dossier contract"));

  const second = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: contextSlot,
    previousBody: first,
    expectedWatermark: 18,
    targetWatermark: 24,
    changes: [...page1Changes, ...page2Changes],
    synthesizedAt: "2026-11-22T12:30:00.000Z",
  });
  assert.equal(second.split("\n", 1)[0], "<!-- dossier-watermark: 24 -->");
  assert.ok(second.includes("3 total (+3 in window)"), "duplicate eventIds must not inflate cumulative count");
  assert.equal(
    second.split("Adopt vertical living dossier contract").length,
    first.split("Adopt vertical living dossier contract").length,
    "replaying prior eventIds must not duplicate rendered rows",
  );
  const invariantsSection =
    second.split("<!-- dossier-anchor: active-invariants -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  assert.equal(invariantsSection.split("Adopt vertical living dossier contract").length - 1, 1);
});

test("F-DOSSIER-02: preserves chronicler-authored Markdown and HTML without private dossier-state comments", () => {
  const chroniclerMarkdown = [
    "<!-- dossier-watermark: 10 -->",
    "# Domain Context",
    "",
    "<!-- dossier-anchor: overview -->",
    "## Overview",
    "Curated chronicler narrative explaining the four-plane kernel and daemon split.",
    "",
    "<!-- dossier-anchor: active-invariants -->",
    "## Active Invariants",
    "Single-writer canonical queue owns every ledger revision.",
    "",
    "<!-- dossier-anchor: recent-changes -->",
    "## Recent Changes",
    "Baseline curated at r10.",
    "",
  ].join("\n");

  // Empty incremental window must keep chronicler Markdown 100% intact except watermark header
  const mdEmptyAdvance = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: contextSlot,
    previousBody: chroniclerMarkdown,
    expectedWatermark: 10,
    targetWatermark: 16,
    changes: [],
    synthesizedAt: "2026-11-22T13:00:00.000Z",
  });
  assert.equal(mdEmptyAdvance.split("\n", 1)[0], "<!-- dossier-watermark: 16 -->");
  assert.equal(
    mdEmptyAdvance.slice(mdEmptyAdvance.indexOf("\n")),
    chroniclerMarkdown.slice(chroniclerMarkdown.indexOf("\n")),
    "empty delta must not alter chronicler Markdown body",
  );
  assert.ok(!mdEmptyAdvance.includes("<!-- dossier-state:v1 "), "must not overwrite external body with managed state");

  // Non-empty incremental window preserves all chronicler prose and appends non-destructive delta
  const mdNonEmptyAdvance = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: contextSlot,
    previousBody: mdEmptyAdvance,
    expectedWatermark: 16,
    targetWatermark: 24,
    changes: page1Changes,
    synthesizedAt: "2026-11-22T13:30:00.000Z",
  });
  assert.equal(mdNonEmptyAdvance.split("\n", 1)[0], "<!-- dossier-watermark: 24 -->");
  assert.ok(mdNonEmptyAdvance.includes("Curated chronicler narrative explaining the four-plane kernel"));
  assert.ok(mdNonEmptyAdvance.includes("Adopt vertical living dossier contract"));

  const chroniclerHtml = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><meta name="dossier-watermark" content="10"><title>Curated Atlas</title></head>',
    "<body><main>",
    '<section id="atlas-topology"><svg viewBox="0 0 400 120" role="img"><rect x="10" y="10" width="120" height="40"/><text x="20" y="34">Curated Topology</text></svg></section>',
    '<section id="entity-map"><p>Handcrafted entity taxonomy narrative.</p></section>',
    '<section id="change-ledger"><p>Verified at r10.</p></section>',
    "</main></body></html>",
  ].join("\n");

  const htmlEmptyAdvance = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: chroniclerHtml,
    expectedWatermark: 10,
    targetWatermark: 18,
    changes: [],
    synthesizedAt: "2026-11-22T14:00:00.000Z",
  });
  assert.equal(
    htmlEmptyAdvance,
    chroniclerHtml.replace('content="10"', 'content="18"'),
    "empty delta must update only the HTML meta watermark without touching curated DOM",
  );

  const htmlNonEmptyAdvance = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: htmlEmptyAdvance,
    expectedWatermark: 18,
    targetWatermark: 24,
    changes: [
      {
        ...page1Changes[0]!,
        payload: { title: "Follow up on https://example.com/rfc-12" },
      },
    ],
    synthesizedAt: "2026-11-22T14:30:00.000Z",
  });
  assert.match(htmlNonEmptyAdvance, /<meta name="dossier-watermark" content="24">/u);
  assert.ok(htmlNonEmptyAdvance.includes("Handcrafted entity taxonomy narrative."));
  assert.ok(htmlNonEmptyAdvance.includes("example.com/rfc-12"));
  assert.doesNotMatch(htmlNonEmptyAdvance, /https?:\/\//iu, "appended HTML delta must scrub external URLs");
});

test("F-DOSSIER-04: retains early active decisions across >50 events, removes superseded decisions, tracks live blockers and rolls up two Works", () => {
  const window1: DossierChangeItem[] = [
    {
      eventId: "evt_dec_keep",
      schema: "decision-event/v1",
      type: "decision_accepted",
      occurredAt: "2026-11-22T01:00:00.000Z",
      workspaceRevision: 10,
      decisionId: "dec_keep",
      actor: { principal: { personId: "person_zeyu" } },
      payload: { title: "Keep durable standing architecture", modules: ["kernel", "daemon"] },
      entityRefs: ["decision/dec_keep"],
    },
    {
      eventId: "evt_dec_temp_accept",
      schema: "decision-event/v1",
      type: "decision_accepted",
      occurredAt: "2026-11-22T01:05:00.000Z",
      workspaceRevision: 11,
      decisionId: "dec_temp",
      actor: { principal: { personId: "person_zeyu" } },
      payload: { title: "Temporary migration shim", modules: ["daemon"] },
      entityRefs: ["decision/dec_temp"],
    },
    {
      eventId: "evt_work_a",
      schema: "task-event/v1",
      type: "task_created",
      occurredAt: "2026-11-22T01:10:00.000Z",
      workspaceRevision: 12,
      taskId: "work_alpha",
      actor: { principal: { personId: "person_zeyu" } },
      payload: {
        title: "Alpha Platform Work",
        taskClass: "work",
        taskStatus: "active",
        parentTaskId: null,
        packagePath: "tasks/work_alpha-alpha-platform",
      },
      entityRefs: ["task/work_alpha"],
    },
    {
      eventId: "evt_work_b",
      schema: "task-event/v1",
      type: "task_created",
      occurredAt: "2026-11-22T01:11:00.000Z",
      workspaceRevision: 13,
      taskId: "work_beta",
      actor: { principal: { personId: "person_zeyu" } },
      payload: { title: "Beta GUI Work", taskClass: "work", taskStatus: "active", parentTaskId: null },
      entityRefs: ["task/work_beta"],
    },
    {
      eventId: "evt_child_a1",
      schema: "task-event/v1",
      type: "task_completed",
      occurredAt: "2026-11-22T01:12:00.000Z",
      workspaceRevision: 14,
      taskId: "task_a1",
      actor: { executor: { id: "worker" } },
      payload: {
        title: "Deliver Alpha kernel store",
        taskClass: "standard",
        taskStatus: "done",
        parentTaskId: "work_alpha",
        surfaces: ["packages/kernel"],
      },
      entityRefs: ["task/task_a1"],
    },
    {
      eventId: "evt_child_a2_block",
      schema: "task-event/v1",
      type: "task_transitioned",
      occurredAt: "2026-11-22T01:13:00.000Z",
      workspaceRevision: 15,
      taskId: "task_a2",
      actor: { executor: { id: "worker" } },
      payload: {
        title: "Alpha schema migration",
        taskClass: "standard",
        taskStatus: "blocked",
        parentTaskId: "work_alpha",
        reason: "Waiting for upstream schema freeze",
      },
      entityRefs: ["task/task_a2"],
    },
    {
      eventId: "evt_child_b1",
      schema: "task-event/v1",
      type: "task_completed",
      occurredAt: "2026-11-22T01:14:00.000Z",
      workspaceRevision: 16,
      taskId: "task_b1",
      actor: { executor: { id: "worker" } },
      payload: {
        title: "Deliver Beta reader pane",
        taskClass: "standard",
        taskStatus: "done",
        parentTaskId: "work_beta",
        surfaces: ["packages/gui"],
      },
      entityRefs: ["task/task_b1"],
    },
    {
      eventId: "evt_rel_derives",
      schema: "relation-event/v1",
      type: "relation_created",
      occurredAt: "2026-11-22T01:15:00.000Z",
      workspaceRevision: 17,
      actor: { principal: { personId: "person_zeyu" } },
      payload: {
        relation: {
          relationId: "rel_001",
          source: "decision/dec_keep",
          target: "task/task_a1",
          sourceKind: "decision",
          targetKind: "task",
          relationType: "derives",
          state: "active",
          rationale: "Task implements durable standing architecture",
        },
      },
      entityRefs: ["relation/rel_001", "decision/dec_keep", "task/task_a1"],
    },
  ];

  // Window 2: 55 ordinary fact events (exceeds 48-entry sliding window) + supersede dec_temp + unblock & complete task_a2
  const fillerFacts: DossierChangeItem[] = Array.from({ length: 55 }, (_, i) => ({
    eventId: `evt_fact_${i + 1}`,
    schema: "fact-event/v1",
    type: "fact_recorded",
    occurredAt: "2026-11-22T02:00:00.000Z",
    workspaceRevision: 20 + i,
    factId: `F-FILL${String(i + 1).padStart(4, "0")}`,
    actor: { executor: { id: "worker" } },
    payload: { statement: `Verified incremental invariant #${i + 1}` },
    entityRefs: [`fact/F-FILL${String(i + 1).padStart(4, "0")}`],
  }));

  const window2: DossierChangeItem[] = [
    ...fillerFacts,
    {
      eventId: "evt_dec_temp_supersede",
      schema: "decision-event/v1",
      type: "decision_superseded",
      occurredAt: "2026-11-22T03:00:00.000Z",
      workspaceRevision: 80,
      decisionId: "dec_temp",
      actor: { principal: { personId: "person_zeyu" } },
      payload: { reason: "Superseded after migration completed" },
      entityRefs: ["decision/dec_temp"],
    },
  ];

  // Check blocked state is live before unblocking
  const pulseBlocked = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 18,
    changes: window1,
    synthesizedAt: "2026-11-22T01:30:00.000Z",
  });
  assert.ok(
    pulseBlocked.includes("Waiting for upstream schema freeze"),
    "live blocked task must appear in risk-signals",
  );
  assert.ok(pulseBlocked.includes("tasks/work_alpha-alpha-platform/artifacts/explainer.html"));
  assert.ok(pulseBlocked.includes("task/work_beta · artifacts/explainer.html"));
  assert.ok(pulseBlocked.includes("task/task_a1"), "derived task must appear in decision trail");

  // Window 2: dec_temp superseded, >50 facts push recent entries past 48, task_a2 still blocked here
  const adr1 = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: adrLedgerSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 18,
    changes: window1,
    synthesizedAt: "2026-11-22T01:30:00.000Z",
  });
  const adr2 = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: adrLedgerSlot,
    previousBody: adr1,
    expectedWatermark: 18,
    targetWatermark: 80,
    changes: window2,
    synthesizedAt: "2026-11-22T03:30:00.000Z",
  });
  const activeDecisionsSection =
    adr2.split("<!-- dossier-anchor: active-decisions -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  const supersessionSection = adr2.split("<!-- dossier-anchor: supersession-log -->")[1] ?? "";
  assert.ok(activeDecisionsSection.includes("dec_keep"), "early active decision must survive >50 ordinary events");
  assert.ok(!activeDecisionsSection.includes("dec_temp"), "superseded decision must be removed from Active Decisions");
  assert.ok(supersessionSection.includes("dec_temp"), "superseded decision must appear in Supersession Log");

  // Window 3: unblock and complete task_a2
  const pulseUnblocked = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: pulseBlocked,
    expectedWatermark: 18,
    targetWatermark: 82,
    changes: [
      ...window2,
      {
        eventId: "evt_child_a2_done",
        schema: "task-event/v1",
        type: "task_completed",
        occurredAt: "2026-11-22T03:10:00.000Z",
        workspaceRevision: 82,
        taskId: "task_a2",
        actor: { executor: { id: "worker" } },
        payload: {
          title: "Alpha schema migration",
          taskClass: "standard",
          taskStatus: "done",
          parentTaskId: "work_alpha",
        },
        entityRefs: ["task/task_a2"],
      },
    ],
    synthesizedAt: "2026-11-22T03:40:00.000Z",
  });
  const riskSection = pulseUnblocked.split('id="risk-signals"')[1]?.split("</section>")[0] ?? "";
  assert.ok(riskSection.includes("0 live blocked tasks"), "completed task must clear from live blockers");
  assert.ok(!riskSection.includes("Waiting for upstream schema freeze"), "resolved block reason must clear");
  const decisionTrailSection = pulseUnblocked.split('id="decision-trail"')[1]?.split("</section>")[0] ?? "";
  assert.ok(decisionTrailSection.includes("dec_keep"), "early active decision remains in Pulse decision trail");
  assert.ok(pulseUnblocked.includes("2/2"), "work_alpha progress rollup must reach 2/2 after task_a2 completes");

  // Verify Atlas SVG renders directed relation edges with arrowheads
  const atlas = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 18,
    changes: window1,
    synthesizedAt: "2026-11-22T01:30:00.000Z",
  });
  assert.match(atlas, /marker-end="url\(#dossier-arrow\)"/u, "Atlas SVG must render directed edge arrowheads");
  assert.ok(atlas.includes(">derives</text>"), "Atlas SVG must label directed relation edges");

  // Verify WORK_NARRATIVES delivery-arc rolls up Works distinctly from work-log
  const workMd = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: workNarrativesSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: 18,
    changes: window1,
    synthesizedAt: "2026-11-22T01:30:00.000Z",
  });
  const deliveryArc = workMd.split("<!-- dossier-anchor: delivery-arc -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  const workLog = workMd.split("<!-- dossier-anchor: work-log -->")[1] ?? "";
  assert.ok(deliveryArc.includes("tasks/work_alpha-alpha-platform/artifacts/explainer.html"));
  assert.ok(deliveryArc.includes("task/work_beta · artifacts/explainer.html"));
  assert.ok(deliveryArc.includes("1/2"));
  assert.ok(workLog.includes("task_completed"));
  assert.notEqual(deliveryArc.trim(), workLog.trim());
});

test("F-DOSSIER-05: strips all external http(s):// URLs across HTML body and embedded dossier-state comments while preserving readable clues", () => {
  const urlBearingChanges: readonly DossierChangeItem[] = [
    {
      eventId: "evt_url_1",
      schema: "task-event/v1",
      type: "task_completed",
      occurredAt: "2026-11-22T15:00:00.000Z",
      workspaceRevision: 30,
      taskId: "task_url_1",
      actor: { executor: { id: "worker" } },
      payload: {
        title: "Verify spec https://example.com/specs/v3?mode=strict and http://internal.corp:8080/health",
        taskStatus: "done",
      },
      entityRefs: ["task/task_url_1"],
    },
    {
      eventId: "evt_url_2",
      schema: "decision-event/v1",
      type: "decision_accepted",
      occurredAt: "2026-11-22T15:05:00.000Z",
      workspaceRevision: 31,
      decisionId: "dec_url_2",
      actor: { principal: { personId: "person_zeyu" } },
      payload: {
        title: "Reference htthttps://p://nested.example.org/bypass and https://docs.example.net/adr",
      },
      entityRefs: ["decision/dec_url_2"],
    },
    {
      eventId: "evt_url_3",
      schema: "fact-event/v1",
      type: "fact_recorded",
      occurredAt: "2026-11-22T15:10:00.000Z",
      workspaceRevision: 32,
      factId: "F-URL00001",
      actor: { executor: { id: "worker" } },
      payload: {
        statement: "CI run archived at https://ci.example.invalid/runs/12345",
      },
      entityRefs: ["fact/F-URL00001"],
    },
  ];

  for (const slot of [atlasSlot, pulseSlot]) {
    const html = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot,
      previousBody: null,
      expectedWatermark: 0,
      targetWatermark: 32,
      changes: urlBearingChanges,
      synthesizedAt: "2026-11-22T15:15:00.000Z",
    });
    assert.doesNotMatch(html, /https?:\/\//iu, `${slot.path} must contain zero http:// or https:// anywhere`);
    assert.ok(html.includes("example.com/specs/v3?mode=strict"), "readable domain/path clue must be kept");
    assert.ok(html.includes("docs.example.net/adr"), "decision URL path clue must be kept");
  }
});

test("F-DOSSIER-05: chronicler HTML continuation strips external hrefs, SVG xmlns and prose URLs on both empty and non-empty windows", () => {
  const chroniclerWithLinks = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><meta name="dossier-watermark" content="10"><title>Curated Atlas</title></head>',
    "<body><main>",
    "<!-- Reference https://internal.example.net/diagram-spec -->",
    '<section id="atlas-topology"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100" role="img"><rect x="8" y="8" width="120" height="40"/><text x="16" y="32">Curated Graph</text></svg></section>',
    '<section id="entity-map"><p>Read <a class="cite" href="https://example.com/spec">Spec</a> and note http://example.org/note for details.</p></section>',
    '<section id="change-ledger"><p>Baseline curated at r10.</p></section>',
    "</main></body></html>",
  ].join("\n");

  const emptyOut = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: chroniclerWithLinks,
    expectedWatermark: 10,
    targetWatermark: 14,
    changes: [],
    synthesizedAt: "2026-11-23T01:00:00.000Z",
  });
  assert.doesNotMatch(emptyOut, /https?:\/\//iu, "empty window must scrub all external URLs from chronicler HTML");
  assert.ok(emptyOut.includes("Spec [ref: example.com/spec]"), "link text and readable citation must be preserved");
  assert.ok(emptyOut.includes("example.org/note"), "prose URL path clue must be preserved");
  assert.ok(emptyOut.includes("Curated Graph"), "curated SVG narrative must remain intact");

  const nonEmptyOut = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: chroniclerWithLinks,
    expectedWatermark: 10,
    targetWatermark: 18,
    changes: [
      {
        ...page1Changes[0]!,
        payload: { title: "Follow up on https://example.dev/rfc-99" },
      },
    ],
    synthesizedAt: "2026-11-23T01:10:00.000Z",
  });
  assert.doesNotMatch(nonEmptyOut, /https?:\/\//iu, "non-empty window must scrub all external URLs");
  assert.ok(nonEmptyOut.includes("Spec [ref: example.com/spec]"));
  assert.ok(nonEmptyOut.includes("example.dev/rfc-99"));
});

test("F-DOSSIER-06: chronicler HTML appendix stays bounded across 40 non-empty pages and trims within 512 KiB budget", () => {
  let current = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><meta name="dossier-watermark" content="0"><title>Curated Atlas</title></head>',
    "<body><main>",
    '<section id="atlas-topology"><svg viewBox="0 0 320 100" role="img"><rect x="8" y="8" width="120" height="40"/></svg></section>',
    '<section id="entity-map"><p>Curated chronicler narrative that must survive 40 incremental pages.</p></section>',
    '<section id="change-ledger"><p>Initial baseline.</p></section>',
    "</main></body></html>",
  ].join("\n");

  const maxBytes = 512 * 1024;
  for (let page = 1; page <= 40; page += 1) {
    const revBase = (page - 1) * 10;
    const changes: DossierChangeItem[] = Array.from({ length: 8 }, (_, idx) => ({
      eventId: `evt_p${page}_${idx}`,
      schema: "task-event/v1",
      type: "task_completed",
      occurredAt: "2026-11-23T02:00:00.000Z",
      workspaceRevision: revBase + idx + 1,
      taskId: `task_p${page}_${idx}`,
      actor: { executor: { id: "worker" } },
      payload: { title: `Large incremental summary page ${page} item ${idx} ${"x".repeat(140)}` },
      entityRefs: [`task/task_p${page}_${idx}`],
    }));
    current = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: atlasSlot,
      previousBody: current,
      expectedWatermark: revBase,
      targetWatermark: revBase + 10,
      changes,
      synthesizedAt: "2026-11-23T02:00:00.000Z",
    });
    assert.ok(Buffer.byteLength(current, "utf8") <= maxBytes, `page ${page} must stay <= 512 KiB`);
  }
  assert.ok(current.includes("Curated chronicler narrative that must survive 40 incremental pages."));
  assert.ok(current.includes("page 40 item 7"), "latest incremental row must be kept");
  assert.ok(!current.includes("page 1 item 0"), "oldest incremental rows must be evicted beyond cap");
  const tbodyMatch = /<section[^>]*id="dossier-incremental-appendix"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/iu.exec(current);
  assert.ok(tbodyMatch, "replaceable appendix container must exist");
  const rowCount = (tbodyMatch[1]!.match(/<tr\b/giu) ?? []).length;
  assert.ok(rowCount <= 24, `appendix rows must stay capped at <= 24 (got ${rowCount})`);

  // Near-limit (~510 KiB) valid chronicler HTML: trims appendix rows to fit <= 512 KiB cleanly
  const fillerParagraph = `<p>${"Curated archival narrative block. ".repeat(15_360)}</p>`;
  const nearLimitHtml = [
    "<!doctype html>",
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><meta name="dossier-watermark" content="10"><title>Large Curated Atlas</title></head>',
    "<body><main>",
    '<section id="atlas-topology"><svg viewBox="0 0 320 100" role="img"><rect x="8" y="8" width="120" height="40"/></svg></section>',
    `<section id="entity-map">${fillerParagraph}</section>`,
    '<section id="change-ledger"><p>Baseline r10.</p></section>',
    "</main></body></html>",
  ].join("\n");
  const baseSize = Buffer.byteLength(nearLimitHtml, "utf8");
  assert.ok(baseSize > 500 * 1024 && baseSize < maxBytes, `expected near-limit fixture ~510 KiB, got ${baseSize}`);

  const largeChanges: DossierChangeItem[] = Array.from({ length: 24 }, (_, idx) => ({
    eventId: `evt_near_${idx}`,
    schema: "task-event/v1",
    type: "task_completed",
    occurredAt: "2026-11-23T02:30:00.000Z",
    workspaceRevision: 11 + idx,
    taskId: `task_near_${idx}`,
    actor: { executor: { id: "worker" } },
    payload: { title: `Overflowing delta row ${idx} ${"y".repeat(160)}` },
    entityRefs: [`task/task_near_${idx}`],
  }));
  const trimmed = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: atlasSlot,
    previousBody: nearLimitHtml,
    expectedWatermark: 10,
    targetWatermark: 40,
    changes: largeChanges,
    synthesizedAt: "2026-11-23T02:30:00.000Z",
  });
  assert.ok(Buffer.byteLength(trimmed, "utf8") <= maxBytes, "trimmed near-limit HTML must stay <= 512 KiB");
  assert.match(trimmed, /<meta name="dossier-watermark" content="40">/u);

  // Base document already exceeding 512 KiB must fail deterministically with recovery hint
  const oversizedHtml = nearLimitHtml.replace("Baseline r10.", "z".repeat(30_000));
  assert.throws(
    () =>
      synthesizeDossierDocument({
        verticalId: "software/coding",
        slot: atlasSlot,
        previousBody: oversizedHtml,
        expectedWatermark: 10,
        targetWatermark: 20,
        changes: [],
        synthesizedAt: "2026-11-23T02:35:00.000Z",
      }),
    /exceeds 524288 UTF-8 bytes.*chronicler/iu,
  );
});

function mkTaskChange(
  rev: number,
  taskId: string,
  type: string,
  payload: Readonly<Record<string, unknown>>,
  occurredAt = "2026-11-23T03:00:00.000Z",
): DossierChangeItem {
  return {
    eventId: `evt_t_${rev}`,
    workspaceRevision: rev,
    occurredAt,
    schema: "task-event/v1",
    type,
    taskId,
    actor: { principal: { personId: "person_zeyu" } },
    payload,
    entityRefs: [`task/${taskId}`],
  };
}

test("F-DOSSIER-11: preserves exact total live blockers across 64/65/80 display-cap thresholds and qualifies incomplete state compaction across header, SVGs, Markdown, and risk table", () => {
  const at = "2026-11-23T03:00:00.000Z";
  let pulseBody: string | null = null;
  let atlasBody: string | null = null;
  let contextBody: string | null = null;
  let rev = 0;

  const pushBlockedBatch = (count: number, startIndex: number): void => {
    const prev = rev;
    const changes: DossierChangeItem[] = [];
    for (let idx = startIndex; idx < startIndex + count; idx += 1) {
      const tid = `task_blk_${String(idx).padStart(4, "0")}`;
      changes.push(
        mkTaskChange(++rev, tid, "task_created", {
          title: `Standalone task ${idx}`,
          taskClass: "standard",
          taskStatus: "active",
          parentTaskId: null,
        }),
        mkTaskChange(++rev, tid, "task_transitioned", {
          title: `Standalone task ${idx}`,
          taskClass: "standard",
          taskStatus: "blocked",
          parentTaskId: null,
          reason: `Reason ${idx}`,
        }),
      );
    }
    if (startIndex === 1) {
      changes.push({
        eventId: `evt_rel_${++rev}`,
        workspaceRevision: rev,
        occurredAt: at,
        schema: "relation-event/v1",
        type: "relation_created",
        actor: { principal: { personId: "person_zeyu" } },
        payload: {
          relation: {
            relationId: "rel_1",
            source: "decision/dec_1",
            target: "task/task_blk_0001",
            sourceKind: "decision",
            targetKind: "task",
            relationType: "derives",
          },
        },
        entityRefs: ["decision/dec_1", "task/task_blk_0001"],
      });
    }
    pulseBody = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: pulseSlot,
      previousBody: pulseBody,
      expectedWatermark: prev,
      targetWatermark: rev,
      changes,
      synthesizedAt: at,
    });
    atlasBody = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: atlasSlot,
      previousBody: atlasBody,
      expectedWatermark: prev,
      targetWatermark: rev,
      changes,
      synthesizedAt: at,
    });
    contextBody = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: contextSlot,
      previousBody: contextBody,
      expectedWatermark: prev,
      targetWatermark: rev,
      changes,
      synthesizedAt: at,
    });
  };

  pushBlockedBatch(64, 1);
  assert.match(pulseBody!, /<strong>64<\/strong><span>Live Blockers<\/span>/u);
  assert.ok(pulseBody!.includes("64 live blockers"));
  assert.ok(!pulseBody!.includes("Showing 64 most recent of"));
  assert.ok(atlasBody!.includes("blockers 64</text>"));
  assert.ok(contextBody!.includes("Live Blocked Tasks: 64 ·"));

  pushBlockedBatch(1, 65);
  assert.match(pulseBody!, /<strong>65<\/strong><span>Live Blockers<\/span>/u);
  assert.ok(pulseBody!.includes("65 live blockers"));
  assert.ok(pulseBody!.includes("Showing 64 most recent of 65 live blocked tasks."));
  assert.ok(atlasBody!.includes("blockers 65</text>"));
  assert.ok(contextBody!.includes("Live Blocked Tasks: 65 ·"));

  pushBlockedBatch(15, 66);
  assert.match(pulseBody!, /<strong>80<\/strong><span>Live Blockers<\/span>/u);
  assert.ok(pulseBody!.includes("80 live blockers"));
  assert.ok(pulseBody!.includes("Showing 64 most recent of 80 live blocked tasks."));
  assert.equal((pulseBody!.match(/<code>task\/task_blk_/gu) ?? []).length, 64);
  assert.ok(atlasBody!.includes("blockers 80</text>"));
  assert.ok(contextBody!.includes("Live Blocked Tasks: 80 ·"));

  pushBlockedBatch(70, 81);
  assert.ok(Buffer.byteLength(pulseBody!, "utf8") < 250_000, "fixture must stay well below 512 KiB byte compaction");
  assert.match(pulseBody!, /<strong>128\+<\/strong><span>Live Blockers \(windowed\)<\/span>/u);
  assert.ok(pulseBody!.includes("128+ live blockers (windowed)"));
  assert.ok(pulseBody!.includes("Showing 64 most recent retained live blocked tasks (128+ live blockers;"));
  assert.ok(atlasBody!.includes("blockers 128+ (windowed)</text>"));
  assert.ok(contextBody!.includes("Live Blocked Tasks: 128+ (windowed)"));
});

test("F-DOSSIER-12: reconciles archived blocked child tasks by taskId across unblock, re-block, completion, and subsequent pages without double-counting Work totals", () => {
  const at = "2026-11-23T03:10:00.000Z";
  const workId = "task_work_root_132";
  let pulseBody: string | null = null;
  let rev = 0;

  const step = (changes: DossierChangeItem[]): string => {
    const prev = rev;
    pulseBody = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: pulseSlot,
      previousBody: pulseBody,
      expectedWatermark: prev,
      targetWatermark: rev,
      changes,
      synthesizedAt: at,
    });
    return pulseBody;
  };

  const seedEvents: DossierChangeItem[] = [
    mkTaskChange(++rev, workId, "task_created", {
      title: "Work 132",
      taskClass: "work",
      taskStatus: "active",
      parentTaskId: null,
    }),
  ];
  for (let i = 1; i <= 132; i += 1) {
    const cid = `task_child_${String(i).padStart(3, "0")}`;
    seedEvents.push(
      mkTaskChange(++rev, cid, "task_created", {
        title: `Child ${i}`,
        taskClass: "standard",
        taskStatus: "active",
        parentTaskId: workId,
      }),
      mkTaskChange(++rev, cid, "task_transitioned", {
        title: `Child ${i}`,
        taskClass: "standard",
        taskStatus: "blocked",
        parentTaskId: workId,
        reason: "dep",
      }),
    );
  }
  const r265 = step(seedEvents);
  assert.ok(
    r265.includes(`<td class="rev">0/132</td><td class="rev">132</td>`),
    "r265 must show exact 0/132 and 132 blocked",
  );
  assert.match(r265, /<strong>132<\/strong><span>Live Blockers<\/span>/u);

  const r266 = step([
    mkTaskChange(++rev, "task_child_001", "task_transitioned", { title: "Child 1", taskStatus: "active" }),
  ]);
  assert.ok(r266.includes(`<td class="rev">0/132</td><td class="rev">131</td>`));
  assert.match(r266, /<strong>131<\/strong><span>Live Blockers<\/span>/u);

  const r267 = step([
    mkTaskChange(++rev, "task_child_001", "task_transitioned", {
      title: "Child 1",
      taskStatus: "blocked",
      reason: "dep again",
    }),
  ]);
  assert.ok(r267.includes(`<td class="rev">0/132</td><td class="rev">132</td>`));
  assert.match(r267, /<strong>132<\/strong><span>Live Blockers<\/span>/u);

  const r268 = step([
    mkTaskChange(++rev, "task_child_002", "task_completed", { title: "Child 2", taskStatus: "done" }),
  ]);
  assert.ok(r268.includes(`<td class="rev">1/132</td><td class="rev">131</td>`));
  rev += 5;
  const r273 = step([]);
  assert.ok(r273.includes(`<td class="rev">1/132</td><td class="rev">131</td>`));
  assert.match(r273, /<strong>131<\/strong><span>Live Blockers<\/span>/u);
});
