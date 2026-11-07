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
  writeRepoFile(
    rootDir,
    "packages/kernel/src/domain/runtime-instance-contract.ts",
    `export function createRuntimeInstanceKindContract() {\n  return { kind: "runtime-instance", actionCatalog: { actions: [${executable("create", "runtime-instance-create")}] } };\n}\n`,
  );
  writeRepoFile(
    rootDir,
    registryPath,
    [
      'import { createRuntimeInstanceKindContract } from "./runtime-instance-contract.ts";',
      "export const entityKindContracts = Object.freeze([",
      `  { kind: "task", actionCatalog: { actions: [${executable("create", "task-create")}] } },`,
      `  { kind: "runtime-session", actionCatalog: { actions: [${executable("runtime_session_started", "runtime_session_started", "compiled-event", "runtime-run")}] } },`,
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
