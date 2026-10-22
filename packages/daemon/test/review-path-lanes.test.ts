// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readSubmissionFacts, type ExecutionV1, type SubmissionV1 } from "@harness-anything/kernel";
import { reviewLaneDispatchKey, reviewLaneHits, reviewLanePrompt, reviewPathLanes } from "../src/review-path-lanes.ts";
import { reviewFindingScopePrompt } from "../src/review-prompt-guidance.ts";
import { reviewDispatchKey } from "../src/task-review-dispatch.ts";

const submission = (
  deliverables: readonly string[],
  deleted: readonly string[] = [],
  changedFiles?: readonly string[],
): SubmissionV1 =>
  ({
    completionClaim: "claim",
    deliverables,
    ...(changedFiles === undefined ? {} : { changedFiles }),
    outputs: deleted.map((target) => `Deleted-Production-Paths: ${target}`),
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    commitSha: "0".repeat(40),
    completionContract: {},
  }) as unknown as SubmissionV1;

test("settings entries group into one lane per agent, splitting directory prefixes from exact files", () => {
  assert.deepEqual(
    reviewPathLanes([
      "data-migration packages/kernel/src/domain/",
      "data-migration packages/kernel/src/store/",
      "data-migration tools/gates/canonical-event-compat.mjs",
      "gui-reviewer packages/gui/src/",
      "data-migration packages/kernel/src/domain/",
      "malformed-entry-without-a-space",
      "x ",
      " ",
    ]),
    [
      {
        agentId: "data-migration",
        prefixes: ["packages/kernel/src/domain/", "packages/kernel/src/store/"],
        files: ["tools/gates/canonical-event-compat.mjs"],
      },
      { agentId: "gui-reviewer", prefixes: ["packages/gui/src/"], files: [] },
    ],
  );
  assert.deepEqual(reviewPathLanes([]), []);
  assert.deepEqual(reviewPathLanes(undefined), []);
});

test("a cut hits a lane through its frozen deliverables or its deleted production paths", () => {
  const lanes = reviewPathLanes([
    "data-migration packages/kernel/src/domain/",
    "data-migration tools/gates/canonical-event-compat.mjs",
    "gui-reviewer packages/gui/src/",
  ]);
  const hits = reviewLaneHits(
    submission(
      ["packages/kernel/src/domain/settings.ts", "packages/gui/src/App.tsx", "README.md"],
      ["packages/kernel/src/domain/retired.ts"],
    ),
    lanes,
  );
  assert.deepEqual(
    [...hits],
    [
      ["data-migration", ["packages/kernel/src/domain/retired.ts", "packages/kernel/src/domain/settings.ts"]],
      ["gui-reviewer", ["packages/gui/src/App.tsx"]],
    ],
  );
});

test("new cuts route deleted non-production paths from the complete frozen file list", () => {
  const hits = reviewLaneHits(
    submission(["README.md"], [], ["README.md", "packages/kernel/src/domain/retired.test.ts"]),
    reviewPathLanes(["data-migration packages/kernel/src/domain/"]),
  );
  assert.deepEqual([...hits], [["data-migration", ["packages/kernel/src/domain/retired.test.ts"]]]);
});

test("legacy lane routing uses the same normalized paths exposed by submission facts", () => {
  const cut = submission(
      ["README.md", "packages/kernel/src/domain/settings.ts"],
      ["packages/kernel/src/domain/old.ts"],
    ),
    facts = readSubmissionFacts(cut),
    hits = reviewLaneHits(cut, reviewPathLanes(["data-migration packages/kernel/src/domain/"]));
  assert.equal(facts.kind, "legacy");
  assert.deepEqual(facts.changedFiles, [
    "README.md",
    "packages/kernel/src/domain/old.ts",
    "packages/kernel/src/domain/settings.ts",
  ]);
  assert.deepEqual(
    [...hits],
    [["data-migration", ["packages/kernel/src/domain/old.ts", "packages/kernel/src/domain/settings.ts"]]],
  );
});

test("matching stays path-exact: a near-miss file or a sibling directory never fires", () => {
  const lanes = reviewPathLanes([
    "data-migration packages/kernel/src/domain/",
    "data-migration tools/gates/canonical-event-compat.mjs",
  ]);
  assert.equal(
    reviewLaneHits(
      submission([
        "packages/kernel/src/domains/settings.ts",
        "packages/kernel/src/domain",
        "tools/gates/canonical-event-compat.test.mjs",
      ]),
      lanes,
    ).size,
    0,
  );
});

test("an empty configuration or an empty cut reports no lanes: the mechanism is off by default", () => {
  assert.equal(reviewLaneHits(submission(["packages/kernel/src/domain/settings.ts"]), []).size, 0);
  assert.equal(
    reviewLaneHits(
      submission(["packages/kernel/src/domain/settings.ts"]),
      reviewPathLanes(["data-migration packages/kernel/src/domain/"]),
    ).size,
    1,
  );
  assert.equal(
    reviewLaneHits(
      submission(["packages/kernel/src/domain/settings.ts"]),
      reviewPathLanes(["data-migration packages/kernel/src/schemas/"]),
    ).size,
    0,
  );
  assert.equal(reviewLaneHits(null, reviewPathLanes(["data-migration packages/kernel/src/domain/"])).size, 0);
});

test("the lane keys off the same cut with the agent as its own segment", () => {
  const execution = {
    executionId: "execution-path-lane",
    iteration: 2,
    submission: submission(["packages/kernel/src/domain/settings.ts"]),
  } as unknown as ExecutionV1;
  const key = reviewLaneDispatchKey("data-migration", "task-path-lane", execution),
    cutKey = reviewDispatchKey("task-path-lane", execution, "reviewer-a");
  assert.match(key, /^task-review-lane:data-migration:task-path-lane:execution-path-lane:2:sha256:[0-9a-f]{64}$/u);
  assert.ok(cutKey.endsWith(":reviewer:reviewer-a"));
  assert.notEqual(key, cutKey);
  assert.notEqual(key, reviewLaneDispatchKey("gui-reviewer", "task-path-lane", execution));
});

test("the lane prompt fixes the routing evidence and the registration identity, not the role contract", () => {
  const execution = {
      executionId: "execution-path-prompt",
      iteration: 1,
      submission: submission(["packages/kernel/src/domain/settings.ts"]),
    } as unknown as ExecutionV1,
    hits = reviewLaneHits(execution.submission, reviewPathLanes(["data-migration packages/kernel/src/domain/"])).get(
      "data-migration",
    )!,
    prompt = reviewLanePrompt({
      agentId: "data-migration",
      taskId: "task-path-prompt",
      packagePath: "tasks/task-path-prompt-pkg",
      dispatchId: "dispatch_prompt01",
      execution,
      hits,
    });
  assert.match(prompt, /additional review lane for agent data-migration/u);
  assert.ok(prompt.includes("- packages/kernel/src/domain/settings.ts"), prompt);
  assert.ok(prompt.includes("Your own Agent declaration defines this lane's review focus"), prompt);
  assert.ok(
    prompt.includes("--review-id review-dispatch_prompt01") &&
      prompt.includes("--from-file harness/tasks/task-path-prompt-pkg/artifacts/reports/dispatch_prompt01.json"),
    "registration identity is fixed by the dispatch",
  );
  assert.ok(!prompt.includes("attach-migrations.ts"), "the shared prompt must not hardcode one lane's contract");
  // The lane and the cut prompt quote one guidance source; neither may tell a re-reviewer to
  // downgrade a newly found invariant or production-path defect.
  assert.ok(prompt.includes(reviewFindingScopePrompt("re-review")), "the lane quotes the shared re-review rule");
  assert.ok(!prompt.includes("Do not reopen"), "the lane never suppresses a visible blocker");
});
