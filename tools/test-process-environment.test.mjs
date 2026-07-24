// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHermeticTestEnvironment, gitFixtureIdentityGuidance } from "./test-process-environment.mjs";

test("hermetic test environment rejects ambient Git identity and preserves the npm cache", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ha-hermetic-git-"));
  const environment = createHermeticTestEnvironment({
    ...process.env,
    HOME: "/developer/home",
    npm_config_cache: "/developer/npm-cache"
  });
  try {
    execFileSync("git", ["-C", fixture, "init", "-q"], { env: environment.env });
    const implicitCommit = spawnSync("git", ["-C", fixture, "commit", "--allow-empty", "-m", "implicit"], {
      encoding: "utf8",
      env: environment.env
    });
    assert.equal(implicitCommit.status, 128);
    assert.match(implicitCommit.stderr, /identity|email/iu);
    assert.equal(environment.env.HOME, environment.home);
    assert.equal(environment.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(environment.env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(environment.env.npm_config_cache, "/developer/npm-cache");

    execFileSync("git", [
      "-C", fixture,
      "-c", "user.email=harness@example.test",
      "-c", "user.name=Harness Test",
      "commit", "--allow-empty", "-m", "explicit"
    ], { env: environment.env, stdio: "ignore" });
  } finally {
    environment.cleanup();
    rmSync(fixture, { recursive: true, force: true });
  }
  assert.equal(existsSync(environment.home), false);
});

test("hermetic test environment removes Git author and agent-session fallbacks", () => {
  const environment = createHermeticTestEnvironment({
    ...process.env,
    GIT_AUTHOR_NAME: "Developer",
    GIT_AUTHOR_EMAIL: "developer@example.test",
    HARNESS_GIT_AUTHOR_NAME: "Developer",
    HARNESS_GIT_AUTHOR_EMAIL: "developer@example.test",
    CLAUDE_CODE_SESSION_ID: "developer-session",
    CODEX_THREAD_ID: "developer-thread"
  });
  try {
    assert.equal(environment.env.GIT_AUTHOR_NAME, undefined);
    assert.equal(environment.env.GIT_AUTHOR_EMAIL, undefined);
    assert.equal(environment.env.HARNESS_GIT_AUTHOR_NAME, "Developer");
    assert.equal(environment.env.HARNESS_GIT_AUTHOR_EMAIL, "developer@example.test");
    assert.equal(environment.env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(environment.env.CODEX_THREAD_ID, undefined);
    assert.equal(readEnvironmentValue(environment.env, "PATH"), readEnvironmentValue(process.env, "PATH"));
  } finally {
    environment.cleanup();
  }
});

test("hermetic test children exclude optional native exit state", () => {
  const compileCache = mkdtempSync(path.join(tmpdir(), "ha-shared-compile-cache-"));
  const environment = createHermeticTestEnvironment({
    ...process.env,
    NODE_COMPILE_CACHE: compileCache,
    MSGPACKR_NATIVE_ACCELERATION_DISABLED: "false"
  });
  try {
    const positiveControlEnv = {
      ...environment.env,
      MSGPACKR_NATIVE_ACCELERATION_DISABLED: "false"
    };
    const positiveControl = runNativeLifecycleProbe(positiveControlEnv);
    assert.equal(typeof positiveControl.compileCacheDir, "string");
    assert.equal(positiveControl.msgpackrNativeAcceleration, true);
    assert.equal(positiveControl.nativeAddons.some((addon) => addon.includes("msgpackr-extract")), true);

    const isolated = runNativeLifecycleProbe(environment.env);
    assert.equal(environment.env.NODE_COMPILE_CACHE, compileCache);
    assert.equal(environment.env.MSGPACKR_NATIVE_ACCELERATION_DISABLED, "true");
    assert.equal(typeof isolated.compileCacheDir, "string");
    assert.equal(isolated.msgpackrNativeAcceleration, false);
    assert.equal(isolated.nativeAddons.some((addon) => addon.includes("msgpackr-extract")), false);
  } finally {
    environment.cleanup();
    rmSync(compileCache, { recursive: true, force: true });
  }
});

function readEnvironmentValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function runNativeLifecycleProbe(env) {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'import { getCompileCacheDir } from "node:module";',
      'import { isNativeAccelerationEnabled } from "msgpackr";',
      "const report = process.report.getReport();",
      "console.log(JSON.stringify({",
      "  compileCacheDir: getCompileCacheDir() ?? null,",
      "  msgpackrNativeAcceleration: isNativeAccelerationEnabled,",
      '  nativeAddons: report.sharedObjects.filter((entry) => entry.endsWith(".node"))',
      "}));"
    ].join("\n")
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("Git identity failures teach the fixture-local repair command", () => {
  assert.match(gitFixtureIdentityGuidance("Author identity unknown"), /git -c user\.email=.* -c user\.name=/u);
  assert.match(gitFixtureIdentityGuidance("Author identity unknown"), /rerun the same test command/u);
  assert.equal(gitFixtureIdentityGuidance("ordinary assertion failure"), null);
});
