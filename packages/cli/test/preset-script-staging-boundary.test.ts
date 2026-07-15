// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverScriptEntries } from "../src/commands/extensions/script.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");

test("CLI preset action cannot write directly to the canonical output root", () => {
  withTempRoot((rootDir) => {
    initializeHarness(rootDir);
    writeProcessActionPreset(rootDir, "canonical-bypass-action", "scaffold", [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const canonical = path.join(context.paths.projectRoot, 'harness/tasks/task-canonical-action/artifacts');",
      "mkdirSync(canonical, { recursive: true });",
      "writeFileSync(path.join(canonical, 'escaped.txt'), 'escaped\\n', 'utf8');",
      "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/preset-result.json'), JSON.stringify({ ok: true, report: {} }), 'utf8');"
    ]);

    const result = runJson(rootDir, [
      "preset", "action", "canonical-bypass-action", "scaffold",
      "--task", "task-canonical-action", "--allow-scripts"
    ], false);

    assert.equal(result.ok, false);
    assert.match(result.error.code, /^preset_(read|write)_scope_violation$/u);
    assert.equal(existsSync(path.join(
      rootDir,
      "harness/tasks/task-canonical-action/artifacts/escaped.txt"
    )), false);
  });
});

test("CLI preset action rejects descendant write symlinks targeting canonical and dangling paths", {
  skip: process.platform === "win32"
}, () => {
  withTempRoot((rootDir) => {
    initializeHarness(rootDir);
    writeProcessActionPreset(rootDir, "descendant-write-symlink", "scaffold", [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "const escaped = path.join(context.outputRoot, 'artifacts/escape');",
      "mkdirSync(escaped, { recursive: true });",
      "writeFileSync(path.join(escaped, 'pwned.txt'), 'escaped\\n', 'utf8');",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/preset-result.json'), JSON.stringify({ ok: true, report: {} }), 'utf8');"
    ], false);

    const canonicalTarget = path.join(rootDir, "harness/context/canonical-symlink-target");
    mkdirSync(canonicalTarget, { recursive: true });
    writeFileSync(path.join(canonicalTarget, "sentinel.txt"), "canonical\n", "utf8");
    const canonicalLinkParent = path.join(rootDir, "harness/tasks/task-canonical-descendant/artifacts");
    mkdirSync(canonicalLinkParent, { recursive: true });
    symlinkSync(canonicalTarget, path.join(canonicalLinkParent, "escape"));

    const canonicalResult = runJson(rootDir, [
      "preset", "action", "descendant-write-symlink", "scaffold",
      "--task", "task-canonical-descendant", "--allow-scripts"
    ], false);

    assert.equal(canonicalResult.ok, false);
    assert.equal(canonicalResult.error.code, "preset_write_scope_invalid");
    assert.equal(existsSync(path.join(canonicalTarget, "pwned.txt")), false);
    assert.equal(readFileSync(path.join(canonicalTarget, "sentinel.txt"), "utf8"), "canonical\n");

    const danglingLinkParent = path.join(rootDir, "harness/tasks/task-dangling-descendant/artifacts");
    mkdirSync(danglingLinkParent, { recursive: true });
    symlinkSync(path.join(rootDir, "missing-descendant-target"), path.join(danglingLinkParent, "escape"));

    const danglingResult = runJson(rootDir, [
      "preset", "action", "descendant-write-symlink", "scaffold",
      "--task", "task-dangling-descendant", "--allow-scripts"
    ], false);

    assert.equal(danglingResult.ok, false);
    assert.equal(danglingResult.error.code, "preset_write_scope_invalid");
    assert.equal(existsSync(path.join(rootDir, "missing-descendant-target/pwned.txt")), false);
  });
});

test("CLI preset action attributes symlinks in overlapping read and write scopes to the read boundary", {
  skip: process.platform === "win32"
}, () => {
  withTempRoot((rootDir) => {
    initializeHarness(rootDir);
    writeProcessActionPreset(rootDir, "overlapping-symlink-scope", "scaffold", []);
    const outputRoot = path.join(rootDir, "harness/tasks/task-overlapping-symlink");
    mkdirSync(outputRoot, { recursive: true });
    symlinkSync("missing-read-target", path.join(outputRoot, "dangling-read"));

    const result = runJson(rootDir, [
      "preset", "action", "overlapping-symlink-scope", "scaffold",
      "--task", "task-overlapping-symlink", "--allow-scripts"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_read_scope_invalid");
  });
});

test("CLI preset action preserves a failed receipt without ingesting staged writes", () => {
  withTempRoot((rootDir) => {
    initializeHarness(rootDir);
    writeProcessActionPreset(rootDir, "failed-preset-action", "scaffold", failedPresetScript("partial.txt"));
    const headBefore = gitRead(rootDir, "rev-parse", "HEAD");

    const result = runJson(rootDir, [
      "preset", "action", "failed-preset-action", "scaffold",
      "--task", "task-failed-action", "--allow-scripts"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_script_result_failed");
    assert.equal(result.report.status, "failed");
    assert.deepEqual(result.generated, []);
    assert.equal(existsSync(path.join(
      rootDir,
      "harness/tasks/task-failed-action/artifacts/partial.txt"
    )), false);
    assert.equal(existsSync(path.join(
      rootDir,
      "harness/tasks/task-failed-action/artifacts/preset-result.json"
    )), false);
    assert.equal(gitRead(rootDir, "rev-parse", "HEAD"), headBefore);
    assert.equal(gitRead(rootDir, "status", "--short"), "");
  });
});

test("CLI preset audit action may ingest diagnostics without becoming an automatic check", () => {
  withTempRoot((rootDir) => {
    initializeHarness(rootDir);
    writeProcessActionPreset(rootDir, "failed-preset-audit", "check", failedPresetScript("audit-diagnostic.json"));

    const listedChecks = runJson(rootDir, ["script", "list", "--kind", "check"]);
    assert.equal(listedChecks.scripts.some(
      (script: { id: string }) => script.id === "preset:failed-preset-audit:check"
    ), false);

    const result = runJson(rootDir, [
      "preset", "action", "failed-preset-audit", "check",
      "--task", "task-failed-audit", "--allow-scripts"
    ], false);

    assert.equal(result.ok, false);
    assert.equal(result.error.code, "preset_script_result_failed");
    assert.equal(result.report.status, "failed");
    assert.equal(result.generated.includes(
      "harness/tasks/task-failed-audit/artifacts/audit-diagnostic.json"
    ), true);
    assert.equal(readFileSync(path.join(
      rootDir,
      "harness/tasks/task-failed-audit/artifacts/audit-diagnostic.json"
    ), "utf8"), "diagnostic\n");
    assert.match(gitRead(rootDir, "log", "--format=%s"), /script-ingest/u);
  });
});

test("CLI preset action rejects a preset package containing a symlinked read escape", {
  skip: process.platform === "win32"
}, () => {
  withTempRoot((rootDir) => {
    initializeHarness(rootDir);
    const externalRoot = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-preset-package-escape-"));
    try {
      writeFileSync(path.join(externalRoot, "secret.txt"), "preset package secret\n", "utf8");
      writeProcessActionPreset(rootDir, "preset-package-symlink", "scaffold", [
        "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
        "const secret = readFileSync(path.join(import.meta.dirname, 'escape/secret.txt'), 'utf8');",
        "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
        "writeFileSync(path.join(context.outputRoot, 'artifacts/preset-result.json'), JSON.stringify({ ok: true, report: { secret } }), 'utf8');"
      ]);
      symlinkSync(externalRoot, path.join(
        rootDir,
        ".harness/presets/preset-package-symlink/scripts/escape"
      ));

      const result = runJson(rootDir, [
        "preset", "action", "preset-package-symlink", "scaffold",
        "--task", "task-preset-package-symlink", "--allow-scripts"
      ], false);

      assert.equal(result.ok, false);
      assert.equal(result.error.code, "preset_read_scope_invalid");
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});

test("two entrypoints in one preset exclude undeclared host secrets and GitHub tokens", () => {
  withTempRoot((rootDir) => {
    initializeHarness(rootDir);
    writeProcessActionPreset(rootDir, "child-env-boundary", "scaffold", [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
      "mkdirSync(path.join(context.outputRoot, 'artifacts'), { recursive: true });",
      "writeFileSync(path.join(context.outputRoot, 'artifacts/preset-result.json'), JSON.stringify({",
      "  ok: true, report: {",
      "    entrypoint: context.entrypoint,",
      "    secret: process.env.HARNESS_SECRET_SENTINEL ?? null,",
      "    githubToken: process.env.GITHUB_TOKEN ?? null,",
      "    ghToken: process.env.GH_TOKEN ?? null",
      "  }",
      "}), 'utf8');"
    ]);
    const manifestPath = path.join(rootDir, ".harness/presets/child-env-boundary/preset.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, any>;
    manifest.entrypoints.check = { ...manifest.entrypoints.scaffold };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const secretEnvironment = {
      HARNESS_SECRET_SENTINEL: "must-not-leak",
      GITHUB_TOKEN: "github-must-not-leak",
      GH_TOKEN: "gh-must-not-leak"
    };
    const discovered = discoverScriptEntries(rootDir, "script-list");
    assert.equal(discovered.ok, true);

    const scriptRun = runJson(rootDir, [
      "script", "run", "preset:child-env-boundary:check",
      "--task", "task-child-env-script"
    ], true, secretEnvironment);
    const presetAction = runJson(rootDir, [
      "preset", "action", "child-env-boundary", "scaffold",
      "--task", "task-child-env-action", "--allow-scripts"
    ], true, secretEnvironment);

    assert.deepEqual(presetAction.report, {
      entrypoint: "scaffold",
      secret: null,
      githubToken: null,
      ghToken: null
    });
    assert.deepEqual(scriptRun.report, {
      entrypoint: "check",
      secret: null,
      githubToken: null,
      ghToken: null
    });
  });
});

function initializeHarness(rootDir: string): void {
  ensureTestHarnessIdentity(rootDir);
  runJson(rootDir, ["init"]);
}

function writeProcessActionPreset(
  rootDir: string,
  presetId: string,
  entrypoint: string,
  scriptLines: ReadonlyArray<string>,
  includeOutputRead = true
): void {
  writeFile(rootDir, `.harness/presets/${presetId}/preset.json`, JSON.stringify({
    schema: "preset-manifest/v2",
    id: presetId,
    title: presetId,
    vertical: "software/coding",
    version: "1.0.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: {
      [entrypoint]: {
        type: "script",
        command: "scripts/preset-action.mjs",
        ...(includeOutputRead ? { reads: ["{{outputRoot}}/**"] } : {}),
        writes: ["{{outputRoot}}/**"]
      }
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
  writeFile(
    rootDir,
    `.harness/presets/${presetId}/scripts/preset-action.mjs`,
    `${scriptLines.join("\n")}\n`
  );
}

function failedPresetScript(filename: string): ReadonlyArray<string> {
  return [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
    "const artifacts = path.join(context.outputRoot, 'artifacts');",
    "mkdirSync(artifacts, { recursive: true });",
    `writeFileSync(path.join(artifacts, '${filename}'), 'diagnostic\\n', 'utf8');`,
    "writeFileSync(path.join(artifacts, 'preset-result.json'), JSON.stringify({ ok: false, report: { status: 'failed' } }), 'utf8');"
  ];
}

function runJson(
  rootDir: string,
  args: ReadonlyArray<string>,
  expectSuccess = true,
  extraEnvironment: Readonly<Record<string, string>> = {}
): Record<string, any> {
  try {
    const output = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_ACTOR: "agent:preset-script-staging-test",
        HARNESS_GIT_AUTHOR_NAME: "Harness Test",
        HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test",
        ...extraEnvironment
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
  const rootDir = mkdtempSync(path.join(realpathSync(tmpdir()), "harness-preset-script-staging-"));
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

function writeFile(rootDir: string, relativePath: string, body: string): void {
  const target = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}
