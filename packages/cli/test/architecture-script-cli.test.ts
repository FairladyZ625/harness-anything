// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { architectureSourceDigest } from "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-runtime.mjs";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI architecture init explicitly materializes the scaffold and is idempotent", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    const listed = runJson(rootDir, ["script", "list", "--source", "vertical"]);
    for (const scriptId of [
      "vertical:software-coding:architecture-init",
      "vertical:software-coding:architecture-snapshot",
      "vertical:software-coding:architecture-check"
    ]) {
      const script = listed.scripts.find((candidate: Record<string, unknown>) => candidate.id === scriptId);
      assert.notEqual(script, undefined, scriptId);
      assert.equal(script.kind, "action", `${scriptId} must stay out of ordinary ha check`);
    }

    const first = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"]);

    assert.equal(first.report.schema, "architecture-init-report/v1");
    assert.equal(first.report.status, "initialized");
    assert.equal(first.report.created.length, 7);
    assert.equal(first.report.conflicts.length, 0);
    assert.equal(JSON.parse(readFileSync(path.join(
      rootDir,
      "harness/context/architecture/architecture-manifest.json"
    ), "utf8")).schema, "architecture-manifest/v1");
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/model/views/runtime.c4")), true);
    assert.equal(gitRead(rootDir, "status", "--short"), "");

    const headBeforeNoop = gitRead(rootDir, "rev-parse", "HEAD");
    const second = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"]);

    assert.equal(second.report.status, "unchanged");
    assert.equal(second.report.created.length, 0);
    assert.equal(second.report.unchanged.length, 7);
    assert.deepEqual(second.generated, []);
    assert.equal(gitRead(rootDir, "rev-parse", "HEAD"), headBeforeNoop);
    assert.equal(gitRead(rootDir, "status", "--short"), "");
  });
});

test("CLI architecture init reports every conflict and writes nothing", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    const manifestPath = "harness/context/architecture/architecture-manifest.json";
    writeFile(rootDir, manifestPath, "existing architecture manifest\n");
    mkdirSync(path.join(rootDir, "harness/context/architecture/model/likec4.config.json"), { recursive: true });

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_result_failed");
    assert.equal(result.report.schema, "architecture-init-report/v1");
    assert.equal(result.report.status, "conflict");
    assert.deepEqual(result.report.conflicts.map((entry: Record<string, unknown>) => entry.path), [
      manifestPath,
      "harness/context/architecture/model/likec4.config.json"
    ]);
    assert.equal(readFileSync(path.join(rootDir, manifestPath), "utf8"), "existing architecture manifest\n");
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/model/specification.c4")), false);
  });
});

test("CLI architecture init reports parent conflicts with canonical repository paths", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    writeFile(rootDir, "harness/context/architecture/model", "not a directory\n");

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"], false);

    const parentConflicts = result.report.conflicts.filter((entry: Record<string, unknown>) => entry.reason === "parent-file");
    assert.equal(result.report.status, "conflict");
    assert.equal(parentConflicts.length, 6);
    assert.equal(parentConflicts.every((entry: Record<string, any>) =>
      entry.existingAliases.length === 1 && entry.existingAliases[0] === "harness/context/architecture/model"), true);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/architecture-manifest.json")), false);
  });
});

test("CLI architecture init reports portable root aliases without materialization", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    rmSync(path.join(rootDir, "harness/context/architecture"), { recursive: true, force: true });
    const aliasRoot = path.join(rootDir, "harness/context/Architecture");
    mkdirSync(aliasRoot, { recursive: true });
    writeFileSync(path.join(aliasRoot, "sentinel.txt"), "existing alias\n", "utf8");

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_result_failed");
    assert.equal(result.report.status, "conflict");
    assert.equal(result.report.conflicts.length, 7);
    assert.equal(result.report.conflicts.every((entry: Record<string, any>) =>
      entry.reason === "portable-path-collision" &&
      entry.existingAliases[0] === "harness/context/Architecture" &&
      /never creates/u.test(entry.remediation)), true);
    assert.deepEqual(readdirNames(aliasRoot), ["sentinel.txt"]);
  });
});

test("CLI architecture init reports canonical and portable alias root files as structured conflicts", () => {
  for (const rootName of ["architecture", "Architecture"]) {
    withTempRoot((rootDir) => {
      ensureTestHarnessIdentity(rootDir);
      runJson(rootDir, ["init"]);
      rmSync(path.join(rootDir, "harness/context/architecture"), { recursive: true, force: true });
      const conflictingRoot = path.join(rootDir, "harness/context", rootName);
      writeFileSync(conflictingRoot, "not a directory\n", "utf8");

      const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"], false);

      assert.equal(result.error.code, "script_result_failed");
      assert.equal(result.report.schema, "architecture-init-report/v1");
      assert.equal(result.report.status, "conflict");
      assert.equal(result.report.conflicts.length, 7);
      assert.equal(readFileSync(conflictingRoot, "utf8"), "not a directory\n");
      assert.equal(result.generated.length, 0);
    });
  }
});

test("CLI architecture init rejects symlinks at the declared read boundary before materialization", {
  skip: process.platform === "win32"
}, () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    const manifestPath = path.join(rootDir, "harness/context/architecture/architecture-manifest.json");
    symlinkSync("missing-architecture-manifest.json", manifestPath);

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_scope_invalid_read");
    assert.equal(result.report, undefined);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/model")), false);
  });
});

test("CLI architecture init never follows an architecture-root symlink", {
  skip: process.platform === "win32"
}, () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    const architectureRoot = path.join(rootDir, "harness/context/architecture");
    const externalRoot = path.join(rootDir, "external-architecture-target");
    rmSync(architectureRoot, { recursive: true, force: true });
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(path.join(externalRoot, "sentinel.txt"), "outside\n", "utf8");
    symlinkSync(externalRoot, architectureRoot);

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"], false);

    assert.equal(result.ok, false);
    assert.equal(typeof result.error.code, "string");
    assert.deepEqual(readdirNames(externalRoot), ["sentinel.txt"]);
  });
});

test("CLI architecture init never overwrites a modified completed scaffold", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"]);
    const modelPath = path.join(rootDir, "harness/context/architecture/model/model.c4");
    const modified = `${readFileSync(modelPath, "utf8")}\n// MANUAL-ARCHITECTURE-SENTINEL\n`;
    writeFileSync(modelPath, modified, "utf8");
    const headBefore = gitRead(rootDir, "rev-parse", "HEAD");

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"], false);

    assert.equal(result.report.status, "conflict");
    assert.deepEqual(result.report.conflicts.map((entry: Record<string, unknown>) => entry.path), [
      "harness/context/architecture/model/model.c4"
    ]);
    assert.equal(readFileSync(modelPath, "utf8"), modified);
    assert.equal(gitRead(rootDir, "rev-parse", "HEAD"), headBefore);
  });
});

test("CLI architecture scripts keep dry-run side-effect free", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);

    const init = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init", "--dry-run"]);
    const snapshot = runJson(rootDir, [
      "script", "run", "vertical:software-coding:architecture-snapshot", "--task", "task_DRY_RUN", "--dry-run"
    ]);

    assert.equal(init.report.dryRun, true);
    assert.equal(snapshot.report.dryRun, true);
    assert.deepEqual(init.generated, []);
    assert.deepEqual(snapshot.generated, []);
    assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/architecture-manifest.json")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task_DRY_RUN")), false);
  });
});

test("CLI architecture snapshot and check reject nonexistent owning tasks before execution", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);

    for (const scriptId of [
      "vertical:software-coding:architecture-snapshot",
      "vertical:software-coding:architecture-check"
    ]) {
      const result = runJson(rootDir, [
        "script", "run", scriptId, "--task", "task_DOES_NOT_EXIST"
      ], false);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "task_not_found");
      assert.equal(result.report, undefined);
    }
  });
});

test("CLI configured architecture snapshot and check require an owning task", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"]);
    const modelPath = path.join(rootDir, "harness/context/architecture/model/model.c4");
    writeFileSync(modelPath, readFileSync(modelPath, "utf8").replaceAll("placeholder true", "placeholder false"), "utf8");

    for (const [scriptId, issueCode] of [
      ["vertical:software-coding:architecture-snapshot", "architecture_snapshot_task_required"],
      ["vertical:software-coding:architecture-check", "architecture_check_task_required"]
    ]) {
      const result = runJson(rootDir, ["script", "run", scriptId], false);
      assert.equal(result.error.code, "script_result_failed");
      assert.equal(result.report.status, "invalid");
      assert.equal(result.report.issues[0].code, issueCode);
    }
  });
});

test("CLI architecture check is invisible until configured and snapshot degrades without its fixed adapter", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);

    const absent = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-check"]);
    assert.equal(absent.report.schema, "architecture-check-report/v1");
    assert.equal(absent.report.status, "not-configured");
    const ordinaryCheck = runJson(rootDir, ["check", "--profile", "source-package"]);
    assert.equal(ordinaryCheck.report.scriptChecks.some((entry: Record<string, unknown>) =>
      String(entry.scriptId).includes(":architecture-")), false);

    runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"]);
    const modelPath = path.join(rootDir, "harness/context/architecture/model/model.c4");
    writeFileSync(modelPath, readFileSync(modelPath, "utf8").replaceAll("placeholder true", "placeholder false"), "utf8");
    const task = runJson(rootDir, ["task", "create", "--title", "Architecture snapshot fixture"]);

    const missing = runJson(rootDir, [
      "script", "run", "vertical:software-coding:architecture-snapshot", "--task", task.taskId
    ], false);

    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, "script_result_failed");
    assert.equal(missing.report.schema, "architecture-snapshot-report/v1");
    assert.equal(missing.report.status, "tool-missing");
    assert.deepEqual(missing.report.missingTools.map((tool: Record<string, unknown>) => tool.adapter), [
      "likec4/model-v1",
      "javascript-typescript/imports-v1"
    ]);
    assert.equal(existsSync(path.join(
      rootDir,
      task.packagePath,
      "artifacts/architecture/architecture-snapshot.json"
    )), false);
  });
});

test("CLI architecture check rejects a portable manifest alias", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    runJson(rootDir, ["init"]);
    runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"]);
    const architectureRoot = path.join(rootDir, "harness/context/architecture");
    renameSync(
      path.join(architectureRoot, "architecture-manifest.json"),
      path.join(architectureRoot, "Architecture-Manifest.json")
    );

    const result = runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-check"], false);

    assert.equal(result.ok, false);
    assert.equal(result.report.status, "invalid");
    assert.equal(result.report.issues.some(
      (issue: Record<string, unknown>) => issue.code === "architecture_manifest_path_collision"
    ), true);
  });
});

test("CLI architecture check rejects symlink snapshots at the host boundary and mismatched manifest provenance", {
  skip: process.platform === "win32"
}, () => {
  withTempRoot((rootDir) => {
    const { task, snapshotPath } = configuredArchitectureTask(rootDir, "Architecture symlink snapshot");
    const externalPath = path.join(rootDir, "external-architecture-snapshot.json");
    writeFileSync(externalPath, JSON.stringify(validSnapshotFixture()), "utf8");
    mkdirSync(path.dirname(snapshotPath), { recursive: true });
    symlinkSync(externalPath, snapshotPath);

    const result = runJson(rootDir, [
      "script", "run", "vertical:software-coding:architecture-check", "--task", task.taskId
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_scope_invalid_read");
    assert.equal(result.report, undefined);
  });

  withTempRoot((rootDir) => {
    const { task, snapshotPath } = configuredArchitectureTask(rootDir, "Architecture manifest mismatch");
    writeFile(rootDir, path.relative(rootDir, snapshotPath), JSON.stringify(validSnapshotFixture()));

    const result = runJson(rootDir, [
      "script", "run", "vertical:software-coding:architecture-check", "--task", task.taskId
    ], false);

    assert.equal(result.report.status, "invalid");
    assert.equal(result.report.issues[0].code, "architecture_snapshot_manifest_mismatch");
    assert.equal(result.report.snapshot.present, true);
    assert.equal(result.report.snapshot.valid, true);
    assert.match(result.report.snapshot.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(result.report.snapshot.provenance, validSnapshotFixture().provenance);
  });
});

test("CLI architecture check treats a changed manifest digest as model evolution", () => {
  withTempRoot((rootDir) => {
    const { task, snapshotPath } = configuredArchitectureTask(rootDir, "Architecture manifest evolution");
    const snapshot = validSnapshotFixture();
    snapshot.manifest = {
      path: "harness/context/architecture/architecture-manifest.json",
      digest: `sha256:${"f".repeat(64)}`
    };
    writeFile(rootDir, path.relative(rootDir, snapshotPath), JSON.stringify(snapshot));

    const result = runJson(rootDir, [
      "script", "run", "vertical:software-coding:architecture-check", "--task", task.taskId
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.report.status, "tool-missing");
    assert.deepEqual(result.report.issues, []);
  });
});

test("CLI architecture check does not infer snapshot presence from its task artifact path", () => {
  withTempRoot((rootDir) => {
    const { task, snapshotPath } = configuredArchitectureTask(rootDir, "Architecture absent snapshot descriptor");

    const absent = runJson(rootDir, [
      "script", "run", "vertical:software-coding:architecture-check", "--task", task.taskId
    ], false);

    assert.notEqual(absent.error?.code, "task_not_found");
    assert.equal(absent.report.status, "tool-missing");
    assert.equal(absent.report.snapshot.path, path.relative(rootDir, snapshotPath));
    assert.deepEqual(absent.report.snapshot, {
      path: path.relative(rootDir, snapshotPath),
      present: false,
      valid: false,
      digest: null,
      provenance: null
    });
  });
});


function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_ACTOR: "agent:architecture-script-test",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
      }
    });
    const parsed = JSON.parse(output) as Record<string, any>;
    if (expectSuccess) assert.equal(parsed.ok, true, output);
    return unwrapCommandReceipt(parsed);
  } catch (error) {
    if (expectSuccess) throw error;
    const failure = error as { readonly stdout?: string };
    return unwrapCommandReceipt(JSON.parse(failure.stdout ?? "{}") as Record<string, any>);
  }
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "harness-architecture-script-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function gitRead(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
  }).trimEnd();
}

function configuredArchitectureTask(rootDir: string, title: string): { readonly task: Record<string, any>; readonly snapshotPath: string } {
  ensureTestHarnessIdentity(rootDir);
  runJson(rootDir, ["init"]);
  runJson(rootDir, ["script", "run", "vertical:software-coding:architecture-init"]);
  const modelPath = path.join(rootDir, "harness/context/architecture/model/model.c4");
  writeFileSync(modelPath, readFileSync(modelPath, "utf8").replaceAll("placeholder true", "placeholder false"), "utf8");
  const task = runJson(rootDir, ["task", "create", "--title", title]);
  return {
    task,
    snapshotPath: path.join(rootDir, task.packagePath, "artifacts/architecture/architecture-snapshot.json")
  };
}

function validSnapshotFixture(): Record<string, unknown> {
  const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
  const extractors = [{
    id: "js-ts-imports",
    adapter: "javascript-typescript/imports-v1",
    sourceScopeIds: ["source"],
    inputDigest: digest("4"),
    toolRef: "extractor:js-ts-imports"
  }];
  return {
    schema: "architecture-snapshot/v1",
    modelContract: "architecture-model/v1",
    manifest: { path: "harness/context/architecture/wrong-manifest.json", digest: digest("1") },
    provenance: {
      commit: { sha: null, verification: "unverified" },
      sourceDigest: architectureSourceDigest(extractors),
      modelDigest: digest("3"),
      tools: [
        { role: "provider", declarationId: "likec4", adapter: "likec4/model-v1", tool: "likec4", version: "1.0.0" },
        { role: "extractor", declarationId: "js-ts-imports", adapter: "javascript-typescript/imports-v1", tool: "dependency-cruiser", version: "1.0.0" }
      ]
    },
    extractors,
    mappings: [],
    nodeEdges: [],
    unmapped: [],
    stats: { sourceFiles: 0, mappedFiles: 0, nodeEdges: 0, evidenceEdges: 0, unmappedPaths: 0 }
  };
}

function readdirNames(directory: string): ReadonlyArray<string> {
  return execFileSync("find", [directory, "-mindepth", "1", "-maxdepth", "1", "-print"], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((entry) => path.basename(entry))
    .sort();
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
