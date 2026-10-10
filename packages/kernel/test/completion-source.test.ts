// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { Schema } from "effect";
import { VerticalCompletionDeclarationSchema } from "../src/schemas/completion-source.ts";
import { effectiveCloseoutGates } from "../src/domain/settings-closeout.ts";
import { resolveCompletionContract } from "../src/domain/completion-contract.ts";
import { completionPredicateIssues } from "../src/schemas/completion-predicate.ts";
import { claimGateRun, currentGateRun, settleGateRun } from "../src/domain/gate-run.ts";
import type { ExecutionV1 } from "../src/domain/execution.ts";

const declaration = {
  sources: {
    "research/anchor-check": {
      kind: "command" as const,
      entrypoint: "experiment-checks/check-anchors",
      predicateType: "research/version-pinned/v1",
      resultSchema: {
        type: "object",
        additionalProperties: false,
        required: ["seed"],
        properties: { seed: { type: "integer" } },
      },
    },
  },
  gates: {
    "version-pinned": {
      source: "research/anchor-check",
      appliesTo: "artifacts" as const,
      subjects: "all-artifacts" as const,
      bindings: { seed: { artifact: "artifacts/experiment.json", pointer: "/seed" } },
    },
  },
  closeoutDefaults: { codeDoc: false },
};
const digest = `sha256:${"a".repeat(64)}`;
const resolved = resolveCompletionContract(
  ["version-pinned"],
  { gates: [], ci: { workflows: [] } },
  { digest, completion: declaration },
);
assert.equal(resolved.ok, true);
if (!resolved.ok) throw new Error(resolved.message);
const requirement = resolved.contract.gates[0]!;
const anchor = { path: "artifacts/experiment.json", revision: 7, blobSha256: "b".repeat(64) };
const result = {
  result: "pass" as const,
  subjects: [anchor],
  predicateType: "research/version-pinned/v1",
  predicate: { seed: 42 },
  diagnostic: "",
};

test("source IDs are declarations and arbitrary additional IDs resolve without kernel registration", () => {
  assert.doesNotThrow(() => Schema.decodeUnknownSync(VerticalCompletionDeclarationSchema)(declaration));
  for (const id of ["lab/another", "chemistry/protocol-3"]) {
    const completion = {
      ...declaration,
      sources: { [id]: declaration.sources["research/anchor-check"] },
      gates: { "version-pinned": { ...declaration.gates["version-pinned"], source: id } },
    };
    const cut = resolveCompletionContract(
      ["version-pinned"],
      { gates: [], ci: { workflows: [] } },
      { digest, completion },
    );
    assert.equal(cut.ok && cut.contract.gates[0]!.witness.adapterId, id);
  }
});

test("source admission rejects invalid schemas, external references, and asynchronous schemas", () => {
  for (const resultSchema of [
    { type: "unknown" },
    { $ref: "https://example.invalid/schema" },
    { $async: true, type: "object" },
  ])
    assert.throws(() =>
      Schema.decodeUnknownSync(VerticalCompletionDeclarationSchema)({
        ...declaration,
        sources: { source: { ...declaration.sources["research/anchor-check"], resultSchema } },
      }),
    );
});

test("missing seed has a field path; mismatched metadata and substituted subjects never pass", () => {
  assert.deepEqual(
    completionPredicateIssues(requirement, result, [anchor], () => ({ seed: 42 })),
    [],
  );
  assert.match(
    completionPredicateIssues(requirement, { ...result, predicate: {} }, [anchor], () => ({})).join(";"),
    /gates\.version-pinned\.predicate\.seed/,
  );
  assert.match(
    completionPredicateIssues(requirement, result, [anchor], () => ({ seed: 17 })).join(";"),
    /does not equal/,
  );
  assert.match(
    completionPredicateIssues(requirement, { ...result, subjects: [] }, [anchor], () => ({ seed: 42 })).join(";"),
    /subjects/,
  );
});

const actor = { principal: { personId: "owner" }, executor: { kind: "agent" as const, id: "center-witness" } };
const execution: ExecutionV1 = {
  schema: "execution/v1",
  taskId: "task_example",
  executionId: "exe_example",
  nodeId: "implementation",
  iteration: 0,
  state: "submitted",
  actor,
  claimedAt: "2026-10-10T00:00:00Z",
  submittedAt: "2026-10-10T00:00:00Z",
  closedAt: null,
  gateRuns: [],
  submission: {
    commitSha: null,
    artifacts: [anchor],
    completionClaim: "experiment delivered",
    deliverables: [],
    outputs: [],
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    completionContract: resolved.contract,
  },
};

test("a cut has one claimed run and a terminal result cannot be replaced by arrival order", () => {
  for (const result of ["pass", "fail"] as const) {
    const run = claimGateRun({
      expiresAt: "2026-10-10T01:00:00Z",
      execution,
      repoId: "repo",
      requirement,
      runId: "run_a",
      claimFence: 8,
      actor,
      occurredAt: "2026-10-10T00:00:01Z",
    });
    const claimed = { ...execution, gateRuns: [run] };
    assert.throws(
      () =>
        claimGateRun({
          expiresAt: "2026-10-10T01:00:00Z",
          execution: claimed,
          repoId: "repo",
          requirement,
          runId: "run_b",
          claimFence: 9,
          actor,
          occurredAt: "2026-10-10T00:00:02Z",
        }),
      /already has current run/,
    );
    const request = {
      execution: claimed,
      runId: run.runId,
      claimFence: run.claimFence,
      actor,
      occurredAt: "2026-10-10T00:00:03Z",
      outcome: { availability: "available" as const, result, diagnostic: result },
    };
    assert.throws(() => settleGateRun({ ...request, claimFence: 9 }), /current submission run and fence/);
    assert.throws(() => settleGateRun({ ...request, occurredAt: "2026-10-10T01:00:00Z" }), /expired/);
    const settled = settleGateRun(request),
      terminal = { ...claimed, gateRuns: [settled] };
    assert.throws(
      () =>
        settleGateRun({
          ...request,
          execution: terminal,
          outcome: { ...request.outcome, result: result === "pass" ? "fail" : "pass" },
        }),
      /already terminal/,
    );
    assert.equal(currentGateRun(terminal, requirement.gateId)?.result, result);
    const amended = { ...claimed, submission: { ...claimed.submission!, completionClaim: "amended" } };
    assert.throws(() => settleGateRun({ ...request, execution: amended }), /current submission run and fence/);
  }
});

test("domain defaults are reachable only when the repository left a value unset, then the cut freezes them", () => {
  const defaults = { review: true, consent: true, factDisposition: true, codeDoc: false };
  assert.deepEqual(effectiveCloseoutGates({}, [], undefined, defaults), { ...defaults, fact: true });
  assert.equal(effectiveCloseoutGates({ profile: "standard" }, [], undefined, defaults).review, false);
  assert.equal(effectiveCloseoutGates({ overrides: { consent: false } }, [], undefined, defaults).consent, false);
  assert.equal(effectiveCloseoutGates({ profile: "strict" }, [], { review: false }, defaults).review, false);
  assert.equal(effectiveCloseoutGates({}, ["code-doc-reconciliation"], { codeDoc: false }, defaults).codeDoc, true);
  assert.equal(effectiveCloseoutGates({}, [], { fact: false }, defaults).fact, false);
  const frozen = resolveCompletionContract(
    [],
    { gates: [], ci: { workflows: [] } },
    { digest, completion: { ...declaration, closeoutDefaults: defaults } },
  );
  assert.equal(frozen.ok && frozen.contract.closeoutGates.consent, true);
});
