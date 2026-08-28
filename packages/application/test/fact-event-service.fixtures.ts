import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileDecisionWrite,
  compileFactWrite,
  deriveRelationId,
  isTaskEvent,
  makeTaskEventStore,
  makeTaskProjection,
  taskLifecycleWritePlan,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type CanonicalWriteBundle,
  type DecisionEventDraftV1,
  type FactEventDraftV1,
  type FactEventV1,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import { makeDecisionService, makeFactService } from "../src/index.ts";
import { realizedDecisionBody } from "../../../tools/fixtures/task-plan.mjs";

export const actor = {
  principal: { personId: "person-fact" },
  executor: { kind: "agent", id: "codex" },
} as const;

export function withFixture(
  run: (fixture: {
    readonly store: ReturnType<typeof makeTaskEventStore>;
    readonly projection: ReturnType<typeof makeTaskProjection>;
    readonly service: ReturnType<typeof makeFactService>;
  }) => void,
): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-fact-service-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Fact Test");
    git(rootDir, "config", "user.email", "fact@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "fact-test", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    run({
      store,
      projection,
      service: makeFactService({ eventStore: store, projection }),
    });
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}
export function withDecisionFixture(
  run: (fixture: {
    readonly store: ReturnType<typeof makeTaskEventStore>;
    readonly projection: ReturnType<typeof makeTaskProjection>;
    readonly service: ReturnType<typeof makeDecisionService>;
  }) => void,
): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-decision-service-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Decision Test");
    git(rootDir, "config", "user.email", "decision@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
    const store = makeTaskEventStore({ repoId: "decision-test", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore: store });
    run({
      store,
      projection,
      service: makeDecisionService({ eventStore: store, projection }),
    });
  } finally {
    projection?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}
export function decisionEvent(
  revision: number,
  type: DecisionEventDraftV1["type"],
  eventActor = {
    principal: { personId: "person-arbiter" },
    executor: null,
  } as const,
  extra?: unknown,
): DecisionEventDraftV1 {
  const base = {
    schema: "decision-event/v1" as const,
    eventId: `event-decision-${revision}`,
    workspaceRevision: revision,
    opId: `op-decision-${revision}`,
    decisionId: "dec_FIXTURE",
    actor: type === "decision_proposed" ? actor : eventActor,
    source: "local" as const,
    occurredAt: new Date(Date.UTC(2026, 7, 13, 1, 0, revision)).toISOString(),
  };
  if (type === "decision_proposed")
    return {
      ...base,
      type,
      payload: {
        title: "Canonical Decision",
        question: "Should this Decision be event-backed?",
        riskTier: "medium",
        urgency: "medium",
        vertical: "default",
        preset: "default",
        appliesTo: { modules: ["kernel"], productLines: [] },
        decisionClass: "ordinary",
        chosen: [{ id: "CH1", text: "Use events", rationale: "Replayable" }],
        rejected: [{ id: "RJ1", text: "Use markdown", whyNot: "Not canonical" }],
        body: realizedDecisionBody("Canonical Decision"),
        claims: [],
        fulfillments: [],
        relations: [],
        provenance: [
          {
            runtime: "codex",
            sessionId: "session-decision",
            transcriptReachability: "by_session_id",
            boundAt: "2026-08-13T00:00:00.000Z",
          },
        ],
      },
    };
  if (type === "decision_accepted")
    return {
      ...base,
      type,
      payload: {
        rationale: "Independent approval.",
        judgmentOnlyRationale: "Explicit judgment-only acceptance.",
      },
    };
  if (type === "decision_rejected" || type === "decision_deferred" || type === "decision_retired")
    return { ...base, type, payload: { reason: "Recorded outcome." } };
  if (type === "decision_claim_declared")
    return {
      ...base,
      type,
      payload: {
        claimId: "C1",
        text: "The event is deterministic.",
        loadBearing: true,
      },
    };
  if (type === "decision_claim_fulfillment_declared")
    return { ...base, type, payload: { claimId: "C1", mode: "evidenced" } };
  if (type === "decision_related") return { ...base, type, payload: { relation: extra as never } };
  return {
    ...base,
    type,
    payload: {
      relationId: String(extra),
      reason: "The edge is no longer current.",
    },
  };
}
export function decisionAt(
  revision: number,
  decisionId: string,
  type: DecisionEventDraftV1["type"],
  payload: unknown,
  eventActor: DecisionEventDraftV1["actor"],
): DecisionEventDraftV1 {
  return {
    schema: "decision-event/v1",
    eventId: `event-${decisionId}-${revision}`,
    workspaceRevision: revision,
    opId: `op-${decisionId}-${revision}`,
    decisionId,
    type,
    actor: eventActor,
    source: "local",
    occurredAt: new Date(Date.UTC(2026, 7, 13, 2, 0, revision)).toISOString(),
    payload,
  } as DecisionEventDraftV1;
}
export function relationRecord(source: string, target: string, type: "supports" | "produces" | "evidenced-by") {
  const identity = { source, target, type, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong" as const,
    origin: "declared" as const,
    rationale: "Canonical Decision relation.",
    state: "active" as const,
  };
}
export function factEvent(
  revision: number,
  taskId: string,
  factId: string,
  supersedes?: { readonly factRef: string; readonly rationale: string },
): FactEventDraftV1 {
  return {
    schema: "fact-event/v1",
    eventId: `event-fact-${revision}`,
    workspaceRevision: revision,
    opId: `op-fact-${revision}`,
    taskId,
    factId,
    type: "fact_recorded",
    actor,
    source: "local",
    occurredAt: new Date(Date.UTC(2026, 7, 13, 0, 0, revision)).toISOString(),
    payload: {
      statement: `Fact observation ${revision}`,
      evidenceSource: "integration test",
      observedAt: new Date(Date.UTC(2026, 7, 13, 0, 0, revision)).toISOString(),
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: ["pattern"],
      provenance: [
        {
          runtime: "codex",
          sessionId: "session-fact",
          transcriptReachability: "by_session_id",
          boundAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      ...(supersedes ? { supersedes } : {}),
    },
  };
}
export function compile(projection: Pick<TaskProjection, "searchFacts">, draft: FactEventDraftV1) {
  return compileFactWrite({
    event: draft,
  });
}
export function recordFact(
  service: ReturnType<typeof makeFactService>,
  projection: Pick<TaskProjection, "searchFacts">,
  draft: FactEventDraftV1,
) {
  return service.record(compile(projection, draft));
}
export function compileDecision(projection: TaskProjection, draft: DecisionEventDraftV1) {
  const read = projection.readDecision(draft.decisionId),
    current = read.decision,
    path = `decisions/decision-${draft.decisionId}/decision.md`,
    document = projection.readDocument(path).document,
    relations = projection
      .readDecisionGraph()
      .edges.filter((edge) => edge.ownerRef === `decision/${draft.decisionId}`)
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
      })),
    compiled = compileDecisionWrite({
      event: draft,
      currentDecision: current,
      currentRelations: relations,
      currentDocument: document,
    }),
    graphMutation = [
      "decision_proposed",
      "decision_accepted",
      "decision_retired",
      "decision_claim_declared",
      "decision_claim_fulfillment_declared",
      "decision_related",
      "decision_relation_retired",
    ].includes(draft.type);
  assert.equal(compiled.event.payload.baseDocumentSha256, document?.blobSha256 ?? null);
  assert.equal(compiled.event.payload.decisionDocumentClaim.sha256, compiled.blobs[0].sha256);
  assert.equal(compiled.event.payload.decisionDocumentClaim.path, path);
  assert.equal(
    compiled.plan.targets.some(
      (target) => target.kind === "projection_invalidation" && target.projection === "relation-graph/v1",
    ),
    graphMutation,
  );
  return compiled;
}
export function recordDecision(
  service: ReturnType<typeof makeDecisionService>,
  projection: TaskProjection,
  draft: DecisionEventDraftV1,
) {
  const result = service.record(compileDecision(projection, draft));
  assert.equal(result.decision.workspaceRevision, result.revision);
  assert.equal(projection.readDocument(result.path).document?.workspaceRevision, result.revision);
  return result;
}
export function factBacklog(count: number, taskId: string) {
  const events: FactEventV1[] = [],
    contents = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    const compiled = compileFactWrite({
      event: factEvent(index + 1, taskId, `F-${String(index + 1).padStart(8, "0")}`),
    });
    events.push(compiled.event);
    contents.set(compiled.event.payload.factsDocumentClaim.sha256, Buffer.from(compiled.body));
  }
  return { events, contents };
}
export function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
export function bundle(event: CanonicalEventV1): CanonicalWriteBundle {
  if (!isTaskEvent(event)) throw new Error("fixture requires a task event");
  return { event, plan: taskLifecycleWritePlan(event), blobs: [] };
}

export function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
  }).trim();
}
export function memoryFactStore(initial: ReturnType<typeof factBacklog>): CanonicalEventStore {
  const events = [...initial.events],
    contents = new Map(initial.contents);
  return {
    readHead: () => (events.length ? { revision: events.length } : null),
    readBatch: (cursor: string | null, maxItems: number) => {
      const start = cursor === null ? 0 : Number(cursor),
        batch = events.slice(start, start + maxItems),
        next = start + batch.length;
      return {
        sourceRevision: events.length,
        events: batch,
        cursor: String(next),
        done: next === events.length,
        accessedItems: batch.length,
        prefetchContent: (requested: readonly CanonicalEventV1[]) =>
          new Map(
            requested.flatMap((event) => {
              const claim = (event as FactEventV1).payload.factsDocumentClaim,
                body = contents.get(claim.sha256) ?? null;
              if (body === null || body.byteLength !== claim.size)
                throw new Error(`fixture content ${claim.sha256} is not exact`);
              return [[claim.sha256, body] as const];
            }),
          ),
      };
    },
    readContentBlob: (sha256: string) => contents.get(sha256) ?? null,
    readEvent: (opId: string) => events.find((event) => event.opId === opId) ?? null,
    append: (bundleValue: CanonicalWriteBundle) => {
      const event = bundleValue.event as FactEventV1;
      events.push(event);
      for (const blob of bundleValue.blobs) contents.set(blob.sha256, Buffer.from(blob.body));
      return {
        revision: event.workspaceRevision,
        commitSha: { sha: "0".repeat(40) },
      };
    },
  } as unknown as CanonicalEventStore;
}
