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
  });
});

test("artifact-only submissions have no code facts", () => {
  assert.deepEqual(readSubmissionFacts({ ...base, commitSha: null, artifacts: [] }), {
    kind: "artifact-only",
    changedFiles: [],
    productionDelta: null,
  });
});
