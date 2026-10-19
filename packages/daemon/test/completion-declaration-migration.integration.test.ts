// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRuntime, decodePresetPackageV3 } from "@harness-anything/preset/internal/preset-resolver";
import { defaultAssets, defaultBundled } from "@harness-anything/preset/internal/preset-resolver-common";
import { presetUserRoot } from "@harness-anything/preset/internal/preset-system";
import {
  activateEmptyCanonicalGeneration,
  makeTaskEventStore,
  makeTaskEventReader,
  makeTaskProjection,
} from "@harness-anything/kernel";
import { migrateCompletion } from "@harness-anything/preset/internal/preset-resolver";
import { initRepo, ownerBinding, standardMigration } from "./doc-sync-slice-a.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { readCanonicalVerticalDeclaration } from "../src/vertical-declaration-action.ts";

test("converted historical declaration is accepted, replayed on reopen and permits a relation write", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-declaration-migration-")),
    repoId = workspaceId("completion-migration"),
    oldBody = readFileSync(
      new URL("../../preset/fixtures/completion-migration/repository-before.json", import.meta.url),
      "utf8",
    );
  initRepo(root);
  const bootstrapped = await openBootstrappedRepoCell({
    repoId,
    rootDir: canonicalRoot(root),
    ownerId: "migration-bootstrap",
  });
  await bootstrapped.close();
  const seed = makeTaskEventStore({ repoId, rootDir: root, activationPreflight: activateEmptyCanonicalGeneration });
  const historicalRevision = (seed.readHead()?.revision ?? 0) + 1;
  seed.append(standardMigration(historicalRevision, "vertical.json", oldBody));
  await seed.drain();
  let cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "migration-test" });
  try {
    const source = path.join(root, "old.json"),
      candidate = path.join(root, "candidate.json");
    writeFileSync(source, oldBody);
    migrateCompletion({ source, destination: candidate, dryRun: false });
    writeFileSync(path.join(root, "harness", "vertical.json"), readFileSync(candidate));
    const accepted = await cell.run({ kind: "doc-submit", paths: ["vertical.json"] }, ownerBinding);
    assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
    await cell.close();
    cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "migration-reopen" });
    const reader = makeTaskEventReader({ repoId, rootDir: root }),
      projection = makeTaskProjection({ rootDir: root, eventStore: reader });
    try {
      const declaration = readCanonicalVerticalDeclaration(projection)!;
      assert.deepEqual(declaration.definition.completion.gates, {});
      assert.equal(declaration.revision, 65820);
      assert.equal(reader.read().events[historicalRevision - 1]!.schema, "migration-import-event/v1");
    } finally {
      projection.close();
    }
    for (const taskId of ["task_migration_source", "task_migration_target"])
      assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, ownerBinding)).outcome, "applied");
    const relation = await cell.run(
      {
        kind: "relation-relate",
        sourceRef: "task/task_migration_source",
        targetRef: "task/task_migration_target",
        relationType: "depends-on",
        rationale: "Migration acceptance probe",
        expectedVersion: 0,
      },
      ownerBinding,
    );
    assert.equal(relation.outcome, "applied", JSON.stringify(relation));
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const sample = (name: string) =>
  readFileSync(new URL(`../../preset/fixtures/completion-migration/${name}.json`, import.meta.url), "utf8");
function scan(root: string): Map<string, string> {
  return new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(root, file).replaceAll("\\", "/"), readFileSync(file, "utf8")];
      }),
  );
}
const cli = fileURLToPath(new URL("../../cli/src/index.ts", import.meta.url));
function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [cli, "migrate", "completion", ...args, "--json"], { encoding: "utf8" });
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), result.stderr);
  return { status: result.status, receipt: JSON.parse(result.stdout.trim()) };
}
function invokeConcurrent(...args: string[]): Promise<{ status: number | null; receipt: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "migrate", "completion", ...args, "--json"]);
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      if (signal || !stdout.trim()) return reject(new Error(`${signal}: ${stderr}`));
      resolve({ status, receipt: JSON.parse(stdout.trim()) });
    });
  });
}

test("old active pin resolves after explicit migration while templates, scripts, user content and old objects survive", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-completion-pin-"));
  initRepo(root);
  const repoId = workspaceId("completion-pin-migration");
  const cell = await openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "center-writer" });
  try {
    const userRoot = presetUserRoot(root),
      oldDigest = "a".repeat(64),
      source = path.join(userRoot, "preset-objects", oldDigest),
      pointer = path.join(userRoot, "active", "gui-development.json");
    cpSync(defaultAssets, source, { recursive: true });
    cpSync(path.join(defaultBundled, "gui-development"), source, { recursive: true });
    writeFileSync(path.join(source, "preset.json"), sample("gui-development"));
    writeFileSync(path.join(source, "custom.txt"), "User content must survive.\n");
    mkdirSync(path.dirname(pointer), { recursive: true });
    writeFileSync(
      pointer,
      JSON.stringify({
        schema: "preset-active-pointer/v1",
        presetId: "gui-development",
        verticalId: "software/coding",
        digest: oldDigest,
      }),
    );
    const original = scan(source),
      oldPointer = readFileSync(pointer, "utf8");
    const request = {
      presetId: "gui-development",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    } as const;
    const selected = () => createRuntime({ userRoot }).resolveInternal(request);
    assert.throws(selected, { message: /ha migrate completion --help/u });
    const competing = await Promise.all(
      [1, 2].map(() => invokeConcurrent("--source", source, "--mode", "convert", "--user-root", userRoot)),
    );
    for (const rejected of competing) {
      assert.equal(rejected.status, 1, JSON.stringify(rejected));
      assert.match(String(rejected.receipt.hint), /Unknown input --user-root/u);
    }
    assert.equal(readFileSync(pointer, "utf8"), oldPointer);
    const candidate = path.join(root, "candidate");
    assert.equal(invoke("--source", source, "--mode", "dry-run", "--destination", candidate).status, 0);
    assert.equal(readFileSync(pointer, "utf8"), oldPointer);
    const migrated = invoke("--source", source, "--mode", "convert", "--destination", candidate);
    assert.equal(migrated.status, 0, JSON.stringify(migrated));
    assert.match(migrated.receipt.next, /ha preset install/u);
    assert.equal(readFileSync(pointer, "utf8"), oldPointer);
    await assert.rejects(openBootstrappedRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "second-writer" }), {
      code: "writer_rejected",
    });
    const installs = [1, 2].map(() => cell.run({ kind: "preset-install", packageSource: candidate }, ownerBinding));
    const receipts = await Promise.all(installs);
    assert.equal(receipts.length, 2);
    for (const receipt of receipts) assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.deepEqual(
      receipts.map((receipt) => JSON.parse(receipt.evidence!).changed),
      [true, false],
    );
    assert.equal(cell.status().queueDepth, 0);
    assert.deepEqual(scan(source), original);
    const current = decodePresetPackageV3(selected().packageRoot);
    assert.ok(current);
    for (const [name, body] of original) if (name !== "preset.json") assert.equal(current.files.get(name), body, name);
    const resolved = await createRuntime({ userRoot }).resolver.resolve({
      presetId: "gui-development",
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      purpose: "task-create",
    });
    assert.equal(resolved.ok, true, JSON.stringify(resolved));
    const unchanged = invoke(
      "--source",
      current.root,
      "--mode",
      "convert",
      "--destination",
      path.join(root, "unchanged"),
    );
    assert.equal(unchanged.status, 0, JSON.stringify(unchanged));
    assert.equal(unchanged.receipt.changed, false);
    const reinstalled = await cell.run(
      { kind: "preset-install", packageSource: path.join(root, "unchanged") },
      ownerBinding,
    );
    assert.equal(reinstalled.outcome, "applied", JSON.stringify(reinstalled));
    assert.equal(JSON.parse(reinstalled.evidence!).changed, false);
    const activeBeforeFailure = readFileSync(pointer, "utf8"),
      invalid = path.join(root, "invalid");
    cpSync(source, invalid, { recursive: true });
    const manifest = JSON.parse(sample("gui-development"));
    manifest.profiles[0].checkerProfile = "custom";
    writeFileSync(path.join(invalid, "preset.json"), JSON.stringify(manifest));
    assert.equal(
      invoke("--source", invalid, "--mode", "convert", "--destination", path.join(root, "invalid-candidate")).status,
      1,
    );
    assert.equal(readFileSync(pointer, "utf8"), activeBeforeFailure);
  } finally {
    await cell.close();
    rmSync(root, { recursive: true, force: true });
  }
});
