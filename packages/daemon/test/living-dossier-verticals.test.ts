// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateDossierContent } from "@harness-anything/application/internal/commands/dossier-content.ts";
import { readDossierContext } from "@harness-anything/application/internal/queries/living-dossier.ts";
import { compileVerticalContract, type CanonicalEventV1 } from "@harness-anything/kernel";
import { synthesizeDossierDocument, type DossierChangeItem } from "@harness-anything/kernel/browser";
import { decodeVerticalDefinition } from "@harness-anything/kernel/schemas";
import { listBundledAgentDeclarationIds, readBundledAgentDeclaration } from "@harness-anything/preset";
import { resolveVerticalAssetsRoot } from "@harness-anything/preset/internal/preset-assets";
import { validateVerticalSource } from "@harness-anything/preset/internal/preset-resolver";

const EXPECTED_SLOTS = {
  "software/coding": {
    markdown: ["CONTEXT.md", "ADR_LEDGER.md", "WORK_NARRATIVES.md", "CAPABILITIES.md"],
    html: ["project-atlas.html", "project-pulse.html"],
  },
  "office/collab": {
    markdown: ["PROJECT_BRIEF.md", "DELIVERABLE_REGISTER.md", "HANDOFF_MAP.md"],
    html: ["project-atlas.html", "project-pulse.html"],
  },
} as const;

const SAMPLE_CHANGES: Record<keyof typeof EXPECTED_SLOTS, readonly DossierChangeItem[]> = {
  "software/coding": [
    {
      eventId: "evt_sc_1",
      schema: "decision-event/v1",
      type: "decision_accepted",
      occurredAt: "2026-11-22T08:00:00.000Z",
      workspaceRevision: 12,
      decisionId: "dec_4276A0CEACD4D402F122295925",
      actor: { principal: { personId: "person_zeyu" } },
      payload: {
        title: "Living dossier contract for software/coding (ref https://docs.example.invalid/adr-42)",
        modules: ["kernel", "gui"],
      },
      entityRefs: ["decision/dec_4276A0CEACD4D402F122295925"],
    },
    {
      eventId: "evt_sc_2",
      schema: "task-event/v1",
      type: "task_completed",
      occurredAt: "2026-11-22T09:00:00.000Z",
      workspaceRevision: 20,
      taskId: "task_4bc216a471f89c7de849901719",
      actor: { executor: { id: "worker" } },
      payload: {
        title: "Deliver incremental living dossier engine",
        taskStatus: "done",
        parentTaskId: "task_e0b50dcf56d9bea060d2111ac0",
      },
      entityRefs: ["task/task_4bc216a471f89c7de849901719"],
    },
    {
      eventId: "evt_sc_3",
      schema: "fact-event/v1",
      type: "fact_recorded",
      occurredAt: "2026-11-22T09:30:00.000Z",
      workspaceRevision: 25,
      factId: "F-B811EF90",
      actor: { executor: { id: "worker" } },
      payload: { statement: "Fixed-window dossier cost stays O(delta) at 30,000 revisions." },
      entityRefs: ["fact/F-B811EF90"],
    },
  ],
  "office/collab": [
    {
      eventId: "evt_oc_1",
      schema: "entity-event/v1",
      type: "entity_content_observed",
      occurredAt: "2026-11-22T08:15:00.000Z",
      workspaceRevision: 6,
      actor: { principal: { personId: "person_alice" } },
      payload: { title: "Q4 Operating Charter (http://intranet.example.invalid/charter)", entityKind: "project-brief" },
      entityRefs: ["entity-kind/KND-7a1c4e9b2d6f8a0c3e5b1d7f9a2c4e61/BRIEF-00000000000000000000000000000001"],
      matchedKinds: ["project-brief"],
    },
    {
      eventId: "evt_oc_2",
      schema: "entity-event/v1",
      type: "entity_content_observed",
      occurredAt: "2026-11-22T09:15:00.000Z",
      workspaceRevision: 11,
      actor: { principal: { personId: "person_bob" } },
      payload: { title: "Launch Readiness Report", entityKind: "deliverable" },
      entityRefs: ["entity-kind/KND-8b2d5f0c3e7a9b1d4f6c2e8a0b3d5f72/DELIV-00000000000000000000000000000001"],
      matchedKinds: ["deliverable"],
    },
    {
      eventId: "evt_oc_3",
      schema: "entity-event/v1",
      type: "entity_content_observed",
      occurredAt: "2026-11-22T10:15:00.000Z",
      workspaceRevision: 14,
      actor: { principal: { personId: "person_alice" } },
      payload: { title: "Operations Ownership Handoff", entityKind: "handoff" },
      entityRefs: ["entity-kind/KND-9c3e6a1d4f8b0c2e5a7d3f9b1c4e6a83/HANDOFF-00000000000000000000000000000001"],
      matchedKinds: ["handoff"],
    },
  ],
};

for (const verticalId of ["software/coding", "office/collab"] as const) {
  test(`${verticalId}: validateVerticalSource, chronicler bundle, and every dossier slot pass write-boundary validation`, () => {
    const report = validateVerticalSource({ source: verticalId });
    assert.equal(report.valid, true, JSON.stringify(report.issues));
    assert.equal(report.vertical?.id, verticalId);
    const assetsRoot = resolveVerticalAssetsRoot(verticalId);
    const decoded = decodeVerticalDefinition(JSON.parse(readFileSync(path.join(assetsRoot, "vertical.json"), "utf8")));
    const compiled = compileVerticalContract(decoded);
    const slots = compiled.definition.livingDossier?.slots ?? [];
    const expected = EXPECTED_SLOTS[verticalId];

    assert.deepEqual(
      slots.filter((slot) => slot.kind === "markdown").map((slot) => slot.path),
      expected.markdown,
    );
    assert.deepEqual(
      slots.filter((slot) => slot.kind === "html").map((slot) => slot.path),
      expected.html,
    );

    assert.ok(listBundledAgentDeclarationIds(verticalId).includes("chronicler"));
    const chronicler = readBundledAgentDeclaration("chronicler", verticalId);
    assert.ok(chronicler);
    assert.equal(chronicler.id, "chronicler");

    const changes = SAMPLE_CHANGES[verticalId];
    for (const slot of slots) {
      // Window 1: initial empty window (must still pass strict non-placeholder validation)
      const initial = synthesizeDossierDocument({
        verticalId,
        slot,
        previousBody: null,
        expectedWatermark: 0,
        targetWatermark: 5,
        changes: [],
        synthesizedAt: "2026-11-22T07:00:00.000Z",
      });
      validateDossierContent(slot, initial, 5);

      // Window 2: incremental update with URL-bearing domain changes
      const updated = synthesizeDossierDocument({
        verticalId,
        slot,
        previousBody: initial,
        expectedWatermark: 5,
        targetWatermark: 25,
        changes,
        synthesizedAt: "2026-11-22T10:30:00.000Z",
      });
      validateDossierContent(slot, updated, 25);

      if (slot.kind === "html") {
        assert.match(updated, /<svg\b/iu, `${verticalId}/${slot.path} must include inline SVG`);
        assert.doesNotMatch(updated, /https?:\/\//iu, `${verticalId}/${slot.path} must stay 100% offline`);
        assert.doesNotMatch(updated, /<(?:script|iframe|link|base|embed|object)\b/iu);
      } else {
        assert.equal(updated.split("\n", 1)[0], "<!-- dossier-watermark: 25 -->");
      }
    }
  });
}

test("F-DOSSIER-03 & F-DOSSIER-04: real readDossierContext classifies compiled office/collab entity-kind/KND-... refs accurately across all slots", () => {
  const assetsRoot = resolveVerticalAssetsRoot("office/collab");
  const decoded = decodeVerticalDefinition(JSON.parse(readFileSync(path.join(assetsRoot, "vertical.json"), "utf8")));
  const compiled = compileVerticalContract(decoded);
  const kindById = new Map(compiled.artifactKinds.map((art) => [art.declaration.id, art.typeIdentity]));
  const briefKind = kindById.get("project-brief")!;
  const delivKind = kindById.get("deliverable")!;
  const handoffKind = kindById.get("handoff")!;
  const memoryKind = kindById.get("memory-item")!;
  const actor = { principal: { personId: "person_alice" }, executor: null };

  // Build real production-shaped canonical events (with opaque entity-kind/KND-... refs, never aliases)
  const events: CanonicalEventV1[] = [
    {
      schema: "entity-event/v1",
      type: "entity_reference_declared",
      eventId: "evt_real_brief",
      opId: "op_real_brief",
      workspaceRevision: 1,
      occurredAt: "2026-11-22T08:00:00.000Z",
      actor,
      source: "local",
      payload: {
        entityKind: briefKind,
        entityId: "BRIEF-00000000000000000000000000000001",
        descriptor: { title: "Q4 Launch Operating Charter" },
        locator: { kind: "url", value: "https://docs.example.invalid/q4-charter" },
      },
    } as unknown as CanonicalEventV1,
    {
      schema: "entity-event/v1",
      type: "entity_reference_declared",
      eventId: "evt_real_deliv",
      opId: "op_real_deliv",
      workspaceRevision: 2,
      occurredAt: "2026-11-22T08:10:00.000Z",
      actor,
      source: "local",
      payload: {
        entityKind: delivKind,
        entityId: "DELIV-00000000000000000000000000000001",
        descriptor: { title: "Executive Launch Readiness Deck" },
        locator: { kind: "repository-path", value: "docs/launch-deck.md" },
      },
    } as unknown as CanonicalEventV1,
    {
      schema: "entity-event/v1",
      type: "entity_reference_declared",
      eventId: "evt_real_handoff",
      opId: "op_real_handoff",
      workspaceRevision: 3,
      occurredAt: "2026-11-22T08:20:00.000Z",
      actor,
      source: "local",
      payload: {
        entityKind: handoffKind,
        entityId: "HANDOFF-00000000000000000000000000000001",
        descriptor: { title: "Ops Support Ownership Transfer" },
        locator: { kind: "repository-path", value: "docs/handoff-ops.md" },
      },
    } as unknown as CanonicalEventV1,
    {
      schema: "entity-event/v1",
      type: "entity_reference_declared",
      eventId: "evt_real_memory",
      opId: "op_real_memory",
      workspaceRevision: 4,
      occurredAt: "2026-11-22T08:30:00.000Z",
      actor,
      source: "local",
      payload: {
        entityKind: memoryKind,
        entityId: "MEM-00000000000000000000000000000001",
        descriptor: { title: "Vendor Escalation Playbook" },
        locator: { kind: "repository-path", value: "docs/vendor-escalation.md" },
      },
    } as unknown as CanonicalEventV1,
    {
      schema: "decision-event/v1",
      type: "decision_proposed",
      eventId: "evt_real_dec_prop_1",
      opId: "op_real_dec_prop_1",
      workspaceRevision: 5,
      occurredAt: "2026-11-22T08:35:00.000Z",
      decisionId: "dec_office_001",
      actor,
      source: "local",
      payload: {
        title: "Freeze Q4 Launch Deliverables",
        appliesTo: { modules: ["office/launch", "office/legal"], productLines: [] },
        chosen: [{ id: "CH1", text: "Require legal signoff before customer brief release" }],
      },
    } as unknown as CanonicalEventV1,
    {
      schema: "decision-event/v1",
      type: "decision_accepted",
      eventId: "evt_real_dec_1",
      opId: "op_real_dec_1",
      workspaceRevision: 6,
      occurredAt: "2026-11-22T08:40:00.000Z",
      decisionId: "dec_office_001",
      actor,
      source: "local",
      payload: { rationale: "Freeze Q4 launch deliverables and require signoff." },
    } as unknown as CanonicalEventV1,
    {
      schema: "task-event/v1",
      type: "task_created",
      eventId: "evt_real_work_1",
      opId: "op_real_work_1",
      workspaceRevision: 7,
      occurredAt: "2026-11-22T08:50:00.000Z",
      taskId: "work_q4_launch",
      actor,
      source: "local",
      payload: {
        task: {
          taskId: "work_q4_launch",
          title: "Q4 Launch Program",
          taskClass: "work",
          status: "active",
          metadata: { parentTaskId: null, slug: "q4-launch-program", surfaces: ["office/launch"] },
        },
      },
    } as unknown as CanonicalEventV1,
    {
      schema: "task-event/v1",
      type: "task_transitioned",
      eventId: "evt_real_task_block",
      opId: "op_real_task_block",
      workspaceRevision: 8,
      occurredAt: "2026-11-22T09:00:00.000Z",
      taskId: "task_legal_review",
      actor,
      source: "local",
      payload: {
        task: {
          taskId: "task_legal_review",
          title: "Legal signoff on customer brief",
          taskClass: "standard",
          status: "blocked",
          metadata: { parentTaskId: "work_q4_launch", surfaces: ["office/legal"] },
        },
        mutation: { command: "transition", reason: "Awaiting external counsel comment", fields: ["status"] },
      },
    } as unknown as CanonicalEventV1,
    {
      schema: "relation-event/v1",
      type: "relation_created",
      eventId: "evt_real_rel",
      opId: "op_real_rel",
      workspaceRevision: 9,
      occurredAt: "2026-11-22T09:10:00.000Z",
      relationId: "rel_0123456789abcdef",
      actor,
      source: "local",
      payload: {
        relation: {
          relation_id: "rel_0123456789abcdef",
          source: "decision/dec_office_001",
          target: "task/task_legal_review",
          type: "derives",
          direction: "directed",
          origin: "declared",
          state: "active",
          rationale: "Launch freeze requires legal signoff",
          targetObservedVersion: null,
        },
      },
    } as unknown as CanonicalEventV1,
  ];

  const reader = {
    store: {
      readHead: () => ({ revision: 9, opId: "op_real_rel" }),
      readEvent: (opId: string) => events.find((e) => e.opId === opId) ?? null,
      readEventAtRevision: (rev: number) => events.find((e) => e.workspaceRevision === rev) ?? null,
      readEventWindow: (query: {
        readonly afterRevision: number;
        readonly maxRevision?: number;
        readonly limit: number;
      }) => {
        const filtered = events.filter(
          (e) =>
            e.workspaceRevision > query.afterRevision &&
            (query.maxRevision === undefined || e.workspaceRevision <= query.maxRevision),
        );
        return {
          sourceRevision: 9,
          events: filtered.slice(0, query.limit),
          lastScannedRevision: 9,
          windowMaxRevision: 9,
          done: true,
        };
      },
    },
    projection: {
      readDocumentMetadata: () => ({ status: "ready" as const, document: null }),
      readDocument: () => ({ status: "ready" as const, document: null }),
    },
  };

  const slots = new Map((compiled.definition.livingDossier?.slots ?? []).map((slot) => [slot.id, slot]));

  // 1. PROJECT_BRIEF.md: charter gets project-brief, aligned-scope gets decision
  const briefSlot = slots.get("project-brief")!;
  const briefCtx = readDossierContext(reader, "office/collab", briefSlot, undefined, compiled.definition.entityKinds);
  const briefBody = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: briefSlot,
    previousBody: null,
    expectedWatermark: briefCtx.expectedWatermark,
    targetWatermark: briefCtx.nextWatermark,
    changes: briefCtx.changes,
    synthesizedAt: "2026-11-22T09:30:00.000Z",
    kindMap: briefCtx.kindMap,
  });
  validateDossierContent(briefSlot, briefBody, 9);
  const charterSec = briefBody.split("<!-- dossier-anchor: charter -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  const scopeSec = briefBody.split("<!-- dossier-anchor: aligned-scope -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  assert.ok(charterSec.includes("Q4 Launch Operating Charter"), "charter must include project-brief entity");
  assert.ok(!charterSec.includes("dec_office_001"), "charter must not mix decision rows");
  assert.ok(scopeSec.includes("dec_office_001"), "aligned-scope must include accepted decision");
  assert.ok(scopeSec.includes("Freeze Q4 Launch Deliverables"), "accepted decision must inherit proposal title");
  assert.ok(scopeSec.includes("CH1: Require legal signoff"), "accepted decision must inherit proposal chosen text");

  // 2. DELIVERABLE_REGISTER.md: deliverable-index gets deliverable ONLY (never decision!)
  const delivSlot = slots.get("deliverable-register")!;
  const delivCtx = readDossierContext(reader, "office/collab", delivSlot, undefined, compiled.definition.entityKinds);
  const delivBody = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: delivSlot,
    previousBody: null,
    expectedWatermark: delivCtx.expectedWatermark,
    targetWatermark: delivCtx.nextWatermark,
    changes: delivCtx.changes,
    synthesizedAt: "2026-11-22T09:30:00.000Z",
    kindMap: delivCtx.kindMap,
  });
  validateDossierContent(delivSlot, delivBody, 9);
  const delivIdx =
    delivBody.split("<!-- dossier-anchor: deliverable-index -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  assert.ok(delivIdx.includes("Executive Launch Readiness Deck"));
  assert.ok(!delivIdx.includes("dec_office_001"), "decision must never be misclassified as deliverable");

  // 3. HANDOFF_MAP.md: ownership-transfers gets ONLY handoff; institutional-memory gets ONLY memory-item
  const handoffSlot = slots.get("handoff-map")!;
  const handoffCtx = readDossierContext(
    reader,
    "office/collab",
    handoffSlot,
    undefined,
    compiled.definition.entityKinds,
  );
  const handoffBody = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: handoffSlot,
    previousBody: null,
    expectedWatermark: handoffCtx.expectedWatermark,
    targetWatermark: handoffCtx.nextWatermark,
    changes: handoffCtx.changes,
    synthesizedAt: "2026-11-22T09:30:00.000Z",
    kindMap: handoffCtx.kindMap,
  });
  validateDossierContent(handoffSlot, handoffBody, 9);
  const transfersSec =
    handoffBody.split("<!-- dossier-anchor: ownership-transfers -->")[1]?.split("<!-- dossier-anchor:")[0] ?? "";
  const memorySec =
    handoffBody.split("<!-- dossier-anchor: institutional-memory -->")[1]?.split("<!-- dossier-state:v1")[0] ?? "";
  assert.ok(transfersSec.includes("Ops Support Ownership Transfer"));
  assert.ok(!transfersSec.includes("Vendor Escalation Playbook"), "memory-item must never be misclassified as handoff");
  assert.ok(memorySec.includes("Vendor Escalation Playbook"));
  assert.ok(!memorySec.includes("Ops Support Ownership Transfer"), "handoff must stay in ownership-transfers");

  // 4. office/collab project-atlas.html: exact kindCounts (1 each, never dumped into project-brief) + zero URLs
  const atlasSlot = slots.get("project-atlas")!;
  const atlasCtx = readDossierContext(reader, "office/collab", atlasSlot, undefined, compiled.definition.entityKinds);
  const atlasBody = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: atlasSlot,
    previousBody: null,
    expectedWatermark: atlasCtx.expectedWatermark,
    targetWatermark: atlasCtx.nextWatermark,
    changes: atlasCtx.changes,
    synthesizedAt: "2026-11-22T09:30:00.000Z",
    kindMap: atlasCtx.kindMap,
  });
  validateDossierContent(atlasSlot, atlasBody, 9);
  assert.doesNotMatch(atlasBody, /https?:\/\//iu, "office/collab Atlas must strip locator URLs");
  assert.ok(atlasBody.includes("<code>project-brief</code><strong>1</strong>"));
  assert.ok(atlasBody.includes("<code>deliverable</code><strong>1</strong>"));
  assert.ok(atlasBody.includes("<code>handoff</code><strong>1</strong>"));
  assert.ok(atlasBody.includes("<code>memory-item</code><strong>1</strong>"));

  // 5. office/collab project-pulse.html: Work rollup + real slugged explainer path + live blocked task + active decision
  const pulseSlot = slots.get("project-pulse")!;
  const pulseCtx = readDossierContext(reader, "office/collab", pulseSlot, undefined, compiled.definition.entityKinds);
  const pulseBody = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: pulseSlot,
    previousBody: null,
    expectedWatermark: pulseCtx.expectedWatermark,
    targetWatermark: pulseCtx.nextWatermark,
    changes: pulseCtx.changes,
    synthesizedAt: "2026-11-22T09:30:00.000Z",
    kindMap: pulseCtx.kindMap,
  });
  validateDossierContent(pulseSlot, pulseBody, 9);
  assert.doesNotMatch(pulseBody, /https?:\/\//iu);
  assert.ok(pulseBody.includes("tasks/work_q4_launch-q4-launch-program/artifacts/explainer.html"));
  assert.ok(pulseBody.includes("Awaiting external counsel comment"));
  assert.ok(pulseBody.includes("Freeze Q4 Launch Deliverables"));
  assert.ok(pulseBody.includes("office/launch, office/legal"));
  assert.ok(pulseBody.includes("task/task_legal_review"));

  // 5b. F-DOSSIER-04b: canonical relation_retired (only relationId, no source/target) passes readDossierContext and removes stale edge & derived task
  const retireEvent: CanonicalEventV1 = {
    schema: "relation-event/v1",
    type: "relation_retired",
    eventId: "evt_real_rel_retire",
    opId: "op_real_rel_retire",
    workspaceRevision: 10,
    occurredAt: "2026-11-22T09:45:00.000Z",
    relationId: "rel_0123456789abcdef",
    actor,
    source: "local",
    payload: { reason: "Legal review moved to another charter" },
  } as unknown as CanonicalEventV1;
  const retireReader = {
    store: {
      readHead: () => ({ revision: 10, opId: "op_real_rel_retire" }),
      readEvent: (opId: string) => (opId === "op_real_rel_retire" ? retireEvent : null),
      readEventAtRevision: (rev: number) => (rev === 10 ? retireEvent : null),
      readEventWindow: () => ({
        sourceRevision: 10,
        events: [retireEvent],
        lastScannedRevision: 10,
        windowMaxRevision: 10,
        done: true,
      }),
    },
    projection: {
      readDocumentMetadata: () => ({ status: "ready" as const, document: null }),
      readDocument: () => ({ status: "ready" as const, document: null }),
    },
  };
  const pulseRetireCtx = readDossierContext(
    retireReader,
    "office/collab",
    pulseSlot,
    undefined,
    compiled.definition.entityKinds,
  );
  assert.equal(pulseRetireCtx.changes.length, 1, "relation_retired must not be dropped by entity-scoped slot");
  const pulseAfterRetire = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: pulseSlot,
    previousBody: pulseBody,
    expectedWatermark: 9,
    targetWatermark: 10,
    changes: pulseRetireCtx.changes,
    synthesizedAt: "2026-11-22T09:50:00.000Z",
    kindMap: pulseRetireCtx.kindMap,
  });
  validateDossierContent(pulseSlot, pulseAfterRetire, 10);
  const pulseDecTrail = pulseAfterRetire.split('id="decision-trail"')[1]?.split("</section>")[0] ?? "";
  assert.ok(!pulseDecTrail.includes("task/task_legal_review"), "retired relation must clear Derived Tasks");

  // 6. F-DOSSIER-02/05/06 write-boundary verification: chronicler HTML with external <a href> and prose URL passes validateDossierContent with zero http(s)://
  const curatedMd = [
    "<!-- dossier-watermark: 4 -->",
    "# Project Brief",
    "<!-- dossier-anchor: charter -->",
    "## Charter",
    "Executive initiative charter curated by the chronicler agent.",
    "<!-- dossier-anchor: aligned-scope -->",
    "## Aligned Scope",
    "Scope frozen for Q4.",
    "<!-- dossier-anchor: recent-updates -->",
    "## Recent Updates",
    "Reviewed in weekly sync.",
  ].join("\n");
  const advancedMdEmpty = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: briefSlot,
    previousBody: curatedMd,
    expectedWatermark: 4,
    targetWatermark: 9,
    changes: [],
    synthesizedAt: "2026-11-22T10:00:00.000Z",
  });
  validateDossierContent(briefSlot, advancedMdEmpty, 9);
  assert.ok(advancedMdEmpty.includes("Executive initiative charter curated by the chronicler agent."));

  const curatedHtmlWithLinks = [
    "<!doctype html>",
    '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="dossier-watermark" content="4"><title>Atlas</title></head>',
    '<body><main><section id="atlas-topology"><svg viewBox="0 0 320 100" role="img"><rect x="8" y="8" width="120" height="40"/></svg></section>',
    '<section id="entity-map"><p>Curated office entity overview with <a href="https://example.com/spec">Spec</a> and http://example.org/note.</p></section>',
    '<section id="change-ledger"><p>Curated baseline at r4.</p></section></main></body></html>',
  ].join("\n");
  // Valid chronicler HTML is accepted at V2 write boundary before continuation
  validateDossierContent(atlasSlot, curatedHtmlWithLinks, 4);

  const advancedHtmlEmpty = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: atlasSlot,
    previousBody: curatedHtmlWithLinks,
    expectedWatermark: 4,
    targetWatermark: 6,
    changes: [],
    synthesizedAt: "2026-11-22T09:55:00.000Z",
    kindMap: atlasCtx.kindMap,
  });
  validateDossierContent(atlasSlot, advancedHtmlEmpty, 6);
  assert.doesNotMatch(advancedHtmlEmpty, /https?:\/\//iu);
  assert.ok(advancedHtmlEmpty.includes("Spec [ref: example.com/spec]"));

  const advancedHtmlNonEmpty = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: atlasSlot,
    previousBody: curatedHtmlWithLinks,
    expectedWatermark: 4,
    targetWatermark: 9,
    changes: atlasCtx.changes,
    synthesizedAt: "2026-11-22T10:00:00.000Z",
    kindMap: atlasCtx.kindMap,
  });
  validateDossierContent(atlasSlot, advancedHtmlNonEmpty, 9);
  assert.ok(advancedHtmlNonEmpty.includes("Curated office entity overview"));
  assert.doesNotMatch(advancedHtmlNonEmpty, /https?:\/\//iu);
});
