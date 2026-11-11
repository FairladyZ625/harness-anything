// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildImportGraph, listImportGraphFiles, selectAffectedTests } from "./affected-tests.mjs";

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

test("a selection above the whole-tier ratio is reported in full instead of truncated", (t) => {
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
  assert.equal(result.tooMany, true);
  assert.equal(result.selected.length, 3);
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
