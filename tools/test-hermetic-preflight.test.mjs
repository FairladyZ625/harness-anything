// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assessHermeticConfig, main, parsePreflightArgs } from "./test-hermetic-preflight.mjs";

const identityHome = "/home/tester";
const defaultUserRoot = path.resolve(identityHome, ".harness");
const productionRoot = path.join(userInfo().homedir, ".harness");
const noIdentity = () => undefined;

test("preflight rejects the default daemon with separate user-root and socket failures", () => {
  const result = assessHermeticConfig({
    userRoot: defaultUserRoot,
    daemonId: "default",
    userRootSource: "flag",
    identityHome,
    readIdentity: noIdentity,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    `user-root path: ${defaultUserRoot} is the default daemon root; choose a dedicated directory.`,
    "socket namespace: the default user-root with daemon-id default resolves to the user's default daemon endpoint.",
  ]);
});

test("preflight reports a missing user root", () => {
  const result = assessHermeticConfig({
    userRoot: undefined,
    daemonId: undefined,
    userRootSource: undefined,
    identityHome: "/home/runner",
    readIdentity: noIdentity,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, [
    "user-root source: pass --user-root explicitly; implicit daemon configuration is not permitted.",
  ]);
});

test("preflight accepts an explicit dedicated user root with the default daemon id", () => {
  const result = assessHermeticConfig({
    userRoot: "/tmp/harness-test-isolation/run-42",
    daemonId: undefined,
    userRootSource: "flag",
    identityHome: "/home/runner",
    readIdentity: noIdentity,
  });
  assert.deepEqual(result, { ok: true, failures: [], effectiveDaemonId: "default" });
});

test("preflight refuses an environment-only user root", () => {
  const config = parsePreflightArgs([], {
    HARNESS_DAEMON_USER_ROOT: "/tmp/harness-test-isolation/run-42",
    HARNESS_DAEMON_ID: "test-isolation-42",
  });
  assert.deepEqual(
    assessHermeticConfig({ ...config, identityHome: "/home/runner", readIdentity: noIdentity }).failures,
    [
      "user-root source: pass --user-root explicitly; an environment-only value is not an auditable isolation boundary.",
    ],
  );
});

test("preflight command accepts explicit values", () => {
  assert.equal(main(["--user-root", "/tmp/harness-test-isolation/run-42"], {}), 0);
});

test("preflight rejects a symlink alias of the production daemon root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preflight-symlink-alias-"));
  try {
    const accountHome = path.join(root, "account");
    const production = path.join(accountHome, ".harness");
    const alias = path.join(root, "production-alias");
    mkdirSync(production, { recursive: true });
    symlinkSync(production, alias, "dir");

    const result = assessHermeticConfig({
      userRoot: alias,
      daemonId: "default",
      userRootSource: "flag",
      identityHome: accountHome,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [
      `user-root path: ${production} is the default daemon root; choose a dedicated directory.`,
      "socket namespace: the default user-root with daemon-id default resolves to the user's default daemon endpoint.",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight admits a dedicated root when the production root does not exist", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preflight-missing-production-"));
  try {
    const result = assessHermeticConfig({
      userRoot: path.join(root, "state"),
      daemonId: "default",
      userRootSource: "flag",
      identityHome: path.join(root, "account"),
    });
    assert.deepEqual(result, { ok: true, failures: [], effectiveDaemonId: "default" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight fails closed when a directory identity cannot be read", () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  for (const unreadable of ["/home/runner/.harness", "/tmp/harness-test-isolation/run-42"]) {
    const result = assessHermeticConfig({
      userRoot: "/tmp/harness-test-isolation/run-42",
      daemonId: "default",
      userRootSource: "flag",
      identityHome: "/home/runner",
      readIdentity(target) {
        if (target === unreadable) throw denied;
        return { dev: 1, ino: target === "/home/runner/.harness" ? 1 : 2 };
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [
      `user-root path: cannot verify /tmp/harness-test-isolation/run-42 is not the default daemon root: EACCES`,
    ]);
  }
});

// os.homedir() follows the mutable HOME a runtime may redirect. The production daemon root is
// the account's real home, so the CLI must reject it even when a child HOME points elsewhere.
test("preflight rejects the production daemon root while HOME is redirected", () => {
  const redirectedHome = mkdtempSync(path.join(tmpdir(), "ha-preflight-redirected-home-"));
  try {
    // The worker runtime redirects HOME into its own instance directory under the production root.
    for (const home of [redirectedHome, path.join(productionRoot, "runtime-instances", "fixture", "home")]) {
      const child = runPreflight(home, ["--user-root", productionRoot, "--daemon-id", "default"]);

      assert.equal(child.status, 1, child.stderr);
      assert.ok(child.stderr.includes(`user-root path: ${productionRoot} is the default daemon root`), child.stderr);
      assert.match(child.stderr, /socket namespace: .* default daemon endpoint/u);
    }
  } finally {
    rmSync(redirectedHome, { recursive: true, force: true });
  }
});

test(
  "preflight rejects filesystem aliases of the production daemon root while HOME is redirected",
  {
    skip:
      process.platform === "win32"
        ? "requires POSIX directory-symlink semantics"
        : hasProductionRoot()
          ? false
          : "the host has no production daemon root to alias",
  },
  () => {
    const redirectedHome = mkdtempSync(path.join(tmpdir(), "ha-preflight-redirected-home-"));
    try {
      const aliases = [path.join(redirectedHome, "production-alias")];
      symlinkSync(productionRoot, aliases[0], "dir");
      const caseAlias = path.join(
        path.dirname(productionRoot).toUpperCase(),
        path.basename(productionRoot).toUpperCase(),
      );
      if (sameIdentity(productionRoot, caseAlias)) aliases.push(caseAlias);

      for (const alias of aliases) {
        const child = runPreflight(redirectedHome, ["--user-root", alias, "--daemon-id", "default"]);

        assert.equal(child.status, 1, `${alias}\n${child.stderr}`);
        assert.ok(child.stderr.includes(`user-root path: ${productionRoot} is the default daemon root`), child.stderr);
        assert.match(child.stderr, /socket namespace: .* default daemon endpoint/u);
      }
    } finally {
      rmSync(redirectedHome, { recursive: true, force: true });
    }
  },
);

test("preflight admits a dedicated root under the same redirected HOME", () => {
  const redirectedHome = mkdtempSync(path.join(tmpdir(), "ha-preflight-redirected-home-"));
  try {
    const child = runPreflight(redirectedHome, [
      "--user-root",
      "/tmp/harness-test-isolation/dedicated-root",
      "--daemon-id",
      "default",
    ]);

    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /^PASS hermetic test configuration:/u);
  } finally {
    rmSync(redirectedHome, { recursive: true, force: true });
  }
});

function hasProductionRoot() {
  try {
    statSync(productionRoot);
    return true;
  } catch {
    return false;
  }
}

function sameIdentity(left, right) {
  try {
    const leftStat = statSync(left),
      rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function runPreflight(home, args) {
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./test-hermetic-preflight.mjs", import.meta.url)), ...args],
    { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
}
