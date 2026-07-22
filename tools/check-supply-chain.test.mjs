// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-supply-chain.mjs");
const CHECK_PROCESS_TIMEOUT_MS = 90_000;

test("supply-chain check accepts the expected release gate contract", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root);

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Supply chain check passed/u);
    assert.match(result.stdout, /phase=sbom .*status=completed/u);
  });
});

test("supply-chain check accepts an explicitly wider fail-closed command timeout", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root);

    const result = runCheck(root, {
      env: { HARNESS_SUPPLY_CHAIN_COMMAND_TIMEOUT_MS: "120000" }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /phase=audit-1 .*timeoutMs=120000 .*status=completed/u);
  });
});

test("supply-chain check rejects non-CLI publishable packages", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      packageMutator: (packages) => {
        packages["packages/daemon/package.json"].private = false;
      }
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /packages\/daemon\/package\.json must remain private/u);
  });
});

test("supply-chain check rejects CLI dry-run metadata drift", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      packageMutator: (packages) => {
        packages["packages/cli/package.json"].publishConfig = undefined;
      }
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publishConfig\.access public/u);
  });
});

test("supply-chain check rejects missing OSV documentation", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      supplyDocBody: validSupplyDoc().replace("npx --yes osv-scanner@latest --lockfile=package-lock.json", "osv scan later")
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /OSV live scan command/u);
  });
});

test("supply-chain check rejects unreviewed dependency licenses", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      lockMutator: (lock) => {
        lock.packages["node_modules/example"].license = "GPL-2.0-only";
      }
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unreviewed license GPL-2\.0-only/u);
  });
});

test("supply-chain check accepts reviewed OR-license elections", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      lockMutator: (lock) => {
        lock.packages["node_modules/expand-template"] = {
          version: "2.0.3",
          resolved: "https://registry.npmjs.org/expand-template/-/expand-template-2.0.3.tgz",
          integrity: "sha512-test",
          license: "(MIT OR WTFPL)"
        };
        lock.packages["node_modules/rc"] = {
          version: "1.2.8",
          resolved: "https://registry.npmjs.org/rc/-/rc-1.2.8.tgz",
          integrity: "sha512-test",
          license: "(BSD-2-Clause OR MIT OR Apache-2.0)"
        };
        lock.packages["node_modules/argparse"] = {
          version: "2.0.1",
          resolved: "https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz",
          integrity: "sha512-test",
          license: "Python-2.0"
        };
        lock.packages["node_modules/truncate-utf8-bytes"] = {
          version: "1.0.2",
          resolved: "https://registry.npmjs.org/truncate-utf8-bytes/-/truncate-utf8-bytes-1.0.2.tgz",
          integrity: "sha512-test",
          license: "WTFPL"
        };
        lock.packages["node_modules/example/node_modules/type-fest"] = {
          version: "4.41.0",
          resolved: "https://registry.npmjs.org/type-fest/-/type-fest-4.41.0.tgz",
          integrity: "sha512-test",
          license: "(MIT OR CC0-1.0)"
        };
      },
      sbomMutator: (sbom) => {
        sbom.components.push(
          {
            name: "expand-template",
            purl: "pkg:npm/expand-template@2.0.3",
            hashes: [{ alg: "SHA-512", content: "test" }]
          },
          {
            name: "rc",
            purl: "pkg:npm/rc@1.2.8",
            hashes: [{ alg: "SHA-512", content: "test" }]
          },
          {
            name: "argparse",
            purl: "pkg:npm/argparse@2.0.1",
            hashes: [{ alg: "SHA-512", content: "test" }]
          },
          {
            name: "truncate-utf8-bytes",
            purl: "pkg:npm/truncate-utf8-bytes@1.0.2",
            hashes: [{ alg: "SHA-512", content: "test" }]
          }
        );
      }
    });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Supply chain check passed/u);
  });
});

test("supply-chain check accepts reviewed CycloneDX license expressions", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      lockMutator: (lock) => {
        lock.packages["node_modules/jszip"] = {
          version: "3.10.1",
          resolved: "https://registry.npmjs.org/jszip/-/jszip-3.10.1.tgz",
          integrity: "sha512-test",
          license: "(MIT OR GPL-3.0-or-later)"
        };
      },
      sbomMutator: (sbom) => {
        sbom.components.push({
          name: "jszip",
          purl: "pkg:npm/jszip@3.10.1",
          hashes: [{ alg: "SHA-512", content: "test" }],
          licenses: [{ expression: "(MIT OR GPL-3.0-or-later)" }]
        });
      }
    });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("supply-chain check recognizes the unscoped VS Code workspace link", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      lockMutator: (lock) => {
        lock.packages["node_modules/harness-anything-vscode"] = {
          resolved: "packages/vscode-ext",
          link: true
        };
      },
      sbomMutator: (sbom) => {
        sbom.components.push({
          name: "vscode-ext",
          purl: "pkg:npm/harness-anything-vscode@0.1.0",
          licenses: [{ license: { id: "AGPL-3.0-or-later" } }]
        });
      }
    });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("supply-chain check rejects CI drift", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      workflowBody: "name: rewrite-ci\njobs:\n  typecheck:\n    steps:\n      - run: npm run typecheck\n"
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rewrite-ci\.yml/u);
  });
});

test("supply-chain check rejects missing AGPL checklist items", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      supplyDocBody: validSupplyDoc().replace("modified source corresponding to the network service", "modified source exists")
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AGPL checklist checkbox item/u);
  });
});

test("supply-chain check invokes npm instead of reading fixture output from env", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root);

    const result = requireCompletedSpawn(spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
      timeout: CHECK_PROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        PATH: "/nonexistent",
        HARNESS_SUPPLY_CHAIN_FIXTURE_OUTPUT_DIR: path.join(root, ".supply-chain-command-output")
      }
    }), "node tools/check-supply-chain.mjs", CHECK_PROCESS_TIMEOUT_MS);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm audit --audit-level=high failed/u);
  });
});

test("supply-chain check rejects Dependabot directory under wrong ecosystem", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      dependabotBody: validDependabot().replace('package-ecosystem: "npm"', 'package-ecosystem: "github-actions"')
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must cover npm directory/u);
  });
});

test("supply-chain check isolates local contract failures from npm commands", async () => {
  await withFixtureRepo((root) => {
    const invocationLogPath = path.join(root, "npm-invocations.log");
    writeValidSupplyChainFixture(root, {
      dependabotBody: validDependabot().replace('package-ecosystem: "npm"', 'package-ecosystem: "github-actions"'),
      invocationLogPath
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must cover npm directory/u);
    assert.equal(existsSync(invocationLogPath), false, "local contract failure must not enter the npm network phase");
  });
});

test("supply-chain check reports a bounded npm command timeout", async (t) => {
  await withFixtureRepo((root) => {
    const hangPidPath = path.join(root, "hanging-npm.pid");
    writeValidSupplyChainFixture(root, {
      hangNpmCommand: "sbom --sbom-format=cyclonedx --sbom-type=application",
      hangPidPath
    });

    const result = runCheck(root, {
      env: {
        HARNESS_SUPPLY_CHAIN_COMMAND_TIMEOUT_MS: "5000",
        HARNESS_SUPPLY_CHAIN_NETWORK_BUDGET_MS: "11000"
      },
      timeoutMs: 20_000
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /phase=sbom attempt=2\/2 .*timed out/u);
    assert.match(result.stderr, /termination=SIGKILL/u);
    assert.doesNotMatch(result.stderr, /phase=audit-.*timed out/u);
    const hangingPid = Number(readFileSync(hangPidPath, "utf8"));
    assert.equal(processGroupExists(hangingPid), false, `hanging npm process group ${hangingPid} must be gone`);
    t.diagnostic(`timeout receipt: ${result.stderr.trim()}`);
    t.diagnostic(`process group gone: ${hangingPid}`);
  });
});

function runCheck(root, options = {}) {
  const timeoutMs = options.timeoutMs ?? CHECK_PROCESS_TIMEOUT_MS;
  return requireCompletedSpawn(spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      ...(options.env ?? {}),
      PATH: `${path.join(root, ".mock-bin")}${path.delimiter}${process.env.PATH ?? ""}`
    }
  }), "node tools/check-supply-chain.mjs", timeoutMs);
}

function requireCompletedSpawn(result, command, timeoutMs) {
  if (result.error?.code === "ETIMEDOUT") throw new Error(`${command} timed out after ${timeoutMs}ms`);
  if (result.error) throw new Error(`${command} failed to start: ${result.error.message}`);
  if (result.signal !== null) throw new Error(`${command} terminated by signal ${result.signal}`);
  return result;
}

async function withFixtureRepo(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "ha-supply-chain-"));
  try {
    mkdirSync(path.join(root, "docs-release"), { recursive: true });
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function writeValidSupplyChainFixture(root, options = {}) {
  const packageJson = {
    name: "harness-anything",
    version: "0.1.0",
    private: true,
    license: "AGPL-3.0-or-later",
    scripts: {
      check: "npm run typecheck && npm test && npm run harness:check-supply-chain",
      "check:pr": "npm run typecheck && npm run harness:check-supply-chain",
      "harness:check-supply-chain": "node tools/check-supply-chain.mjs"
    }
  };
  writeJson(root, "package.json", packageJson);

  const workspacePackages = {};
  for (const packagePath of [
    "packages/kernel/package.json",
    "packages/application/package.json",
    "packages/daemon/package.json",
    "packages/cli/package.json",
    "packages/gui/package.json",
    "packages/adapters/local/package.json",
    "packages/adapters/multica/package.json",
    "packages/adapters/github-issues/package.json",
    "packages/adapters/linear/package.json",
    "packages/api-contracts/package.json",
    "packages/daemon-client/package.json",
    "packages/vscode-ext/package.json"
  ]) {
    workspacePackages[packagePath] = { name: packagePath, version: "0.1.0", private: true, license: "AGPL-3.0-or-later" };
  }
  workspacePackages["packages/cli/package.json"] = {
    ...workspacePackages["packages/cli/package.json"],
    name: "@harness-anything/cli",
    version: "0.1.0",
    private: false,
    publishConfig: { access: "public" },
    repository: { type: "git", url: "git+https://github.com/FairladyZ625/harness-anything.git", directory: "packages/cli" },
    engines: { node: ">=24" },
    bin: { "harness-anything": "dist/cli/src/index.js", ha: "dist/cli/src/index.js" },
    files: ["dist", "README.md", "package.json"]
  };
  options.packageMutator?.(workspacePackages);
  for (const [packagePath, packageJson] of Object.entries(workspacePackages)) {
    writeJson(root, packagePath, packageJson);
  }

  const lock = {
    name: "harness-anything",
    version: "0.1.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "harness-anything",
        version: "0.1.0",
        license: "AGPL-3.0-or-later"
      },
      "node_modules/electron": {
        version: "42.4.0",
        resolved: "https://registry.npmjs.org/electron/-/electron-42.4.0.tgz",
        integrity: "sha512-test",
        license: "MIT"
      },
      "node_modules/example": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        integrity: "sha512-test",
        license: "MIT"
      }
    }
  };
  options.lockMutator?.(lock);
  writeJson(root, "package-lock.json", lock);

  writeFile(root, ".github/dependabot.yml", options.dependabotBody ?? validDependabot());
  writeFile(root, ".github/workflows/rewrite-ci.yml", options.workflowBody ?? validWorkflow());
  writeFile(root, "README.md", validReadme());
  writeFile(root, "docs-release/release-posture.md", options.supplyDocBody ?? validSupplyDoc());
  writeMockNpm(root, options);
}

function validReadme() {
  return [
    "# Harness Anything",
    "The accountability layer for AI agents."
  ].join("\n");
}

function validSupplyDoc() {
  return [
    "# Release Posture",
    "release artifacts are not published.",
    "The live OSV scan is not part of the default local gate.",
    "npx --yes osv-scanner@latest --lockfile=package-lock.json",
    "release-evidence/osv/scan-result.json",
    "AGPL network-service release note checklist",
    "- [ ] public source offer and license notice",
    "- [ ] modified source corresponding to the network service",
    "- [ ] deployment and service docs preserve AGPL notices",
    "- [ ] release notes identify user-visible network-service changes",
    "- [ ] third-party license notices included with release evidence",
    "release artifact SBOM",
    "Electron upgrades require security review"
  ].join("\n");
}

function validDependabot() {
  return [
    "version: 2",
    "updates:",
    "  - package-ecosystem: \"npm\"",
    "    directory: \"/\"",
    "    labels:",
    "      - \"dependencies\"",
    "      - \"security\""
  ].join("\n");
}

function validWorkflow() {
  return [
    "name: rewrite-ci",
    "jobs:",
    "  supply-chain:",
    "    steps:",
    "      - run: npm run harness:check-supply-chain"
  ].join("\n");
}

function writeMockNpm(root, options) {
  const mockPath = path.join(root, ".mock-bin/npm");
  const sbomValue = validSbom();
  options.sbomMutator?.(sbomValue);
  const sbom = JSON.stringify(sbomValue);
  writeFile(root, ".mock-bin/npm", [
    "#!/usr/bin/env node",
    "const { appendFileSync, writeFileSync } = require('node:fs');",
    "const args = process.argv.slice(2).join(' ');",
    ...(options.invocationLogPath ? [`appendFileSync(${JSON.stringify(options.invocationLogPath)}, args + '\\n');`] : []),
    `if (args === ${JSON.stringify(options.hangNpmCommand)}) {`,
    ...(options.hangPidPath ? [`  writeFileSync(${JSON.stringify(options.hangPidPath)}, String(process.pid));`] : []),
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);",
    "}",
    "if (args === 'audit --audit-level=high' || args === 'audit --omit=dev --audit-level=high') {",
    "  console.log('found 0 vulnerabilities');",
    "  process.exit(0);",
    "}",
    "if (args === 'sbom --sbom-format=cyclonedx --sbom-type=application') {",
    `  console.log(${JSON.stringify(sbom)});`,
    "  process.exit(0);",
    "}",
    "console.error(`unexpected npm args: ${args}`);",
    "process.exit(1);"
  ].join("\n"));
  chmodSync(mockPath, 0o755);
}

function processGroupExists(pid) {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function validSbom() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: {
      component: {
        licenses: [{ license: { id: "AGPL-3.0-or-later" } }]
      }
    },
    components: [
      {
        name: "example",
        purl: "pkg:npm/example@1.0.0",
        hashes: [{ alg: "SHA-512", content: "test" }],
        licenses: [{ license: { id: "MIT" } }]
      },
      {
        name: "gui",
        purl: "pkg:npm/%40harness-anything/gui@0.1.0",
        licenses: [{ license: { id: "AGPL-3.0-or-later" } }]
      }
    ]
  };
}

function writeJson(root, relativePath, value) {
  writeFile(root, relativePath, JSON.stringify(value, null, 2));
}

function writeFile(root, relativePath, body) {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${body.trimEnd()}\n`, "utf8");
}
