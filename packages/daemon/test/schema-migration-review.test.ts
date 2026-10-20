// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionV1, SubmissionV1 } from "@harness-anything/kernel";
import {
  persistedShapeSurfaceHits,
  schemaMigrationReviewPrompt,
  schemaReviewDispatchKey,
} from "../src/schema-migration-review.ts";
import { reviewDispatchKey } from "../src/task-review-dispatch.ts";

const submission = (deliverables: readonly string[], deleted: readonly string[] = []): SubmissionV1 =>
  ({
    completionClaim: "claim",
    deliverables,
    outputs: deleted.map((target) => `Deleted-Production-Paths: ${target}`),
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    commitSha: "0".repeat(40),
    completionContract: {},
  }) as unknown as SubmissionV1;

/**
 * Replay of the five 2026-10-20 incidents: each entry is a real subset of that delivery's
 * actual diff paths (commit named per incident; re-derive with `git show <sha> --name-only`).
 * The criterion is an existential intersection, so a hit on the real subset proves a hit on
 * the full real manifest: hits are monotone under adding paths.
 */
const incidents = [
  {
    name: "#3805 closeoutOverrides.fact (0603933faa)",
    deliverables: [
      "packages/daemon/src/fact-observed-commit.ts",
      "packages/kernel/src/domain/completion-readiness.ts",
      "packages/kernel/src/domain/settings-closeout.ts",
      "packages/kernel/src/domain/fact-event.ts",
      "packages/preset/assets/software-coding/presets/standard-task/preset.json",
      "packages/gui/src/renderer/entity-docs.ts",
    ],
    deleted: [],
    expected: "packages/kernel/src/domain/completion-readiness.ts",
  },
  {
    name: "88eafa8a schedule ciObserve retirement",
    deliverables: [
      "packages/cli/src/cli-runtime-command.ts",
      "packages/kernel/src/domain/schedule.ts",
      "packages/kernel/src/domain/schedule-action-contract.ts",
      "packages/kernel/src/store/event-shape-migration.ts",
    ],
    deleted: ["packages/kernel/src/domain/ci-rerun-statistics.ts"],
    expected: "packages/kernel/src/domain/schedule.ts",
  },
  {
    name: "#3803 settings.gates.ci + vertical sources (3ba54a2ce)",
    deliverables: [
      "packages/kernel/src/domain/settings.ts",
      "packages/kernel/src/domain/completion-contract.ts",
      "packages/kernel/src/schemas/completion-source.ts",
      "packages/preset/assets/software-coding/vertical.json",
      "docs-release/README.zh-CN.md",
    ],
    deleted: [],
    expected: "packages/kernel/src/domain/settings.ts",
  },
  {
    name: "e08dd0ccc preset snapshot normalization",
    deliverables: [
      "packages/kernel/src/domain/completion-contract.ts",
      "packages/kernel/src/projection/historical-event-normalization.ts",
      "packages/kernel/src/store/attach-migrations.ts",
      "packages/kernel/test/store/attach-migrations.test.ts",
    ],
    deleted: [],
    expected: "packages/kernel/src/projection/historical-event-normalization.ts",
  },
] as const;

for (const incident of incidents) {
  test(`persisted-shape routing hits incident ${incident.name}`, () => {
    const hits = persistedShapeSurfaceHits(submission(incident.deliverables, incident.deleted));
    assert.ok(hits.length > 0, `expected at least one registry hit, got: ${hits.join(", ")}`);
    assert.ok(hits.includes(incident.expected), `expected ${incident.expected} among hits: ${hits.join(", ")}`);
    assert.ok(
      hits.includes("packages/kernel/src/domain/ci-rerun-statistics.ts") || incident.deleted.length === 0,
      "deleted persisted-shape paths ride the Deleted-Production-Paths output lines",
    );
  });
}

test("a delivery outside the persisted-shape surfaces dispatches no schema-migration lane", () => {
  assert.deepEqual(
    persistedShapeSurfaceHits(
      submission([
        "README.md",
        "packages/daemon/src/task-review-dispatch.ts",
        "packages/gui/src/renderer/App.tsx",
        "docs-release/data-format-migrations.md",
        "tools/gates/production-delta.mjs",
      ]),
    ),
    [],
  );
  assert.deepEqual(persistedShapeSurfaceHits(null), []);
});

test("the canonical-event compatibility gate file is a registry hit by exact path", () => {
  assert.deepEqual(persistedShapeSurfaceHits(submission(["tools/gates/canonical-event-compat.mjs"])), [
    "tools/gates/canonical-event-compat.mjs",
  ]);
  // Near misses stay silent: the registry is path-exact, not a keyword guess.
  assert.deepEqual(
    persistedShapeSurfaceHits(submission(["tools/gates/canonical-event-compat.test.mjs", "packages/kernel/README.md"])),
    [],
  );
});

test("the schema lane keys off the same cut with its own lane segment", () => {
  const execution = {
    executionId: "execution-schema-lane",
    iteration: 2,
    submission: submission(["packages/kernel/src/domain/settings.ts"]),
  } as unknown as ExecutionV1;
  const key = schemaReviewDispatchKey("task-schema-lane", execution);
  assert.match(key, /^task-review-schema:task-schema-lane:execution-schema-lane:2:sha256:[0-9a-f]{64}$/u);
  assert.notEqual(key, reviewDispatchKey("task-schema-lane", execution));
});

test("the schema-migration prompt names the routing evidence and fixes the registration identity", () => {
  const execution = {
      executionId: "execution-schema-prompt",
      iteration: 1,
      submission: submission(["packages/kernel/src/domain/settings.ts"]),
    } as unknown as ExecutionV1,
    prompt = schemaMigrationReviewPrompt({
      taskId: "task-schema-prompt",
      packagePath: "tasks/task-schema-prompt-pkg",
      dispatchId: "dispatch_prompt01",
      execution,
      hits: persistedShapeSurfaceHits(execution.submission),
    });
  assert.match(prompt, /schema-migration lane/u);
  assert.ok(prompt.includes("- packages/kernel/src/domain/settings.ts"), prompt);
  assert.ok(prompt.includes("attach-migrations.ts"), "the prompt names the one upgrade entry");
  assert.ok(prompt.includes("changes_requested"), "the prompt states the missing-part verdict rule");
  assert.ok(
    prompt.includes("--review-id review-dispatch_prompt01") &&
      prompt.includes("--from-file harness/tasks/task-schema-prompt-pkg/artifacts/reports/dispatch_prompt01.json"),
    "registration identity is fixed by the dispatch",
  );
});
