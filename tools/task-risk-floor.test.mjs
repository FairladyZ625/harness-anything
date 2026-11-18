// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assessRepositoryRisk } from "./task-risk-floor.mjs";

function fixture(t, protectedSurfaces = []) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-risk-floor-"));
  mkdirSync(path.join(root, "tools"), { recursive: true });
  writeFileSync(
    path.join(root, "tools/gate-manifest.json"),
    JSON.stringify({
      gates: [{ changeControl: { requiresGovernanceEvidence: true, protectedSurfaces } }],
    }),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function input(files, matchedPathReviewers = []) {
  return {
    schema: "task-risk-tier-input/v1",
    task: {
      taskId: "task-risk",
      declaredTier: "low",
      verticalId: "software/coding",
      presetId: "standard-task",
      workKind: "fix",
    },
    delivery: {
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      patch: "frozen diff",
      files,
    },
    matchedPathReviewers,
  };
}

function sourceFile(filePath, additions, deletions = 0, status = "modified") {
  return { path: filePath, status, additions, deletions, binary: false, patch: "" };
}

test("documentation and newly added test or fixture diffs stay low", (t) => {
  const root = fixture(t);
  const docsOnly = assessRepositoryRisk(input([sourceFile("docs-release/guide.md", 200)]), root);
  assert.equal(docsOnly.minimumTier, "low");
  const addedTest = assessRepositoryRisk(
    input([
      sourceFile("docs-release/guide.md", 20),
      sourceFile("packages/app/test/new-feature.test.ts", 100, 0, "added"),
      sourceFile("packages/app/test/fixtures/new-sample.json", 40, 0, "added"),
      sourceFile("packages/app/src/__snapshots__/new.snap", 15, 0, "added"),
    ]),
    root,
  );
  assert.equal(addedTest.minimumTier, "low");
});

test("modifying, deleting, or renaming an existing test or fixture raises minimum tier to medium", (t) => {
  const root = fixture(t);
  const deletedAssertion = assessRepositoryRisk(
    input([sourceFile("packages/foo/test/bar.test.ts", 0, 2, "modified")]),
    root,
  );
  assert.equal(deletedAssertion.minimumTier, "medium");
  assert.ok(deletedAssertion.reasons.some((reason) => reason.includes("packages/foo/test/bar.test.ts")));

  const additionOnlyOnExistingTest = assessRepositoryRisk(
    input([sourceFile("packages/foo/test/bar.test.ts", 3, 0, "modified")]),
    root,
  );
  assert.equal(additionOnlyOnExistingTest.minimumTier, "medium");
  assert.ok(additionOnlyOnExistingTest.reasons.some((reason) => reason.includes("packages/foo/test/bar.test.ts")));

  const deletedFixture = assessRepositoryRisk(
    input([sourceFile("packages/app/test/fixtures/expected.json", 0, 25, "deleted")]),
    root,
  );
  assert.equal(deletedFixture.minimumTier, "medium");
  assert.ok(deletedFixture.reasons.some((reason) => reason.includes("packages/app/test/fixtures/expected.json")));

  const modifiedYamlFixture = assessRepositoryRisk(
    input([sourceFile("packages/daemon/fixtures/contracts/case.yaml", 2, 2, "modified")]),
    root,
  );
  assert.equal(modifiedYamlFixture.minimumTier, "medium");
  assert.ok(
    modifiedYamlFixture.reasons.some((reason) => reason.includes("packages/daemon/fixtures/contracts/case.yaml")),
  );

  const renamedSnapshot = assessRepositoryRisk(
    input([sourceFile("packages/gui/test/__snapshots__/panel.snap", 0, 0, "renamed")]),
    root,
  );
  assert.equal(renamedSnapshot.minimumTier, "medium");
  assert.ok(renamedSnapshot.reasons.some((reason) => reason.includes("packages/gui/test/__snapshots__/panel.snap")));

  const localizedSourceWithModifiedTest = assessRepositoryRisk(
    input([
      sourceFile("packages/app/src/main.ts", 5, 2, "modified"),
      sourceFile("packages/app/test/main.test.ts", 1, 1, "modified"),
    ]),
    root,
  );
  assert.equal(localizedSourceWithModifiedTest.minimumTier, "medium");
  assert.ok(
    localizedSourceWithModifiedTest.reasons.some((reason) => reason.includes("packages/app/test/main.test.ts")),
  );
});

test("oracle change reasons are bounded on massive test refactors", (t) => {
  const root = fixture(t);
  const files = Array.from({ length: 40 }, (_, index) =>
    sourceFile(`packages/app/test/suite-${String(index)}.test.ts`, 1, 1, "modified"),
  );
  const result = assessRepositoryRisk(input(files), root);
  assert.equal(result.minimumTier, "medium");
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0], /total 40/u);
  assert.match(result.reasons[0], /suite-4\.test\.ts/u);
  assert.doesNotMatch(result.reasons[0], /suite-5\.test\.ts/u);
  assert.match(result.reasons[0], /35 more/u);
});

test("testing documentation stays low and Markdown fixtures are protected", (t) => {
  const root = fixture(t);
  assert.equal(assessRepositoryRisk(input([sourceFile("packages/app/test/README.md", 1, 1)]), root).minimumTier, "low");
  assert.equal(
    assessRepositoryRisk(input([sourceFile("packages/app/test/fixtures/expected.md", 1, 1)]), root).minimumTier,
    "medium",
  );
});

test("new colocated tests are excluded from the production budget", (t) => {
  const root = fixture(t);
  assert.equal(
    assessRepositoryRisk(input([sourceFile("packages/app/src/feature.test.ts", 41, 0, "added")]), root).minimumTier,
    "low",
  );
  assert.equal(
    assessRepositoryRisk(
      input([
        sourceFile("packages/app/src/feature.spec.ts", 2, 0, "added"),
        sourceFile("packages/app/src/main.ts", 1, 1),
      ]),
      root,
    ).minimumTier,
    "low",
  );
});

test("renames check both endpoints and copies leave the source intact", (t) => {
  const root = fixture(t),
    oldPath = "packages/app/test/fixtures/expected.json",
    newPath = "packages/app/data/expected.json";
  for (const [from, to] of [
    [oldPath, newPath],
    [newPath, oldPath],
  ]) {
    const renamed = assessRepositoryRisk(input([{ ...sourceFile(to, 0, 0, "renamed"), oldPath: from }]), root);
    assert.equal(renamed.minimumTier, "medium");
    assert.ok(renamed.reasons.some((reason) => reason.includes(`${from} -> ${to}`)));
  }
  assert.equal(
    assessRepositoryRisk(input([{ ...sourceFile(newPath, 0, 0, "copied"), oldPath }]), root).minimumTier,
    "low",
  );
});

test("one localized production file stays low through 40 changed lines", (t) => {
  const root = fixture(t);
  const result = assessRepositoryRisk(input([sourceFile("packages/app/src/main.ts", 25, 15)]), root);
  assert.equal(result.minimumTier, "low");
});

test("multiple production files are medium and large production diffs are high", (t) => {
  const root = fixture(t);
  assert.equal(
    assessRepositoryRisk(
      input([sourceFile("packages/app/src/a.ts", 20), sourceFile("packages/app/src/b.ts", 20)]),
      root,
    ).minimumTier,
    "medium",
  );
  assert.equal(assessRepositoryRisk(input([sourceFile("packages/app/src/a.ts", 251, 250)]), root).minimumTier, "high");
});

test("protected surfaces, sensitive paths and configured path reviewers are high", (t) => {
  const root = fixture(t, ["packages/app/src/critical.ts"]);
  assert.equal(assessRepositoryRisk(input([sourceFile("packages/app/src/critical.ts", 1)]), root).minimumTier, "high");
  assert.equal(
    assessRepositoryRisk(input([sourceFile("packages/app/src/store/schema.ts", 1)]), root).minimumTier,
    "high",
  );
  assert.equal(
    assessRepositoryRisk(
      input(
        [sourceFile("packages/app/src/main.ts", 1)],
        [{ agentId: "data-migration", paths: ["packages/app/src/main.ts"] }],
      ),
      root,
    ).minimumTier,
    "low",
  );
});
