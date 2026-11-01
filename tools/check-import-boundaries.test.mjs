// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-import-boundaries.mjs");

test("Fleet center write frames must use the one center write entry", () => {
  const root = makeFixtureRoot();
  try {
    const centerPath = path.join(root, "packages/daemon/src/fleet/center-listener.ts");
    mkdirSync(path.dirname(centerPath), { recursive: true });
    writeFileSync(
      centerPath,
      [
        'if (frame.schema === "fleet.doc.submit/v1") { return runFleetCenterWrite(frame, async () => { return options.host.run(); }); }',
        'if (frame.schema === "fleet.task.command/v1") { return runFleetCenterWrite(frame, async () => { return options.host.run(); }); }',
        'if (frame.schema === "fleet.schedule.command/v1") { return runFleetCenterWrite(frame, async () => { return options.host.run(); }); }',
        'if (frame.schema === "fleet.runtime.event/v1") { return runFleetCenterWrite(frame, async () => { return options.host.runtimeIngress(); }); }',
        'if (frame.schema === "fleet.runtime.archive/v1") { return runFleetCenterWrite(frame, async () => { return options.host.runtimeIngress(); }); }',
        'if (frame.schema === "fleet.upload.begin/v1") { return runFleetCenterWrite(frame, async () => { return persist(); }); }',
        'if (frame.schema === "fleet.upload.chunk/v1") { return runFleetCenterWrite(frame, async () => { return appendFileSync(); }); }',
        'if (frame.schema === "fleet.upload.finish/v1") { return runFleetCenterWrite(frame, async () => { return renameSync(); }); }',
      ].join("\n"),
    );
    const valid = runChecker(root);
    assert.equal(valid.status, 0, valid.stderr);

    writeFileSync(
      centerPath,
      readFileSync(centerPath, "utf8").replace(
        "return runFleetCenterWrite(frame, async () => { return options.host.run(); });",
        "return options.host.run();",
      ),
    );
    const bypass = runChecker(root);
    assert.notEqual(bypass.status, 0);
    assert.match(bypass.stderr, /fleet\.doc\.submit\/v1 must use its center write entry/u);

    writeFileSync(
      centerPath,
      readFileSync(centerPath, "utf8").replace(
        'if (frame.schema === "fleet.runtime.event/v1") { return runFleetCenterWrite(frame, async () => { return options.host.runtimeIngress(); }); }',
        'if (frame.schema === "fleet.runtime.event/v1") { return options.host.runtimeIngress(); }',
      ),
    );
    const runtimeBypass = runChecker(root);
    assert.notEqual(runtimeBypass.status, 0);
    assert.match(runtimeBypass.stderr, /fleet\.runtime\.event\/v1 must use its center write entry/u);

    const restored = readFileSync(centerPath, "utf8").replace(
      'if (frame.schema === "fleet.runtime.event/v1") { return options.host.runtimeIngress(); }',
      'if (frame.schema === "fleet.runtime.event/v1") { return runFleetCenterWrite(frame, async () => { return options.host.runtimeIngress(); }); }',
    );
    writeFileSync(
      centerPath,
      restored.replace(
        'if (frame.schema === "fleet.upload.chunk/v1") { return runFleetCenterWrite(frame, async () => { return appendFileSync(); }); }',
        'if (frame.schema === "fleet.upload.chunk/v1") { return appendFileSync(); }',
      ),
    );
    const uploadBypass = runChecker(root);
    assert.notEqual(uploadBypass.status, 0);
    assert.match(uploadBypass.stderr, /fleet\.upload\.chunk\/v1 must use its center write entry/u);

    writeFileSync(
      centerPath,
      restored.replace(
        'if (frame.schema === "fleet.upload.chunk/v1") { return runFleetCenterWrite(frame, async () => { return appendFileSync(); }); }',
        'if (frame.schema === "fleet.upload.chunk/v1") { return runFleetCenterWrite(async () => { return appendFileSync(); }); }',
      ),
    );
    const malformedEntry = runChecker(root);
    assert.notEqual(malformedEntry.status, 0);
    assert.match(malformedEntry.stderr, /fleet\.upload\.chunk\/v1 must call the center write entry with its frame/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects application imports from adapters", () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(
      path.join(root, "packages/application/src/index.ts"),
      [
        "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
        "export const engine = makeLocalLifecycleEngine;",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/adapters/local/src/index.ts"),
      ["export function makeLocalLifecycleEngine() {", "  return {};", "}"].join("\n"),
      "utf8",
    );

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
    writeFileSync(
      path.join(policyRoot, "check-import-boundaries.json"),
      JSON.stringify({
        schema: "harness-anything/gate-allowlist/v1",
        gateId: "check-import-boundaries",
        entries: {
          guiAdapterCompositionRoots: [
            {
              value: "packages/gui/src/main/local-composition-root.ts",
              reason: "fixture omits ref",
            },
          ],
          cliAdapterCompositionRoots: [
            {
              value: "packages/cli/src/index.ts",
              ref: "ADR-0022#D3",
              reason: "fixture includes ref",
            },
          ],
          kernelStoreCompositionRoots: [
            {
              value: "packages/kernel/src/composition/index.ts",
              ref: "dec_mra9ag8o",
              reason: "fixture includes ref",
            },
          ],
          cliAdapterKnownDebt: [
            {
              value: "packages/cli/src/commands/lifecycle.ts",
              ref: "dec_GATE_DEFENSE_ROOT_CAUSE",
              reason: "fixture includes ref",
            },
          ],
        },
      }),
      "utf8",
    );

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
    writeFileSync(
      path.join(root, "packages/application/src/index.ts"),
      [
        "import type { DomainStatus } from '@harness-anything/kernel';",
        "export const status: DomainStatus = 'planned';",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/kernel/src/index.ts"),
      ["export type DomainStatus = 'planned';"].join("\n"),
      "utf8",
    );

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Import boundary check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects kernel imports from storage", () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(
      path.join(root, "packages/kernel/src/index.ts"),
      [
        "import { openSqliteEventStore } from '@harness-anything/storage';",
        "export const open = openSqliteEventStore;",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/storage/src/index.ts"),
      "export function openSqliteEventStore() { return {}; }\n",
      "utf8",
    );

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /kernel must not depend on storage/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects storage imports from delivery packages", () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(
      path.join(root, "packages/storage/src/index.ts"),
      "import { startDaemon } from '@harness-anything/daemon';\nexport const start = startDaemon;\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/daemon/src/index.ts"),
      "export function startDaemon() { return {}; }\n",
      "utf8",
    );

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /storage must depend inward on kernel only/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check resolves package export patterns before enforcing storage direction", () => {
  const root = makeFixtureRoot();
  try {
    addPackageExport(root, "packages/application", "./internal/*.ts", "./src/*.ts");
    mkdirSync(path.join(root, "packages/application/src/internal"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/application/src/internal/probe.ts"),
      "export const applicationProbe = true;\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/storage/src/index.ts"),
      "import { applicationProbe } from '@harness-anything/application/internal/probe.ts';\nexport const observed = applicationProbe;\n",
      "utf8",
    );

    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /storage must depend inward on kernel only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check permits storage implementations to depend on kernel ports", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/storage/src/store"), { recursive: true });
    mkdirSync(path.join(root, "packages/kernel/src/ports"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/kernel/src/ports/index.ts"),
      ["export type StorePort = { readonly read: () => unknown };"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/storage/src/store/index.ts"),
      [
        "import type { StorePort } from '@harness-anything/kernel/ports/index.ts';",
        "export const makeStore = (): StorePort => ({ read: () => undefined });",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/storage/src/index.ts"),
      ["export { makeStore } from './store/index.ts';"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/application/src/index.ts"),
      ["import { makeStore } from '@harness-anything/storage';", "export const appStore = makeStore;"].join("\n"),
      "utf8",
    );

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Import boundary check passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects every CLI kernel store import", () => {
  const root = makeFixtureRoot();
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-import-boundary-policy-"));
  try {
    mkdirSync(path.join(root, "packages/cli/src"), { recursive: true });
    mkdirSync(path.join(root, "packages/storage/src/store"), { recursive: true });
    writeFileSync(path.join(root, "packages/storage/src/store/ledger-backup.ts"), "export const backup = true;\n");
    writeFileSync(
      path.join(root, "packages/cli/src/not-a-composition-root.ts"),
      "import { backup } from '../../" + "kernel/src/store/ledger-backup.ts';\nexport { backup };\n",
    );
    writeFileSync(
      path.join(policyRoot, "check-import-boundaries.json"),
      JSON.stringify({
        schema: "harness-anything/gate-allowlist/v1",
        gateId: "check-import-boundaries",
        entries: {
          guiAdapterCompositionRoots: [],
          cliAdapterCompositionRoots: [],
          kernelStoreCompositionRoots: [],
          cliAdapterKnownDebt: [],
        },
      }),
      "utf8",
    );

    const result = runChecker(root, { env: { HARNESS_GATE_ALLOWLIST_DIR: policyRoot } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/cli\/src\/not-a-composition-root\.ts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("import boundary check restricts GUI adapter imports to local composition root", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/gui/src/api"), { recursive: true });
    mkdirSync(path.join(root, "packages/gui/src/main"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/gui/src/api/service-bridge.ts"),
      [
        "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
        "export const bridge = makeLocalLifecycleEngine;",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/gui/src/main/local-composition-root.ts"),
      [
        "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
        "export const bridge = makeLocalLifecycleEngine;",
      ].join("\n"),
      "utf8",
    );
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
  const policyRoot = mkdtempSync(path.join(tmpdir(), "ha-import-boundary-policy-"));
  try {
    writeFileSync(
      path.join(policyRoot, "check-import-boundaries.json"),
      JSON.stringify({
        schema: "harness-anything/gate-allowlist/v1",
        gateId: "check-import-boundaries",
        entries: {
          guiAdapterCompositionRoots: [],
          kernelStoreCompositionRoots: [],
          cliAdapterCompositionRoots: [
            {
              value: "packages/cli/src/index.ts",
              ref: "ADR-0022#D3",
              reason: "Fixture composition root.",
            },
          ],
          cliAdapterKnownDebt: [
            {
              value: "packages/cli/src/commands/lifecycle.ts",
              ref: "dec_FIXTURE",
              reason: "Fixture debt entry proving allowlisted paths stay exempt.",
            },
          ],
        },
      }),
      "utf8",
    );
    mkdirSync(path.join(root, "packages/cli/src/commands"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/cli/src/index.ts"),
      [
        "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
        "export const engine = makeLocalLifecycleEngine;",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/cli/src/commands/lifecycle.ts"),
      [
        "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
        "export const engine = makeLocalLifecycleEngine;",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/cli/src/commands/new-command.ts"),
      [
        "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';",
        "export const engine = makeLocalLifecycleEngine;",
      ].join("\n"),
      "utf8",
    );
    writeLocalAdapter(root);

    const result = runChecker(root, { env: { HARNESS_GATE_ALLOWLIST_DIR: policyRoot } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/cli\/src\/commands\/new-command\.ts/);
    assert.doesNotMatch(result.stderr, /packages\/cli\/src\/commands\/lifecycle\.ts/);
    assert.doesNotMatch(result.stderr, /packages\/cli\/src\/index\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(policyRoot, { recursive: true, force: true });
  }
});

test("import boundary check rejects package modules outside distribution that are only re-exported by the root barrel", () => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/gui/src/terminal"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/gui/src/index.ts"),
      ["export { unusedPolicy } from './terminal/unused-policy.ts';"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/gui/src/terminal/unused-policy.ts"),
      ["export const unusedPolicy = true;"].join("\n"),
      "utf8",
    );

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
    writeFileSync(
      path.join(root, "packages/cli/src/index.ts"),
      [
        "import { parseArgs } from './cli/parse-args.ts';",
        "export function main(argv) { return parseArgs(argv); }",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/cli/src/cli/parse-args.ts"),
      ["export function parseArgs(argv) {", "  return argv;", "}"].join("\n"),
      "utf8",
    );

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
    writeFileSync(
      path.join(root, "packages/application/src/index.ts"),
      ["export { liveGate } from './live-gate.ts';", "export { orphanGate } from './orphan-gate.ts';"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/application/src/live-gate.ts"),
      ["export const liveGate = true;"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/application/src/orphan-gate.ts"),
      ["export const orphanGate = true;"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/cli/src/commands/check.ts"),
      ["import { liveGate } from '@harness-anything/application';", "export const checked = liveGate;"].join("\n"),
      "utf8",
    );

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
    writeFileSync(
      path.join(root, "packages/gui/src/index.ts"),
      ["export { releaseGate } from './distribution/release-gate.ts';"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/gui/src/distribution/release-gate.ts"),
      ["export const releaseGate = true;"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "tools/check-release-gate.mjs"),
      [
        "import { releaseGate } from '../packages/gui/src/distribution/release-gate.ts';",
        "if (!releaseGate) process.exit(1);",
      ].join("\n"),
      "utf8",
    );

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("package-form mutations cover every import-boundary rule class", async (context) => {
  const mutations = [
    [
      "domain upper kernel layer",
      "packages/kernel/src/domain/package-probe.ts",
      "@harness-anything/kernel/ports/package-probe",
      "packages/kernel/src/ports/package-probe.ts",
      /domain layer imports upper kernel layer/u,
    ],
    [
      "ports implementation layer",
      "packages/kernel/src/ports/package-probe.ts",
      "@harness-anything/kernel/application/package-probe",
      "packages/kernel/src/application/package-probe.ts",
      /ports layer imports implementation\/controller layer/u,
    ],
    [
      "domain legacy runtime",
      "packages/kernel/src/domain/package-probe.ts",
      "@harness-anything/scripts/kernel/task/package-probe",
      null,
      /domain layer imports legacy runtime/u,
    ],
    [
      "domain IO runtime",
      "packages/kernel/src/domain/package-probe.ts",
      "node:fs",
      null,
      /domain layer imports IO\/runtime module/u,
    ],
    [
      "ports controller package",
      "packages/kernel/src/ports/package-probe.ts",
      "@harness-anything/cli",
      null,
      /ports layer imports implementation\/controller layer/u,
    ],
    [
      "CLI GUI package",
      "packages/cli/src/package-probe.ts",
      "@harness-anything/gui",
      null,
      /CLI imports GUI, adapter, or store implementation/u,
    ],
    [
      "production old runtime package",
      "packages/daemon/src/package-probe.ts",
      "@harness-anything/scripts/kernel/task/package-probe",
      null,
      /production package imports old runtime/u,
    ],
  ];
  for (const mutation of mutations) await context.test(mutation[0], () => assertPackageMutation(...mutation.slice(1)));
});

test("import boundary check counts explicit package subpaths as real orphan-module consumers", () => {
  const root = makeFixtureRoot();
  try {
    addPackageExport(root, "packages/application", "./live-gate", "./src/live-gate.ts");
    writeFileSync(
      path.join(root, "packages/application/src/index.ts"),
      "export { liveGate } from './live-gate.ts';\n",
      "utf8",
    );
    writeFileSync(path.join(root, "packages/application/src/live-gate.ts"), "export const liveGate = true;\n", "utf8");
    writeFileSync(
      path.join(root, "packages/daemon/src/package-consumer.ts"),
      "import { liveGate } from '@harness-anything/application/live-gate';\nexport const consumed = liveGate;\n",
      "utf8",
    );

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
    writeFileSync(
      path.join(root, "packages/gui/src/index.ts"),
      ["export { plannedPolicy } from './distribution/planned-policy.ts';"].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(root, "packages/gui/src/distribution/planned-policy.ts"),
      ["/** @slice-activation M4 packaging owns this policy surface. */", "export const plannedPolicy = true;"].join(
        "\n",
      ),
      "utf8",
    );

    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated package manifests cannot replace source package import resolution", () => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(path.join(root, "packages/application/src/index.ts"), "export { feature } from './feature.ts';\n");
    writeFileSync(path.join(root, "packages/application/src/feature.ts"), "export const feature = true;\n");
    writeFileSync(
      path.join(root, "packages/cli/src/index.ts"),
      "import { feature } from '@harness-anything/application';\nexport const result = feature;\n",
    );
    assert.equal(runChecker(root).status, 0);
    // Pack copies stay invisible to the gate through .gitignore, the sole ignore
    // authority since directory enumeration moved into git.
    writeFileSync(path.join(root, ".gitignore"), "packages/gui/build-resources/\n");
    for (const name of ["application", "adapter-local"]) {
      const staged = path.join(root, "packages/gui/build-resources/app-node_modules/@harness-anything", name);
      mkdirSync(staged, { recursive: true });
      writeFileSync(
        path.join(staged, "package.json"),
        JSON.stringify({ name: `@harness-anything/${name}`, exports: { ".": "./dist/index.js" } }),
      );
    }
    const legal = runChecker(root);
    assert.equal(legal.status, 0, legal.stderr);
    writeLocalAdapter(root);
    writeFileSync(
      path.join(root, "packages/application/src/index.ts"),
      "import { makeLocalLifecycleEngine } from '@harness-anything/adapter-local';\nexport const engine = makeLocalLifecycleEngine;\n",
    );
    const forbidden = runChecker(root);
    assert.notEqual(forbidden.status, 0);
    assert.match(forbidden.stderr, /application layer imports store\/adapter\/controller implementation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-import-boundary-"));
  // The gate enumerates through git; the excludesFile pin keeps host-global ignores out.
  for (const args of [
    ["init", "--quiet"],
    ["config", "core.excludesFile", "/dev/null"],
  ])
    spawnSync("git", args, { cwd: root });
  for (const [packageRoot, name] of [
    ["packages/application", "@harness-anything/application"],
    ["packages/adapters/local", "@harness-anything/adapter-local"],
    ["packages/kernel", "@harness-anything/kernel"],
    ["packages/storage", "@harness-anything/storage"],
    ["packages/daemon", "@harness-anything/daemon"],
    ["packages/preset", "@harness-anything/preset"],
    ["packages/cli", "@harness-anything/cli"],
    ["packages/gui", "@harness-anything/gui"],
  ]) {
    mkdirSync(path.join(root, packageRoot, "src"), { recursive: true });
    writeFileSync(
      path.join(root, packageRoot, "package.json"),
      JSON.stringify({
        name,
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
      "utf8",
    );
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
      addPackageExport(
        root,
        "packages/kernel",
        specifier.replace("@harness-anything/kernel", "."),
        target.replace("packages/kernel/", "./"),
      );
      mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
      writeFileSync(path.join(root, target), "export const packageProbe = true;\n", "utf8");
    }
    mkdirSync(path.dirname(path.join(root, importer)), { recursive: true });
    writeFileSync(
      path.join(root, importer),
      `import { packageProbe } from '${specifier}';\nexport const observed = packageProbe;\n`,
      "utf8",
    );
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, reason);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeLocalAdapter(root) {
  writeFileSync(
    path.join(root, "packages/adapters/local/src/index.ts"),
    ["export function makeLocalLifecycleEngine() {", "  return {};", "}"].join("\n"),
    "utf8",
  );
}

function runChecker(cwd, options = {}) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
}

for (const empty of [false, true]) {
  test(`import boundary rejects ${empty ? "empty" : "missing"} packages discovery`, () => {
    const root = makeFixtureRoot();
    try {
      renameSync(path.join(root, "packages"), path.join(root, "escaped-packages"));
      if (empty) mkdirSync(path.join(root, "packages"));
      const result = runChecker(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /packages/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
