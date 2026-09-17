// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { renderDecisionDocument, type DecisionDocumentState } from "../../src/domain/decision-event.ts";
import {
  assertEntityDocumentEventWritePlan,
  compileEntityDocumentRematerialization,
  isEntityDocumentEvent,
  validateCurrentEntityDocumentEvent,
  validateEntityDocumentEvent,
} from "../../src/domain/entity-document-event.ts";
import type { EntityRelationRecord } from "../../src/domain/entity-relation.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { validateCurrentCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";

const actor = { principal: { personId: "person-fixture" }, executor: { kind: "agent" as const, id: "codex" } },
  baseInput = {
    actor,
    source: "local" as const,
    occurredAt: "2026-09-20T00:00:00.000Z",
    opId: "op-rematerialize-fixture",
    workspaceRevision: 7,
    rationale: "rematerialize current entity documents",
    entityRefs: ["decision/dec_FIXTURE"],
  },
  decisionUpdate = (body: string) => ({
    path: "decisions/decision-dec_FIXTURE/decision.md",
    policyId: "markdown-body-replaceable/v1",
    mediaType: "text/markdown" as const,
    body,
  });

test("entity document rematerialization compiles a validated event and exact write plan", () => {
  const body = "# Decision\n\ncurrent prose\n",
    compiled = compileEntityDocumentRematerialization({ ...baseInput, updates: [decisionUpdate(body)] });
  assert.notEqual(compiled, null);
  assert.equal(isEntityDocumentEvent(compiled!.event), true);
  assert.deepEqual(validateEntityDocumentEvent(compiled!.event), []);
  assert.deepEqual(validateCurrentEntityDocumentEvent(compiled!.event), []);
  assertEntityDocumentEventWritePlan(compiled!.event, compiled!.plan);
  assert.deepEqual(
    compiled!.plan.targets.map(({ kind }) => kind),
    ["event_file", "event_head", "authored_file", "content_blob", "projection_invalidation"],
  );
  const claim = compiled!.event.payload.documentClaims[0]!;
  assert.equal(claim.sha256, sha256Text(body));
  assert.equal(compiled!.blobs[0]!.body, body);
});

test("identical content claims share one content blob target and one blob", () => {
  const body = "# Same bytes\n",
    otherPath = "decisions/decision-dec_OTHER/decision.md",
    compiled = compileEntityDocumentRematerialization({
      ...baseInput,
      entityRefs: ["decision/dec_FIXTURE", "decision/dec_OTHER"],
      updates: [decisionUpdate(body), { ...decisionUpdate(body), path: otherPath }],
    });
  assert.equal(compiled!.event.payload.documentClaims.length, 2);
  assert.equal(compiled!.blobs.length, 1);
  assert.equal(
    compiled!.plan.targets.filter(({ kind }) => kind === "content_blob").length,
    1,
    "two claims on one blob must not double the content write",
  );
  assert.equal(compiled!.plan.targets.filter(({ kind }) => kind === "authored_file").length, 2);
});

test("empty and duplicate-path updates are rejected before any write", () => {
  assert.throws(
    () => compileEntityDocumentRematerialization({ ...baseInput, updates: [] }),
    /requires one changed document/u,
  );
  assert.throws(
    () =>
      compileEntityDocumentRematerialization({
        ...baseInput,
        updates: [decisionUpdate("# A\n"), decisionUpdate("# B\n")],
      }),
    /unique paths/u,
  );
});

test("the strict current validator rejects extra payload fields while the fixture stays readable", () => {
  const compiled = compileEntityDocumentRematerialization({ ...baseInput, updates: [decisionUpdate("# D\n")] })!,
    widened = { ...compiled.event, payload: { ...compiled.event.payload, futureField: true } };
  assert.deepEqual(validateEntityDocumentEvent(widened), []);
  assert.notEqual(validateCurrentEntityDocumentEvent(widened).length, 0);
  assert.notEqual(validateCurrentCanonicalEvent(widened).length, 0);
  const fixture = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "../../fixtures/canonical-events/entity-document-event-v1/accepted.json"),
      "utf8",
    ),
  );
  assert.deepEqual(validateCurrentEntityDocumentEvent(fixture), []);
  assert.deepEqual(validateCurrentCanonicalEvent(fixture), []);
});

const relation = (overrides: Partial<EntityRelationRecord>): EntityRelationRecord => ({
  relation_id: "rel_fixture",
  source: "decision/dec_FIXTURE/C1",
  target: "fact/F-00000000",
  type: "evidenced-by",
  strength: "strong",
  direction: "directed",
  origin: "declared",
  rationale: "fixture edge",
  state: "active",
  ...overrides,
});

const decisionState = (relations: readonly EntityRelationRecord[]): DecisionDocumentState => ({
  decisionId: "dec_FIXTURE",
  state: "in_effect",
  title: "Fixture Decision",
  question: "Does the graph block link?",
  riskTier: "medium",
  urgency: "low",
  vertical: "software/coding",
  preset: "standard-task",
  decisionClass: "ordinary",
  appliesTo: { modules: [], productLines: [] },
  proposer: actor,
  arbiter: null,
  proposedAt: "2026-09-01T00:00:00.000Z",
  decidedAt: null,
  workspaceRevision: 3,
  chosen: [{ id: "CH1", text: "Ship links" }],
  rejected: [],
  claims: [{ id: "C1", text: "Links resolve.", loadBearing: true, fulfillment: null }],
  relations,
  provenance: [],
  judgmentConsents: [],
});

test("the causal graph block renders grouped, deterministic, relative links at the document tail", () => {
  const outgoing = [
      relation({
        relation_id: "rel_derives",
        source: "decision/dec_FIXTURE/CH1",
        target: "task/task_fixture",
        type: "derives",
      }),
      relation({ relation_id: "rel_evidence" }),
    ],
    incoming = [
      relation({
        relation_id: "rel_incoming",
        source: "fact/F-11111111",
        target: "decision/dec_FIXTURE",
        type: "supersedes-fact",
      }),
      relation({
        relation_id: "rel_peer",
        source: "decision/dec_PEER",
        target: "decision/dec_FIXTURE",
        type: "relates",
      }),
    ],
    resolveLink = (ref: string) =>
      ref.startsWith("decision/")
        ? { path: `decisions/decision-${ref.slice("decision/".length).split("/")[0]}/decision.md`, label: ref }
        : ref.startsWith("fact/")
          ? { path: `facts/${ref.slice("fact/".length).split("/")[0]}.md`, label: `statement of ${ref}` }
          : ref.startsWith("task/")
            ? { path: `tasks/${ref.slice("task/".length)}/INDEX.md`, label: `title of ${ref}` }
            : null,
    body = renderDecisionDocument(
      decisionState(outgoing),
      "---\nx: 1\n---\n\n# Fixture\n\nprose.\n",
      undefined,
      null,
      incoming,
      resolveLink,
    );
  assert.match(
    body,
    /### 支撑事实 \(Evidenced by\)\n\n- \[F-00000000\]\(\.\.\/\.\.\/facts\/F-00000000\.md\): statement of fact\/F-00000000\n/u,
  );
  assert.match(
    body,
    /### 派生任务 \(Derives\)\n\n- \[task_fixture\]\(\.\.\/\.\.\/tasks\/task_fixture\/INDEX\.md\): title of task\/task_fixture\n/u,
  );
  assert.match(
    body,
    /### 演进与关联决策 \(Related Decisions\)\n\n- \[dec_PEER\]\(\.\.\/decision-dec_PEER\/decision\.md\): decision\/dec_PEER \(incoming relates\)\n/u,
  );
  assert.match(
    body,
    /### 反向关联 \(Incoming\)\n\n- \[F-11111111\]\(\.\.\/\.\.\/facts\/F-11111111\.md\): statement of fact\/F-11111111 \(incoming supersedes-fact\)\n/u,
  );
  assert.ok(body.endsWith("<!-- harness:relation-neighborhood:end -->\n"));
  assert.ok(body.indexOf("prose.") < body.indexOf("<!-- harness:relation-neighborhood:start -->"));
  // Rendering the same cut twice is byte-for-byte identical.
  assert.equal(
    body,
    renderDecisionDocument(
      decisionState(outgoing),
      "---\nx: 1\n---\n\n# Fixture\n\nprose.\n",
      undefined,
      null,
      incoming,
      resolveLink,
    ),
  );
});

test("unresolved endpoints render as plain refs without fabricating links", () => {
  const body = renderDecisionDocument(
    decisionState([relation({ target: "module/kernel", type: "relates" })]),
    null,
    "# Fixture\n",
    null,
    [],
    () => null,
  );
  assert.match(body, /### 其他关联 \(Other\)\n\n- module\/kernel: "fixture edge" \(outgoing relates\)\n/u);
});
