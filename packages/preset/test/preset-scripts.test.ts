// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { compileTaskBootstrap } from "../src/index.ts";

const actor = { principal: { personId: "person-1" }, executor: null } as const;

test("task create materializes preset scripts into artifacts/scripts as byte-identical regular files", () => {
  const fixture = makeFixture({
      "check-env.mjs": '// 预置脚本：输出环境标记（非 ASCII 注释验证字节保真）\nconsole.log("preset-script-ok");\n',
      "sum.mjs": "const sum = (a, b) => a + b;\nconsole.log(sum(2, 3));\n",
    }),
    rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-scripts-e2e-"));
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Preset Test");
    git(rootDir, "config", "user.email", "preset@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const bootstrap = compileTaskBootstrap({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      actor,
      source: "local",
      occurredAt: "2026-08-19T00:00:00.000Z",
      taskId: "task-scripts",
      title: "Scripts",
      presetId: "standard-task",
      workspaceRevision: 1,
      eventId: "event-scripts",
      opId: "op-scripts",
    });
    const store = makeTaskEventStore({ repoId: "preset-scripts-e2e", rootDir });
    store.append({ event: bootstrap.event, plan: bootstrap.plan, blobs: bootstrap.blobs });
    const packageDir = path.join(rootDir, "harness", bootstrap.packagePath),
      scriptsDir = path.join(packageDir, "artifacts", "scripts");
    assert.deepEqual(readdirSync(scriptsDir).sort(), ["check-env.mjs", "sum.mjs"]);
    assert.deepEqual(readdirSync(path.join(packageDir, "artifacts")).sort(), [".gitkeep", "scripts"]);
    for (const name of ["check-env.mjs", "sum.mjs"]) {
      const target = path.join(scriptsDir, name),
        status = lstatSync(target);
      assert.equal(status.isFile(), true);
      assert.equal(status.isSymbolicLink(), false, `${name} must be a copy, not a symbolic link`);
      assert.deepEqual(
        readFileSync(target),
        readFileSync(path.join(fixture.presetRoot, "scripts", name)),
        `${name} must be byte-identical to the preset package file`,
      );
    }
    const contract = JSON.parse(readFileSync(path.join(packageDir, "task-contract.json"), "utf8")) as {
      documents: { path: string; owner: string; mediaType: string }[];
    };
    assert.deepEqual(
      contract.documents
        .filter(({ path: target }) => target.startsWith("artifacts/scripts/"))
        .map(({ path: target }) => target),
      ["artifacts/scripts/check-env.mjs", "artifacts/scripts/sum.mjs"],
    );
    // Materialized scripts must claim the media type doc-sync's classifier derives for the same
    // path, so the projection does not disagree with the scanner about what the file is.
    assert.deepEqual(
      bootstrap.event.payload.initialDocumentClaims
        .filter(({ path: target }) => target.includes("/artifacts/scripts/"))
        .map(({ mediaType }) => mediaType),
      ["text/javascript", "text/javascript"],
    );
    const run = spawnSync(process.execPath, [path.join(scriptsDir, "check-env.mjs")], { encoding: "utf8" });
    assert.equal(run.status, 0, `node must execute the copied script: ${run.stderr}`);
    assert.match(run.stdout, /preset-script-ok/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("a preset without scripts leaves the task package unchanged and creates no artifacts/scripts directory", () => {
  const fixture = makeFixture(),
    rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-scripts-none-"));
  try {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Preset Test");
    git(rootDir, "config", "user.email", "preset@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const bootstrap = compileTaskBootstrap({
      bundledRoot: fixture.bundledRoot,
      userRoot: fixture.userRoot,
      assetsRoot: fixture.assetsRoot,
      verticalId: "software/coding",
      profileId: "baseline",
      locale: "en-US",
      actor,
      source: "local",
      occurredAt: "2026-08-19T00:00:00.000Z",
      taskId: "task-plain",
      title: "Plain",
      presetId: "standard-task",
      workspaceRevision: 1,
      eventId: "event-plain",
      opId: "op-plain",
    });
    assert.equal(
      bootstrap.documents.some(({ relativePath }) => relativePath.startsWith("artifacts/scripts/")),
      false,
    );
    assert.equal(bootstrap.documents.length, 5);
    const store = makeTaskEventStore({ repoId: "preset-scripts-none", rootDir });
    store.append({ event: bootstrap.event, plan: bootstrap.plan, blobs: bootstrap.blobs });
    assert.equal(existsSync(path.join(rootDir, "harness", bootstrap.packagePath, "artifacts", "scripts")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("irregular scripts nodes fail closed instead of widening copy semantics", () => {
  const nested = makeFixture({ "top.mjs": 'console.log("top");\n' }),
    flat = makeFixture(),
    linked = makeFixture({ "real.mjs": 'console.log("real");\n' });
  try {
    write(path.join(nested.presetRoot, "scripts/nested/deep.mjs"), 'console.log("deep");\n');
    assert.throws(
      () =>
        compileTaskBootstrap({
          bundledRoot: nested.bundledRoot,
          userRoot: nested.userRoot,
          assetsRoot: nested.assetsRoot,
          verticalId: "software/coding",
          profileId: "baseline",
          locale: "en-US",
          actor,
          source: "local",
          occurredAt: "2026-08-19T00:00:00.000Z",
          taskId: "task-nested",
          title: "Nested",
          presetId: "standard-task",
          workspaceRevision: 1,
          eventId: "event-nested",
          opId: "op-nested",
        }),
      (error: unknown) => (error as { code?: string }).code === "invalid_preset_scripts",
    );
    write(path.join(flat.presetRoot, "scripts"), "not a directory");
    assert.throws(
      () =>
        compileTaskBootstrap({
          bundledRoot: flat.bundledRoot,
          userRoot: flat.userRoot,
          assetsRoot: flat.assetsRoot,
          verticalId: "software/coding",
          profileId: "baseline",
          locale: "en-US",
          actor,
          source: "local",
          occurredAt: "2026-08-19T00:00:00.000Z",
          taskId: "task-flat",
          title: "Flat",
          presetId: "standard-task",
          workspaceRevision: 1,
          eventId: "event-flat",
          opId: "op-flat",
        }),
      (error: unknown) => (error as { code?: string }).code === "invalid_preset_scripts",
    );
    write(path.join(path.dirname(linked.presetRoot), "outside.mjs"), 'console.log("outside");\n');
    symlinkSync(
      path.join(path.dirname(linked.presetRoot), "outside.mjs"),
      path.join(linked.presetRoot, "scripts/link.mjs"),
    );
    assert.throws(
      () =>
        compileTaskBootstrap({
          bundledRoot: linked.bundledRoot,
          userRoot: linked.userRoot,
          assetsRoot: linked.assetsRoot,
          verticalId: "software/coding",
          profileId: "baseline",
          locale: "en-US",
          actor,
          source: "local",
          occurredAt: "2026-08-19T00:00:00.000Z",
          taskId: "task-linked",
          title: "Linked",
          presetId: "standard-task",
          workspaceRevision: 1,
          eventId: "event-linked",
          opId: "op-linked",
        }),
      (error: unknown) => (error as { code?: string }).code === "symlink_forbidden",
    );
  } finally {
    nested.cleanup();
    flat.cleanup();
    linked.cleanup();
  }
});

function makeFixture(scripts: Readonly<Record<string, string>> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-scripts-")),
    bundledRoot = path.join(root, "bundled"),
    userRoot = path.join(root, "user"),
    assetsRoot = path.join(root, "assets"),
    presetRoot = path.join(bundledRoot, "standard-task");
  cpSync(new URL("../assets/software-coding/", import.meta.url), assetsRoot, { recursive: true });
  write(
    path.join(presetRoot, "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id: "standard-task",
      title: "Standard Task",
      vertical: "software/coding",
      version: "3.0.0",
      kind: "template-content",
      outputShape: "repository-diff",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      profiles: [
        {
          id: "baseline",
          title: "Baseline",
          completionGates: ["ci", "code-doc-reconciliation"],
          templateSelections: [],
        },
      ],
      defaultProfile: "baseline",
    }),
  );
  write(
    path.join(presetRoot, "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: General task\nwhenToUse: Use for ordinary repository work.\n---\n# Standard Task\n",
  );
  for (const [name, body] of Object.entries(scripts)) write(path.join(presetRoot, "scripts", name), body);
  mkdirSync(userRoot, { recursive: true });
  return {
    bundledRoot,
    userRoot,
    assetsRoot,
    presetRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function write(target: string, body: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${body}${body.endsWith("\n") ? "" : "\n"}`);
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
