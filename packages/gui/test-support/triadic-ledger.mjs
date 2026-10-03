import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeDecisionService, makeFactService } from "@harness-anything/application";
import {
  compileDecisionWrite,
  compileFactWrite,
  decisionReviewContentDigest,
  deriveRelationId,
  makeTaskEventStore,
  makeTaskProjection,
} from "@harness-anything/kernel";

export function writeTriadicLedger(rootDir) {
  const taskDir = path.join(rootDir, "harness/tasks/task-gui-smoke");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    path.join(taskDir, "INDEX.md"),
    [
      "---",
      "schema: task-package/v2",
      "task_id: task-gui-smoke",
      "title: Render the real triadic projection",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: local",
      "  status: active",
      "  ref:",
      "  titleSnapshot: Render the real triadic projection",
      "  url:",
      "  bindingCreatedAt: 2026-07-10T00:00:00.000Z",
      "  bindingFingerprint: sha256:gui-smoke",
      "packageDisposition: active",
      "vertical: software/coding",
      "preset: implementation",
      "relations:",
      '  - {relation_id: rel_bfa32bfd7f399b66, source: task/task-gui-smoke, target: fact/F-ABCDEFGH, type: produces, strength: strong, direction: directed, origin: declared, rationale: "Task produced the renderer projection evidence", state: active}',
      "---",
      "",
    ].join("\n"),
  );
}

export async function seedTriadicEvents(rootDir, repoId, writerFence) {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    factService = makeFactService({ eventStore: store, projection }),
    decisionService = makeDecisionService({ eventStore: store, projection }),
    actor = { principal: { personId: "person-gui" }, executor: null };
  try {
    const append = (type, decisionId, payload, eventActor = actor) => {
      const revision = (store.readHead()?.revision ?? 0) + 1,
        event = {
          schema: "decision-event/v1",
          eventId: `event-${type}-${revision}`,
          workspaceRevision: revision,
          opId: `op-${type}-${revision}`,
          decisionId,
          type,
          actor: eventActor,
          source: "local",
          occurredAt: `2026-08-13T00:00:${String(revision).padStart(2, "0")}.000Z`,
          payload,
        },
        read = projection.readDecision(decisionId),
        path = `decisions/decision-${decisionId}/decision.md`,
        document = projection.readDocument(path).document,
        relations = projection
          .readDecisionGraph()
          .edges.filter((edge) => edge.ownerRef === `decision/${decisionId}`)
          .map((edge) => ({
            relation_id: edge.relationId,
            source: edge.sourceRef,
            target: edge.targetRef,
            type: edge.relationType,
            strength: edge.strength,
            direction: edge.direction,
            origin: edge.origin,
            rationale: edge.rationale,
            state: edge.state,
          }));
      decisionService.record(
        compileDecisionWrite({
          event:
            type === "decision_review_recorded"
              ? {
                  ...event,
                  payload: {
                    ...payload,
                    reviewContentDigest: decisionReviewContentDigest({ ...read.decision, relations }, document.body),
                  },
                }
              : event,
          currentDecision: read.decision,
          currentRelations: relations,
          currentDocument: document,
        }),
      );
    };
    const revision = (store.readHead()?.revision ?? 0) + 1,
      fact = {
        schema: "fact-event/v1",
        eventId: `event-fact-gui-${revision}`,
        workspaceRevision: revision,
        opId: `op-fact-gui-${revision}`,
        taskId: "task-gui-smoke",
        factId: "F-ABCDEFGH",
        type: "fact_recorded",
        actor,
        source: "local",
        occurredAt: "2026-08-13T00:00:20.000Z",
        payload: {
          statement: "The GUI renderer received event-backed triadic rows.",
          evidenceSource: "GUI integration",
          observedAt: "2026-08-13T00:00:20.000Z",
          confidence: "low",
          memoryClass: "semantic",
          memoryTags: ["pattern"],
          provenance: [
            {
              runtime: "codex",
              sessionId: "fg-p1-07-e2e",
              transcriptReachability: "by_session_id",
              boundAt: "2026-08-13T00:00:20.000Z",
            },
          ],
        },
      };
    const packagePath = projection.read("task-gui-smoke").packagePath;
    if (!packagePath) throw new Error("GUI task package is unavailable");
    factService.record(compileFactWrite({ event: fact, packagePath, currentFacts: [] }));
    append("decision_proposed", "dec_gui_smoke", {
      title: "Expose the triadic projection to the GUI",
      question: "Should the GUI consume the public relation graph?",
      riskTier: "high",
      urgency: "high",
      vertical: "software/coding",
      preset: "architecture-decision",
      appliesTo: { modules: ["gui"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Use the existing daemon/service bridge" }],
      rejected: [{ id: "RJ1", text: "Read Markdown directly", whyNot: "It bypasses canonical projection truth" }],
      body: "\n# Expose the triadic projection to the GUI\n",
      claims: [],
      fulfillments: [],
      relations: [],
      provenance: [
        {
          runtime: "codex",
          sessionId: "gui-decision-session",
          transcriptReachability: "by_session_id",
          boundAt: "2026-08-13T00:00:21.000Z",
        },
      ],
    });
    append("decision_claim_declared", "dec_gui_smoke", {
      claimId: "C1",
      text: "The public path preserves kernel relation names",
      loadBearing: true,
    });
    for (const relation of [
      {
        source: "decision/dec_gui_smoke",
        target: "task/task-gui-smoke",
        type: "derives",
        rationale: "Decision derived the GUI task",
      },
      {
        source: "decision/dec_gui_smoke/C1",
        target: "fact/F-ABCDEFGH",
        type: "evidenced-by",
        rationale: "Fact evidences the public projection",
      },
    ]) {
      const identity = { ...relation, direction: "directed" };
      append("decision_related", "dec_gui_smoke", {
        relation: {
          relation_id: deriveRelationId(identity),
          ...identity,
          strength: "strong",
          origin: "declared",
          state: "active",
        },
      });
    }
    append(
      "decision_review_recorded",
      "dec_gui_smoke",
      {
        reviewId: "review-gui-flow-1",
        verdict: "changes_requested",
        reason: "Two points need a response before judgment.",
        findings: [
          { findingId: "F1", text: "Name the read surface the GUI consumes.", anchor: "C1" },
          { findingId: "F2", text: "Reject option lacks a cost estimate.", anchor: "RJ1" },
        ],
        evidenceChecked: ["decision body", "C1", "RJ1"],
        reportRef: null,
      },
      { principal: { personId: "person-gui-reviewer" }, executor: null },
    );
    // This fixture bypasses the daemon command lane. Seed its review notification as well,
    // matching decision-review-awaits so owner work is visible in the agenda's awaits group.
    const reviewAwait = {
      source: "decision/dec_gui_smoke",
      target: "person/person-gui",
      type: "awaits",
      direction: "directed",
    };
    append("decision_related", "dec_gui_smoke", {
      relation: {
        relation_id: deriveRelationId(reviewAwait),
        ...reviewAwait,
        strength: "strong",
        origin: "declared",
        state: "active",
        rationale: "consent: Decision dec_gui_smoke has review changes to resolve.",
      },
    });
  } finally {
    projection.close();
    await store.drain();
  }
}

/**
 * 取代链种子:dec_gui_smoke 以 supersedes 边指向 12 个真实 proposed 决策,给
 * decision-supersede-chain 场景种出「随关系数无界增长的链接链」真实数据(12 条边
 * 足以让详情卡里的链溢出)。走与 seedTriadicEvents 同一 decisionService 写路。
 */
export async function seedSupersedeChain(rootDir, repoId, writerFence) {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    decisionService = makeDecisionService({ eventStore: store, projection }),
    actor = { principal: { personId: "person-gui" }, executor: null };
  try {
    const append = (type, decisionId, payload) => {
      const revision = (store.readHead()?.revision ?? 0) + 1,
        event = {
          schema: "decision-event/v1",
          eventId: `event-${type}-${revision}`,
          workspaceRevision: revision,
          opId: `op-${type}-${revision}`,
          decisionId,
          type,
          actor,
          source: "local",
          occurredAt: `2026-08-13T00:01:${String(revision % 60).padStart(2, "0")}.000Z`,
          payload,
        },
        read = projection.readDecision(decisionId),
        path = `decisions/decision-${decisionId}/decision.md`,
        document = projection.readDocument(path).document,
        relations = projection
          .readDecisionGraph()
          .edges.filter((edge) => edge.ownerRef === `decision/${decisionId}`)
          .map((edge) => ({
            relation_id: edge.relationId,
            source: edge.sourceRef,
            target: edge.targetRef,
            type: edge.relationType,
            strength: edge.strength,
            direction: edge.direction,
            origin: edge.origin,
            rationale: edge.rationale,
            state: edge.state,
          }));
      decisionService.record(
        compileDecisionWrite({
          event,
          currentDecision: read.decision,
          currentRelations: relations,
          currentDocument: document,
        }),
      );
    };
    for (let index = 1; index <= 12; index += 1) {
      const decisionId = `dec_sup_${String(index).padStart(2, "0")}`;
      append("decision_proposed", decisionId, {
        title: `取代链样本决策 ${index}`,
        question: "GUI 取代链横滚场景的种子决策?",
        riskTier: "low",
        urgency: "low",
        vertical: "software/coding",
        preset: "architecture-decision",
        appliesTo: { modules: ["gui"], productLines: [] },
        decisionClass: "ordinary",
        chosen: [{ id: "CH1", text: "跟随被取代决策的既有路线" }],
        rejected: [{ id: "RJ1", text: "另立新决策", whyNot: "取代链场景只需要被取代的存量路线" }],
        body: `\n# 取代链样本决策 ${index}\n`,
        claims: [],
        fulfillments: [],
        relations: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "gui-supersede-chain",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-13T00:01:00.000Z",
          },
        ],
      });
      const identity = {
        source: "decision/dec_gui_smoke",
        target: `decision/${decisionId}`,
        type: "supersedes",
        direction: "directed",
      };
      append("decision_related", "dec_gui_smoke", {
        relation: {
          relation_id: deriveRelationId(identity),
          ...identity,
          strength: "strong",
          origin: "declared",
          state: "active",
          rationale: "supersede-chain e2e: canonical decision policy lineage seed.",
        },
      });
    }
  } finally {
    projection.close();
    await store.drain();
  }
}
