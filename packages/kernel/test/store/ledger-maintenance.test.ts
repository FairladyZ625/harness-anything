// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { configureLedgerMaintenance, installLedgerCommitGuard } from "../../src/index.ts";
import { withTempStore } from "./helpers.ts";

function git(repoRoot: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function ledger(rootDir: string): string {
  const repoRoot = path.join(rootDir, "harness");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet");
  return repoRoot;
}

/** Shadows `git version` with an older release while delegating every other subcommand to the real binary. */
function withStubbedGitVersion<T>(rootDir: string, version: string, fn: () => T): T {
  const binDir = path.join(rootDir, "stub-bin"),
    windows = process.platform === "win32",
    shim = path.join(binDir, windows ? "git.cmd" : "git"),
    real = execFileSync(windows ? "where" : "which", ["git"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/u)[0]!;
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    shim,
    windows
      ? `@echo off\r\nfor %%A in (%*) do if /I "%%~A"=="version" (echo git version ${version}& exit /b 0)\r\n"${real}" %*\r\n`
      : `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "version" ]; then echo "git version ${version}"; exit 0; fi; done\nexec ${real} "$@"\n`,
    "utf8",
  );
  if (!windows) chmodSync(shim, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previous ?? ""}`;
  try {
    const observed = windows
      ? execFileSync("cmd.exe", ["/d", "/s", "/c", "git version"], { encoding: "utf8" }).trim()
      : execFileSync("git", ["version"], { encoding: "utf8" }).trim();
    if (observed !== `git version ${version}`)
      throw new Error(`git version fixture did not intercept the probe: ${observed}`);
    return fn();
  } finally {
    process.env.PATH = previous;
  }
}

test("ledger maintenance pins automatic housekeeping out of the write path", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    const receipt = configureLedgerMaintenance(repoRoot);

    assert.equal(git(repoRoot, "config", "--get", "maintenance.autoDetach"), "true");
    assert.equal(git(repoRoot, "config", "--get", "gc.autoDetach"), "true");
    assert.equal(git(repoRoot, "config", "--get", "core.splitIndex"), "false");
    assert.equal(git(repoRoot, "config", "--get", "core.untrackedCache"), "true");
    assert.ok(receipt.applied.includes("maintenance.autoDetach=true"));
    assert.equal(receipt.gitVersion !== null, true);
  });
});

test("ledger maintenance selects the geometric strategy on Git 2.52 and later", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    const receipt = configureLedgerMaintenance(repoRoot);
    const supported =
      receipt.gitVersion !== null &&
      Number(receipt.gitVersion.split(".")[0]) * 1000 + Number(receipt.gitVersion.split(".")[1]) >= 2052;

    if (supported) {
      assert.equal(receipt.strategy, "geometric");
      assert.equal(receipt.degraded, null);
      assert.equal(git(repoRoot, "config", "--get", "maintenance.strategy"), "geometric");
    } else {
      assert.equal(receipt.strategy, null);
      assert.match(receipt.degraded ?? "", /predates the 2\.52\.0 geometric maintenance strategy/u);
    }
  });
});

test("ledger maintenance degrades audibly below the geometric floor and leaves the strategy unset", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    const receipt = withStubbedGitVersion(rootDir, "2.39.5", () => configureLedgerMaintenance(repoRoot));

    assert.equal(receipt.strategy, null);
    assert.equal(receipt.gitVersion, "2.39.5");
    assert.match(receipt.degraded ?? "", /git 2\.39\.5 predates the 2\.52\.0 geometric maintenance strategy/u);
    // An unset strategy is required: an unknown value makes every later `git commit` print a fatal.
    assert.throws(() => git(repoRoot, "config", "--get", "maintenance.strategy"));
    // The detach pins still land, because they are what keeps housekeeping off the write path.
    assert.equal(git(repoRoot, "config", "--get", "gc.autoDetach"), "true");
  });
});

test("ledger maintenance is idempotent and rewrites nothing on a second call", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    const first = configureLedgerMaintenance(repoRoot);
    const second = configureLedgerMaintenance(repoRoot);

    assert.ok(first.applied.length > 0);
    assert.deepEqual(second.applied, []);
    assert.equal(second.strategy, first.strategy);
  });
});

test("ledger maintenance config outranks a global gc.autoDetach opt-out", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      globalConfig = path.join(rootDir, "global-gitconfig");
    writeFileSync(globalConfig, "[gc]\n\tautoDetach = false\n", "utf8");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      configureLedgerMaintenance(repoRoot);
      // Repository scope wins, so a global opt-out cannot pull a repack into a ledger write.
      assert.equal(git(repoRoot, "config", "--get", "gc.autoDetach"), "true");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
});

test("ledger maintenance keeps blobs byte-identical under a global core.autocrlf=true", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      globalConfig = path.join(rootDir, "global-gitconfig");
    writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n", "utf8");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      configureLedgerMaintenance(repoRoot);
      assert.equal(git(repoRoot, "config", "--get", "core.autocrlf"), "false");
      // Init verifies its publication by hashing the exact bytes it wrote, so a
      // CRLF document normalized to LF on commit fails that readback wholesale.
      const body = "line one\r\nline two\r\n",
        target = path.join(repoRoot, "crlf.md");
      writeFileSync(target, body, "utf8");
      git(repoRoot, "add", "crlf.md");
      // The installed commit guard refuses commits without the daemon's writer env marker.
      installLedgerCommitGuard(repoRoot);
      execFileSync(
        "git",
        [
          "-C",
          repoRoot,
          "-c",
          "user.name=Ledger",
          "-c",
          "user.email=ledger@example.com",
          "commit",
          "--quiet",
          "-m",
          "crlf",
        ],
        { encoding: "utf8", env: { ...process.env, HARNESS_LEDGER_WRITER: "1" } },
      );
      const blob = execFileSync("git", ["-C", repoRoot, "show", "HEAD:crlf.md"], { encoding: "buffer" });
      assert.deepEqual(new Uint8Array(blob), new Uint8Array(Buffer.from(body)));
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });
});

test("ledger commit guard refuses a manual commit and points at ha doc sync --submit", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    installLedgerCommitGuard(repoRoot);
    writeFileSync(path.join(repoRoot, "note.md"), "manual\n", "utf8");
    git(repoRoot, "add", "note.md");

    const attempt = spawnSync(
      "git",
      ["-C", repoRoot, "-c", "user.name=Manual", "-c", "user.email=manual@example.com", "commit", "-m", "manual"],
      { encoding: "utf8" },
    );
    assert.equal(attempt.status, 1);
    assert.match(attempt.stderr, /Refusing a manual commit in the Harness ledger repository/u);
    assert.match(attempt.stderr, /ha doc sync --submit --task <task-id>/u);
    assert.throws(() => git(repoRoot, "rev-parse", "--verify", "--quiet", "HEAD"));
  });
});

test("ledger commit guard lets a daemon-marked commit through", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    installLedgerCommitGuard(repoRoot);
    writeFileSync(path.join(repoRoot, "note.md"), "daemon\n", "utf8");
    git(repoRoot, "add", "note.md");

    execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "-c",
        "user.name=Daemon",
        "-c",
        "user.email=daemon@example.com",
        "commit",
        "--quiet",
        "-m",
        "daemon",
      ],
      { encoding: "utf8", env: { ...process.env, HARNESS_LEDGER_WRITER: "1" } },
    );
    assert.equal(git(repoRoot, "log", "-1", "--format=%s"), "daemon");
  });
});

test("ledger commit guard preserves a foreign hook as pre-commit.local and reinstall is idempotent", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      hooksDir = path.join(repoRoot, ".git", "hooks"),
      foreignPath = path.join(rootDir, "foreign-ran"),
      foreignBody = `#!/bin/sh\necho foreign > "${foreignPath}"\n`;
    writeFileSync(path.join(hooksDir, "pre-commit"), foreignBody, { mode: 0o755 });

    const first = installLedgerCommitGuard(repoRoot);
    assert.ok(first.applied.includes("hooks/pre-commit=harness-ledger-commit-guard/v1"));
    assert.equal(readFileSync(path.join(hooksDir, "pre-commit.local"), "utf8"), foreignBody);

    const second = installLedgerCommitGuard(repoRoot);
    assert.ok(!second.applied.includes("hooks/pre-commit=harness-ledger-commit-guard/v1"));

    // The chained foreign hook still runs for the daemon's marked commit.
    writeFileSync(path.join(repoRoot, "note.md"), "daemon\n", "utf8");
    git(repoRoot, "add", "note.md");
    execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "-c",
        "user.name=Daemon",
        "-c",
        "user.email=daemon@example.com",
        "commit",
        "--quiet",
        "-m",
        "daemon",
      ],
      { encoding: "utf8", env: { ...process.env, HARNESS_LEDGER_WRITER: "1" } },
    );
    assert.equal(readFileSync(foreignPath, "utf8").trim(), "foreign");

    // And it still refuses a manual commit.
    writeFileSync(path.join(repoRoot, "more.md"), "manual\n", "utf8");
    git(repoRoot, "add", "more.md");
    const attempt = spawnSync(
      "git",
      ["-C", repoRoot, "-c", "user.name=Manual", "-c", "user.email=manual@example.com", "commit", "-m", "manual"],
      { encoding: "utf8" },
    );
    assert.equal(attempt.status, 1);
    assert.match(attempt.stderr, /ha doc sync --submit/u);
  });
});

test("ledger commit guard stays out of a ledger that shares the project's repository", () => {
  withTempStore((rootDir) => {
    // A ledger root that is a plain directory of the enclosing repository: every commit
    // there is a project commit, and refusing one is the harm the guard exists to prevent.
    const ledgerRoot = path.join(rootDir, "harness");
    mkdirSync(ledgerRoot, { recursive: true });
    git(rootDir, "init", "--quiet");

    const receipt = installLedgerCommitGuard(ledgerRoot);

    assert.deepEqual(receipt.applied, []);
    assert.match(receipt.degraded ?? "", /not a standalone Git repository/u);
    assert.equal(existsSync(path.join(rootDir, ".git", "hooks", "pre-commit")), false);
    writeFileSync(path.join(ledgerRoot, "note.md"), "project content\n", "utf8");
    git(rootDir, "add", "harness/note.md");
    // Fixture commits carry their own identity: an ambient global identity exists on developer
    // machines and not in the isolated test target.
    execFileSync(
      "git",
      [
        "-C",
        rootDir,
        "-c",
        "user.name=Project",
        "-c",
        "user.email=project@example.com",
        "commit",
        "--quiet",
        "-m",
        "project commit through the shared ledger directory",
      ],
      { encoding: "utf8" },
    );
    assert.equal(git(rootDir, "log", "-1", "--format=%s"), "project commit through the shared ledger directory");
  });
});
