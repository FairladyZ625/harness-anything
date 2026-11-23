// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateDossierContent } from "@harness-anything/application/internal/commands/dossier-content.ts";
import { prepareDossierSynthesis } from "@harness-anything/application/internal/commands/living-dossier.ts";
import { readDossierContext } from "@harness-anything/application/internal/queries/living-dossier.ts";
import {
  compileVerticalContract,
  type CanonicalEventV1,
  type DecisionProjectionRow,
  type FactProjectionRow,
  type TaskIndexProjectionRow,
  type TaskRelationProjectionRow,
} from "@harness-anything/kernel";
import { DOSSIER_PAGE_SIZE, synthesizeDossierDocument } from "@harness-anything/kernel/browser";
import { validateDossierSynthesisEvent } from "@harness-anything/kernel/internal/domain/dossier-synthesis-event.ts";
import { dossierStatePath } from "@harness-anything/kernel/internal/domain/living-dossier.ts";
import { decodeVerticalDefinition } from "@harness-anything/kernel/schemas";
import { resolveVerticalAssetsRoot } from "@harness-anything/preset/internal/preset-assets";
import type { DossierReader } from "@harness-anything/application/internal/dossier-state.ts";

const actor = { principal: { personId: "person_zeyu" }, executor: null } as const;

function loadSlots(verticalId: "software/coding" | "office/collab") {
  const assetsRoot = resolveVerticalAssetsRoot(verticalId);
  const decoded = decodeVerticalDefinition(JSON.parse(readFileSync(path.join(assetsRoot, "vertical.json"), "utf8")));
  const compiled = compileVerticalContract(decoded);
  const slots = new Map((compiled.definition.livingDossier?.slots ?? []).map((slot) => [slot.id, slot]));
  return { compiled, slots };
}

test("DOSSIER_PAGE_SIZE=512 folds 1,600 revisions across afterWatermark pages in memory and commits 1 synthesis event", () => {
  assert.equal(DOSSIER_PAGE_SIZE, 512);
  const { compiled, slots } = loadSlots("software/coding");
  const pulseSlot = slots.get("project-pulse")!;
  const head = 1600;

  const events: CanonicalEventV1[] = [];
  for (let rev = 1; rev <= head; rev += 1) {
    events.push({
      schema: "task-event/v1",
      type: rev === 1 ? "task_created" : rev % 400 === 0 ? "task_completed" : "task_transitioned",
      eventId: `evt_fold_${rev}`,
      opId: `op_fold_${rev}`,
      workspaceRevision: rev,
      occurredAt: "2026-11-23T01:00:00.000Z",
      taskId: rev === 1 ? "work_turbo" : `task_turbo_${Math.ceil(rev / 400)}`,
      actor,
      source: "local",
      payload: {
        task: {
          taskId: rev === 1 ? "work_turbo" : `task_turbo_${Math.ceil(rev / 400)}`,
          title: rev === 1 ? "Turbo Dossier Overhaul" : `Slice ${Math.ceil(rev / 400)}`,
          taskClass: rev === 1 ? "work" : "standard",
          status: rev === 1 ? "active" : rev % 400 === 0 ? "done" : "active",
          metadata: { parentTaskId: rev === 1 ? null : "work_turbo" },
        },
      },
    } as unknown as CanonicalEventV1);
  }

  let windowCalls = 0;
  const reader: DossierReader = {
    store: {
      readHead: () => ({ revision: head, opId: `op_fold_${head}` }),
      readEvent: (opId: string) => events.find((e) => e.opId === opId) ?? null,
      readEventAtRevision: (rev: number) => events.find((e) => e.workspaceRevision === rev) ?? null,
      readEventWindow: (query) => {
        windowCalls += 1;
        const upper = Math.min(head, query.maxRevision ?? head);
        const matching = events.filter(
          (e) => e.workspaceRevision > query.afterRevision && e.workspaceRevision <= upper,
        );
        const sliced = matching.slice(0, query.limit);
        const hasMore = matching.length > query.limit;
        return {
          sourceRevision: head,
          events: sliced,
          windowMaxRevision: upper,
          lastScannedRevision: hasMore ? sliced.at(-1)!.workspaceRevision : Math.max(query.afterRevision, upper),
          done: !hasMore,
        };
      },
    },
    projection: {
      readDocumentMetadata: () => ({ status: "ready", document: null }),
      readDocument: () => ({ status: "ready", document: null }),
    },
  };

  let cursor = 0;
  let body: string | null = null;
  let pages = 0;
  while (true) {
    const page = readDossierContext(reader, "software/coding", pulseSlot, head, compiled.definition.entityKinds, {
      afterWatermark: cursor,
    });
    assert.equal(page.expectedWatermark, 0, "persisted slot watermark remains 0 while folding in memory");
    assert.equal(page.afterWatermark, cursor);
    body = synthesizeDossierDocument({
      verticalId: "software/coding",
      slot: pulseSlot,
      previousBody: body,
      expectedWatermark: cursor,
      targetWatermark: page.nextWatermark,
      changes: page.changes,
      synthesizedAt: "2026-11-23T02:00:00.000Z",
      kindMap: page.kindMap,
    });
    cursor = page.nextWatermark;
    pages += 1;
    if (page.done) break;
  }

  assert.equal(pages, 4, "1600 revisions / 512 per page = 4 bounded read pages");
  assert.equal(windowCalls, 4);
  assert.equal(cursor, 1600);
  validateDossierContent(pulseSlot, body!, 1600);

  // Commit ONE single synthesis event advancing 0 -> 1600 (zero write amplification!)
  const bundle = prepareDossierSynthesis({
    reader,
    verticalId: "software/coding",
    slot: pulseSlot,
    expectedWatermark: 0,
    watermark: 1600,
    body: body!,
    opId: "op_single_commit_1600",
    actor,
    source: "local",
    occurredAt: "2026-11-23T02:00:00.000Z",
  });
  assert.deepEqual(validateDossierSynthesisEvent(bundle.event), []);
  assert.equal(bundle.event.payload.expectedWatermark, 0);
  assert.equal(bundle.event.payload.state.lastSynthesizedWatermark, 1600);
  assert.ok(body!.includes("Turbo Dossier Overhaul"));
  assert.ok(body!.includes("Slice 4"));

  // Negative controls: CAS conflict and invalid watermark bounds still reject fail-closed
  assert.throws(
    () =>
      prepareDossierSynthesis({
        reader,
        verticalId: "software/coding",
        slot: pulseSlot,
        expectedWatermark: 64,
        watermark: 1600,
        body: body!,
        opId: "op_bad_cas",
        actor,
        source: "local",
        occurredAt: "2026-11-23T02:00:00.000Z",
      }),
    /Slot project-pulse has watermark 0, expected 64/u,
  );
  assert.throws(
    () =>
      prepareDossierSynthesis({
        reader,
        verticalId: "software/coding",
        slot: pulseSlot,
        expectedWatermark: 0,
        watermark: 0,
        body: body!,
        opId: "op_zero_advance",
        actor,
        source: "local",
        occurredAt: "2026-11-23T02:00:00.000Z",
      }),
    /strictly above the current slot watermark/u,
  );
  assert.throws(
    () =>
      prepareDossierSynthesis({
        reader,
        verticalId: "software/coding",
        slot: pulseSlot,
        expectedWatermark: 0,
        watermark: 1601,
        body: body!,
        opId: "op_beyond_cut",
        actor,
        source: "local",
        occurredAt: "2026-11-23T02:00:00.000Z",
      }),
    /strictly above the current slot watermark up to the source cut/u,
  );
  assert.throws(
    () =>
      readDossierContext(reader, "software/coding", pulseSlot, head, compiled.definition.entityKinds, {
        afterWatermark: head + 1,
      }),
    /afterWatermark must be an integer up to the upper watermark/u,
  );
  assert.throws(
    () =>
      readDossierContext(reader, "software/coding", pulseSlot, head - 1, compiled.definition.entityKinds, {
        bootstrap: true,
      }),
    /cannot target a historical maxWatermark/u,
  );
});

test("bootstrap: true jumps a high-watermark repository (r64 -> r290,000) in 1 projection-backed read + 1 write", () => {
  const { compiled: codingCompiled, slots: codingSlots } = loadSlots("software/coding");
  const { compiled: collabCompiled, slots: collabSlots } = loadSlots("office/collab");
  const head = 290_000;
  const briefOpaqueKind = collabCompiled.artifactKinds.find((k) => k.declaration.id === "project-brief")!.typeIdentity;

  const priorSynthesis = {
    schema: "dossier-synthesis-event/v1",
    type: "dossier_synthesized",
    opId: "op_prior_64",
    eventId: "event-op_prior_64",
    actor,
    source: "local",
    occurredAt: "2026-11-22T00:00:00.000Z",
    workspaceRevision: 65,
    payload: {
      expectedWatermark: 0,
      sourceWatermark: 64,
      state: {
        verticalId: "software/coding",
        slotId: "project-pulse",
        lastSynthesizedWatermark: 64,
        synthesizedAt: "2026-11-22T00:00:00.000Z",
        path: "dossiers/software+coding/project-pulse.html",
      },
      documentClaims: [],
    },
  } as unknown as CanonicalEventV1;

  const tailTaskEvent = {
    schema: "task-event/v1",
    type: "task_completed",
    eventId: "evt_tail_290000",
    opId: "op_tail_290000",
    workspaceRevision: head,
    occurredAt: "2026-11-23T02:10:00.000Z",
    taskId: "task_tail_latest",
    actor,
    source: "local",
    payload: {
      task: {
        taskId: "task_tail_latest",
        title: "Eliminate dossier write amplification",
        taskClass: "standard",
        status: "done",
        metadata: { parentTaskId: "work_dossier_perf" },
      },
    },
  } as unknown as CanonicalEventV1;

  let windowReads = 0;
  const makeReader = (verticalId: string, slotId: string, cutStatus: "ready" | "behind" = "ready"): DossierReader => ({
    store: {
      readHead: () => ({ revision: head, opId: "op_tail_290000" }),
      readEvent: () => tailTaskEvent,
      readEventAtRevision: (rev: number) => (rev === 65 ? priorSynthesis : rev === head ? tailTaskEvent : null),
      readEventWindow: (query) => {
        windowReads += 1;
        assert.equal(query.afterRevision, head - DOSSIER_PAGE_SIZE, "bootstrap only scans the final 512-revision tail");
        return {
          sourceRevision: head,
          events: [tailTaskEvent],
          windowMaxRevision: head,
          lastScannedRevision: head,
          done: true,
        };
      },
    },
    projection: {
      readDocumentMetadata: (docPath: string) => ({
        status: "ready",
        document:
          verticalId === "software/coding" && docPath === dossierStatePath("software/coding", slotId)
            ? { path: docPath, workspaceRevision: 65 }
            : null,
      }),
      readDocument: () => ({ status: "ready", document: null }),
      readCut: () => ({ status: cutStatus, watermark: cutStatus === "ready" ? head : head - 10, sourceRevision: head }),
      readTaskIndex: (query) => {
        const workRow: TaskIndexProjectionRow = {
          supersededBy: null,
          taskId: "work_dossier_perf",
          title: "Living Dossier Performance Overhaul",
          status: "active",
          pinned: true,
          parentTaskId: null,
          workKind: "feat",
          riskTier: "medium",
          urgency: "high",
          taskClass: "work",
          packageDisposition: "active",
          packagePath: "tasks/work_dossier_perf",
          updatedAt: "2026-11-23T02:00:00.000Z",
          createdByPersonId: "person_zeyu",
        };
        const blockedRow: TaskIndexProjectionRow = {
          ...workRow,
          taskId: "task_blocked_gate",
          title: "Awaiting upstream OIDC token rotation",
          status: "blocked",
          pinned: false,
          parentTaskId: "work_dossier_perf",
          taskClass: "standard",
        };
        const rows = query?.workRootsOnly
          ? [workRow]
          : query?.status === "blocked"
            ? [blockedRow]
            : [workRow, blockedRow];
        return {
          schema: "task-index-projection/v1",
          status: "ready",
          rows,
          watermark: head,
          sourceRevision: head,
          warnings: [],
          page: null,
        };
      },
      listDecisions: ((filters: { readonly state?: string }) => {
        const activeDec = {
          decisionId: "dec_4276A0CEACD4D402F122295925",
          legacyId: null,
          path: "decisions/decision-dec_4276A0CEACD4D402F122295925/decision.md",
          state: "in_effect",
          title: "Vertical Living Dossier Standing Contract",
          question: "How to maintain human-readable dossiers?",
          riskTier: "medium",
          urgency: "high",
          vertical: "software/coding",
          preset: "decision-conformance",
          decisionClass: "standing_policy",
          appliesTo: { modules: ["kernel", "application", "gui"], productLines: ["harness-anything"] },
          proposer: actor,
          arbiter: actor,
          proposedAt: "2026-11-22T06:00:00.000Z",
          decidedAt: "2026-11-22T06:06:00.000Z",
          workspaceRevision: 288_995,
          chosen: [{ id: "CH2", text: "Single-writer incremental synthesis cursor" }],
          rejected: [],
          claims: [],
          provenance: [],
          judgmentConsents: [],
          reviews: [],
          reviewResponses: [],
          reviewOverrides: [],
          relations: [],
          body: null,
          capabilities: [],
          claimsOpen: false,
        } as unknown as DecisionProjectionRow;
        return {
          status: "ready",
          decisions: filters.state === "in_effect" ? [activeDec] : [],
          watermark: head,
          sourceRevision: head,
          warnings: [],
        };
      }) as NonNullable<DossierReader["projection"]["listDecisions"]>,
      searchFacts: () => ({
        status: "ready",
        facts: [
          {
            schema: "fact-row/v1",
            ref: "fact/F-FASTBOOT",
            factId: "F-FASTBOOT",
            statement: "Bootstrap reaches r290,000 in a single bounded projection pass.",
            evidenceSource: "packages/application/src/queries/living-dossier-bootstrap.ts",
            observedAt: "2026-11-23T02:05:00.000Z",
            confidence: "high",
            memoryClass: "semantic",
            memoryTags: [],
            provenance: [],
            actor,
            source: "local",
            occurredAt: "2026-11-23T02:05:00.000Z",
            workspaceRevision: 289_990,
            state: "valid",
            invalidated: false,
            archived: false,
          } satisfies FactProjectionRow,
        ],
        watermark: head,
        sourceRevision: head,
        warnings: [],
        page: { limit: 50, cursor: null, nextCursor: null },
      }),
      readRelationQuery: () => ({
        status: "ready",
        rows: [
          {
            relationId: "rel_boot_derives",
            workspaceRevision: 289_000,
            sourceRef: "decision/dec_4276A0CEACD4D402F122295925/CH2",
            targetRef: "task/work_dossier_perf",
            relationType: "derives",
            direction: "directed",
            strength: "strong",
            origin: "declared",
            state: "active",
            targetObservedVersion: null,
            currentTargetVersion: null,
            freshness: "fresh",
            rationale: "Implements O(1) dossier catch-up",
            ownerRef: "decision/dec_4276A0CEACD4D402F122295925",
            sourcePath: "decisions/decision-dec_4276A0CEACD4D402F122295925/decision.md",
            recordIndex: 0,
          } satisfies TaskRelationProjectionRow,
        ],
        watermark: head,
        sourceRevision: head,
        warnings: [],
      }),
      listEntities: (kind: string) =>
        kind === briefOpaqueKind
          ? [
              {
                kind: briefOpaqueKind,
                id: "BRIEF-BOOT-01",
                ownerId: null,
                workspaceRevision: 289_500,
                freshness: "fresh",
                currentVersion: null,
                value: { descriptor: { title: "Executive Bootstrap Charter" }, updatedAt: "2026-11-23T01:55:00.000Z" },
              },
            ]
          : [],
    },
  });

  // Negative control: lagging projection fails closed with projection_pending
  const pulseSlot = codingSlots.get("project-pulse")!;
  assert.throws(
    () =>
      readDossierContext(
        makeReader("software/coding", "project-pulse", "behind"),
        "software/coding",
        pulseSlot,
        undefined,
        codingCompiled.definition.entityKinds,
        { bootstrap: true },
      ),
    /projection has not caught up/u,
  );

  // Positive 1: software/coding project-pulse jumps r64 -> r290,000 in 1 read + 1 write
  const codingReader = makeReader("software/coding", "project-pulse");
  const bootCtx = readDossierContext(
    codingReader,
    "software/coding",
    pulseSlot,
    undefined,
    codingCompiled.definition.entityKinds,
    { bootstrap: true },
  );
  assert.equal(bootCtx.bootstrapped, true);
  assert.equal(bootCtx.expectedWatermark, 64);
  assert.equal(bootCtx.nextWatermark, head);
  assert.equal(bootCtx.done, true);
  assert.equal(windowReads, 1, "must read only 1 bounded tail window");

  const pulseHtml = synthesizeDossierDocument({
    verticalId: "software/coding",
    slot: pulseSlot,
    previousBody: null,
    expectedWatermark: bootCtx.expectedWatermark,
    targetWatermark: bootCtx.nextWatermark,
    changes: bootCtx.changes,
    synthesizedAt: "2026-11-23T02:15:00.000Z",
    kindMap: bootCtx.kindMap,
  });
  validateDossierContent(pulseSlot, pulseHtml, head);
  assert.ok(pulseHtml.includes("Living Dossier Performance Overhaul"));
  assert.ok(pulseHtml.includes("Vertical Living Dossier Standing Contract"));
  assert.ok(pulseHtml.includes("Awaiting upstream OIDC token rotation"));
  assert.ok(pulseHtml.includes("Eliminate dossier write amplification"));

  const prepared = prepareDossierSynthesis({
    reader: codingReader,
    verticalId: "software/coding",
    slot: pulseSlot,
    expectedWatermark: 64,
    watermark: head,
    body: pulseHtml,
    opId: "op_boot_290000",
    actor,
    source: "local",
    occurredAt: "2026-11-23T02:15:00.000Z",
  });
  assert.equal(prepared.event.payload.state.lastSynthesizedWatermark, head);

  // Positive 2: office/collab project-brief bootstraps declared custom entity-kind rows accurately
  const briefSlot = collabSlots.get("project-brief")!;
  const collabReader = makeReader("office/collab", "project-brief");
  const briefBoot = readDossierContext(
    collabReader,
    "office/collab",
    briefSlot,
    undefined,
    collabCompiled.definition.entityKinds,
    { bootstrap: true },
  );
  const briefMd = synthesizeDossierDocument({
    verticalId: "office/collab",
    slot: briefSlot,
    previousBody: null,
    expectedWatermark: 0,
    targetWatermark: head,
    changes: briefBoot.changes,
    synthesizedAt: "2026-11-23T02:15:00.000Z",
    kindMap: briefBoot.kindMap,
  });
  validateDossierContent(briefSlot, briefMd, head);
  assert.ok(briefMd.includes("Executive Bootstrap Charter"));
});
