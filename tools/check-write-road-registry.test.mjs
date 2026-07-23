// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-write-road-registry.mjs");

test("write-road registry accepts a covered fixture", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root);
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Write-road registry check passed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects unified entry compilers that point to different materializers", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, { splitIntentCompiler: true });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unified entry compilers must resolve to one materializer ref/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an authored surface without a criterion item", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, { omitGuiCriterionSurface: true });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /guiBridgeMethods:registeredBridge: authored ingress surface has no intent compiler criterion item/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry accepts a compliant single-surface-debt item", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, { parity: "single-surface-debt" });
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects single-surface-debt without owner and sunset", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, { parity: "single-surface-debt", omitDispositionFields: true });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /single-surface-debt must include owner/u);
    assert.match(result.stderr, /single-surface-debt must include sunset as YYYY-MM-DD/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry accepts a compliant single-entry item", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, { parity: "single-entry" });
    const result = runChecker(root);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects single-entry without a review trigger", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, { parity: "single-entry", omitDispositionFields: true });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /single-entry must include a specific reviewWhen trigger/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered coordinated write callsite", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      file: {
        "packages/application/src/unregistered.ts": [
          "declare const coordinator: unknown;",
          "declare const hashPayload: unknown;",
          "writeCoordinatedPayload(coordinator, hashPayload, { entityId: 'task/t1', kind: 'unregistered_kind', payload: {} });"
        ]
      }
    });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unregistered\.ts#coordinator-callsite/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered machine artifact boundary", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      operationsBoundary: "\"registered-boundary\" | \"unregistered-boundary\""
    });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /machine artifact boundary unregistered-boundary/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered direct fs write", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      file: {
        "packages/cli/src/commands/unregistered-fs.ts": [
          "import { writeFileSync } from 'node:fs';",
          "export function writeNow() {",
          "  writeFileSync('harness/tasks/task-1/INDEX.md', '# bad', 'utf8');",
          "}"
        ]
      }
    });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unregistered-fs\.ts#writeFileSync@1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry derives a newly added package source root from workspaces", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      file: {
        "packages/newcomer/src/unregistered-fs.ts": [
          "import { writeFileSync } from 'node:fs';",
          "writeFileSync('output.txt', 'bad', 'utf8');"
        ]
      }
    });
    writeLines(root, "packages/newcomer/package.json", ['{"name":"newcomer"}']);

    const result = runChecker(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/newcomer\/src\/unregistered-fs\.ts#writeFileSync@1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered tools process boundary", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      file: {
        "tools/unregistered-process.cjs": [
          "const { spawnSync } = require('child_process');",
          "spawnSync(process.execPath, ['--version']);"
        ]
      }
    });

    const result = runChecker(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tools\/unregistered-process\.cjs#spawnSync@1/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered mutating GUI route", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      extraApiRoute: "{ id: 'tasks.unregistered', method: 'POST', path: '/api/tasks/:taskId/unregistered', inputSchemaId: 'in', outputSchemaId: 'out', errorSchemaId: 'err', service: 'LocalControllerService', serviceMethod: 'setTaskStatus', auth: 'local-session-token', guiBridgeMethod: 'unregisteredBridge' }"
    });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mutating API route tasks\.unregistered/u);
    assert.match(result.stderr, /mutating GUI bridge method unregisteredBridge/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered task write CLI policy", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, { extraTaskCliAction: "unregistered-task-action" });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /task write CLI route unregistered-task-action/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered task write API policy", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      extraTaskApiRoute: "{ id: 'tasks.unregistered', method: 'POST', guiBridgeMethod: 'unregisteredTaskBridge' }"
    });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mutating API route tasks\.unregistered/u);
    assert.match(result.stderr, /mutating GUI bridge method unregisteredTaskBridge/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write-road registry rejects an unregistered preset script output scope", () => {
  const root = makeFixtureRoot();
  try {
    writeFixture(root, {
      presetWrites: ["{{outputRoot}}/**", "{{paths.tasksRoot}}/*/**"]
    });
    const result = runChecker(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\{\{paths\.tasksRoot\}\}\/\*\/\*\*/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-write-road-"));
  for (const dir of [
    "tools",
    "packages/kernel/src/ports",
    "packages/kernel/src/store",
    "packages/application/src",
    "packages/daemon/src/protocol",
    "packages/gui/src/api",
    "packages/cli/src/commands/extensions/assets/software-coding/presets/fixture"
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

function writeFixture(root, overrides = {}) {
  writeLines(root, "package.json", ['{"workspaces":["packages/*"]}']);
  for (const packageRoot of ["kernel", "application", "daemon", "gui", "cli", "api-contracts"]) {
    writeLines(root, `packages/${packageRoot}/package.json`, [`{"name":"${packageRoot}"}`]);
  }
  const boundary = overrides.operationsBoundary ?? "\"registered-boundary\"";
  writeLines(root, "packages/kernel/src/ports/write-coordinator.ts", [
    "export type TaskWriteOpKind = 'registered_kind';",
    "export type MachineArtifactWriteOpKind = 'machine_artifact_write';",
    "export type WriteOpKind = TaskWriteOpKind | MachineArtifactWriteOpKind;"
  ]);
  writeLines(root, "packages/kernel/src/write-coordination/journal/operations/transaction-plan.ts", [
    `type MachineArtifactBoundary = ${boundary};`
  ]);
  writeLines(root, "packages/application/src/fixture.ts", [
    "declare const coordinator: unknown;",
    "declare const hashPayload: unknown;",
    "writeCoordinatedPayload(coordinator, hashPayload, { entityId: 'task/t1', kind: 'registered_kind', payload: {} });",
    "export function compileRegisteredIntent() { return {}; }",
    "export function compileRegisteredIntentSeparately() { return {}; }"
  ]);
  const taskCliPolicies = ["{ actionKind: 'registered-action' }"];
  if (overrides.extraTaskCliAction) taskCliPolicies.push(`{ actionKind: '${overrides.extraTaskCliAction}' }`);
  const taskApiPolicies = ["single-surface-debt", "single-entry"].includes(overrides.parity)
    ? []
    : ["{ id: 'registered.route', method: 'POST', guiBridgeMethod: 'registeredBridge' }"];
  if (overrides.extraTaskApiRoute) taskApiPolicies.push(overrides.extraTaskApiRoute);
  writeLines(root, "packages/application/src/task-write-route-policy.ts", [
    `export const taskWriteCliRoutePolicies = [${taskCliPolicies.join(", ")}] as const;`,
    `export const taskWriteApiRoutePolicies = [${taskApiPolicies.join(", ")}] as const;`
  ]);
  writeLines(root, "packages/daemon/src/protocol/method-registry.ts", [
    "const repoWriteCliActionKinds = new Set<string>([]);",
    "const arbiterCliActionKinds = new Set<string>([]);"
  ]);
  const apiRoutes = [];
  if (overrides.extraApiRoute) apiRoutes.push(overrides.extraApiRoute);
  writeLines(root, "packages/api-contracts/src/api-contract-registry.ts", [
    `export const apiRouteContracts = [${apiRoutes.join(", ")}] as const;`
  ]);
  writeFileSync(path.join(root, "packages/cli/src/commands/extensions/assets/software-coding/presets/fixture/preset.json"), JSON.stringify({
    schema: "preset-manifest/v2",
    id: "fixture",
    entrypoints: {
      run: {
        type: "script",
        command: "scripts/run.mjs",
        writes: overrides.presetWrites ?? ["{{outputRoot}}/**"],
        produces: ["{{outputRoot}}/ok.json"]
      }
    }
  }, null, 2), "utf8");
  writeFileSync(path.join(root, "tools/write-road-registry.json"), `${JSON.stringify(makeRegistry(overrides), null, 2)}\n`, "utf8");
  for (const [rel, lines] of Object.entries(overrides.file ?? {})) {
    writeLines(root, rel, lines);
  }
}

function makeRegistry(overrides = {}) {
  const parity = overrides.parity ?? "unified";
  const surfaces = {
    cliActions: ["registered-action"],
    apiRoutes: ["single-surface-debt", "single-entry"].includes(parity) ? [] : ["registered.route"],
    guiBridgeMethods: overrides.omitGuiCriterionSurface || ["single-surface-debt", "single-entry"].includes(parity)
      ? []
      : ["registeredBridge"]
  };
  const compilers = parity === "single-entry"
    ? [{ entry: "direct", ref: "packages/application/src/fixture.ts#compileRegisteredIntent" }]
    : [
        { entry: "direct", ref: "packages/application/src/fixture.ts#compileRegisteredIntent" },
        {
          entry: "daemon",
          ref: overrides.splitIntentCompiler || parity === "single-surface-debt"
            ? "packages/application/src/fixture.ts#compileRegisteredIntentSeparately"
            : "packages/application/src/fixture.ts#compileRegisteredIntent"
        }
      ];
  const dispositionFields = overrides.omitDispositionFields
    ? {}
    : parity === "single-surface-debt"
      ? { owner: "fixture.covered", sunset: "2026-10-31" }
      : parity === "single-entry"
        ? { reviewWhen: "Return to unknown when any second authored ingress surface is registered." }
        : {};
  return {
    schema: "harness-anything/write-road-registry/v1",
    intentCompilerCriterion: {
      authoredSurfaceFields: ["cliActions", "apiRoutes", "guiBridgeMethods"],
      notApplicableWhen: "no-authored-ingress-surfaces"
    },
    rowCountReconciliation: {
      phase1FunctionalRows: 26,
      registryRows: 1
    },
    writePointRatchet: {
      previousCoverage: 0,
      previousOmissionDebt: 0
    },
    rows: [{
      id: "fixture.covered",
      sourceInventoryRows: Array.from({ length: 26 }, (_, index) => index + 1),
      road: "A",
      bearing: "fixture",
      leaseRequired: false,
      channel: { pathClass: "rpc-only", zoneClass: "fixture-zone" },
      entry: ["fixture"],
      writeKinds: ["registered_kind", "machine_artifact_write"],
      machineArtifactBoundaries: ["registered-boundary"],
      cliActions: ["registered-action"],
      apiRoutes: surfaces.apiRoutes,
      guiBridgeMethods: ["single-surface-debt", "single-entry"].includes(parity) ? [] : ["registeredBridge"],
      intentCompilers: [{
        selector: "registered-action",
        surfaces,
        parity,
        compilers,
        ...dispositionFields
      }],
      presetWriteScopes: ["{{outputRoot}}/**"],
      presetProduces: ["{{outputRoot}}/ok.json"],
      callsiteFiles: ["packages/application/src/fixture.ts"],
      evidence: ["packages/kernel/src/ports/write-coordinator.ts:1"],
      freshness: "fixture"
    }]
  };
}

function writeLines(root, rel, lines) {
  const target = path.join(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${lines.join("\n")}\n`, "utf8");
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: root,
    encoding: "utf8"
  });
}
