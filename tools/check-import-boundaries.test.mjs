// harness-test-tier: integration
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
        kernelWriteInternalConsumers: [
          {
            source: "packages/kernel/src/entity/declaration.ts",
            target: "packages/kernel/src/write-coordination/submit.ts",
            ref: "task_01KXW80M803GR3EKRDV3X7T0MM",
            reason: "fixture includes ref"
          }
        ],
        daemonRuntimeSupportConsumers: [
          {
            value: "packages/daemon/src/runtime/",
            ref: "task_01KXW80M803GR3EKRDV3X7T0MM",
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

test("import boundary check allows the documented daemon runtime support coupling", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/daemon/src/runtime"), { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/runtime/repo-runtime.ts"), [
      "im" + "port { runtimeSupport } from '@harness-anything/kernel/daemon-runtime-support';",
      "export const support = runtimeSupport;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`daemon-runtime-support positive control exit=${result.status}`);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects daemon runtime support imports from other packages", (t) => {
  const root = makeFixtureRoot();
  try {
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "im" + "port { runtimeSupport } from '@harness-anything/kernel/daemon-runtime-support';",
      "export const leaked = runtimeSupport;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`daemon-runtime-support other-package control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to the daemon runtime owner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects daemon runtime support imports from tools", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "tools"), { recursive: true });
    writeFileSync(path.join(root, "tools/runtime-support-consumer.mjs"), [
      "im" + "port { runtimeSupport } from '@harness-anything/kernel/daemon-runtime-support';",
      "export const leaked = runtimeSupport;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`daemon-runtime-support tools control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to the daemon runtime owner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects relative imports of the daemon runtime support target", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/daemon/src/runtime"), { recursive: true });
    writeFileSync(path.join(root, "packages/kernel/src/daemon-runtime-support.ts"), [
      "export const runtimeSupport = true;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/daemon/src/runtime/repo-runtime.ts"), [
      "im" + "port { runtimeSupport } from '../../../kernel/src/daemon-runtime-support.ts';",
      "export const leaked = runtimeSupport;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`daemon-runtime-support relative-target control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be imported through the governed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects daemon runtime support imports from unrelated daemon modules", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/daemon/src/service"), { recursive: true });
    writeFileSync(path.join(root, "packages/daemon/src/service/unrelated.ts"), [
      "im" + "port { runtimeSupport } from '@harness-anything/kernel/daemon-runtime-support';",
      "export const leaked = runtimeSupport;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`daemon-runtime-support unrelated-daemon control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to the daemon runtime owner/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects application deep imports from write-coordination journal", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/kernel/src/write-coordination/journal"), { recursive: true });
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "import { internalJournal } from '../../kernel/src/write-coordination/journal/private.ts';",
      "export const leakedJournal = internalJournal;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/write-coordination/journal/private.ts"), [
      "export const internalJournal = true;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`journal positive control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /application layer imports store\/adapter\/controller implementation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects application deep imports from write-coordination root", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/kernel/src/write-coordination"), { recursive: true });
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "import { privateWrite } from '../../kernel/src/write-coordination/private.ts';",
      "export const leakedWrite = privateWrite;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/write-coordination/private.ts"), [
      "export const privateWrite = true;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`root-private positive control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /application layer imports store\/adapter\/controller implementation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check allows write helpers through the governed kernel root barrel", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/kernel/src/write-coordination"), { recursive: true });
    writeFileSync(path.join(root, "packages/application/src/index.ts"), [
      "import { writeCoordinatedPayload } from '../../kernel/src/index.ts';",
      "export const writePayload = writeCoordinatedPayload;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/index.ts"), [
      "export { writeCoordinatedPayload } from './write-coordination/submit.ts';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/write-coordination/submit.ts"), [
      "export const writeCoordinatedPayload = true;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`root-public-helper control exit=${result.status}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Import boundary check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects other internal imports from the governed submit consumer", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/kernel/src/entity"), { recursive: true });
    mkdirSync(path.join(root, "packages/kernel/src/write-coordination/journal"), { recursive: true });
    writeFileSync(path.join(root, "packages/kernel/src/entity/declaration.ts"), [
      "import { privateJournal } from '../write-coordination/journal/private.ts';",
      "export const leakedJournal = privateJournal;"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/write-coordination/journal/private.ts"), [
      "export const privateJournal = true;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`governed-consumer-other-internal control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /entity\/declaration\.ts: store implementation is internal/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("import boundary check rejects other internal exports from the kernel root barrel", (t) => {
  const root = makeFixtureRoot();
  try {
    mkdirSync(path.join(root, "packages/kernel/src/write-coordination/journal"), { recursive: true });
    writeFileSync(path.join(root, "packages/kernel/src/index.ts"), [
      "export { privateJournal } from './write-coordination/journal/private.ts';"
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "packages/kernel/src/write-coordination/journal/private.ts"), [
      "export const privateJournal = true;"
    ].join("\n"), "utf8");

    const result = runChecker(root);
    t.diagnostic(`root-barrel-other-internal control exit=${result.status}`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /kernel\/src\/index\.ts: store implementation is internal/);
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
      "import { makeStore } from '../../kernel/src/index.ts';",
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
      "import { liveGate } from '../../../application/src/index.ts';",
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
