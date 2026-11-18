// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildImportGraph, listImportGraphFiles, selectAffectedTests } from "./affected-tests.mjs";
import { collectGuiVitestFiles } from "./gui-test-runner-lib.mjs";
import { discoverGuiVitestFiles, discoverTestFiles, discoverTestTierManifest } from "./test-tier-manifest.mjs";

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), "affected-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  return root;
}

function integrationTest(body) {
  return `// harness-test-tier: integration\n${body}`;
}

function fastTest(body) {
  return `// harness-test-tier: fast\n${body}`;
}

// The positive control is the PR #4498 shape: one settlement module, one settlement
// wrapper, one test fixture, three integration suites. Two suites import the fixture
// and one imports the settlement module as a type only. The fixture is fixed here so a
// selector that only sees direct imports fails this test even when the repository moves.
const positiveControlFiles = {
  "packages/daemon/src/runtime-spawn-settlement.ts": "export const settle = true;\n",
  "packages/daemon/src/runtime-settlement.ts":
    'import { settle } from "./runtime-spawn-settlement.ts";\nexport const settlement = settle;\n',
  "packages/daemon/test/runtime-settlement.fixtures.ts":
    'import { settlement } from "../src/runtime-settlement.ts";\nexport const runtimeSettlementFixture = settlement;\n',
  "packages/daemon/test/fleet-squad-canonical.integration.test.ts": integrationTest(
    'import { runtimeSettlementFixture } from "./runtime-settlement.fixtures.ts";\nexport const value = runtimeSettlementFixture;\n',
  ),
  "packages/daemon/test/fleet-runtime-assignment-ownership.integration.test.ts": integrationTest(
    'import { runtimeSettlementFixture } from "./runtime-settlement.fixtures.ts";\nexport const value = runtimeSettlementFixture;\n',
  ),
  "packages/daemon/test/review-independence-diagnostics.integration.test.ts": integrationTest(
    'import type { settle } from "../src/runtime-spawn-settlement.ts";\nexport const value: typeof settle = true;\n',
  ),
  "packages/daemon/test/unrelated.integration.test.ts": integrationTest("export const value = 1;\n"),
};

test("reverse selection reaches the PR #4498 suites through the settlement chain", (t) => {
  const root = fixture(t, positiveControlFiles);
  const testFiles = Object.keys(positiveControlFiles).filter((file) => file.includes(".integration.test."));
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/runtime-spawn-settlement.ts"],
    testFiles,
    ratio: 1,
  });

  assert.deepEqual(
    result.selected.map(({ file }) => file),
    [
      "packages/daemon/test/fleet-runtime-assignment-ownership.integration.test.ts",
      "packages/daemon/test/fleet-squad-canonical.integration.test.ts",
      "packages/daemon/test/review-independence-diagnostics.integration.test.ts",
    ],
  );
  for (const { via, changed } of result.selected) {
    assert.equal(via, "packages/daemon/src/runtime-spawn-settlement.ts");
    assert.equal(changed, false);
  }
  assert.equal(result.tooMany, false);
  assert.deepEqual(result.unmapped, []);
});

test("a changed test file is selected directly and keeps itself as its reason", (t) => {
  const root = fixture(t, positiveControlFiles);
  const changed = "packages/daemon/test/fleet-squad-canonical.integration.test.ts";
  const result = selectAffectedTests({
    root,
    changedFiles: [changed],
    testFiles: Object.keys(positiveControlFiles).filter((file) => file.includes(".integration.test.")),
    ratio: 1,
  });

  assert.deepEqual(result.changedTests, [changed]);
  assert.deepEqual(result.selected, [{ file: changed, via: changed, changed: true }]);
});

test("workspace package exports resolve through dist metadata to the source file", (t) => {
  const root = fixture(t, {
    "packages/kernel/package.json": JSON.stringify({
      name: "@harness-anything/kernel",
      exports: {
        ".": { types: "./src/index.ts", default: "./src/index.ts" },
        "./internal/domain/*.ts": {
          types: "./dist/domain/*.d.ts",
          default: "./dist/domain/*.js",
        },
      },
    }),
    "packages/kernel/src/index.ts": "export const kernel = 1;\n",
    "packages/kernel/src/domain/agent-runtime.ts": "export const runtime = 1;\n",
    "packages/kernel/test/contracts/public-surface.test.ts": [
      "// harness-test-tier: fast",
      'import { kernel } from "@harness-anything/kernel";',
      'import { runtime } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";',
      "export const value = kernel + runtime;",
      "",
    ].join("\n"),
  });
  const testFile = "packages/kernel/test/contracts/public-surface.test.ts";

  for (const changed of ["packages/kernel/src/index.ts", "packages/kernel/src/domain/agent-runtime.ts"]) {
    const result = selectAffectedTests({ root, changedFiles: [changed], testFiles: [testFile], ratio: 1 });
    assert.deepEqual(
      result.selected.map(({ file }) => file),
      [testFile],
      changed,
    );
  }
});

test("relative .js specifiers and directory index files resolve to their source modules", (t) => {
  const root = fixture(t, {
    "packages/daemon/src/leaf.ts": "export const leaf = 1;\n",
    "packages/daemon/src/dir/index.ts": 'export { leaf } from "../leaf.js";\n',
    "packages/daemon/test/dir.test.ts":
      '// harness-test-tier: fast\nimport { leaf } from "../src/dir";\nexport const value = leaf;\n',
  });
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/leaf.ts"],
    testFiles: ["packages/daemon/test/dir.test.ts"],
    ratio: 1,
  });

  assert.deepEqual(
    result.selected.map(({ file }) => file),
    ["packages/daemon/test/dir.test.ts"],
  );
});

test("a deleted changed module still reaches the test files that import it", (t) => {
  const root = fixture(t, {
    "packages/daemon/test/deleted.test.ts":
      '// harness-test-tier: fast\nimport { gone } from "../src/deleted.ts";\nexport const value = gone;\n',
  });
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/deleted.ts"],
    testFiles: ["packages/daemon/test/deleted.test.ts"],
    ratio: 1,
  });

  assert.deepEqual(
    result.selected.map(({ file, via }) => ({ file, via })),
    [{ file: "packages/daemon/test/deleted.test.ts", via: "packages/daemon/src/deleted.ts" }],
  );
});

test("the import graph is built once no matter how many files changed", (t) => {
  const root = fixture(t, {
    "packages/daemon/src/leaf.ts": "export const leaf = 1;\n",
    "packages/daemon/src/other.ts": "export const other = 1;\n",
    "packages/daemon/test/one.test.ts": '// harness-test-tier: fast\nexport { leaf } from "../src/leaf.ts";\n',
  });
  let builds = 0;
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/leaf.ts", "packages/daemon/src/other.ts"],
    testFiles: ["packages/daemon/test/one.test.ts"],
    ratio: 1,
    buildGraph(input) {
      builds += 1;
      return buildImportGraph(input.root, { knownTargets: input.knownTargets });
    },
  });

  assert.equal(builds, 1);
  assert.deepEqual(
    result.selected.map(({ file }) => file),
    ["packages/daemon/test/one.test.ts"],
  );
});

test("a selection above the whole-tier ratio is capped and every deferred file is named", (t) => {
  const files = {
    "packages/daemon/src/shared.ts": "export const shared = 1;\n",
  };
  for (let index = 0; index < 10; index += 1) {
    files[`packages/daemon/test/suite-${index}.integration.test.ts`] = integrationTest(
      index < 3
        ? 'import { shared } from "../src/shared.ts";\nexport const value = shared;\n'
        : "export const value = 1;\n",
    );
  }
  const root = fixture(t, files);
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/shared.ts"],
    testFiles: Object.keys(files).filter((file) => file.includes(".integration.test.")),
    ratio: 0.1,
  });

  assert.equal(result.integrationTotal, 10);
  assert.equal(result.maxSelected, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.tooMany, false);
  assert.deepEqual(
    result.selected.map(({ file }) => file),
    ["packages/daemon/test/suite-0.integration.test.ts"],
  );
  assert.deepEqual(
    result.deferred.map(({ file }) => file),
    ["packages/daemon/test/suite-1.integration.test.ts", "packages/daemon/test/suite-2.integration.test.ts"],
  );
  assert.equal(result.deferredCount, 2);
  assert.match(result.deferredReason, /^2 of 3 affected test files are not run/u);
  assert.match(result.deferredReason, /capped at 1 \(10% of the 10 integration tests\)/u);
  assert.match(result.deferredReason, /Run the deferred files in CI\.$/u);
});

test("the third-slice settlement fixture selects every reported CI failure within the cap", (t) => {
  // The PR #4498 shape: a settlement module reached through the runtime spawner by almost
  // every daemon test. The five files that failed CI are hidden among forty unrelated
  // integration suites that reach the same module through a longer, unrelated chain.
  const files = {
    "packages/daemon/src/runtime-spawn-settlement.ts": "export const settle = true;\n",
    "packages/daemon/src/runtime-spawner.ts":
      'import { settle } from "./runtime-spawn-settlement.ts";\nexport const spawner = settle;\n',
    "packages/daemon/src/runtime-spawn.ts":
      'import { spawner } from "./runtime-spawner.ts";\nexport const spawn = spawner;\n',
    "packages/daemon/src/repo-cell-open.ts":
      'import { spawn } from "./runtime-spawn.ts";\nexport const open = spawn;\n',
    "packages/daemon/src/fleet-squad-coordinator.ts":
      'import { spawner } from "./runtime-spawner.ts";\nexport const squad = spawner;\n',
    "packages/daemon/src/fleet-edge-runtime.ts":
      'import { spawn } from "./runtime-spawn.ts";\nexport const edge = spawn;\n',
    "packages/daemon/src/unrelated-host.ts":
      'import { spawn } from "./runtime-spawn.ts";\nexport const host = spawn;\n',
    "packages/daemon/src/unrelated-spawn.ts":
      'import { host } from "./unrelated-host.ts";\nexport const unrelatedSpawn = host;\n',
    "packages/daemon/test/fixtures/runtime-process.ts":
      'import { settle } from "../../src/runtime-spawn-settlement.ts";\nexport const runtimeProcessFixture = settle;\n',
    "packages/daemon/test/dispatch-lifecycle-read.fixtures.ts": 'export const lifecycleEvent = "lifecycle";\n',
    "packages/daemon/test/repo-settings.fixture.ts":
      'import { open } from "../src/repo-cell-open.ts";\nexport const openBootstrappedRepoCell = open;\n',
    "packages/daemon/test/fleet-runtime-recovery.fixtures.ts": 'export const fleetFixture = "fleet";\n',
    "packages/daemon/test/runtime-spawn-settlement.test.ts": fastTest(
      [
        'import { publishExit } from "../src/runtime-spawn-settlement.ts";',
        'import { lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";',
        'import { runtimeProcessFixture } from "./fixtures/runtime-process.ts";',
        "export const value = [publishExit, lifecycleEvent, runtimeProcessFixture];",
        "",
      ].join("\n"),
    ),
    "packages/daemon/test/runtime-spawn-escalation-stop.test.ts": fastTest(
      [
        'import { publishExit } from "../src/runtime-spawn-settlement.ts";',
        'import { lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";',
        "export const value = [publishExit, lifecycleEvent];",
        "",
      ].join("\n"),
    ),
    "packages/daemon/test/fleet-squad-canonical.integration.test.ts": integrationTest(
      [
        'import { squad } from "../src/fleet-squad-coordinator.ts";',
        'import { lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";',
        "export const value = [squad, lifecycleEvent];",
        "",
      ].join("\n"),
    ),
    "packages/daemon/test/fleet-runtime-assignment-ownership.integration.test.ts": integrationTest(
      [
        'import { edge } from "../src/fleet-edge-runtime.ts";',
        'import { fleetFixture } from "./fleet-runtime-recovery.fixtures.ts";',
        "export const value = [edge, fleetFixture];",
        "",
      ].join("\n"),
    ),
    "packages/daemon/test/review-independence-diagnostics.integration.test.ts": integrationTest(
      [
        'import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";',
        'import { runtimeProcessFixture } from "./fixtures/runtime-process.ts";',
        "export const value = [openBootstrappedRepoCell, runtimeProcessFixture];",
        "",
      ].join("\n"),
    ),
    "packages/daemon/test/runtime-spend-cap.integration.test.ts": integrationTest(
      [
        'import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";',
        'import { runtimeProcessFixture } from "./fixtures/runtime-process.ts";',
        "export const value = [openBootstrappedRepoCell, runtimeProcessFixture];",
        "",
      ].join("\n"),
    ),
  };
  for (let index = 0; index < 40; index += 1) {
    files[`packages/daemon/test/unrelated-${index}.integration.test.ts`] = integrationTest(
      `import { unrelatedSpawn } from "../src/unrelated-spawn.ts";\nexport const value = ${index} + unrelatedSpawn;\n`,
    );
  }
  const root = fixture(t, files);
  const testFiles = Object.keys(files).filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/runtime-spawn-settlement.ts"],
    testFiles,
    ratio: 0.25,
  });

  assert.equal(result.integrationTotal, 44);
  assert.equal(result.maxSelected, 11);
  assert.equal(result.truncated, true);
  assert.equal(result.selected.length, 11);
  const selected = new Set(result.selected.map(({ file }) => file));
  for (const target of [
    "packages/daemon/test/fleet-squad-canonical.integration.test.ts",
    "packages/daemon/test/fleet-runtime-assignment-ownership.integration.test.ts",
    "packages/daemon/test/review-independence-diagnostics.integration.test.ts",
    "packages/daemon/test/runtime-spend-cap.integration.test.ts",
    "packages/daemon/test/runtime-spawn-escalation-stop.test.ts",
  ])
    assert.ok(selected.has(target), `${target} must stay inside the cap`);
  assert.equal(result.deferredCount, 35);
  assert.match(result.deferredReason, /35 of 46 affected test files are not run/u);
  assert.match(result.deferredReason, /import-set similarity/u);
  assert.ok(result.deferred.some(({ file }) => file.includes("unrelated-39.integration.test.ts")));
});

test("the full third-slice fixture keeps all five targets when changed tests occupy distance 0", (t) => {
  // The frozen PR #4498 input changed 41 test files as well as the daemon sources. Those
  // changed tests must run, but they must not consume the whole cap and push the known
  // consumers out. This fixture reproduces the shape: 13 changed test files (10 fast,
  // one fast target, two integration targets), a changed fixture that directly covers the
  // settlement, and a large integration layer.
  const files = {
    "packages/daemon/src/runtime-spawn-settlement.ts": "export const settle = true;\n",
    "packages/daemon/src/runtime-spawner.ts":
      'import { settle } from "./runtime-spawn-settlement.ts";\nexport const spawner = settle;\n',
    "packages/daemon/src/runtime-spawn.ts":
      'import { spawner } from "./runtime-spawner.ts";\nexport const spawn = spawner;\n',
    "packages/daemon/src/repo-cell-open.ts":
      'import { spawn } from "./runtime-spawn.ts";\nexport const open = spawn;\n',
    "packages/daemon/src/unrelated-host.ts":
      'import { spawn } from "./runtime-spawn.ts";\nexport const host = spawn;\n',
    "packages/daemon/src/unrelated-spawn.ts":
      'import { host } from "./unrelated-host.ts";\nexport const unrelatedSpawn = host;\n',
    "packages/daemon/test/fixtures/runtime-process.ts":
      'import { settle } from "../../src/runtime-spawn-settlement.ts";\nexport const runtimeProcessFixture = settle;\n',
    "packages/daemon/test/repo-settings.fixture.ts":
      'import { open } from "../src/repo-cell-open.ts";\nexport const openBootstrappedRepoCell = open;\n',
    "packages/daemon/test/fleet-squad-canonical.integration.test.ts": integrationTest(
      'import { spawner } from "../src/runtime-spawner.ts";\nexport const value = spawner;\n',
    ),
    "packages/daemon/test/fleet-runtime-assignment-ownership.integration.test.ts": integrationTest(
      'import { spawn } from "../src/runtime-spawn.ts";\nexport const value = spawn;\n',
    ),
    "packages/daemon/test/runtime-spawn-escalation-stop.test.ts": fastTest(
      'import { settle } from "../src/runtime-spawn-settlement.ts";\nexport const value = settle;\n',
    ),
    "packages/daemon/test/review-independence-diagnostics.integration.test.ts": integrationTest(
      'import { runtimeProcessFixture } from "./fixtures/runtime-process.ts";\nexport const value = runtimeProcessFixture;\n',
    ),
    "packages/daemon/test/runtime-spend-cap.integration.test.ts": integrationTest(
      'import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";\nexport const value = openBootstrappedRepoCell;\n',
    ),
  };
  const changedTests = [
    "packages/daemon/test/fleet-squad-canonical.integration.test.ts",
    "packages/daemon/test/fleet-runtime-assignment-ownership.integration.test.ts",
    "packages/daemon/test/runtime-spawn-escalation-stop.test.ts",
  ];
  for (let index = 0; index < 10; index += 1) {
    const file = `packages/daemon/test/changed-${index}.test.ts`;
    files[file] = fastTest(
      'import { settle } from "../src/runtime-spawn-settlement.ts";\nexport const value = settle;\n',
    );
    changedTests.push(file);
  }
  for (let index = 0; index < 20; index += 1) {
    files[`packages/daemon/test/direct-${index}.test.ts`] = fastTest(
      'import { settle } from "../src/runtime-spawn-settlement.ts";\nexport const value = settle;\n',
    );
  }
  for (let index = 0; index < 100; index += 1) {
    files[`packages/daemon/test/unrelated-${index}.integration.test.ts`] = integrationTest(
      `import { unrelatedSpawn } from "../src/unrelated-spawn.ts";\nexport const value = ${index} + unrelatedSpawn;\n`,
    );
  }
  const root = fixture(t, files);
  const testFiles = Object.keys(files).filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
  const result = selectAffectedTests({
    root,
    changedFiles: [
      "packages/daemon/src/runtime-spawn-settlement.ts",
      "packages/daemon/src/runtime-spawn.ts",
      "packages/daemon/src/repo-cell-open.ts",
      "packages/daemon/test/fixtures/runtime-process.ts",
      ...changedTests,
    ],
    testFiles,
    ratio: 0.25,
  });

  assert.equal(result.integrationTotal, 104);
  assert.equal(result.maxSelected, 26);
  assert.equal(result.selected.length, 26);
  assert.equal(result.truncated, true);
  const selected = new Set(result.selected.map(({ file }) => file));
  for (const target of [
    "packages/daemon/test/fleet-squad-canonical.integration.test.ts",
    "packages/daemon/test/fleet-runtime-assignment-ownership.integration.test.ts",
    "packages/daemon/test/review-independence-diagnostics.integration.test.ts",
    "packages/daemon/test/runtime-spend-cap.integration.test.ts",
    "packages/daemon/test/runtime-spawn-escalation-stop.test.ts",
  ])
    assert.ok(selected.has(target), `${target} must stay inside the cap`);
  assert.match(result.deferredReason, /Changed test files always run/u);
  assert.ok(result.deferredCount > 0);
});

test("a far test stays behind nearer tests even when it shares the anchor fixture", (t) => {
  const root = fixture(t, {
    "packages/daemon/src/leaf.ts": "export const leaf = 1;\n",
    "packages/daemon/src/middle.ts": 'import { leaf } from "./leaf.ts";\nexport const middle = leaf;\n',
    "packages/daemon/src/far.ts": 'import { middle } from "./middle.ts";\nexport const far = middle;\n',
    "packages/daemon/test/shared.fixtures.ts": 'export const shared = "shared";\n',
    "packages/daemon/test/anchor.integration.test.ts": integrationTest(
      'import { leaf } from "../src/leaf.ts";\nimport { shared } from "./shared.fixtures.ts";\nexport const value = [leaf, shared];\n',
    ),
    "packages/daemon/test/near.integration.test.ts": integrationTest(
      'import { leaf } from "../src/leaf.ts";\nexport const value = leaf;\n',
    ),
    "packages/daemon/test/far.integration.test.ts": integrationTest(
      'import { far } from "../src/far.ts";\nimport { shared } from "./shared.fixtures.ts";\nexport const value = [far, shared];\n',
    ),
  });
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/leaf.ts"],
    testFiles: [
      "packages/daemon/test/anchor.integration.test.ts",
      "packages/daemon/test/near.integration.test.ts",
      "packages/daemon/test/far.integration.test.ts",
    ],
    ratio: 0.25,
  });
  assert.equal(result.maxSelected, 1);
  assert.deepEqual(
    result.selected.map(({ file }) => file),
    ["packages/daemon/test/anchor.integration.test.ts"],
  );
  assert.deepEqual(
    result.deferred.map(({ file }) => file),
    ["packages/daemon/test/near.integration.test.ts", "packages/daemon/test/far.integration.test.ts"],
  );
});

test("a changed file with no direct test still caps instead of failing the rank", (t) => {
  const files = {
    "packages/daemon/src/leaf.ts": "export const leaf = 1;\n",
    "packages/daemon/src/middle.ts": 'import { leaf } from "./leaf.ts";\nexport const middle = leaf;\n',
  };
  for (let index = 0; index < 5; index += 1) {
    files[`packages/daemon/test/suite-${index}.integration.test.ts`] = integrationTest(
      'import { middle } from "../src/middle.ts";\nexport const value = middle;\n',
    );
  }
  const root = fixture(t, files);
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/daemon/src/leaf.ts"],
    testFiles: Object.keys(files).filter((file) => file.includes(".integration.test.")),
    ratio: 0.2,
  });
  assert.equal(result.maxSelected, 1);
  assert.equal(result.selected.length, 1);
  assert.equal(result.deferredCount, 4);
  assert.match(result.deferredReason, /4 of 5 affected test files are not run/u);
});

test("a test-shaped file outside the node manifest fails closed instead of yielding a smaller green set", (t) => {
  const root = fixture(t, {
    "packages/gui/test/page.vitest.ts": "export const value = 1;\n",
  });
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/gui/test/page.vitest.ts"],
    testFiles: [],
  });

  assert.deepEqual(result.unmapped, ["packages/gui/test/page.vitest.ts"]);
  assert.deepEqual(result.selected, []);
});

test("non-code changes are reported as ignored and never become tests", (t) => {
  const root = fixture(t, {
    "packages/daemon/src/leaf.ts": "export const leaf = 1;\n",
    "packages/daemon/test/leaf.test.ts": '// harness-test-tier: fast\nexport { leaf } from "../src/leaf.ts";\n',
    "docs-release/release-posture.md": "# posture\n",
  });
  const result = selectAffectedTests({
    root,
    changedFiles: ["docs-release/release-posture.md", "packages/daemon/src/leaf.ts"],
    testFiles: ["packages/daemon/test/leaf.test.ts"],
    ratio: 1,
  });

  assert.deepEqual(result.ignored, ["docs-release/release-posture.md"]);
  assert.deepEqual(
    result.selected.map(({ file }) => file),
    ["packages/daemon/test/leaf.test.ts"],
  );
});

test("graph discovery skips build output and accepts repository-relative code roots", (t) => {
  const root = fixture(t, {
    "packages/daemon/src/leaf.ts": "export const leaf = 1;\n",
    "packages/daemon/node_modules/dependency/index.js": "export const dependency = 1;\n",
    "packages/daemon/dist/leaf.js": "export const leaf = 1;\n",
    "scripts/release.mjs": "export const release = 1;\n",
  });

  assert.deepEqual(listImportGraphFiles(root), ["packages/daemon/src/leaf.ts", "scripts/release.mjs"]);
});

test("non-normalized changed paths are rejected before selection", (t) => {
  const root = fixture(t, {
    "packages/daemon/src/leaf.ts": "export const leaf = 1;\n",
    "packages/daemon/test/leaf.test.ts": '// harness-test-tier: fast\nexport { leaf } from "../src/leaf.ts";\n',
  });
  const result = selectAffectedTests({
    root,
    changedFiles: ["../outside.ts"],
    testFiles: ["packages/daemon/test/leaf.test.ts"],
  });

  assert.deepEqual(result.invalid, ["../outside.ts"]);
  assert.deepEqual(result.selected, []);
});

test("GUI Vitest suites are reached via reverse imports while Node test discovery stays pure", (t) => {
  const root = fixture(t, {
    "packages/gui/src/renderer/App.tsx": "export const App = () => null;\n",
    "packages/gui/src/renderer/shell.tsx": 'import { App } from "./App.tsx";\nexport const Shell = App;\n',
    "packages/gui/src/main/ipc.ts": "export const ipc = true;\n",
    "packages/gui/test/app-direct.vitest.ts":
      'import { App } from "../src/renderer/App.tsx";\nexport const tested = App;\n',
    "packages/gui/test/nested/shell.vitest.tsx":
      'import { Shell } from "../../src/renderer/shell.tsx";\nexport const tested = Shell;\n',
    "packages/gui/test/unrelated.vitest.tsx": "export const tested = 1;\n",
    "packages/gui/test/main-ipc.test.ts": fastTest(
      'import { ipc } from "../src/main/ipc.ts";\nexport const tested = ipc;\n',
    ),
  });

  // Node manifest discovery must stay pure (no .vitest.ts(x) files, no tier-marker error).
  assert.deepEqual(discoverTestFiles(root), ["packages/gui/test/main-ipc.test.ts"]);
  assert.deepEqual(discoverTestTierManifest(root), {
    fast: ["packages/gui/test/main-ipc.test.ts"],
    contract: [],
    integration: [],
  });
  assert.deepEqual(discoverGuiVitestFiles(root), [
    "packages/gui/test/app-direct.vitest.ts",
    "packages/gui/test/nested/shell.vitest.tsx",
    "packages/gui/test/unrelated.vitest.tsx",
  ]);

  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/gui/src/renderer/App.tsx"],
  });

  assert.deepEqual(result.unmapped, []);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.nodeSelected, []);
  assert.deepEqual(result.vitestSelected, [
    { file: "packages/gui/test/app-direct.vitest.ts", via: "packages/gui/src/renderer/App.tsx", changed: false },
    { file: "packages/gui/test/nested/shell.vitest.tsx", via: "packages/gui/src/renderer/App.tsx", changed: false },
  ]);
  assert.deepEqual(result.selected, result.vitestSelected);

  // Directly editing a discovered GUI Vitest file selects it instead of marking it unmapped.
  const directEdit = selectAffectedTests({
    root,
    changedFiles: ["packages/gui/test/unrelated.vitest.tsx"],
  });
  assert.deepEqual(directEdit.unmapped, []);
  assert.deepEqual(directEdit.changedTests, ["packages/gui/test/unrelated.vitest.tsx"]);
  assert.deepEqual(directEdit.vitestSelected, [
    { file: "packages/gui/test/unrelated.vitest.tsx", via: "packages/gui/test/unrelated.vitest.tsx", changed: true },
  ]);
  assert.deepEqual(directEdit.nodeSelected, []);
});

test("mixed Node and GUI changes keep Node and Vitest selections cleanly separated across caps", (t) => {
  const files = {
    "packages/shared/package.json": JSON.stringify({
      name: "@harness-anything/shared-fixture",
      exports: { ".": "./src/index.ts" },
    }),
    "packages/shared/src/index.ts": "export const shared = 1;\n",
    "packages/gui/test/shared-view.vitest.tsx":
      'import { shared } from "@harness-anything/shared-fixture";\nexport const view = shared;\n',
  };
  for (let index = 0; index < 5; index += 1) {
    files[`packages/daemon/test/suite-${index}.integration.test.ts`] = integrationTest(
      'import { shared } from "@harness-anything/shared-fixture";\nexport const value = shared;\n',
    );
  }
  const root = fixture(t, files);
  const result = selectAffectedTests({
    root,
    changedFiles: ["packages/shared/src/index.ts"],
    ratio: 0.2,
  });

  assert.equal(result.integrationTotal, 5);
  assert.equal(result.maxSelected, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.deferredCount, 4);
  assert.deepEqual(
    result.nodeSelected.map(({ file }) => file),
    ["packages/daemon/test/suite-0.integration.test.ts"],
  );
  assert.deepEqual(
    result.vitestSelected.map(({ file }) => file),
    ["packages/gui/test/shared-view.vitest.tsx"],
  );
  assert.deepEqual(
    result.selected.map(({ file }) => file),
    ["packages/daemon/test/suite-0.integration.test.ts", "packages/gui/test/shared-view.vitest.tsx"],
  );
  // Node test runner list must never receive .vitest.ts(x) files.
  assert.equal(
    result.nodeSelected.some(({ file }) => /\.vitest\.tsx?$/u.test(file)),
    false,
  );
});

test("repository App.tsx change selects real reverse-dependent GUI Vitest files without polluting Node tests", async () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  assert.deepEqual(discoverGuiVitestFiles(repoRoot), await collectGuiVitestFiles(repoRoot));
  assert.equal(
    discoverTestFiles(repoRoot).some((file) => /\.vitest\.tsx?$/u.test(file)),
    false,
  );

  const result = selectAffectedTests({
    root: repoRoot,
    changedFiles: ["packages/gui/src/renderer/App.tsx"],
  });

  assert.deepEqual(result.unmapped, []);
  assert.equal(result.truncated, false);
  assert.ok(result.vitestSelected.length > 0, "modifying App.tsx must select reverse-dependent Vitest suites");
  assert.ok(
    result.vitestSelected.some(({ file }) => file.endsWith(".vitest.tsx")),
    "must include .vitest.tsx component suites importing App.tsx",
  );
  for (const entry of result.vitestSelected) {
    assert.ok(entry.file.startsWith("packages/gui/test/"), entry.file);
    assert.match(entry.file, /\.vitest\.tsx?$/u);
    assert.equal(entry.via, "packages/gui/src/renderer/App.tsx");
  }
  assert.equal(
    result.nodeSelected.some(({ file }) => /\.vitest\.tsx?$/u.test(file)),
    false,
  );
});

test("GUI Vitest discovery and import graph match collectGuiVitestFiles under nested out/app-node_modules/dist-electron subdirectories while preserving Node exclusions", async (t) => {
  const root = fixture(t, {
    "packages/gui/package.json": JSON.stringify({
      name: "@harness-anything/gui-fixture",
      exports: { ".": "./src/gadget.ts" },
    }),
    "packages/gui/src/gadget.ts": "export const gadget = 1;\n",
    "packages/gui/test/out/gadget.vitest.tsx":
      'import { gadget } from "../../src/gadget.ts";\nexport const view = gadget;\n',
    "packages/gui/test/app-node_modules/nested.vitest.ts":
      'import { gadget } from "../../src/gadget.ts";\nexport const extra = gadget;\n',
    "packages/gui/test/dist/ignored.vitest.ts": 'import { gadget } from "../../src/gadget.ts";\n',
    "packages/gui/test/coverage/ignored.vitest.ts": 'import { gadget } from "../../src/gadget.ts";\n',
    "packages/gui/test/node_modules/ignored.vitest.ts": 'import { gadget } from "../../src/gadget.ts";\n',
    "packages/daemon/out/ignored-node.test.ts": "// intentionally unlabelled build output under out/\n",
    "packages/daemon/test/real.test.ts": fastTest("export const ok = 1;\n"),
  });

  const runnerList = await collectGuiVitestFiles(root);
  const manifestVitestList = discoverGuiVitestFiles(root);
  assert.deepEqual(manifestVitestList, runnerList);
  assert.deepEqual(manifestVitestList, [
    "packages/gui/test/app-node_modules/nested.vitest.ts",
    "packages/gui/test/out/gadget.vitest.tsx",
  ]);
  // Node test discovery still ignores `out/`!
  assert.deepEqual(discoverTestFiles(root), ["packages/daemon/test/real.test.ts"]);

  const selected = selectAffectedTests({
    root,
    changedFiles: ["packages/gui/src/gadget.ts"],
  });
  assert.deepEqual(selected.unmapped, []);
  assert.deepEqual(
    selected.vitestSelected.map(({ file }) => file),
    ["packages/gui/test/app-node_modules/nested.vitest.ts", "packages/gui/test/out/gadget.vitest.tsx"],
  );
  assert.deepEqual(selected.nodeSelected, []);
});

test("resolved non-JS/TS static import targets (GUI JSON locales and CSS modules) seed reverse BFS on modify and delete while unimported assets stay ignored", (t) => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  for (const [assetPath, expectedTest] of [
    [
      "packages/gui/src/renderer/i18n/locales/en-US/components.json",
      "packages/gui/test/decision-state-vocabulary.vitest.ts",
    ],
    ["packages/gui/src/renderer/components/primitives/Button.css", "packages/gui/test/button-feedback.vitest.tsx"],
  ]) {
    const selection = selectAffectedTests({
      root: repoRoot,
      changedFiles: [assetPath],
    });
    assert.deepEqual(selection.unmapped, []);
    assert.deepEqual(selection.ignored, []);
    assert.equal(
      selection.nodeSelected.some(({ file }) => /\.vitest\.tsx?$/u.test(file)),
      false,
    );
    assert.ok(
      selection.vitestSelected.some(({ file, via }) => file === expectedTest && via === assetPath),
      `expected ${expectedTest} via ${assetPath}, got ${JSON.stringify(selection.vitestSelected)}`,
    );
  }

  const root = fixture(t, {
    "packages/gui/src/renderer/Button.css": ".btn { color: red; }\n",
    "packages/gui/src/renderer/locale.json": '{"ok":"Yes"}\n',
    "packages/gui/src/renderer/unused.json": '{"unused":true}\n',
    "packages/gui/src/renderer/Button.tsx":
      'import "./Button.css";\nimport locale from "./locale.json";\nimport "./deleted.css";\nexport const label = locale.ok;\n',
    "packages/gui/test/button.vitest.tsx":
      'import { label } from "../src/renderer/Button.tsx";\nexport const tested = label;\n',
  });

  const modifiedCss = selectAffectedTests({
    root,
    changedFiles: ["packages/gui/src/renderer/Button.css"],
  });
  assert.deepEqual(modifiedCss.ignored, []);
  assert.deepEqual(modifiedCss.vitestSelected, [
    { file: "packages/gui/test/button.vitest.tsx", via: "packages/gui/src/renderer/Button.css", changed: false },
  ]);

  const deletedImportedCss = selectAffectedTests({
    root,
    changedFiles: ["packages/gui/src/renderer/deleted.css"],
  });
  assert.deepEqual(deletedImportedCss.ignored, []);
  assert.deepEqual(deletedImportedCss.vitestSelected, [
    { file: "packages/gui/test/button.vitest.tsx", via: "packages/gui/src/renderer/deleted.css", changed: false },
  ]);

  const unimportedAsset = selectAffectedTests({
    root,
    changedFiles: ["packages/gui/src/renderer/unused.json", "packages/gui/src/renderer/deleted-unused.json"],
  });
  assert.deepEqual(unimportedAsset.selected, []);
  assert.deepEqual(unimportedAsset.vitestSelected, []);
  assert.deepEqual(unimportedAsset.ignored, [
    "packages/gui/src/renderer/unused.json",
    "packages/gui/src/renderer/deleted-unused.json",
  ]);
});
