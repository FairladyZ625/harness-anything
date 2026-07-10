import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const architectureRotRoot = path.resolve("packages/cli/src/commands/extensions/assets/software-coding/presets/architecture-rot-audit");
const detectorPolicy = await import("../src/commands/extensions/assets/software-coding/presets/architecture-rot-audit/scripts/detectors/detector-policy.mjs");
const seedDetectors = await import("../src/commands/extensions/assets/software-coding/presets/architecture-rot-audit/scripts/detectors/seed-detectors.mjs");
const snapshotHelpers = await import("../src/commands/extensions/assets/software-coding/presets/architecture-rot-audit/scripts/snapshot.mjs");

const cliPackage = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
  readonly name: string;
  readonly private?: boolean;
  readonly version: string;
  readonly description?: string;
  readonly repository?: { readonly directory?: string };
  readonly scripts?: Record<string, string>;
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string>;
  readonly files?: readonly string[];
  readonly dependencies?: Record<string, string>;
  readonly publishConfig?: { readonly access?: string };
  readonly engines?: { readonly node?: string };
};

test("CLI package exposes the CLI-only npm dry-run artifact surface", () => {
  assert.equal(cliPackage.name, "@harness-anything/cli");
  assert.equal(cliPackage.private, undefined);
  assert.equal(cliPackage.version, "0.1.0");
  assert.equal(cliPackage.description?.length > 0, true);
  assert.equal(cliPackage.publishConfig?.access, "public");
  assert.equal(cliPackage.repository?.directory, "packages/cli");
  assert.equal(cliPackage.engines?.node, ">=24");
  assert.equal(cliPackage.scripts?.build, "tsc -p tsconfig.build.json && node scripts/copy-assets.mjs");
  assert.equal(cliPackage.bin?.["harness-anything"], "dist/cli/src/index.js");
  assert.equal(cliPackage.bin?.ha, "dist/cli/src/index.js");
  assert.equal(cliPackage.exports?.["."], "./dist/cli/src/index.js");
  assert.equal(cliPackage.files?.includes("dist"), true);
  assert.equal(cliPackage.dependencies?.["@effect/platform"], "0.96.2");
  assert.equal(cliPackage.dependencies?.effect, "3.21.4");
  const cliEntry = path.resolve("packages/cli/src/index.ts");
  assert.equal(readFileSync(cliEntry, "utf8").startsWith("#!/usr/bin/env node"), true);
  if (process.platform !== "win32") {
    assert.equal((statSync(cliEntry).mode & 0o111) !== 0, true);
  }
});

test("bundled software coding assets have consistent template and process-preset surfaces", () => {
  const assetRoot = "packages/cli/src/commands/extensions/assets/software-coding";
  const catalog = JSON.parse(readFileSync(path.join(assetRoot, "template-catalog.json"), "utf8")) as {
    readonly schema: string;
    readonly documents: ReadonlyArray<{
      readonly id: string;
      readonly materializeAs: string;
      readonly locales: ReadonlyArray<{ readonly locale: string; readonly body?: unknown; readonly bodyPath?: unknown }>;
    }>;
  };
  const vertical = JSON.parse(readFileSync(path.join(assetRoot, "vertical.json"), "utf8")) as {
    readonly templateSelections: ReadonlyArray<TemplateSelection>;
    readonly packageScaffolds: ReadonlyArray<{
      readonly entityKind: string;
      readonly templateSelections: ReadonlyArray<TemplateSelection>;
    }>;
    readonly repositoryScaffold: {
      readonly seededDocs: ReadonlyArray<TemplateSelection & { readonly body?: unknown; readonly path?: unknown }>;
    };
    readonly scripts: ReadonlyArray<{
      readonly id: string;
      readonly metadata: { readonly purpose: string };
    }>;
  };
  const index = JSON.parse(readFileSync(path.join(assetRoot, "presets/index.json"), "utf8")) as {
    readonly presets: ReadonlyArray<string>;
  };
  const catalogIds = new Set(catalog.documents.map((document) => document.id));
  const selectedMaterializedPaths = new Set<string>();
  const bundledPresetIds = [
    "standard-task",
    "long-running-task",
    "module",
    "subtask-expansion",
    "github-issue-repair",
    "legacy-migration",
    "create-milestone",
    "milestone-closeout",
    "decision-conformance",
    "worker-dispatch",
    "code-impact-analysis",
    "architecture-rot-audit"
  ].sort();

  assert.equal(catalog.schema, "template-catalog/v2");
  for (const document of catalog.documents) {
    for (const locale of document.locales) {
      assert.equal(locale.body, undefined, `${document.id} ${locale.locale} must not inline template body`);
      assert.equal(typeof locale.bodyPath, "string", `${document.id} ${locale.locale} must reference bodyPath`);
      assert.equal(statSync(path.join(assetRoot, String(locale.bodyPath))).isFile(), true, `${document.id} ${locale.locale} bodyPath must exist`);
    }
  }

  assert.equal(vertical.templateSelections.length, 0, "vertical top-level templateSelections stay deduplicated");
  const taskScaffoldSelections = vertical.packageScaffolds.find((scaffold) => scaffold.entityKind === "task")?.templateSelections ?? [];

  for (const selection of taskScaffoldSelections) {
    assertKnownTemplateRef(catalogIds, selection.templateRef);
    assert.equal(selectedMaterializedPaths.has(selection.materializeAs), false, `duplicate materialized path ${selection.materializeAs}`);
    selectedMaterializedPaths.add(selection.materializeAs);
  }

  for (const selection of vertical.repositoryScaffold.seededDocs) {
    assertKnownTemplateRef(catalogIds, selection.templateRef);
    assert.equal(selection.body, undefined, `${selection.templateRef} must not inline seeded doc body`);
    assert.equal(selection.path, undefined, `${selection.templateRef} must use materializeAs instead of path`);
  }
  assert.equal(vertical.scripts.some((script) => script.id === "vertical:software-coding:adr-seed" && script.metadata.purpose === "scaffold"), true);
  assert.deepEqual([...index.presets].sort(), bundledPresetIds, "bundled preset ids must match the approved public distribution list");

  for (const presetId of index.presets) {
    const manifest = JSON.parse(readFileSync(path.join(assetRoot, "presets", presetId, "preset.json"), "utf8")) as PresetAsset;
    for (const profile of manifest.profiles) {
      const profilePaths = new Set<string>();
      for (const selection of profile.templateSelections) {
        assertKnownTemplateRef(catalogIds, selection.templateRef);
        assert.equal(profilePaths.has(selection.materializeAs), false, `duplicate ${presetId} materialized path ${selection.materializeAs}`);
        profilePaths.add(selection.materializeAs);
      }
    }
    if (manifest.kind === "process-action") {
      assert.notEqual(Object.keys(manifest.entrypoints ?? {}).length, 0);
      for (const entrypoint of Object.values(manifest.entrypoints ?? {})) {
        const scriptEntrypoint = entrypoint as { readonly command?: string; readonly reads?: ReadonlyArray<string>; readonly writes?: ReadonlyArray<string> };
        assert.equal(scriptEntrypoint.reads?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive reads`);
        assert.equal(scriptEntrypoint.writes?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive writes`);
        if (typeof scriptEntrypoint.command === "string") {
          assertPresetScriptImportsStayInsidePackage(path.join(assetRoot, "presets", presetId), scriptEntrypoint.command);
        }
      }
    }
  }
});

test("architecture-rot-audit registry formalizes seven categories and fixed anchors", () => {
  const registry = JSON.parse(readFileSync(path.join(architectureRotRoot, "registry/architecture-rot-registry.json"), "utf8")) as Record<string, any>;
  withTempRoot((rootDir) => {
    assert.equal(runJson(rootDir, ["preset", "check", "architecture-rot-audit"]).ok, true);
  });
  assert.equal(registry.records.length, 17);
  assert.deepEqual([...new Set(registry.records.map((record: Record<string, unknown>) => record.category))].sort(), [
    "atomicity-outsourcing",
    "declaration-first-leak",
    "enforcement-gap",
    "imaginary-seam",
    "layer-misalignment",
    "manual-mirror",
    "shallow-slice"
  ]);
  const fixed = registry.records.filter((record: Record<string, unknown>) => record.status === "fixed");
  assert.equal(fixed.length, 3);
  assert.equal(fixed.every((record: Record<string, unknown>) => /^[0-9a-f]{40}$/u.test(String(record.fixedCommit)) && /^PR#[0-9]+$/u.test(String(record.fixPullRequest))), true);
  assert.equal(registry.records.every((record: Record<string, any>) => record.detection.detector === record.id), true);
});

test("architecture-rot-audit check action writes snapshot and non-blocking triage", () => {
  withTempRoot((rootDir) => {
    writeFixture(rootDir, "packages/cli/src/cli/command-spec/command-spec-fixture.ts", [
      "const specs = [",
      "  { \"kind\": \"one\", \"options\": [{\"flag\":\"--mode\",\"description\":\"First mode.\"}], \"parse\": parseOne, \"run\": runOne },",
      "  { \"kind\": \"two\", \"options\": [{\"flag\":\"--mode\",\"description\":\"Second mode.\"}], \"parse\": parseTwo, \"run\": runTwo }",
      "];",
      "void specs;",
      ""
    ].join("\n"));
    writeFixture(rootDir, "packages/kernel/src/local/task-holder-state.ts", [
      "function withTaskHolderMutationLock() {}",
      "withTaskHolderMutationLock();",
      "withTaskHolderMutationLock();",
      ""
    ].join("\n"));
    writeFixture(rootDir, "packages/cli/src/commands/extensions/script-executor.ts", "import { spawnSync } from \"node:child_process\";\nvoid spawnSync;\n");

    const checked = runJson(rootDir, [
      "preset", "action", "architecture-rot-audit", "check", "--task", "task-rot", "--allow-scripts"
    ]);
    const snapshotPath = path.join(rootDir, "harness/tasks/task-rot/artifacts/arch-rot.snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, any>;

    assert.equal(checked.ok, true);
    assert.equal(checked.report.status, "passed");
    assert.deepEqual(snapshot.lensA.passes.sort(), ["ROT-002", "ROT-006", "ROT-008"]);
    assert.deepEqual(snapshot.lensA.recurrences, []);
    assert.equal(snapshot.root.sourceHead, "unverified");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-rot/artifacts/arch-rot.triage.json")), true);
  });
});

test("architecture rot semantics hard-fail recurrence, warn open green, and triage Lens-B", () => {
  const records = [{ id: "ROT-900", status: "fixed" }, { id: "ROT-901", status: "open" }];
  const fixedPass = detectorPolicy.evaluateDetectionResults([records[0]], [{ id: "ROT-900", outcome: "pass", exitCode: 0, evidence: {} }]);
  const recurrence = detectorPolicy.evaluateDetectionResults([records[0]], [{ id: "ROT-900", outcome: "fail", exitCode: 1, evidence: {} }]);
  const openGreen = detectorPolicy.evaluateDetectionResults([records[1]], [{ id: "ROT-901", outcome: "pass", exitCode: 0, evidence: {} }]);
  const candidates = detectorPolicy.buildLensBCandidates(["packages/cli/src/commands/extensions/new-policy.ts"]);

  assert.equal(fixedPass.ok, true);
  assert.equal(fixedPass.items[0].severity, "none");
  assert.equal(recurrence.ok, false);
  assert.equal(recurrence.items[0].snapshotStatus, "recurred");
  assert.equal(recurrence.items[0].severity, "hard-fail");
  assert.equal(openGreen.ok, true);
  assert.equal(openGreen.items[0].severity, "warning");
  assert.match(openGreen.items[0].interpretation, /commit and PR anchors/u);
  assert.equal(candidates.length > 0, true);
  assert.equal(candidates.every((candidate: Record<string, unknown>) => candidate.blocking === false), true);
});

test("ROT-008 pure detector turns a manufactured second sandbox executor red", () => {
  withTempRoot((rootDir) => {
    writeFixture(rootDir, "packages/cli/src/commands/extensions/script-executor.ts", "import { spawnSync } from \"node:child_process\";\nvoid spawnSync;\n");
    const green = seedDetectors.runSeedDetector(rootDir, "ROT-008");
    writeFixture(rootDir, "packages/cli/src/commands/extensions/second-executor.ts", "import { spawnSync } from \"node:child_process\";\nvoid spawnSync;\n");
    const recurrence = seedDetectors.runSeedDetector(rootDir, "ROT-008");
    const evaluated = detectorPolicy.evaluateDetectionResults([{ id: "ROT-008", status: "fixed" }], [recurrence]);

    assert.equal(green.outcome, "pass");
    assert.equal(recurrence.outcome, "fail");
    assert.deepEqual(recurrence.evidence.owners.sort(), ["script-executor.ts", "second-executor.ts"]);
    assert.equal(evaluated.ok, false);
    assert.equal(evaluated.hardFailures[0].id, "ROT-008");
  });
});

test("architecture rot snapshots ignore bad inputs and break timestamp ties by taskId", () => {
  withTempRoot((rootDir) => {
    const tasksRoot = path.join(rootDir, "harness/tasks");
    writeFixture(rootDir, "harness/tasks/task_A/artifacts/arch-rot.snapshot.json", JSON.stringify(snapshotFixture("task_A")));
    writeFixture(rootDir, "harness/tasks/task_B/artifacts/arch-rot.snapshot.json", JSON.stringify(snapshotFixture("task_B")));
    writeFixture(rootDir, "harness/tasks/task_CURRENT/artifacts/arch-rot.snapshot.json", JSON.stringify(snapshotFixture("task_CURRENT", "2099-01-01T00:00:00.000Z")));
    writeFixture(rootDir, "harness/tasks/task_BAD/artifacts/arch-rot.snapshot.json", "{bad json");

    const selected = snapshotHelpers.selectPriorSnapshot(tasksRoot, "task_CURRENT");

    assert.equal(selected.snapshot.coordinationTaskId, "task_B");
    assert.equal(selected.warnings.length, 1);
    assert.match(selected.warnings[0], /Ignored invalid architecture rot snapshot/u);
  });
});

interface TemplateSelection {
  readonly templateRef: string;
  readonly materializeAs: string;
}

interface PresetAsset {
  readonly title: string;
  readonly kind?: string;
  readonly entrypoints?: Record<string, unknown>;
  readonly profiles: ReadonlyArray<{
    readonly templateSelections: ReadonlyArray<TemplateSelection>;
  }>;
}

function assertKnownTemplateRef(catalogIds: ReadonlySet<string>, templateRef: string): void {
  const match = /^template:\/\/(.+)@\d+$/u.exec(templateRef);
  assert.notEqual(match, null, `malformed template ref ${templateRef}`);
  assert.equal(catalogIds.has(match[1]), true, `unknown template ref ${templateRef}`);
}

function assertPresetScriptImportsStayInsidePackage(presetRoot: string, command: string): void {
  const scriptPath = path.resolve(presetRoot, command);
  const source = readFileSync(scriptPath, "utf8");
  const relativeImports = [...source.matchAll(/^\s*import\s+(?:[^"']+\s+from\s+)?["'](\.{1,2}\/[^"']+)["'];?/gmu)]
    .map((match) => match[1]);
  for (const specifier of relativeImports) {
    const target = path.resolve(path.dirname(scriptPath), specifier);
    const relative = path.relative(path.resolve(presetRoot), target);
    assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false, `${command} imports outside preset package: ${specifier}`);
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], { encoding: "utf8" });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-rot-package-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFixture(rootDir: string, relativePath: string, body: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function snapshotFixture(taskId: string, generatedAt = "2026-07-10T10:00:00.000Z"): Record<string, unknown> {
  return { schema: "architecture-rot-snapshot/v1", generatedAt, coordinationTaskId: taskId, fileHashes: {} };
}
