// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { readSubmissionFacts, type SubmissionV1 } from "@harness-anything/kernel";
import { reviewPathHits, reviewPathRules, reviewPathSeatPrompt, reviewPathSeats } from "../src/review-path-matching.ts";

const submission = (
  deliverables: readonly string[],
  deleted: readonly string[] = [],
  changedFiles?: readonly string[],
): SubmissionV1 =>
  ({
    completionClaim: "claim",
    deliverables,
    ...(changedFiles === undefined ? {} : { changedFiles }),
    ...(changedFiles === undefined
      ? {}
      : {
          productionDelta: {
            baseSha: "1".repeat(40),
            added: 0,
            deleted: 0,
            changed: [],
            unclassified: [],
          },
        }),
    outputs: deleted.map((target) => `Deleted-Production-Paths: ${target}`),
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    commitSha: "0".repeat(40),
    completionContract: {},
  }) as unknown as SubmissionV1;

test("settings entries group into one lane per agent, splitting directory prefixes from exact files", () => {
  assert.deepEqual(
    reviewPathRules([
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
  assert.deepEqual(reviewPathRules([]), []);
  assert.deepEqual(reviewPathRules(undefined), []);
});

test("a cut hits a lane through its frozen deliverables or its deleted production paths", () => {
  const lanes = reviewPathRules([
    "data-migration packages/kernel/src/domain/",
    "data-migration tools/gates/canonical-event-compat.mjs",
    "gui-reviewer packages/gui/src/",
  ]);
  const hits = reviewPathHits(
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
  const hits = reviewPathHits(
    submission(["README.md"], [], ["README.md", "packages/kernel/src/domain/retired.test.ts"]),
    reviewPathRules(["data-migration packages/kernel/src/domain/"]),
  );
  assert.deepEqual([...hits], [["data-migration", ["packages/kernel/src/domain/retired.test.ts"]]]);
});

test("legacy lane routing uses the same normalized paths exposed by submission facts", () => {
  const cut = submission(
      ["README.md", "packages/kernel/src/domain/settings.ts"],
      ["packages/kernel/src/domain/old.ts"],
    ),
    facts = readSubmissionFacts(cut),
    hits = reviewPathHits(cut, reviewPathRules(["data-migration packages/kernel/src/domain/"]));
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

test("incomplete legacy manifests conservatively seat every configured professional reviewer", () => {
  const cut = submission(["none", "merge commit 8ba0c5978 on main"]),
    rules = reviewPathRules(["data-migration packages/kernel/src/store/", "gui-reviewer packages/gui/src/"]),
    hits = reviewPathHits(cut, rules);
  assert.equal(hits.size, 2);
  for (const matched of hits.values())
    assert.deepEqual(matched, ["Legacy submission path evidence is incomplete; review the full delivery."]);
  const prompt = reviewPathSeatPrompt({
    seat: { reviewerId: "data-migration", matchedPaths: hits.get("data-migration")! },
  });
  assert.match(prompt, /professional reviewer data-migration/u);
  assert.match(prompt, /chosen conservatively/u);
  assert.match(prompt, /Review the full delivery/u);
});

test("matching stays path-exact: a near-miss file or a sibling directory never fires", () => {
  const rules = reviewPathRules([
    "data-migration packages/kernel/src/domain/",
    "data-migration tools/gates/canonical-event-compat.mjs",
  ]);
  assert.equal(
    reviewPathHits(
      submission([
        "packages/kernel/src/domains/settings.ts",
        "packages/kernel/src/domain",
        "tools/gates/canonical-event-compat.test.mjs",
      ]),
      rules,
    ).size,
    0,
  );
});

test("an empty configuration or an empty cut seats no professional reviewer: the mechanism is off by default", () => {
  assert.equal(reviewPathHits(submission(["packages/kernel/src/domain/settings.ts"]), []).size, 0);
  assert.equal(
    reviewPathHits(
      submission(["packages/kernel/src/domain/settings.ts"]),
      reviewPathRules(["data-migration packages/kernel/src/domain/"]),
    ).size,
    1,
  );
  assert.equal(
    reviewPathHits(
      submission(["packages/kernel/src/domain/settings.ts"]),
      reviewPathRules(["data-migration packages/kernel/src/schemas/"]),
    ).size,
    0,
  );
  assert.equal(reviewPathHits(null, reviewPathRules(["data-migration packages/kernel/src/domain/"])).size, 0);
});

test("professional seats come back in stable reviewer order from the frozen hit map", () => {
  const hits = new Map([
    ["gui-reviewer", ["packages/gui/src/a.ts"]],
    ["data-migration", ["packages/kernel/src/domain/settings.ts"]],
  ]);
  assert.deepEqual(reviewPathSeats(hits), [
    { agentId: "data-migration", paths: ["packages/kernel/src/domain/settings.ts"] },
    { agentId: "gui-reviewer", paths: ["packages/gui/src/a.ts"] },
  ]);
  assert.deepEqual(reviewPathSeats(new Map()), []);
});

test("the professional seat prompt names the routing evidence, not a second passing gate", () => {
  const prompt = reviewPathSeatPrompt({
    seat: { reviewerId: "data-migration", matchedPaths: ["packages/kernel/src/domain/settings.ts"] },
  });
  assert.match(prompt, /professional reviewer data-migration/u);
  assert.ok(prompt.includes("- packages/kernel/src/domain/settings.ts"), prompt);
  assert.match(prompt, /findings are report content like any other seat's/u);
  assert.match(prompt, /grants no separate approval/u);
  assert.ok(!prompt.includes("attach-migrations.ts"), "the shared prompt must not hardcode one reviewer's contract");
});
