// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const installScript = path.join(repoRoot, "scripts/install-source.sh");
const psInstallScript = path.join(repoRoot, "scripts/install-source.ps1");
const skipOnWindows = process.platform === "win32" ? "requires POSIX shell semantics and executable-bit stubs" : false;
const powershellShell = process.platform === "win32" ? "powershell.exe" : null;
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
if [ "$1" = "link" ] && [ "\${STUB_SKIP_LINK:-}" != 1 ]; then
  if [ "\${STUB_WIN_PREFIX:-}" = 1 ]; then
    mkdir -p "$STUB_NPM_PREFIX"
    cat > "$STUB_NPM_PREFIX/ha" <<'HA'
#!/bin/sh
printf 'fixture win ha: %s\\n' "$*"
HA
    chmod +x "$STUB_NPM_PREFIX/ha"
    : > "$STUB_NPM_PREFIX/ha.cmd"
  else
    mkdir -p "$STUB_NPM_PREFIX/bin"
    cat > "$STUB_NPM_PREFIX/bin/ha" <<'HA'
#!/bin/sh
printf 'fixture ha: %s\\n' "$*"
HA
    chmod +x "$STUB_NPM_PREFIX/bin/ha"
  fi
fi
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

test(
  "the printed CLI entry and launch hints run in a terminal without the npm prefix on PATH",
  { skip: skipOnWindows },
  () => {
    withFixture((fixture) => {
      const result = runInstall(fixture, ["--offline"]);
      assert.equal(result.status, 0, result.stderr);
      const entry = path.join(fixture.npmPrefix, "bin", "ha");
      assert.equal(lineWithPrefix(result.stdout, "CLI entry: "), `CLI entry: ${entry}`);
      const next = lineWithPrefix(result.stdout, "Next: ").slice("Next: ".length);
      const gui = lineWithPrefix(result.stdout, "GUI: ").slice("GUI: ".length);
      assert.equal(next, `"${entry}" --version`);
      assert.equal(gui, `"${entry}" gui`);
      assert.equal(
        lineWithPrefix(result.stdout, "export PATH="),
        `export PATH="${path.join(fixture.npmPrefix, "bin")}:$PATH"`,
      );
      for (const command of [next, gui]) {
        const executed = spawnSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin", HOME: fixture.root },
        });
        assert.equal(executed.status, 0, executed.stderr);
        assert.match(executed.stdout, /^fixture ha: /u);
      }
    });
  },
);

test("installer supports root-level npm prefix entries produced on Windows", { skip: skipOnWindows }, () => {
  withFixture((fixture) => {
    const result = runInstall(fixture, ["--offline"], { STUB_WIN_PREFIX: "1" });
    assert.equal(result.status, 0, result.stderr);
    const entry = path.join(fixture.npmPrefix, "ha");
    assert.equal(lineWithPrefix(result.stdout, "CLI entry: "), `CLI entry: ${entry}`);
    assert.equal(lineWithPrefix(result.stdout, "export PATH="), `export PATH="${fixture.npmPrefix}:$PATH"`);
  });
});

test(
  "PowerShell installer completes offline source flow and prints prefix root PATH",
  { skip: powershellShell ? false : "PowerShell source installer test runs on Windows" },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-ps-install-source-"));
    try {
      const installRoot = path.join(root, "install");
      const binDir = path.join(root, "bin");
      const npmPrefix = path.join(root, "npm");
      mkdirSync(path.join(installRoot, ".git"), { recursive: true });
      mkdirSync(path.join(installRoot, "packages", "cli"), { recursive: true });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(path.join(installRoot, "package.json"), '{"name":"fixture","private":true}\n');
      writeFileSync(
        path.join(installRoot, "package-lock.json"),
        '{"name":"fixture","lockfileVersion":3,"requires":true,"packages":{}}\n',
      );
      writeFileSync(path.join(installRoot, "packages/cli/package.json"), '{"name":"@fixture/cli"}\n');
      const electronRoot = path.join(installRoot, "node_modules", "electron");
      mkdirSync(path.join(electronRoot, "dist"), { recursive: true });
      writeFileSync(path.join(electronRoot, "package.json"), '{"name":"electron","version":"0.0.0"}\n');
      writeFileSync(path.join(electronRoot, "path.txt"), "electron.exe\n");
      writeFileSync(path.join(electronRoot, "install.js"), "process.exit(0);\n");
      writeFileSync(path.join(electronRoot, "dist", "electron.exe"), "stub");
      writeFileSync(path.join(binDir, "git.cmd"), '@echo off\r\nif "%1"=="-C" shift\r\nexit /b 0\r\n');
      writeFileSync(
        path.join(binDir, "npm.cmd"),
        [
          "@echo off",
          'echo npm %*>> "%STUB_NPM_LOG%"',
          'if "%1"=="ci" if not exist node_modules mkdir node_modules',
          'if "%1"=="link" (',
          '  if not exist "%STUB_NPM_PREFIX%" mkdir "%STUB_NPM_PREFIX%"',
          '  echo @echo off> "%STUB_NPM_PREFIX%\\ha.cmd"',
          '  echo echo fixture ps ha: %*>> "%STUB_NPM_PREFIX%\\ha.cmd"',
          ")",
          "exit /b 0",
          "",
        ].join("\r\n"),
      );
      const npmLog = path.join(root, "npm.log");
      const result = spawnSync(
        powershellShell,
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psInstallScript, "--offline"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
            HARNESS_INSTALL_ROOT: installRoot,
            HARNESS_NPM_PREFIX: npmPrefix,
            STUB_NPM_LOG: npmLog,
            STUB_NPM_PREFIX: npmPrefix,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const entry = path.join(npmPrefix, "ha.cmd");
      assert.equal(lineWithPrefix(result.stdout, "CLI entry: "), `CLI entry: ${entry}`);
      assert.equal(lineWithPrefix(result.stdout, "$env:PATH = "), `$env:PATH = "${npmPrefix};$env:PATH"`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "installer fails before printing hints when npm link creates no executable CLI entry",
  { skip: skipOnWindows },
  () => {
    withFixture((fixture) => {
      const result = runInstall(fixture, ["--offline"], { STUB_SKIP_LINK: "1" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /npm link did not create an executable CLI entry/u);
      assert.doesNotMatch(result.stdout, /CLI entry:/u);
    });
  },
);

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
  const npmPrefix = path.join(root, "npm");
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
    npmPrefix,
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
      HARNESS_NPM_PREFIX: fixture.npmPrefix,
      STUB_GIT_LOG: fixture.gitLog,
      STUB_NPM_LOG: fixture.npmLog,
      STUB_NPM_PREFIX: fixture.npmPrefix,
      ...env,
    },
  });
}

function lineWithPrefix(text, prefix) {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  assert.ok(line, `missing a line starting with ${JSON.stringify(prefix)}:\n${text}`);
  return line;
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}
