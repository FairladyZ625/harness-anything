// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { auditKindAuthority, main } from "../ontology-kind-authority.mjs";
import { captureGate, writeRepoFile } from "./helpers.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const registryPath = "packages/kernel/src/domain/entity-kind-registry.ts";
const declarationPath = "packages/kernel/src/domain/action-declaration.ts";
const commandsPath = "packages/daemon/src/protocol/daemon-protocol-commands.ts";

const executable = (id, ingress, implementation = "catalog-runtime", policy = ingress) =>
  `{ id: "${id}", policy: { action: "${policy}" }, execution: { ingress: "${ingress}", read: false, implementation: "${implementation}" } }`;
const declaration = (kind, executionClass = "repo-write", residency = "canonical") =>
  `{ kind: "${kind}", executionClass: "${executionClass}", residency: { scope: "${residency}" } }`;
const command = (kind, commandClass = "repo-write") =>
  `{ id: "${kind}", commandClass: "${commandClass}", method: "repo.task.run" }`;

// Production shape: the registry composes direct rows with a factory-made contract module.
function writeSurfaces(rootDir, { declarations, commands, artifactIngress = [] }) {
  const hostStores = `[{ id: "host.process-lock", role: "operational", purpose: "process-lock", residency: "host-local", medium: { kind: "host-operational", recordSchema: "host-process-lock/v1", purpose: "process-lock" }, vocabulary: [], writerApi: "withHostProcessLock" }, { id: "host.diagnostic-log", role: "operational", purpose: "diagnostic-log", residency: "host-local", medium: { kind: "host-operational", recordSchema: "host-diagnostic-line/v1", purpose: "diagnostic-log" }, vocabulary: [], writerApi: "appendHostDiagnostic" }]`;
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/runtime-instance-contract.ts",
    `export function createRuntimeInstanceKindContract() {\n  return { kind: "runtime-instance", actionCatalog: { actions: [${executable("create", "runtime-instance-create")}] }, stateStores: [] };\n}\n`,
  );
  writeRepoFile(
    rootDir,
    registryPath,
    [
      'import { createRuntimeInstanceKindContract } from "./runtime-instance-contract.ts";',
      "export const entityKindContracts = Object.freeze([",
      `  { kind: "task", actionCatalog: { actions: [${executable("create", "task-create")}] }, stateStores: [] },`,
      `  { kind: "runtime-session", actionCatalog: { actions: [${executable("runtime_session_started", "runtime_session_started", "compiled-event", "runtime-run")}] }, stateStores: [] },`,
      `  { kind: "host", actionCatalog: null, stateStores: ${hostStores} },`,
      "  createRuntimeInstanceKindContract(),",
      "]);",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    rootDir,
    declarationPath,
    `export const artifactActionIngressKinds = Object.freeze(${JSON.stringify(artifactIngress)});\nexport const actionDeclarations = Object.freeze([${declarations.join(", ")}]);\n`,
  );
  writeRepoFile(rootDir, commandsPath, `export const daemonProtocolCommands = [${commands.join(", ")}];\n`);
  writeRepoFile(
    rootDir,
    "packages/daemon/src/protocol/daemon-protocol-gui-actions.ts",
    "export const daemonGuiActionMethods = [];\n",
  );
  writeRepoFile(rootDir, "packages/kernel/src/domain/entity-ref.ts", "export {};\n");
}

function writeStateSurfaces(
  rootDir,
  {
    owner = "task",
    duplicateStore = false,
    invalidHost = false,
    sharedCache = null,
    missingFreshness = false,
    additionalStore = null,
  } = {},
) {
  writeSurfaces(rootDir, { declarations: coveredDeclarations, commands: coveredCommands });
  const hostStores = invalidHost
    ? `[{ id: "host.anything", role: "operational", purpose: "anything", residency: "host-local", medium: { kind: "host-operational", recordSchema: "anything/v1" }, vocabulary: [], writerApi: "anything" }]`
    : `[{ id: "host.process-lock", role: "operational", purpose: "process-lock", residency: "host-local", medium: { kind: "host-operational", recordSchema: "host-process-lock/v1", purpose: "process-lock" }, vocabulary: [], writerApi: "withHostProcessLock" }, { id: "host.diagnostic-log", role: "operational", purpose: "diagnostic-log", residency: "host-local", medium: { kind: "host-operational", recordSchema: "host-diagnostic-line/v1", purpose: "diagnostic-log" }, vocabulary: [], writerApi: "appendHostDiagnostic" }]`;
  const taskStoreId = duplicateStore ? "host.process-lock" : "task.task-events";
  const cacheStore =
    sharedCache === null
      ? ""
      : `, { id: "task.shared-cache", role: "replica", residency: "runtime-local", medium: { kind: "shared-cache", adapter: "${sharedCache}" }, vocabulary: [], source: { kind: "task", store: "task.task-events" }, freshness: ${missingFreshness ? "{}" : '{ cursor: "revision" }'}, invalidation: "fence-on-read", reader: "readTaskCache" }`;
  writeRepoFile(
    rootDir,
    registryPath,
    [
      'import { createRuntimeInstanceKindContract } from "./runtime-instance-contract.ts";',
      "export const entityKindContracts = Object.freeze([",
      `  { kind: "task", actionCatalog: { actions: [${executable("create", "task-create")}] }, stateStores: [{ id: "${taskStoreId}", role: "authority", residency: "canonical", medium: { kind: "canonical-event", schema: "task-event/v1", types: ["*"], writers: ["task-writer"] }, vocabulary: [] }${cacheStore}${additionalStore ? `, ${JSON.stringify(additionalStore)}` : ""}] },`,
      `  { kind: "runtime-session", actionCatalog: { actions: [${executable("runtime_session_started", "runtime_session_started", "compiled-event", "runtime-run")}] }, stateStores: [] },`,
      `  { kind: "host", actionCatalog: null, stateStores: ${hostStores} },`,
      "  createRuntimeInstanceKindContract(),",
      "]);",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/doc-sync-canonical-events.ts",
    `export const canonicalEventSchemas = Object.freeze([{ schema: "task-event/v1", owner: "${owner}" }]);\n`,
  );
}

const coveredDeclarations = [
  declaration("task-create"),
  declaration("runtime-run", "admin", "runtime-local"),
  declaration("runtime-instance-create", "admin"),
];
const coveredCommands = [
  command("task-create"),
  command("runtime-run", "admin"),
  command("runtime-instance-create", "admin"),
];

function fixtureRoot(t) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ontology-kind-authority-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

const ratchet = (rootDir) => captureGate(() => main(["--root", rootDir, "--mode", "ratchet"]));

test("G-B evaluates the production registry, including its factory-made runtime-instance kind", () => {
  const result = auditKindAuthority(repoRoot);
  assert.ok(result.canonicalKinds.includes("runtime-instance"));
  assert.deepEqual(result.coverage.findings, []);
  assert.equal(captureGate(() => main(["--root", repoRoot, "--mode", "ratchet"])).code, 0);
});

test("G-B turns red when a factory-generated runtime-instance effect loses its declaration, green on restore", (t) => {
  const rootDir = fixtureRoot(t);
  writeSurfaces(rootDir, { declarations: coveredDeclarations, commands: coveredCommands });
  const normal = ratchet(rootDir);
  assert.equal(normal.code, 0, normal.stdout);
  assert.match(normal.stdout, /runtime-instance/u);

  writeSurfaces(rootDir, {
    declarations: coveredDeclarations.filter((entry) => !entry.includes('"runtime-instance-create"')),
    commands: coveredCommands,
  });
  const removed = ratchet(rootDir);
  assert.equal(removed.code, 1);
  assert.match(
    removed.stdout,
    /runtime-instance\/create: durable effect runtime-instance-create has no ActionDeclaration/u,
  );
  assert.match(removed.stdout, /runtime-instance-create: protocol ingress has no ActionDeclaration/u);

  writeSurfaces(rootDir, { declarations: coveredDeclarations, commands: coveredCommands });
  assert.equal(ratchet(rootDir).code, 0);
});

test("G-B turns red on a new undeclared effect and on a declared action that lost its ingress", (t) => {
  const rootDir = fixtureRoot(t);
  writeSurfaces(rootDir, { declarations: coveredDeclarations, commands: coveredCommands });
  assert.equal(ratchet(rootDir).code, 0);

  // A new registry effect with a new ingress, but no ActionDeclaration for it.
  writeRepoFile(
    rootDir,
    registryPath,
    [
      'import { createRuntimeInstanceKindContract } from "./runtime-instance-contract.ts";',
      "export const entityKindContracts = Object.freeze([",
      `  { kind: "task", actionCatalog: { actions: [${executable("create", "task-create")}, ${executable("purge", "task-purge")}] } },`,
      `  { kind: "runtime-session", actionCatalog: { actions: [${executable("runtime_session_started", "runtime_session_started", "compiled-event", "runtime-run")}] } },`,
      "  createRuntimeInstanceKindContract(),",
      "]);",
      "",
    ].join("\n"),
  );
  writeRepoFile(
    rootDir,
    commandsPath,
    `export const daemonProtocolCommands = [${[...coveredCommands, command("task-purge")].join(", ")}];\n`,
  );
  const undeclared = ratchet(rootDir);
  assert.equal(undeclared.code, 1);
  assert.match(undeclared.stdout, /task\/purge: durable effect task-purge has no ActionDeclaration/u);

  // Restore, then drop the ingress of a still-declared action: it is no longer reachable.
  writeSurfaces(rootDir, { declarations: coveredDeclarations, commands: coveredCommands });
  assert.equal(ratchet(rootDir).code, 0);
  writeSurfaces(rootDir, {
    declarations: coveredDeclarations,
    commands: coveredCommands.filter((entry) => !entry.includes('"task-create"')),
  });
  const unreachable = ratchet(rootDir);
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.stdout, /task\/create: durable effect task-create has no protocol ingress/u);
  assert.match(unreachable.stdout, /task-create: declared canonical repo-write action has no protocol ingress/u);

  writeSurfaces(rootDir, { declarations: coveredDeclarations, commands: coveredCommands });
  assert.equal(ratchet(rootDir).code, 0);
});

test("G-B keeps host-local actions and generated Artifact ingress green without fake CRUD rows", (t) => {
  const rootDir = fixtureRoot(t);
  writeSurfaces(rootDir, {
    declarations: [...coveredDeclarations, declaration("provider-update", "admin", "host-local")],
    commands: [...coveredCommands, command("provider-update", "admin"), command("entity-update")],
    artifactIngress: ["entity-update"],
  });
  const result = ratchet(rootDir);
  assert.equal(result.code, 0, result.stdout);
  assert.match(
    result.stdout,
    /entity-update: generated Artifact ingress \(packages\/kernel\/src\/domain\/action-declaration\.ts artifactActionIngressKinds\)/u,
  );
  assert.match(
    result.stdout,
    /runtime-session\/runtime_session_started: compiled event emitted under declared action runtime-run/u,
  );

  // The same generated ingress outside the kernel's typed Artifact set is an undeclared ingress.
  writeSurfaces(rootDir, {
    declarations: [...coveredDeclarations, declaration("provider-update", "admin", "host-local")],
    commands: [...coveredCommands, command("provider-update", "admin"), command("entity-update")],
  });
  const untyped = ratchet(rootDir);
  assert.equal(untyped.code, 1);
  assert.match(untyped.stdout, /entity-update: protocol ingress has no ActionDeclaration/u);
});

test("G0-2 closes state ownership over canonical schema owners and host stores", (t) => {
  const rootDir = fixtureRoot(t);
  writeStateSurfaces(rootDir);
  assert.equal(ratchet(rootDir).code, 0);

  writeStateSurfaces(rootDir, { owner: "phantom" });
  const unknownOwner = ratchet(rootDir);
  assert.equal(unknownOwner.code, 1);
  assert.match(unknownOwner.stdout, /task-event\/v1: owner kind phantom does not exist/u);

  writeStateSurfaces(rootDir, { duplicateStore: true });
  const duplicate = ratchet(rootDir);
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stdout, /state store id host\.process-lock is declared by multiple kinds/u);

  writeStateSurfaces(rootDir, { invalidHost: true });
  const arbitraryHost = ratchet(rootDir);
  assert.equal(arbitraryHost.code, 1);
  assert.match(arbitraryHost.stdout, /unknown host operational purpose/u);
});

test("G0-2 rejects a canonical schema with no owner", (t) => {
  const rootDir = fixtureRoot(t);
  writeStateSurfaces(rootDir);
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/doc-sync-canonical-events.ts",
    'export const canonicalEventSchemas = Object.freeze([{ schema: "task-event/v1" }]);\n',
  );
  const result = ratchet(rootDir);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /task-event\/v1: canonical event schema has no owner/u);
});

test("G0-2 validates shared-cache adapter identity and replica shape", (t) => {
  const rootDir = fixtureRoot(t);
  writeStateSurfaces(rootDir, { sharedCache: "redis#createClient" });
  assert.equal(ratchet(rootDir).code, 0);

  writeStateSurfaces(rootDir, { sharedCache: "redis" });
  const invalidAdapter = ratchet(rootDir);
  assert.equal(invalidAdapter.code, 1);
  assert.match(
    invalidAdapter.stdout,
    /task\.shared-cache: shared-cache medium requires an exact module#export adapter/u,
  );

  writeStateSurfaces(rootDir, { sharedCache: "redis#createClient", missingFreshness: true });
  const missingCursor = ratchet(rootDir);
  assert.equal(missingCursor.code, 1);
  assert.match(missingCursor.stdout, /task\.shared-cache: replica requires freshness cursor/u);
});

test("G0-2 validates source-bound SQLite, PostgreSQL, and filesystem store media", (t) => {
  const rootDir = fixtureRoot(t);
  const media = [
    ["sqlite-database", "packages/storage/src/store/sqlite-event-store.ts"],
    ["postgres-database", "packages/storage/src/postgres/event-ledger-schema.ts"],
    ["filesystem-store", "packages/storage/src/durable-file.ts"],
  ];
  for (const [kind, module] of media) {
    const additionalStore = {
      id: `task.source-bound-${kind}`,
      role: "authority",
      residency: "canonical",
      medium: { kind, module, ...(kind.endsWith("-database") ? { tables: [] } : {}) },
      vocabulary: [],
    };
    writeStateSurfaces(rootDir, { additionalStore });
    assert.equal(ratchet(rootDir).code, 0, `${kind} should be a valid declared medium`);

    writeStateSurfaces(rootDir, {
      additionalStore: { ...additionalStore, medium: { kind } },
    });
    const missingModule = ratchet(rootDir);
    assert.equal(missingModule.code, 1);
    assert.match(missingModule.stdout, new RegExp(`${kind} medium requires an exact source module`, "u"));
  }
});

test("G0-1 names an injected registry-external kind", (t) => {
  const rootDir = fixtureRoot(t);
  writeSurfaces(rootDir, { declarations: coveredDeclarations, commands: coveredCommands });
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/entity-ref.ts",
    [
      'export const entityKindRefAuthorities = Object.freeze([{ kind: "task" }, { kind: "phantom" }]) as const;',
      'export type EntityRefKind = (typeof entityKindRefAuthorities)[number]["kind"] | "relation";',
      "",
    ].join("\n"),
  );
  const result = auditKindAuthority(rootDir);
  assert.match(result.findings.join("\n"), /entity-ref\.ts:1.*phantom/u);
  const positive = ratchet(rootDir);
  assert.equal(positive.code, 1);
  assert.match(positive.stdout, /phantom/u);
});
