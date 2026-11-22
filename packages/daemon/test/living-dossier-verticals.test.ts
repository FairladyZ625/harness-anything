// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateDossierContent } from "@harness-anything/application/internal/commands/dossier-content.ts";
import { compileVerticalContract } from "@harness-anything/kernel";
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
      actor: { principal: { personId: "person_zeyu" } },
      payload: { title: "Living dossier contract for software/coding" },
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
      payload: { title: "Deliver incremental living dossier engine" },
      entityRefs: ["task/task_4bc216a471f89c7de849901719"],
    },
    {
      eventId: "evt_sc_3",
      schema: "fact-event/v1",
      type: "fact_recorded",
      occurredAt: "2026-11-22T09:30:00.000Z",
      workspaceRevision: 25,
      actor: { executor: { id: "worker" } },
      payload: { statement: "Fixed-window dossier cost stays O(delta) at 30,000 revisions." },
      entityRefs: ["fact/F-B811EF90"],
    },
  ],
  "office/collab": [
    {
      eventId: "evt_oc_1",
      schema: "entity-event/v1",
      type: "entity_upserted",
      occurredAt: "2026-11-22T08:15:00.000Z",
      workspaceRevision: 6,
      actor: { principal: { personId: "person_alice" } },
      payload: { title: "Q4 Operating Charter", entityKind: "project-brief" },
      entityRefs: ["project-brief/BRIEF-001"],
    },
    {
      eventId: "evt_oc_2",
      schema: "entity-event/v1",
      type: "entity_upserted",
      occurredAt: "2026-11-22T09:15:00.000Z",
      workspaceRevision: 11,
      actor: { principal: { personId: "person_bob" } },
      payload: { title: "Launch Readiness Report", entityKind: "deliverable" },
      entityRefs: ["deliverable/DELIV-001"],
    },
    {
      eventId: "evt_oc_3",
      schema: "entity-event/v1",
      type: "entity_upserted",
      occurredAt: "2026-11-22T10:15:00.000Z",
      workspaceRevision: 14,
      actor: { principal: { personId: "person_alice" } },
      payload: { title: "Operations Ownership Handoff", entityKind: "handoff" },
      entityRefs: ["handoff/HANDOFF-001"],
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

      // Window 2: incremental update with domain changes
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
        assert.doesNotMatch(updated, /https?:\/\//iu, `${verticalId}/${slot.path} must stay offline`);
        assert.doesNotMatch(updated, /<(?:script|iframe|link|base|embed|object)\b/iu);
      } else {
        assert.equal(updated.split("\n", 1)[0], "<!-- dossier-watermark: 25 -->");
      }
    }
  });
}
