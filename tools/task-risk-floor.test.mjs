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

function sourceFile(filePath, additions, deletions = 0) {
  return { path: filePath, status: "modified", additions, deletions, binary: false, patch: "" };
}

test("documentation and test-only diffs stay low", (t) => {
  const root = fixture(t);
  const result = assessRepositoryRisk(
    input([sourceFile("docs-release/guide.md", 200), sourceFile("packages/app/test/app.test.ts", 100)]),
    root,
  );
  assert.equal(result.minimumTier, "low");
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
