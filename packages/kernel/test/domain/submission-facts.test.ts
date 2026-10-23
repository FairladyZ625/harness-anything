// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { SubmissionV1 } from "../../src/domain/execution.ts";
import { readSubmissionFacts } from "../../src/domain/submission-facts.ts";

const base = {
  completionClaim: "Delivered the change.",
  deliverables: ["packages/kernel/new.ts", "README.md"],
  outputs: ["Deleted-Production-Paths: packages/kernel/old.ts", "other output"],
  verificationNotes: [],
  knownGaps: [],
  residualRisks: [],
  completionContract: {} as SubmissionV1["completionContract"],
} as const;

test("frozen submission facts keep the full changed path set and delta", () => {
  const facts = readSubmissionFacts({
    ...base,
    commitSha: "a".repeat(40),
    changedFiles: ["README.md", "packages/kernel/new.ts", "packages/kernel/old.ts"],
    productionDelta: {
      baseSha: "b".repeat(40),
      added: 2,
      deleted: 1,
      changed: [],
      unclassified: [],
    },
  });
  assert.deepEqual(facts, {
    kind: "frozen",
    changedFiles: ["README.md", "packages/kernel/new.ts", "packages/kernel/old.ts"],
    productionDelta: {
      baseSha: "b".repeat(40),
      added: 2,
      deleted: 1,
      changed: [],
      unclassified: [],
    },
  });
});

test("legacy code submissions expose stored deliverables and deleted paths without inventing a delta", () => {
  const facts = readSubmissionFacts({ ...base, commitSha: "a".repeat(40) });
  assert.deepEqual(facts, {
    kind: "legacy",
    changedFiles: ["README.md", "packages/kernel/new.ts", "packages/kernel/old.ts"],
    productionDelta: null,
    pathEvidence: "complete",
  });
});

test("legacy free-form prose is excluded and marks the manifest incomplete", () => {
  const facts = readSubmissionFacts({
    ...base,
    commitSha: "a".repeat(40),
    deliverables: [
      "merge commit 8ba0c5978 on main",
      "none",
      "artifacts/design/10-table-shape.md(489->330 行,r3)",
      "packages/kernel/src/real.ts",
    ],
  });
  assert.deepEqual(facts, {
    kind: "legacy",
    changedFiles: ["packages/kernel/old.ts", "packages/kernel/src/real.ts"],
    productionDelta: null,
    pathEvidence: "partial",
  });
});

test("legacy manifests without trustworthy paths are marked unavailable", () => {
  const facts = readSubmissionFacts({
    ...base,
    commitSha: "a".repeat(40),
    deliverables: ["merge commit 8ba0c5978 on main", "none"],
    outputs: [],
  });
  assert.deepEqual(facts, {
    kind: "legacy",
    changedFiles: [],
    productionDelta: null,
    pathEvidence: "unavailable",
  });
});

test("legacy artifact-only outputs do not make an empty code manifest complete", () => {
  const facts = readSubmissionFacts({
    ...base,
    commitSha: "a".repeat(40),
    deliverables: [],
    outputs: ["Artifact-Anchor: tasks/task-old/artifacts/report.md@12"],
  });
  assert.deepEqual(facts, {
    kind: "legacy",
    changedFiles: [],
    productionDelta: null,
    pathEvidence: "unavailable",
  });
});

test("artifact-only submissions have no code facts", () => {
  assert.deepEqual(readSubmissionFacts({ ...base, commitSha: null, artifacts: [] }), {
    kind: "artifact-only",
    changedFiles: [],
    productionDelta: null,
  });
});
