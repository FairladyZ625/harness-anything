// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";
import { trustedScriptRepositoryContext } from "../src/commands/extensions/script-repository-context.ts";
import { resolveDeclaredReadScopes, resolveDeclaredWriteScopes } from "../src/commands/extensions/script-scope.ts";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI script host preserves a failed receipt but never ingests staged writes", () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "failed-writer", "Failed Writer", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/failed-writer/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const artifacts = path.join(context.outputRoot, 'artifacts');",
      "mkdirSync(artifacts, { recursive: true });",
      "writeFileSync(path.join(artifacts, 'partial.txt'), 'must not commit\\n', 'utf8');",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({",
      "  schema: 'script-result/v1',",
      "  ok: false,",
      "  rows: 1,",
      "  warnings: ['expected failure'],",
      "  report: { schema: 'failed-writer-report/v1', status: 'failed' }",
      "}), 'utf8');",
      ""
    ].join("\n"));
    const headBefore = gitRead(rootDir, "rev-parse", "HEAD");

    const result = runJson(rootDir, [
      "script", "run", "preset:failed-writer:scaffold", "--task", "task-failed-writer"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_result_failed");
    assert.equal(result.report.schema, "failed-writer-report/v1");
    assert.equal(result.rows, 1);
    assert.deepEqual(result.warnings, ["expected failure"]);
    assert.deepEqual(result.generated, []);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-failed-writer/artifacts/partial.txt")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-failed-writer/artifacts/preset-result.json")), false);
    assert.equal(gitRead(rootDir, "rev-parse", "HEAD"), headBefore);
    assert.equal(gitRead(rootDir, "status", "--short"), "");
  });
});

test("CLI script host ingests declared diagnostic artifacts from a failed audit action", () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "failed-auditor", "Failed Auditor", "scripts/preset-audit.mjs", "check");
    writeFile(rootDir, ".harness/presets/failed-auditor/scripts/preset-audit.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const artifacts = path.join(context.outputRoot, 'artifacts');",
      "mkdirSync(artifacts, { recursive: true });",
      "writeFileSync(path.join(artifacts, 'audit-diagnostic.json'), JSON.stringify({ status: 'failed' }), 'utf8');",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({",
      "  schema: 'script-result/v1',",
      "  ok: false,",
      "  report: { schema: 'failed-auditor-report/v1', status: 'failed' }",
      "}), 'utf8');",
      ""
    ].join("\n"));

    const listedChecks = runJson(rootDir, ["script", "list", "--kind", "check"]);
    assert.equal(listedChecks.scripts.some((script: { id: string }) => script.id === "preset:failed-auditor:check"), false);

    const result = runJson(rootDir, [
      "script", "run", "preset:failed-auditor:check", "--task", "task-failed-auditor"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_result_failed");
    assert.equal(result.report.schema, "failed-auditor-report/v1");
    assert.deepEqual(result.generated, ["harness/tasks/task-failed-auditor/artifacts/audit-diagnostic.json"]);
    assert.deepEqual(JSON.parse(readFileSync(
      path.join(rootDir, "harness/tasks/task-failed-auditor/artifacts/audit-diagnostic.json"),
      "utf8"
    )), { status: "failed" });
  });
});

test("CLI script host rejects a symlinked task write root before execution", {
  skip: process.platform === "win32"
}, () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "symlink-writer", "Symlink Writer", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/symlink-writer/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(await import('node:fs').then(({ readFileSync }) => readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8')));",
      "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/escaped.txt'), 'escaped\\n', 'utf8');",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {} }), 'utf8');",
      ""
    ].join("\n"));
    const externalRoot = path.join(rootDir, "external-task-target");
    mkdirSync(path.join(rootDir, "harness/tasks"), { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(path.join(externalRoot, "sentinel.txt"), "outside\n", "utf8");
    symlinkSync(externalRoot, path.join(rootDir, "harness/tasks/task-symlink"));

    const result = runJson(rootDir, [
      "script", "run", "preset:symlink-writer:scaffold", "--task", "task-symlink"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_scope_invalid_write");
    assert.equal(existsSync(path.join(externalRoot, "escaped.txt")), false);
    assert.equal(readFileSync(path.join(externalRoot, "sentinel.txt"), "utf8"), "outside\n");
  });
});

test("CLI script host rejects a dangling task write-root symlink", {
  skip: process.platform === "win32"
}, () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "dangling-writer", "Dangling Writer", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/dangling-writer/scripts/preset-action.mjs", "throw new Error('must not execute');\n");
    mkdirSync(path.join(rootDir, "harness/tasks"), { recursive: true });
    symlinkSync("missing-task-target", path.join(rootDir, "harness/tasks/task-dangling"));

    const result = runJson(rootDir, [
      "script", "run", "preset:dangling-writer:scaffold", "--task", "task-dangling"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_scope_invalid_write");
  });
});

test("CLI script host rejects a descendant write symlink that targets outside the project", {
  skip: process.platform === "win32"
}, () => {
  withCanonicalTempRoot((rootDir) => {
    const externalRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-write-escape-"));
    try {
      writeProcessPreset(rootDir, "descendant-symlink-writer", "Descendant Symlink Writer", "scripts/preset-action.mjs");
      writeFile(rootDir, ".harness/presets/descendant-symlink-writer/scripts/preset-action.mjs", [
        "#!/usr/bin/env node",
        "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
        "const escaped = path.join(context.outputRoot, 'artifacts/escape');",
        "mkdirSync(escaped, { recursive: true });",
        "writeFileSync(path.join(escaped, 'pwned.txt'), 'escaped\\n', 'utf8');",
        "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {} }), 'utf8');",
        ""
      ].join("\n"));
      const symlinkParent = path.join(rootDir, "harness/tasks/task-descendant-symlink/artifacts");
      mkdirSync(symlinkParent, { recursive: true });
      symlinkSync(externalRoot, path.join(symlinkParent, "escape"));

      const result = runJson(rootDir, [
        "script", "run", "preset:descendant-symlink-writer:scaffold", "--task", "task-descendant-symlink"
      ], false);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "script_scope_invalid_write");
      assert.equal(existsSync(path.join(externalRoot, "pwned.txt")), false);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

test("CLI staged script cannot write directly to the canonical output root", () => {
  withCanonicalTempRoot((rootDir) => {
    writeProcessPreset(rootDir, "canonical-bypass", "Canonical Bypass", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/canonical-bypass/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const canonical = path.join(context.paths.projectRoot, 'harness/tasks/task-canonical-bypass/artifacts');",
      "mkdirSync(canonical, { recursive: true });",
      "writeFileSync(path.join(canonical, 'escaped.txt'), 'escaped\\n', 'utf8');",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {} }), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, [
      "script", "run", "preset:canonical-bypass:scaffold", "--task", "task-canonical-bypass"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_scope_violation_write");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-canonical-bypass/artifacts/escaped.txt")), false);
  });
});

test("CLI script host denies reads outside the manifest package and declared scopes", () => {
  withCanonicalTempRoot((rootDir) => {
    writeFile(rootDir, "outside-script-secret.txt", "must stay private\n");
    writeProcessPreset(rootDir, "undeclared-reader", "Undeclared Reader", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/undeclared-reader/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const secret = readFileSync(path.join(context.paths.projectRoot, 'outside-script-secret.txt'), 'utf8');",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: { secret } }), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, [
      "script", "run", "preset:undeclared-reader:scaffold", "--task", "task-undeclared-reader"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "script_scope_violation_read");
  });
});

test("CLI script host refuses to follow descendant symlink leaves", {
  skip: process.platform === "win32"
}, () => {
  withCanonicalTempRoot((rootDir) => {
    const externalRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-read-symlink-target-"));
    try {
      writeFileSync(path.join(externalRoot, "secret.txt"), "must stay outside\n", "utf8");
      mkdirSync(path.join(rootDir, "declared-read"), { recursive: true });
      symlinkSync(externalRoot, path.join(rootDir, "declared-read/escape"));
      writeProcessPreset(
        rootDir,
        "symlink-leaf-reader",
        "Symlink Leaf Reader",
        "scripts/preset-action.mjs",
        "scaffold",
        ["{{outputRoot}}/**"],
        ["{{paths.rootDir}}/declared-read/**"]
      );
      writeFile(rootDir, ".harness/presets/symlink-leaf-reader/scripts/preset-action.mjs", [
        "#!/usr/bin/env node",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
        "const secret = readFileSync(path.join(context.paths.projectRoot, 'declared-read/escape/secret.txt'), 'utf8');",
        "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: { secret } }), 'utf8');",
        ""
      ].join("\n"));

      const result = runJson(rootDir, [
        "script", "run", "preset:symlink-leaf-reader:scaffold", "--task", "task-symlink-leaf-reader"
      ], false);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "script_scope_invalid_read");
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

test("CLI script host denies descendants of a non-recursive write file scope", () => {
  withCanonicalTempRoot((rootDir) => {
    mkdirSync(path.join(rootDir, "harness/tasks/task-exact-file-writer/artifacts"), { recursive: true });
    writeProcessPreset(
      rootDir,
      "exact-file-writer",
      "Exact File Writer",
      "scripts/preset-action.mjs",
      "scaffold",
      ["{{outputRoot}}/artifacts/receipt.json"]
    );
    writeFile(rootDir, ".harness/presets/exact-file-writer/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const declaredFile = context.writeScopes[0];",
      "mkdirSync(declaredFile, { recursive: true });",
      "writeFileSync(path.join(declaredFile, 'escaped.txt'), 'escaped\\n', 'utf8');",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {} }), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, [
      "script", "run", "preset:exact-file-writer:scaffold", "--task", "task-exact-file-writer"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_write_scope_invalid");
    assert.equal(existsSync(path.join(
      rootDir,
      "harness/tasks/task-exact-file-writer/artifacts/receipt.json/escaped.txt"
    )), false);
  });
});

test("script scopes reject portable aliases in declared path components", () => {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-scope-alias-"));
  try {
    const layout = resolveHarnessLayout(rootDir);
    const outputRoot = path.join(layout.tasksRoot, "task-scope-alias");
    mkdirSync(path.join(rootDir, "harness/context/Architecture"), { recursive: true });

    assert.equal(resolveDeclaredReadScopes([
      path.join(rootDir, "harness/context/architecture/**")
    ], layout, outputRoot).ok, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("no-overwrite scaffold scopes surface only non-symlink leaf conflicts", () => {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-scaffold-leaf-conflict-"));
  try {
    const layout = resolveHarnessLayout(rootDir);
    const outputRoot = path.join(rootDir, "harness/context");
    mkdirSync(outputRoot, { recursive: true });
    const aliasPath = path.join(outputRoot, "Architecture");
    writeFileSync(aliasPath, "portable alias file\n", "utf8");

    const resolved = resolveDeclaredWriteScopes(
      ["{{outputRoot}}/architecture/**"],
      layout,
      outputRoot,
      { reportLeafConflicts: true }
    );
    assert.equal(resolved.ok, true);
    assert.deepEqual(resolved.ok ? resolved.reportedLeafConflicts : [], [aliasPath]);

    rmSync(aliasPath);
    const canonicalPath = path.join(outputRoot, "architecture");
    writeFileSync(canonicalPath, "canonical root file\n", "utf8");
    const canonical = resolveDeclaredWriteScopes(
      ["{{outputRoot}}/architecture/**"],
      layout,
      outputRoot,
      { reportLeafConflicts: true }
    );
    assert.equal(canonical.ok, true);
    assert.deepEqual(canonical.ok ? canonical.reportedLeafConflicts : [], [canonicalPath]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("non-recursive script scopes accept only regular files or an absent write file leaf", () => {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-file-scope-"));
  try {
    const layout = resolveHarnessLayout(rootDir);
    const outputRoot = path.join(layout.tasksRoot, "task-file-scope");
    const directory = path.join(rootDir, "read-directory");
    const regularFile = path.join(rootDir, "read-file.txt");
    const globbedFile = path.join(rootDir, "tsconfig.base.json");
    const writeParent = path.join(outputRoot, "artifacts");
    const absentWriteFile = path.join(writeParent, "receipt.json");
    mkdirSync(directory, { recursive: true });
    mkdirSync(writeParent, { recursive: true });
    writeFileSync(regularFile, "readable\n", "utf8");
    writeFileSync(globbedFile, "{}\n", "utf8");
    writeFile(rootDir, "harness/tasks/task-prior/artifacts/arch-rot.snapshot.json", "{}\n");
    mkdirSync(path.join(rootDir, "harness/tasks/task-ordinary/artifacts"), { recursive: true });

    assert.equal(resolveDeclaredReadScopes([directory], layout, outputRoot).ok, false);
    assert.equal(resolveDeclaredWriteScopes([writeParent], layout, outputRoot).ok, false);
    assert.equal(resolveDeclaredReadScopes([regularFile], layout, outputRoot).ok, true);
    const globbed = resolveDeclaredReadScopes([path.join(rootDir, "tsconfig*.json")], layout, outputRoot);
    assert.equal(globbed.ok, true);
    if (globbed.ok) assert.deepEqual(globbed.roots, [globbedFile]);
    const taskSnapshots = resolveDeclaredReadScopes([
      path.join(layout.tasksRoot, "*/artifacts/arch-rot.snapshot.json")
    ], layout, outputRoot);
    assert.equal(taskSnapshots.ok, true);
    if (taskSnapshots.ok) assert.deepEqual(taskSnapshots.roots, [
      path.join(layout.tasksRoot, "task-prior/artifacts/arch-rot.snapshot.json")
    ]);
    assert.equal(resolveDeclaredWriteScopes([absentWriteFile], layout, outputRoot).ok, true);
    assert.equal(resolveDeclaredReadScopes([`${directory}/**`], layout, outputRoot).ok, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("CLI script host rejects a preset package containing a symlinked read escape", {
  skip: process.platform === "win32"
}, () => {
  withCanonicalTempRoot((rootDir) => {
    const externalRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-package-escape-"));
    try {
      writeFileSync(path.join(externalRoot, "secret.txt"), "package secret\n", "utf8");
      writeProcessPreset(rootDir, "package-symlink-reader", "Package Symlink Reader", "scripts/preset-action.mjs");
      writeFile(rootDir, ".harness/presets/package-symlink-reader/scripts/preset-action.mjs", [
        "#!/usr/bin/env node",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const secret = readFileSync(path.join(import.meta.dirname, 'escape/secret.txt'), 'utf8');",
        "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({ schema: 'script-result/v1', ok: true, report: { secret } }), 'utf8');",
        ""
      ].join("\n"));
      symlinkSync(externalRoot, path.join(
        rootDir,
        ".harness/presets/package-symlink-reader/scripts/escape"
      ));

      const result = runJson(rootDir, [
        "script", "run", "preset:package-symlink-reader:scaffold", "--task", "task-package-symlink"
      ], false);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "script_scope_invalid_read");
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

test("CLI script context carries host-verified commit provenance in a linked worktree", {
  skip: process.platform === "win32"
}, () => {
  withLinkedWorktree((rootDir) => {
    writeProcessPreset(rootDir, "commit-reader", "Commit Reader", "scripts/preset-action.mjs");
    writeFile(rootDir, ".harness/presets/commit-reader/scripts/preset-action.mjs", [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "writeFileSync(process.env.HARNESS_SCRIPT_RESULT, JSON.stringify({",
      "  schema: 'script-result/v1', ok: true, report: { repository: context.repository }",
      "}), 'utf8');",
      ""
    ].join("\n"));

    const result = runJson(rootDir, [
      "script", "run", "preset:commit-reader:scaffold", "--task", "task-commit-reader"
    ]);

    assert.deepEqual(result.report.repository.commit, {
      sha: outerGitRead(rootDir, "rev-parse", "HEAD"),
      verification: "verified"
    });
    assert.deepEqual(result.report.repository.root, {
      realpath: realpathSync.native(rootDir),
      verification: "verified"
    });
  });
});

test("trusted script repository context canonicalizes a symlinked project root", {
  skip: process.platform === "win32"
}, () => {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-repository-root-"));
  const realRoot = path.join(container, "real");
  const linkedRoot = path.join(container, "linked");
  try {
    mkdirSync(realRoot);
    symlinkSync(realRoot, linkedRoot);

    assert.deepEqual(trustedScriptRepositoryContext(linkedRoot).root, {
      realpath: realpathSync.native(realRoot),
      verification: "verified"
    });
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test("trusted script repository context ignores ambient Git repository redirects", () => {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-repository-env-"));
  const redirectedRoot = path.join(container, "redirected");
  const requestedRoot = path.join(container, "requested");
  const redirectKeys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"] as const;
  const previous = Object.fromEntries(redirectKeys.map((key) => [key, process.env[key]]));
  try {
    initializeOuterRepository(redirectedRoot, "redirected repository\n");
    initializeOuterRepository(requestedRoot, "requested repository\n");
    const redirectedSha = outerGitRead(redirectedRoot, "rev-parse", "HEAD");
    const requestedSha = outerGitRead(requestedRoot, "rev-parse", "HEAD");
    assert.notEqual(redirectedSha, requestedSha);

    process.env.GIT_DIR = path.join(redirectedRoot, ".git");
    process.env.GIT_WORK_TREE = redirectedRoot;
    process.env.GIT_COMMON_DIR = path.join(redirectedRoot, ".git");

    assert.deepEqual(trustedScriptRepositoryContext(requestedRoot), {
      root: {
        realpath: realpathSync.native(requestedRoot),
        verification: "verified"
      },
      commit: {
        sha: requestedSha,
        verification: "verified"
      }
    });
  } finally {
    for (const key of redirectKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(container, { recursive: true, force: true });
  }
});

test("trusted script repository context accepts a commit only at the requested repository root", () => {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-repository-binding-"));
  const nestedRoot = path.join(rootDir, "nested");
  try {
    initializeOuterRepository(rootDir, "repository root binding\n");
    mkdirSync(nestedRoot);

    assert.deepEqual(trustedScriptRepositoryContext(nestedRoot), {
      root: {
        realpath: realpathSync.native(nestedRoot),
        verification: "verified"
      },
      commit: {
        sha: null,
        verification: "unverified"
      }
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeProcessPreset(
  rootDir: string,
  presetId: string,
  title: string,
  command: string,
  entrypointName = "scaffold",
  writes: ReadonlyArray<string> = ["{{outputRoot}}/**"],
  reads: ReadonlyArray<string> = []
): void {
  writeFile(rootDir, `.harness/presets/${presetId}/preset.json`, JSON.stringify({
    schema: "preset-manifest/v2",
    id: presetId,
    title,
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: {
      [entrypointName]: { type: "script", command, writes, ...(reads.length > 0 ? { reads } : {}) }
    },
    profiles: [{
      id: "baseline",
      title: "Baseline",
      checkerProfile: "standard",
        completionGates: [],
      templateSelections: []
    }],
    defaultProfile: "baseline"
  }, null, 2));
}

function runJson(rootDir: string, args: ReadonlyArray<string>, expectSuccess = true): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: { ...process.env, HARNESS_ACTOR: "agent:script-host-boundary-test" }
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

function withCanonicalTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-script-host-boundary-"));
  try {
    initializeNestedHarnessRepo(rootDir);
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function withLinkedWorktree<T>(fn: (rootDir: string) => T): T {
  const tempRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-linked-worktree-"));
  const primaryRoot = path.join(tempRoot, "primary");
  const linkedRoot = path.join(tempRoot, "linked");
  try {
    mkdirSync(primaryRoot, { recursive: true });
    execFileSync("git", ["-C", primaryRoot, "init", "-q"]);
    execFileSync("git", ["-C", primaryRoot, "config", "user.email", "harness@example.test"]);
    execFileSync("git", ["-C", primaryRoot, "config", "user.name", "Harness Test"]);
    writeFile(primaryRoot, ".gitignore", "/harness/\n/.harness/\n");
    writeFile(primaryRoot, "README.md", "linked worktree fixture\n");
    execFileSync("git", ["-C", primaryRoot, "add", ".gitignore", "README.md"]);
    execFileSync("git", ["-C", primaryRoot, "commit", "-q", "-m", "seed outer repository"]);
    execFileSync("git", ["-C", primaryRoot, "worktree", "add", "-q", "-b", "test-linked", linkedRoot]);
    initializeNestedHarnessRepo(linkedRoot);
    return fn(linkedRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function initializeOuterRepository(rootDir: string, readme: string): void {
  mkdirSync(rootDir, { recursive: true });
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "harness@example.test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Harness Test"]);
  writeFileSync(path.join(rootDir, "README.md"), readme, "utf8");
  execFileSync("git", ["-C", rootDir, "add", "README.md"]);
  execFileSync("git", ["-C", rootDir, "commit", "-q", "-m", "seed outer repository"]);
}

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

function gitRead(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
  }).trimEnd();
}

function outerGitRead(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
  }).trimEnd();
}
