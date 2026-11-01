// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const installScript = path.join(repoRoot, "scripts/install-source.sh");
const skipOnWindows = process.platform === "win32" ? "requires POSIX shell semantics and executable-bit stubs" : false;
const headSha = "a".repeat(40);
const otherSha = "b".repeat(40);

const gitStub = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$STUB_GIT_LOG"
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  pull)
    if [ "\${STUB_PULL:-fail}" = fail ]; then
      printf '%s\\n' "fatal: unable to access 'https://github.com/FairladyZ625/harness-anything.git/': Failed to connect to github.com port 443 after 75002 ms: Could not connect to server" >&2
      exit 128
    fi
    exit 0
    ;;
  rev-parse)
    shift
    case "$1" in
      --verify) printf '%s\\n' "\${STUB_RESOLVED:-${headSha}}" ;;
      *) printf '%s\\n' "\${STUB_HEAD:-1111111111111111111111111111111111111111}" ;;
    esac
    exit 0
    ;;
esac
exit 0
`;

const npmStub = `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$STUB_NPM_LOG"
if [ "$1" = "ci" ]; then mkdir -p node_modules; fi
exit 0
`;

test(
  "offline install builds without git and skips npm ci while dependencies are unchanged",
  { skip: skipOnWindows },
  () => {
    withFixture((fixture) => {
      const first = runInstall(fixture, ["--offline"]);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /Installed source CLI at/u);
      assert.deepEqual(readLines(fixture.npmLog), [
        "npm ci",
        "npm run build -w @harness-anything/daemon",
        "npm run build -w @harness-anything/cli",
        "npm run build -w @harness-anything/gui",
        "npm link",
      ]);
      assert.equal(readLines(fixture.gitLog).length, 0, "offline mode must not invoke git");
      assert.equal(existsSync(path.join(fixture.installRoot, "node_modules/.harness-install-deps.sha256")), true);

      writeFileSync(fixture.npmLog, "");
      const second = runInstall(fixture, ["--offline"]);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /Dependencies unchanged \([0-9a-f]{12}\); skipping npm ci\./u);
      assert.deepEqual(readLines(fixture.npmLog), [
        "npm run build -w @harness-anything/daemon",
        "npm run build -w @harness-anything/cli",
        "npm run build -w @harness-anything/gui",
        "npm link",
      ]);
    });
  },
);

test("default install still pulls when the remote is reachable", { skip: skipOnWindows }, () => {
  withFixture((fixture) => {
    const result = runInstall(fixture, [], { STUB_PULL: "ok" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(readLines(fixture.gitLog)[0], /git -C .* pull --ff-only/u);
    assert.equal(readLines(fixture.npmLog)[0], "npm ci");
  });
});

test("pull failure without offline evidence stops before building and explains why", { skip: skipOnWindows }, () => {
  withFixture((fixture) => {
    const result = runInstall(fixture, []);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot update .* from https:\/\/github\.com\/FairladyZ625\/harness-anything\.git/u);
    assert.match(result.stderr, /rerun with --offline/u);
    assert.deepEqual(readLines(fixture.npmLog), []);
  });
});

test(
  "pull failure continues when --ref proves the checkout is already the requested commit",
  { skip: skipOnWindows },
  () => {
    withFixture((fixture) => {
      const result = runInstall(fixture, ["--ref", headSha], { STUB_HEAD: headSha, STUB_RESOLVED: headSha });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Pull failed, but .* is already at a{40}; continuing with the local source/u);
      assert.equal(readLines(fixture.npmLog)[0], "npm ci");
    });
  },
);

test("pull failure with a different --ref stops before building", { skip: skipOnWindows }, () => {
  withFixture((fixture) => {
    const result = runInstall(fixture, ["--ref", otherSha], { STUB_HEAD: headSha, STUB_RESOLVED: otherSha });

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`local HEAD is ${headSha}`, "u"));
    assert.deepEqual(readLines(fixture.npmLog), []);
  });
});

test("--ref is enforced after a successful pull", { skip: skipOnWindows }, () => {
  withFixture((fixture) => {
    const result = runInstall(fixture, ["--ref", otherSha], {
      STUB_PULL: "ok",
      STUB_HEAD: headSha,
      STUB_RESOLVED: otherSha,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`--ref requires ${otherSha}`, "u"));
    assert.deepEqual(readLines(fixture.npmLog), []);
  });
});

test("offline mode refuses to guess a checkout that does not exist", { skip: skipOnWindows }, () => {
  withFixture((fixture) => {
    rmSync(fixture.installRoot, { recursive: true, force: true });

    const result = runInstall(fixture, ["--offline"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a git checkout/u);
    assert.match(result.stderr, /copy an existing checkout/u);
    assert.deepEqual(readLines(fixture.gitLog), []);
    assert.deepEqual(readLines(fixture.npmLog), []);
  });
});

function withFixture(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-install-source-"));
  try {
    fn(createFixture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createFixture(root) {
  const installRoot = path.join(root, "install");
  const binDir = path.join(root, "bin");
  mkdirSync(path.join(installRoot, ".git"), { recursive: true });
  mkdirSync(path.join(installRoot, "packages", "cli"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(installRoot, "package.json"), '{"name":"fixture","private":true}\n');
  writeFileSync(
    path.join(installRoot, "package-lock.json"),
    '{"name":"fixture","lockfileVersion":3,"requires":true,"packages":{}}\n',
  );
  writeFileSync(path.join(installRoot, "packages/cli/package.json"), '{"name":"@fixture/cli"}\n');
  // The installer downloads Electron through the package's own install.js and then
  // verifies path.txt; model both in the fixture so the test exercises the real
  // installer sequence instead of failing on a missing Electron tree.
  const electronRoot = path.join(installRoot, "node_modules", "electron");
  mkdirSync(path.join(electronRoot, "dist"), { recursive: true });
  writeFileSync(path.join(electronRoot, "package.json"), '{"name":"electron","version":"0.0.0"}\n');
  writeFileSync(path.join(electronRoot, "path.txt"), "electron\n");
  writeExecutable(path.join(electronRoot, "install.js"), "process.exit(0);\n");
  writeExecutable(path.join(electronRoot, "dist", "electron"), "#!/bin/sh\nexit 0\n");
  writeExecutable(path.join(binDir, "git"), gitStub);
  writeExecutable(path.join(binDir, "npm"), npmStub);
  return {
    binDir,
    installRoot,
    gitLog: path.join(root, "git.log"),
    npmLog: path.join(root, "npm.log"),
  };
}

function writeExecutable(file, contents) {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

function runInstall(fixture, args, env = {}) {
  return spawnSync("bash", [installScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      HARNESS_INSTALL_ROOT: fixture.installRoot,
      STUB_GIT_LOG: fixture.gitLog,
      STUB_NPM_LOG: fixture.npmLog,
      ...env,
    },
  });
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}
