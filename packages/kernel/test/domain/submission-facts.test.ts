// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { SubmissionV1 } from "../../src/domain/execution.ts";
import {
  CLOSEOUT_FACTS_END,
  CLOSEOUT_FACTS_START,
  SUBMISSION_FACTS_END,
  SUBMISSION_FACTS_START,
  readSubmissionFacts,
  renderCloseoutSubmissionFacts,
  renderSubmissionFacts,
  replaceSubmissionFacts,
  stripCloseoutFactsRegion,
  upsertCloseoutSubmissionFacts,
} from "../../src/domain/submission-facts.ts";
import { submissionDigest } from "../../src/domain/submission-digest.ts";
import { renderTaskPrBody } from "../../src/domain/task-pr-body.ts";
import {
  missingChineseCloseoutSections,
  submissionFromCloseout,
} from "../../src/domain/transition-document-readiness.ts";

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

test("the shared facts renderer names the frozen commit, base, and production delta", () => {
  const submission: SubmissionV1 = {
      ...base,
      commitSha: "a".repeat(40),
      changedFiles: ["packages/kernel/new.ts"],
      productionDelta: {
        baseSha: "b".repeat(40),
        added: 2,
        deleted: 1,
        changed: [],
        unclassified: [],
      },
    },
    block = renderSubmissionFacts(submission);
  assert.match(block, /^## Delivery Facts$/mu);
  assert.match(block, new RegExp(`Delivery commit: \\x60${"a".repeat(40)}\\x60`, "u"));
  assert.match(block, new RegExp(`Merge base: \\x60${"b".repeat(40)}\\x60`, "u"));
  assert.match(block, /Production delta: \+2\/-1 \(net \+1\)/u);
});

test("the facts replacement keeps authored prose and replaces only the marker region", () => {
  const body = `Intro.\n\n${SUBMISSION_FACTS_START}\nold facts\n${SUBMISSION_FACTS_END}\n\nOutro.`,
    replaced = replaceSubmissionFacts(body, "new facts");
  assert.equal(replaced, `Intro.\n\n${SUBMISSION_FACTS_START}\nnew facts\n${SUBMISSION_FACTS_END}\n\nOutro.`);
  assert.equal(replaceSubmissionFacts("no markers", "new facts"), null);
  assert.equal(
    replaceSubmissionFacts(`${SUBMISSION_FACTS_START}${SUBMISSION_FACTS_START}${SUBMISSION_FACTS_END}`, "x"),
    null,
  );
});

test("closeout submission facts upsert is idempotent, replaces stale cuts, and preserves authored prose and inline mentions", () => {
  const cutA: SubmissionV1 = {
      ...base,
      commitSha: "a".repeat(40),
      changedFiles: ["packages/kernel/new.ts"],
      productionDelta: {
        baseSha: "1".repeat(40),
        added: 5,
        deleted: 2,
        changed: [],
        unclassified: [],
      },
    },
    cutB: SubmissionV1 = {
      ...base,
      commitSha: "b".repeat(40),
      changedFiles: ["packages/kernel/new.ts", "packages/kernel/updated.ts"],
      productionDelta: {
        baseSha: "2".repeat(40),
        added: 12,
        deleted: 3,
        changed: [],
        unclassified: [],
      },
    },
    authored = [
      "# Closeout",
      "",
      "## Summary",
      "",
      `Refreshes \`${CLOSEOUT_FACTS_START}\` / \`${CLOSEOUT_FACTS_END}\` automatically.`,
      "",
      "```markdown",
      CLOSEOUT_FACTS_START,
      "example block inside fence stays untouched",
      CLOSEOUT_FACTS_END,
      "```",
      "",
      "## Verification",
      "",
      "- Targeted tests passed.",
      "",
      "## Residual Risk",
      "",
      "- None.",
      "",
      "## 摘要",
      "",
      "自动维护交付事实段。",
      "",
      "## 验证",
      "",
      "- 定向测试通过。",
      "",
    ].join("\n");

  const withA = upsertCloseoutSubmissionFacts(authored, cutA);
  assert.equal(upsertCloseoutSubmissionFacts(withA, cutA), withA, "repeat upsert is byte-identical");
  assert.ok(withA.includes(renderCloseoutSubmissionFacts(cutA)));
  assert.ok(withA.includes(`Submission digest: \`${submissionDigest(cutA)}\``));
  assert.ok(withA.includes("example block inside fence stays untouched"));
  assert.equal(stripCloseoutFactsRegion(withA), authored);

  const withB = upsertCloseoutSubmissionFacts(withA, cutB);
  assert.ok(withB.includes(`Delivery commit: \`${"b".repeat(40)}\``));
  assert.ok(withB.includes(`Merge base: \`${"2".repeat(40)}\``));
  assert.ok(withB.includes("Production delta: +12/-3 (net +9)."));
  assert.ok(withB.includes(`Submission digest: \`${submissionDigest(cutB)}\``));
  assert.ok(!withB.includes("a".repeat(40)), "stale commit SHA is replaced");
  assert.equal(stripCloseoutFactsRegion(withB), authored, "authored prose remains byte-identical after refresh");

  // Prose readers and PR body rendering stay invariant whether or not the managed block is present.
  const cutMeta = {
    commitSha: cutB.commitSha,
    deliverables: cutB.deliverables,
    outputs: cutB.outputs,
    completionContract: cutB.completionContract,
  };
  assert.deepEqual(submissionFromCloseout(withB, cutMeta), submissionFromCloseout(authored, cutMeta));
  assert.deepEqual(missingChineseCloseoutSections(withB), []);
  const template = [
    "## Summary",
    "",
    "## What Changed",
    "",
    SUBMISSION_FACTS_START,
    SUBMISSION_FACTS_END,
    "",
    "## Verification",
    "",
    "## Residual Risk",
    "",
  ].join("\n");
  assert.equal(
    renderTaskPrBody({
      taskId: "task_0123456789abcdef0123456789",
      submission: cutB,
      profileId: "baseline",
      decisionAuthority: null,
      template,
      closeout: withB,
    }),
    renderTaskPrBody({
      taskId: "task_0123456789abcdef0123456789",
      submission: cutB,
      profileId: "baseline",
      decisionAuthority: null,
      template,
      closeout: authored,
    }),
  );

  // Malformed standalone markers fail closed.
  assert.throws(
    () => upsertCloseoutSubmissionFacts(`${authored}\n${CLOSEOUT_FACTS_START}\n`, cutA),
    /at most one ordered closeout-facts marker pair/u,
  );
});
