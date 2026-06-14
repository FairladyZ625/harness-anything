import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-import-boundaries.mjs");

test("import boundary check rejects application imports from adapters", () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "import { makeLocalLifecycleEngine } from '../../adapters/local/src/index.ts';",
      "export const engine = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/adapters/local/src/index.ts"), [
      "export function makeLocalLifecycleEngine() {",
      "  return {};",
      "}"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /application layer imports store\/adapter\/controller implementation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check allows application imports from kernel public contracts", () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "import type { DomainStatus } from '../../kernel/src/index.ts';",
      "export const status: DomainStatus = 'planned';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/index.ts"), [
      "export type DomainStatus = 'planned';"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Import boundary check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check restricts GUI adapter imports to local composition root", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/gui/src/api"), { recursive: true });
    mkdirSync(path.join(root, "packages/gui/src/main"), { recursive: true });
    writeFileSync(path.join(root, "packages/gui/src/api/service-bridge.ts"), [
      "import { makeLocalLifecycleEngine } from '../../../adapters/local/src/index.ts';",
      "export const bridge = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/gui/src/main/local-composition-root.ts"), [
      "import { makeLocalLifecycleEngine } from '../../../adapters/local/src/index.ts';",
      "export const bridge = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeLocalAdapter(root);

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/gui\/src\/api\/service-bridge\.ts/);
    assert.doesNotMatch(result.stderr, /packages\/gui\/src\/main\/local-composition-root\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check blocks new CLI adapter imports outside allowlisted debt", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
    writeFileSync(path.join(root, "packages/cli/src/index.ts"), [
      "import { makeLocalLifecycleEngine } from '../../adapters/local/src/index.ts';",
      "export const engine = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/cli/src/commands/lifecycle.ts"), [
      "import { makeLocalLifecycleEngine } from '../../../adapters/local/src/index.ts';",
      "export const engine = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/cli/src/commands/new-command.ts"), [
      "import { makeLocalLifecycleEngine } from '../../../adapters/local/src/index.ts';",
      "export const engine = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeLocalAdapter(root);

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/cli\/src\/commands\/new-command\.ts/);
    assert.doesNotMatch(result.stderr, /packages\/cli\/src\/commands\/lifecycle\.ts/);
    assert.doesNotMatch(result.stderr, /packages\/cli\/src\/index\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-import-boundary-"));
  for (const dir of [
    "packages/application/src",
    "packages/adapters/local/src",
    "packages/kernel/src"
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

function writeLocalAdapter(root) {
  writeFileSync(path.join(root, "packages/adapters/local/src/index.ts"), [
    "export function makeLocalLifecycleEngine() {",
    "  return {};",
    "}"
  ].join("\n"), "utf8");
}

function runChecker(cwd) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd,
    encoding: "utf8"
  });
}
