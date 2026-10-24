// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assessTaskRiskTier } from "../src/task-risk-tier.ts";

const task = {
    taskId: "task-risk-tier",
    declaredTier: "low" as const,
    verticalId: "software/coding",
    presetId: "standard-task",
    workKind: "fix" as const,
  },
  delivery = {
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    files: [
      {
        path: "packages/app/src/main.ts",
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        binary: false,
        patch: "diff --git a/packages/app/src/main.ts b/packages/app/src/main.ts\n+change\n",
      },
    ],
  },
  lane = { agentId: "data-migration", paths: ["packages/app/src/main.ts"] };

function rootWithManifest(manifest?: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-risk-tier-"));
  if (manifest !== undefined) {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(path.join(root, "tools/task-risk-manifest.json"), JSON.stringify(manifest));
  }
  return root;
}

function scriptCommand(body: string): readonly string[] {
  return [
    process.execPath,
    "-e",
    `let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => { ${body} });`,
  ];
}

test("risk assessment freezes the real diff anchors and path reviewer hits", async (t) => {
  const root = rootWithManifest({
    schema: "task-risk-manifest/v1",
    scripts: [
      {
        id: "floor",
        command: scriptCommand(
          "const value = JSON.parse(input); process.stdout.write(JSON.stringify({ schema: 'task-risk-tier-result/v1', minimumTier: 'low', reasons: [value.delivery.files[0].patch] }));",
        ),
      },
    ],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const assessment = await assessTaskRiskTier({
    rootDir: root,
    task,
    delivery,
    pathReviewers: ["data-migration packages/app/src/main.ts"],
    matchedPathReviewers: [],
  });

  assert.equal(assessment.effectiveTier, "low");
  assert.equal(assessment.deliveryBaseSha, delivery.baseSha);
  assert.equal(assessment.deliveryHeadSha, delivery.headSha);
  assert.deepEqual(assessment.matchedPathReviewers, [lane]);
  assert.match(assessment.reasons.join("\n"), /packages\/app\/src\/main\.ts/u);
  assert.equal(assessment.guiAcceptanceRequired, false);
});

test("script floors and prior effective tiers can only raise the declared tier", async (t) => {
  const root = rootWithManifest({
    schema: "task-risk-manifest/v1",
    scripts: [
      {
        id: "floor",
        command: scriptCommand(
          "process.stdout.write(JSON.stringify({ schema: 'task-risk-tier-result/v1', minimumTier: 'low', reasons: ['low floor'] }));",
        ),
      },
    ],
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const assessment = await assessTaskRiskTier({
    rootDir: root,
    task,
    delivery,
    matchedPathReviewers: [],
    previousEffectiveTier: "high",
  });

  assert.equal(assessment.effectiveTier, "high");
});

test("configured GUI acceptance survives a risk-tier increase", async (t) => {
  const root = rootWithManifest({ schema: "task-risk-manifest/v1", scripts: [], lowGuiAcceptance: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const assessment = await assessTaskRiskTier({
    rootDir: root,
    task: { ...task, declaredTier: "medium" },
    delivery: {
      ...delivery,
      files: [{ ...delivery.files[0]!, path: "packages/gui/src/App.tsx" }],
    },
    matchedPathReviewers: [],
    previousEffectiveTier: "high",
  });

  assert.equal(assessment.effectiveTier, "high");
  assert.equal(assessment.guiAcceptanceRequired, true);
});

test("missing scripts use the declared tier and GUI acceptance follows repository configuration", async (t) => {
  const root = rootWithManifest({ schema: "task-risk-manifest/v1", scripts: [], lowGuiAcceptance: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const assessment = await assessTaskRiskTier({
    rootDir: root,
    task,
    delivery: {
      ...delivery,
      files: [{ ...delivery.files[0]!, path: "packages/gui/src/App.tsx" }],
    },
    matchedPathReviewers: [],
  });

  assert.equal(assessment.effectiveTier, "low");
  assert.equal(assessment.guiAcceptanceRequired, true);
});

test("failed and malformed configured scripts reject assessment with their own output", async (t) => {
  const failed = rootWithManifest({
    schema: "task-risk-manifest/v1",
    scripts: [
      { id: "broken", command: scriptCommand("process.stderr.write('risk script failure'); process.exitCode = 7;") },
    ],
  });
  t.after(() => rmSync(failed, { recursive: true, force: true }));
  await assert.rejects(
    assessTaskRiskTier({ rootDir: failed, task, delivery, matchedPathReviewers: [] }),
    /risk script failure/u,
  );

  const malformed = rootWithManifest({
    schema: "task-risk-manifest/v1",
    scripts: [{ id: "malformed", command: scriptCommand("process.stdout.write(JSON.stringify({ wrong: true }));") }],
  });
  t.after(() => rmSync(malformed, { recursive: true, force: true }));
  await assert.rejects(
    assessTaskRiskTier({ rootDir: malformed, task, delivery, matchedPathReviewers: [] }),
    /malformed task-risk-tier-result\/v1/u,
  );
});
