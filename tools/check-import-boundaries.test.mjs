// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
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

test("import boundary check fails closed on invalid allowlist JSON", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-import-boundary-policy-"));
  try {
    writeFileSync(path.join(policyRoot, "check-import-boundaries.json"), "{ invalid json", "utf8");

    const result = runChecker(root, { env: { HARNESS_GATE_ALLOWLIST_DIR: policyRoot } });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Gate allowlist load failed for check-import-boundaries/);
    assert.match(result.stderr, /not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("import boundary check fails closed on allowlist entries without refs", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-import-boundary-policy-"));
  try {
    writeFileSync(path.join(policyRoot, "check-import-boundaries.json"), JSON.stringify({
      schema: "harness-anything/gate-allowlist/v1",
      gateId: "check-import-boundaries",
      entries: {
        guiAdapterCompositionRoots: [
          {
            value: "packages/gui/src/main/local-composition-root.ts",
            reason: "fixture omits ref"
          }
        ],
        cliAdapterCompositionRoots: [
          {
            value: "packages/cli/src/index.ts",
            ref: "ADR-0022#D3",
            reason: "fixture includes ref"
          }
        ],
        kernelStoreCompositionRoots: [
          {
            value: "packages/kernel/src/composition/index.ts",
            ref: "dec_mra9ag8o",
            reason: "fixture includes ref"
          }
        ],
        cliAdapterKnownDebt: [
          {
            value: "packages/cli/src/commands/lifecycle.ts",
            ref: "dec_GATE_DEFENSE_ROOT_CAUSE",
            reason: "fixture includes ref"
          }
        ]
      }
    }), "utf8");

    const result = runChecker(root, { env: { HARNESS_GATE_ALLOWLIST_DIR: policyRoot } });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must include a non-empty ref/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("import boundary check allows application imports from kernel public contracts", () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "import type { DomainStatus } from '@harness-anything/kernel';",
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

test("import boundary check confines kernel store imports to the kernel composition root", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/kernel/src/composition"), { recursive: true });
    mkdirSync(path.join(root, "packages/kernel/src/store"), { recursive: true });
    mkdirSync(path.join(root, "packages/kernel/src/application"), { recursive: true });
    writeFileSync(path.join(root, "packages/kernel/src/index.ts"), [
      "export { makeStore } from './composition/index.ts';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/composition/index.ts"), [
      "import { makeStore } from '../store/index.ts';",
      "export { makeStore };"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/application/service.ts"), [
      "import { makeStore } from '../store/index.ts';",
      "export const service = makeStore;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "import { makeStore } from '@harness-anything/kernel';",
      "export const appStore = makeStore;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/store/index.ts"), [
      "export function makeStore() {",
      "  return {};",
      "}"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/kernel\/src\/application\/service\.ts/);
    assert.match(result.stderr, /store implementation is internal to the kernel and must be obtained via the packages\/kernel\/src\/composition\/ seam/u);
    assert.doesNotMatch(result.stderr, /packages\/kernel\/src\/composition\/index\.ts/);
    assert.doesNotMatch(result.stderr, /packages\/application\/src\/index\.ts/);
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
      "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
      "export const bridge = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/gui/src/main/local-composition-root.ts"), [
      "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
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
      "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
      "export const engine = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/cli/src/commands/lifecycle.ts"), [
      "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
      "export const engine = makeLocalLifecycleEngine;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/cli/src/commands/new-command.ts"), [
      "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
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

test("import boundary check rejects package modules outside distribution that are only re-exported by the root barrel", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/gui/src/terminal"), { recursive: true });
    writeFileSync(path.join(root, "packages/gui/src/index.ts"), [
      "export { unusedPolicy } from './terminal/unused-policy.ts';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/gui/src/terminal/unused-policy.ts"), [
      "export const unusedPolicy = true;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/gui\/src\/terminal\/unused-policy\.ts/);
    assert.match(result.stderr, /only re-exported from its package barrel/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check does not treat package entry imports as barrel re-exports", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/cli/src/cli"), { recursive: true });
    writeFileSync(path.join(root, "packages/cli/src/index.ts"), [
      "import { parseArgs } from './cli/parse-args.ts';",
      "export function main(argv) { return parseArgs(argv); }"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/cli/src/cli/parse-args.ts"), [
      "export function parseArgs(argv) {",
      "  return argv;",
      "}"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check counts matching package barrel imports as real consumers only for imported names", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "export { liveGate } from './live-gate.ts';",
      "export { orphanGate } from './orphan-gate.ts';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/application/src/live-gate.ts"), [
      "export const liveGate = true;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/application/src/orphan-gate.ts"), [
      "export const orphanGate = true;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/cli/src/commands/check.ts"), [
      "import { liveGate } from '@harness-anything/application';",
      "export const checked = liveGate;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /packages\/application\/src\/live-gate\.ts/);
    assert.match(result.stderr, /packages\/application\/src\/orphan-gate\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check treats tools imports as real package module consumers", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/gui/src/distribution"), { recursive: true });
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(path.join(root, "packages/gui/src/index.ts"), [
      "export { releaseGate } from './distribution/release-gate.ts';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/gui/src/distribution/release-gate.ts"), [
      "export const releaseGate = true;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "tools/check-release-gate.mjs"), [
      "import { releaseGate } from '../packages/gui/src/distribution/release-gate.ts';",
      "if (!releaseGate) process.exit(1);"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package-form mutations cover every import-boundary rule class", async (context) => {
  const mutations = [
    ["domain upper kernel layer", "packages/kernel/src/domain/package-probe.ts", "@harness-anything/kernel/ports/package-probe", "packages/kernel/src/ports/package-probe.ts", /domain layer imports upper kernel layer/u],
    ["ports implementation layer", "packages/kernel/src/ports/package-probe.ts", "@harness-anything/kernel/application/package-probe", "packages/kernel/src/application/package-probe.ts", /ports layer imports implementation\/controller layer/u],
    ["global kernel store boundary", "packages/daemon/src/package-probe.ts", "@harness-anything/kernel/store/package-probe", "packages/kernel/src/store/package-probe.ts", /store implementation is internal to the kernel/u],
    ["application kernel store boundary", "packages/application/src/package-probe.ts", "@harness-anything/kernel/store/package-probe", "packages/kernel/src/store/package-probe.ts", /application layer imports store\/adapter\/controller implementation/u],
    ["GUI kernel store boundary", "packages/gui/src/package-probe.ts", "@harness-anything/kernel/store/package-probe", "packages/kernel/src/store/package-probe.ts", /GUI imports store or external adapter implementation/u],
    ["CLI kernel store boundary", "packages/cli/src/package-probe.ts", "@harness-anything/kernel/store/package-probe", "packages/kernel/src/store/package-probe.ts", /CLI imports GUI, adapter, or store implementation/u],
    ["domain legacy runtime", "packages/kernel/src/domain/package-probe.ts", "@harness-anything/scripts/kernel/task/package-probe", null, /domain layer imports legacy runtime/u],
    ["domain IO runtime", "packages/kernel/src/domain/package-probe.ts", "node:fs", null, /domain layer imports IO\/runtime module/u],
    ["ports controller package", "packages/kernel/src/ports/package-probe.ts", "@harness-anything/cli", null, /ports layer imports implementation\/controller layer/u],
    ["CLI GUI package", "packages/cli/src/package-probe.ts", "@harness-anything/gui", null, /CLI imports GUI, adapter, or store implementation/u],
    ["production old runtime package", "packages/daemon/src/package-probe.ts", "@harness-anything/scripts/kernel/task/package-probe", null, /production package imports old runtime/u]
  ];
  for (const mutation of mutations) await context.test(mutation[0], () => assertPackageMutation(...mutation.slice(1)));
});

test("import boundary check counts explicit package subpaths as real orphan-module consumers", () => {
  const root = makeFixtureRoot();
  try {
    addPackageExport(root, "packages/application", "./live-gate", "./src/live-gate.ts");
    writeFileSync(path.join(root, "packages/application/src/index.ts"), "export { liveGate } from './live-gate.ts';\n", "utf8");
    writeFileSync(path.join(root, "packages/application/src/live-gate.ts"), "export const liveGate = true;\n", "utf8");
    writeFileSync(path.join(root, "packages/daemon/src/package-consumer.ts"), "import { liveGate } from '@harness-anything/application/live-gate';\nexport const consumed = liveGate;\n", "utf8");

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check allows explicitly slice-activated package modules", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/gui/src/distribution"), { recursive: true });
    writeFileSync(path.join(root, "packages/gui/src/index.ts"), [
      "export { plannedPolicy } from './distribution/planned-policy.ts';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/gui/src/distribution/planned-policy.ts"), [
      "/** @slice-activation M4 packaging owns this policy surface. */",
      "export const plannedPolicy = true;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-import-boundary-"));
  for (const [packageRoot, name] of [
    ["packages/application", "@harness-anything/application"],
    ["packages/adapters/local", "@harness-anything/adapter-local"],
    ["packages/kernel", "@harness-anything/kernel"],
    ["packages/daemon", "@harness-anything/daemon"],
    ["packages/preset", "@harness-anything/preset"],
    ["packages/cli", "@harness-anything/cli"],
    ["packages/gui", "@harness-anything/gui"]
  ]) {
    mkdirSync(path.join(root, packageRoot, "src"), { recursive: true });
    writeFileSync(path.join(root, packageRoot, "package.json"), JSON.stringify({
      name,
      type: "module",
      exports: { ".": "./src/index.ts" }
    }), "utf8");
  }
  return root;
}

function addPackageExport(root, packageRoot, exportKey, target) {
  const packagePath = path.join(root, packageRoot, "package.json");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  packageJson.exports[exportKey] = target;
  writeFileSync(packagePath, JSON.stringify(packageJson), "utf8");
}

function assertPackageMutation(importer, specifier, target, reason) {
  const root = makeFixtureRoot();
  try {
    if (target !== null) {
      addPackageExport(root, "packages/kernel", specifier.replace("@harness-anything/kernel", "."), target.replace("packages/kernel/", "./"));
      mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
      writeFileSync(path.join(root, target), "export const packageProbe = true;\n", "utf8");
    }
    mkdirSync(path.dirname(path.join(root, importer)), { recursive: true });
    writeFileSync(path.join(root, importer), `import { packageProbe } from '${specifier}';\nexport const observed = packageProbe;\n`, "utf8");
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeLocalAdapter(root) {
  writeFileSync(path.join(root, "packages/adapters/local/src/index.ts"), [
    "export function makeLocalLifecycleEngine() {",
    "  return {};",
    "}"
  ].join("\n"), "utf8");
}

function runChecker(cwd, options = {}) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {})
    }
  });
}
