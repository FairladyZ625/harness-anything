import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-runtime-release-readiness.mjs");

test("runtime release readiness check accepts the expected contract", async () => {
  await withFixtureRepo((root) => {
    writeValidRuntimeReleaseFixture(root);

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Runtime release readiness check passed/u);
  });
});

test("runtime release readiness check rejects missing checker script", async () => {
  await withFixtureRepo((root) => {
    writeValidRuntimeReleaseFixture(root, {
      packageMutator: (packageJson) => {
        delete packageJson.scripts["harness:check-runtime-release-readiness"];
      }
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /harness:check-runtime-release-readiness/u);
  });
});

test("runtime release readiness check rejects CI drift", async () => {
  await withFixtureRepo((root) => {
    writeValidRuntimeReleaseFixture(root, {
      workflowBody: "name: rewrite-ci\njobs:\n  typecheck:\n    steps:\n      - run: npm run typecheck\n"
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rewrite-ci\.yml/u);
  });
});

test("runtime release readiness check rejects release overclaim docs", async () => {
  await withFixtureRepo((root) => {
    writeValidRuntimeReleaseFixture(root, {
      runtimeDocBody: `${validRuntimeDoc()}\n\nSigned installers are shipped.\n`
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /may overclaim signed installer/u);
  });
});

test("runtime release readiness check scans product-line docs and mixed clauses", async () => {
  await withFixtureRepo((root) => {
    writeValidRuntimeReleaseFixture(root);
    writeFile(root, "docs-release/other-notes.md", "Signed installers remain unshipped, but release feeds are available.\n");

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release feed/u);
  });
});

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8"
  });
}

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-runtime-release-"));
  try {
    mkdirSync(path.join(root, "docs-release"), { recursive: true });
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeValidRuntimeReleaseFixture(root, options = {}) {
  const packageJson = {
    name: "harness-anything",
    version: "0.0.0",
    private: true,
    engines: { node: ">=24" },
    scripts: {
      check: "npm run typecheck && npm test && npm run harness:check-runtime-release-readiness && npm run harness:smoke-cli-package",
      "check:pr": "npm run typecheck && npm run harness:check-runtime-release-readiness",
      test: "node tools/run-node-tests.mjs",
      "harness:smoke-cli-package": "node tools/smoke-cli-package.mjs",
      "harness:check-runtime-release-readiness": "node tools/check-runtime-release-readiness.mjs"
    }
  };
  options.packageMutator?.(packageJson);
  writeJson(root, "package.json", packageJson);

  for (const packagePath of [
    "packages/kernel/package.json",
    "packages/application/package.json",
    "packages/daemon/package.json",
    "packages/cli/package.json",
    "packages/gui/package.json",
    "packages/adapters/local/package.json",
    "packages/adapters/multica/package.json",
    "packages/adapters/github-issues/package.json",
    "packages/adapters/linear/package.json"
  ]) {
    const packageJson = packagePath === "packages/cli/package.json"
      ? { name: "@harness-anything/cli", version: "0.1.0", publishConfig: { access: "public" } }
      : { name: packagePath, version: "0.0.0", private: true };
    writeJson(root, packagePath, packageJson);
  }

  writeFile(root, "README.md", [
    "# Harness Anything",
    "The accountability layer for AI agents."
  ].join("\n"));
  writeFile(root, "docs-release/release-posture.md", options.runtimeDocBody ?? validRuntimeDoc());
  writeFile(root, ".github/workflows/rewrite-ci.yml", options.workflowBody ?? validWorkflow());
  writeFile(root, "packages/cli/src/index.ts", "console.log(JSON.stringify({ ok: true, schema: \"command-receipt/v2\", command: \"doctor\", action: \"doctor\", summary: \"completed doctor\", details: { data: { report: { readOnly: true } } }, meta: { generatedAt: \"2026-07-04T00:00:00.000Z\", compatibility: { legacyReceipt: \"CommandReceipt/v1\" } } }));\n");
}

function validRuntimeDoc() {
  return [
    "# Runtime Release",
    "Status: source checkout and package smoke only.",
    "Node 24 and Node 26 are checked.",
    "Run node packages/cli/src/index.ts --json doctor.",
    "Run npm run check.",
    "Run npm run check:pr.",
    "Run npm run harness:smoke-cli-package.",
    "Run npm run -w @harness-anything/gui build.",
    "signed installers, notarized builds, auto-update, release feeds, and published",
    "  artifacts are not shipped."
  ].join("\n");
}

function validWorkflow() {
  return [
    "name: rewrite-ci",
    "jobs:",
    "  full-check:",
    "    strategy:",
    "      matrix:",
    "        node-version: [24, 26]",
    "    steps:",
    "      - run: npm run check",
    "  fast-contract:",
    "    steps:",
    "      - run: npm run test:fast",
    "      - run: npm run test:contract",
    "  integration:",
    "    steps:",
    "      - run: npm run test:integration",
    "  boundaries:",
    "    steps:",
    "      - run: npm run harness:check-runtime-release-readiness",
    "  package-policy:",
    "    steps:",
    "      - run: npm run harness:smoke-cli-package",
    "  gui-build:",
    "    steps:",
    "      - run: npm run -w @harness-anything/gui build"
  ].join("\n");
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, JSON.stringify(value, null, 2));
}

function writeFile(root, relativePath, body) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${body.trimEnd()}\n`, "utf8");
}
