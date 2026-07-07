import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-supply-chain.mjs");

test("supply-chain check accepts the expected release gate contract", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root);

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Supply chain check passed/u);
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
          }
        );
      }
    });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Supply chain check passed/u);
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

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "/nonexistent",
        HARNESS_SUPPLY_CHAIN_FIXTURE_OUTPUT_DIR: path.join(root, ".supply-chain-command-output")
      }
    });

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

function runCheck(root) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, ".mock-bin")}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
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
    version: "0.0.0",
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
    "packages/adapters/linear/package.json"
  ]) {
    workspacePackages[packagePath] = { name: packagePath, version: "0.0.0", private: true, license: "AGPL-3.0-or-later" };
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
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "harness-anything",
        version: "0.0.0",
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
  writeMockNpm(root, options.sbomMutator);
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

function writeMockNpm(root, sbomMutator) {
  const mockPath = path.join(root, ".mock-bin/npm");
  const sbomValue = validSbom();
  sbomMutator?.(sbomValue);
  const sbom = JSON.stringify(sbomValue);
  writeFile(root, ".mock-bin/npm", [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2).join(' ');",
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
        purl: "pkg:npm/%40harness-anything/gui@0.0.0",
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
