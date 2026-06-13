import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateLegacyIntakeReadiness } from "./check-legacy-intake-readiness.mjs";

test("Legacy Intake readiness rejects old runtime production references", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "packages/kernel/src/index.ts"), "export const oldPath = 'scripts/kernel/task';\n");

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("retired old runtime")), true);
  });
});

test("Legacy Intake readiness allows old runtime references in tests and behavior report", async () => {
  await withFixtureRepo(async (root) => {
    mkdirSync(path.join(root, "packages/kernel/test"), { recursive: true });
    writeFileSync(path.join(root, "packages/kernel/src/index.ts"), "export const ok = true;\n");
    writeFileSync(path.join(root, "packages/kernel/test/legacy.test.ts"), "const oldPath = 'scripts/kernel/task';\n");

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.deepEqual(violations, []);
  });
});

test("Legacy Intake readiness ignores private harness files inside local worktrees", async () => {
  await withFixtureRepo(async (root) => {
    mkdirSync(path.join(root, ".worktrees/gui-prototype-private-context/.harness-private"), { recursive: true });
    writeFileSync(path.join(root, ".worktrees/gui-prototype-private-context/.harness-private/AGENTS.md"), [
      "Local-only harness note.",
      "It may mention scripts/kernel/task and requestTransition because it is not public surface.",
      "It may also mention coding-agent-harness compatibility.",
      ""
    ].join("\n"));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.deepEqual(violations, []);
  });
});

test("Legacy Intake readiness requires the harness-anything CLI package artifact bin surface", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "packages/cli/package.json"), JSON.stringify({
      name: "@harness-anything/cli",
      private: true,
      type: "module"
    }));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("bin.harness-anything")), true);
  });
});

test("Legacy Intake readiness dynamically rejects public legacy compatibility promises", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "PUBLIC-COMPAT.md"), "This promises coding-agent-harness compatibility.\n");

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("PUBLIC-COMPAT.md")), true);
  });
});

test("Legacy Intake readiness rejects retired runtime paths in root package scripts", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "harness-anything",
      private: true,
      scripts: {
        legacy: "node scripts-refactor/run.mjs"
      },
      dependencies: {
        effect: "3.21.2"
      }
    }));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("package.json") && violation.includes("retired old runtime")), true);
  });
});

test("Legacy Intake readiness rejects retired full-cutover package script gate names", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "harness-anything",
      private: true,
      scripts: {
        "harness:smoke-full-cutover": "node tools/smoke-full-cutover.mjs",
        "harness:check-cutover-readiness": "node tools/check-cutover-readiness.mjs"
      },
      dependencies: {
        effect: "3.21.2"
      }
    }));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("smoke-full-cutover") || violation.includes("check-cutover-readiness")), true);
  });
});

test("Legacy Intake readiness rejects forbidden runtime APIs in public markdown", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "README.md"), "Use requestTransition for lifecycle control.\n");

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("README.md") && violation.includes("forbidden runtime-control")), true);
  });
});

test("Legacy Intake readiness rejects retired runtime paths in GitHub workflow config", async () => {
  await withFixtureRepo(async (root) => {
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(path.join(root, ".github/workflows/rewrite-ci.yml"), [
      "name: rewrite-ci",
      "jobs:",
      "  legacy:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: node scripts/kernel/task/check.mjs",
      ""
    ].join("\n"));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes(".github/workflows/rewrite-ci.yml") && violation.includes("retired old runtime")), true);
  });
});

test("Legacy Intake readiness requires machine-checkable behavior corpus input", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "tools/legacy-intake/behavior-corpus-classification.json"), JSON.stringify({
      categories: {
        preserve: 0,
        "intentional-change": 0,
        "old-bug": 0,
        "unsupported-input": 0,
        "needs-decision": 1
      }
    }));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("needs-decision")), true);
  });
});

test("Legacy Intake readiness requires behavior item counts to match categories", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "tools/legacy-intake/behavior-corpus-classification.json"), JSON.stringify({
      categories: {
        preserve: 1,
        "intentional-change": 0,
        "old-bug": 0,
        "unsupported-input": 0,
        "needs-decision": 0
      },
      items: []
    }));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("does not match")), true);
  });
});

test("Legacy Intake readiness requires a non-trivial behavior corpus", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "tools/legacy-intake/behavior-corpus-classification.md"), [
      "# Behavior Corpus Classification",
      "",
      "Machine-checkable source: `behavior-corpus-classification.json`.",
      "",
      "| Classification | Count | Notes |",
      "| --- | ---: | --- |",
      "| preserve | 1 | too small |",
      "| intentional-change | 0 | none |",
      "| old-bug | 0 | none |",
      "| unsupported-input | 0 | none |",
      "| needs-decision | 0 | none |",
      ""
    ].join("\n"));
    writeFileSync(path.join(root, "tools/legacy-intake/behavior-corpus-classification.json"), JSON.stringify({
      categories: {
        preserve: 1,
        "intentional-change": 0,
        "old-bug": 0,
        "unsupported-input": 0,
        "needs-decision": 0
      },
      items: [
        { classification: "preserve", summary: "too small" }
      ]
    }));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("at least 15 classified items")), true);
  });
});

test("Legacy Intake readiness requires Markdown counts to match JSON categories", async () => {
  await withFixtureRepo(async (root) => {
    writeFileSync(path.join(root, "tools/legacy-intake/behavior-corpus-classification.md"), [
      "# Behavior Corpus Classification",
      "",
      "Machine-checkable source: `behavior-corpus-classification.json`.",
      "",
      "| Classification | Count | Notes |",
      "| --- | ---: | --- |",
      "| preserve | 1 | stale count |",
      "| intentional-change | 0 | none |",
      "| old-bug | 0 | none |",
      "| unsupported-input | 0 | none |",
      "| needs-decision | 0 | none |",
      ""
    ].join("\n"));

    const violations = await evaluateLegacyIntakeReadiness(root);

    assert.equal(violations.some((violation) => violation.includes("category preserve count")), true);
  });
});

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-cutover-"));
  try {
    mkdirSync(path.join(root, "packages/kernel/src"), { recursive: true });
    mkdirSync(path.join(root, "packages/cli"), { recursive: true });
    mkdirSync(path.join(root, "tools/legacy-intake"), { recursive: true });
    writeFileSync(path.join(root, "package.json"), JSON.stringify({
      name: "harness-anything",
      private: true,
      dependencies: {
        effect: "3.21.2"
      }
    }));
    writeFileSync(path.join(root, "packages/cli/package.json"), JSON.stringify({
      name: "@harness-anything/cli",
      private: true,
      type: "module",
      scripts: {
        build: "tsc -p tsconfig.build.json"
      },
      bin: {
        "harness-anything": "./dist/cli/src/index.js"
      },
      exports: {
        ".": "./dist/cli/src/index.js"
      },
      files: [
        "dist",
        "README.md",
        "package.json"
      ],
      dependencies: {
        effect: "3.21.2"
      }
    }));
    writeFileSync(path.join(root, "README.md"), "# Harness Anything\n");
    writeValidBehaviorCorpus(root);

    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeValidBehaviorCorpus(root) {
  writeFileSync(path.join(root, "tools/legacy-intake/behavior-corpus-classification.md"), [
    "# Behavior Corpus Classification",
    "",
    "Machine-checkable source: `behavior-corpus-classification.json`.",
    "",
    "| Classification | Count | Notes |",
    "| --- | ---: | --- |",
    "| preserve | 7 | preserved behavior |",
    "| intentional-change | 5 | intentional differences |",
    "| old-bug | 1 | old bug |",
    "| unsupported-input | 2 | unsupported inputs |",
    "| needs-decision | 0 | none |",
    ""
  ].join("\n"));
  writeFileSync(path.join(root, "tools/legacy-intake/behavior-corpus-classification.json"), JSON.stringify({
    categories: {
      preserve: 7,
      "intentional-change": 5,
      "old-bug": 1,
      "unsupported-input": 2,
      "needs-decision": 0
    },
    items: [
      ...Array.from({ length: 7 }, (_, index) => ({ classification: "preserve", summary: `preserve ${index}` })),
      ...Array.from({ length: 5 }, (_, index) => ({ classification: "intentional-change", summary: `intentional ${index}` })),
      { classification: "old-bug", summary: "old compatibility promise" },
      { classification: "unsupported-input", summary: "conflicting legacy tree" },
      { classification: "unsupported-input", summary: "npm publishing deferred" }
    ]
  }));
}
