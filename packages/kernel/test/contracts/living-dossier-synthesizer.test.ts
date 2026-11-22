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

const page1Changes: readonly DossierChangeItem[] = [
  {
    eventId: "evt_001",
    schema: "decision-event/v1",
    type: "decision_accepted",
    occurredAt: "2026-11-22T10:00:00.000Z",
    workspaceRevision: 10,
    actor: { principal: { personId: "person_zeyu" } },
    payload: { title: "Adopt vertical living dossier contract" },
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
    payload: { title: "Ship <script>alert(1)</script> escaping guard" },
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
    actor: { principal: { personId: "person_zeyu" } },
    payload: { title: "Supersede legacy static docs" },
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
