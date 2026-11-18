// harness-test-tier: integration
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "check-supply-chain.mjs");
const reviewedAt = Date.parse("2026-11-19T00:00:00.000Z");
const expiresAt = Date.parse("2026-12-17T00:00:00.000Z");
const picomatchPath = "node_modules/picomatch";
const reviewedRoot = {
  name: "picomatch",
  severity: "high",
  url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
};
const unreviewedRoot = { ...reviewedRoot, url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz" };
const picomatchFinding = { severity: "high", via: [reviewedRoot] };
const outage = {
  status: 1,
  stdout: JSON.stringify({ statusCode: 503, message: "503 Service Unavailable" }),
  stderr: "npm warn audit 503 Service Unavailable\nnpm error audit endpoint returned an error",
};

test("supply-chain check accepts the expected release gate contract", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root);

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Supply chain check passed/u);
  });
});

test("supply-chain check rejects a public daemon missing metadata", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      packageMutator: (packages) => {
        makeDaemonPublicReady(packages);
        delete packages["packages/daemon/package.json"].bin;
      },
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must declare bin harness-anything-daemon/u);
  });
});

test("supply-chain check accepts a public daemon with complete metadata", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, { packageMutator: makeDaemonPublicReady });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
  });
});

test("supply-chain check rejects CLI dry-run metadata drift", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      packageMutator: (packages) => {
        packages["packages/cli/package.json"].publishConfig = undefined;
      },
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /publishConfig\.access public/u);
  });
});

test("supply-chain check rejects missing OSV documentation", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      supplyDocBody: validSupplyDoc().replace(
        "npx --yes osv-scanner@latest --lockfile=package-lock.json",
        "osv scan later",
      ),
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
      },
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
          license: "(MIT OR WTFPL)",
        };
        lock.packages["node_modules/rc"] = {
          version: "1.2.8",
          resolved: "https://registry.npmjs.org/rc/-/rc-1.2.8.tgz",
          integrity: "sha512-test",
          license: "(BSD-2-Clause OR MIT OR Apache-2.0)",
        };
        lock.packages["node_modules/argparse"] = {
          version: "2.0.1",
          resolved: "https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz",
          integrity: "sha512-test",
          license: "Python-2.0",
        };
        lock.packages["node_modules/truncate-utf8-bytes"] = {
          version: "1.0.2",
          resolved: "https://registry.npmjs.org/truncate-utf8-bytes/-/truncate-utf8-bytes-1.0.2.tgz",
          integrity: "sha512-test",
          license: "WTFPL",
        };
      },
      sbomMutator: (sbom) => {
        sbom.components.push(
          {
            name: "expand-template",
            purl: "pkg:npm/expand-template@2.0.3",
            hashes: [{ alg: "SHA-512", content: "test" }],
          },
          {
            name: "rc",
            purl: "pkg:npm/rc@1.2.8",
            hashes: [{ alg: "SHA-512", content: "test" }],
          },
          {
            name: "argparse",
            purl: "pkg:npm/argparse@2.0.1",
            hashes: [{ alg: "SHA-512", content: "test" }],
          },
          {
            name: "truncate-utf8-bytes",
            purl: "pkg:npm/truncate-utf8-bytes@1.0.2",
            hashes: [{ alg: "SHA-512", content: "test" }],
          },
        );
      },
    });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Supply chain check passed/u);
  });
});

test("supply-chain check rejects CI drift", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      workflowBody: "name: rewrite-ci\njobs:\n  typecheck:\n    steps:\n      - run: npm run typecheck\n",
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rewrite-ci\.yml/u);
  });
});

test("supply-chain check rejects missing AGPL checklist items", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      supplyDocBody: validSupplyDoc().replace(
        "modified source corresponding to the network service",
        "modified source exists",
      ),
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
        HARNESS_SUPPLY_CHAIN_FIXTURE_OUTPUT_DIR: path.join(root, ".supply-chain-command-output"),
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /npm audit --omit=dev --audit-level=high --json failed/u);
  });
});

test("supply-chain check rejects Dependabot directory under wrong ecosystem", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      dependabotBody: validDependabot().replace('package-ecosystem: "npm"', 'package-ecosystem: "github-actions"'),
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must cover npm directory/u);
  });
});

test("supply-chain check passes and annotates when the advisory endpoint is unreachable", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, { allAudit: outage, productionAudit: outage });

    const result = runCheck(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning title=Supply chain audit did not run::/u);
    assert.match(result.stdout, /HTTP 503/u);
    assert.doesNotMatch(result.stderr, /Supply chain check failed/u);
  });
});

test("supply-chain check still fails when the audit runs and finds a vulnerability", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      allAudit: auditReport({ picomatch: { severity: "high", via: [unreviewedRoot] } }),
    });

    const result = runCheck(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unreviewed high advisory GHSA-xxxx-yyyy-zzzz for picomatch/u);
    assert.doesNotMatch(result.stdout, /::warning title=Supply chain audit did not run::/u);
  });
});

test("supply-chain check uses a valid npm v2 report before considering exit status or stderr", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      allAudit: { ...auditReport({}), status: 1, stderr: "npm error E403 Forbidden" },
    });
    const result = runCheck(root);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /::warning/u);
  });
});

test("supply-chain check warns for a reviewed root through a mixed transitive chain at the expiry boundary", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      allAudit: auditReport({
        picomatch: picomatchFinding,
        tinyglobby: { severity: "high", via: ["picomatch"] },
        vite: { severity: "high", via: ["tinyglobby", { name: "vite", severity: "moderate" }] },
      }),
      versions: versionOutput(["4.0.7", "4.0.8-beta.1", "4.0.7+build"]),
    });
    const result = runCheck(root, expiresAt);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /::warning title=Reviewed unpatched dev advisory active::.*GHSA-fc5q-39xc-vjpf.*picomatch.*4\.0\.7.*2026-12-17T00:00:00\.000Z/u,
    );
  });
});

test("supply-chain check blocks a registered dev finding in the production audit", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      allAudit: auditReport({ picomatch: picomatchFinding }),
      productionAudit: auditReport({ picomatch: picomatchFinding }, { high: 0, critical: 0 }),
    });
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm audit --omit=dev --audit-level=high --json failed:.*production/u);
    assert.doesNotMatch(result.stdout, /Reviewed unpatched dev advisory active/u);
  });
});

test("supply-chain check blocks a production audit with only a critical metadata count", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, { productionAudit: auditReport({}, { high: 0, critical: 1 }) });
    const result = runCheck(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm audit --omit=dev --audit-level=high --json failed:.*production/u);
  });
});

for (const [name, options, diagnostic] of [
  ["a missing lock instance", { lockMutator: (lock) => delete lock.packages[picomatchPath] }, /no lockfile instances/u],
  [
    "a lock instance without dev true",
    { lockMutator: (lock) => delete lock.packages[picomatchPath].dev },
    /dev === true/u,
  ],
  [
    "a nested devOptional lock instance",
    {
      lockMutator: (lock) => {
        lock.packages["packages/gui/node_modules/vite/node_modules/picomatch"] = {
          ...lock.packages[picomatchPath],
          devOptional: true,
        };
      },
    },
    /devOptional/u,
  ],
  [
    "a lock version beyond the registration",
    {
      lockMutator: (lock) => {
        lock.packages[picomatchPath].version = "4.0.8";
      },
    },
    /lockfile version 4\.0\.8 exceeds 4\.0\.7/u,
  ],
  [
    "a stable patched version",
    { versions: versionOutput(["4.0.7", "4.0.8"]) },
    /published 4\.0\.8.*remove the registration/u,
  ],
  [
    "a two-digit patch version",
    { versions: versionOutput(["4.0.7", "4.0.10"]) },
    /published 4\.0\.10.*remove the registration/u,
  ],
  [
    "a production npm alias of the reviewed package",
    {
      lockMutator: (lock) => {
        lock.packages["node_modules/old-match"] = { ...lock.packages[picomatchPath], name: "picomatch", dev: false };
      },
    },
    /old-match.*dev === true/u,
  ],
  [
    "a malformed version in the registry list",
    { versions: versionOutput(["4.0.7", "4.0.08"]) },
    /expected a non-empty JSON array of SemVer versions/u,
  ],
  ["an empty registry list", { versions: versionOutput([]) }, /expected a non-empty JSON array of SemVer versions/u],
  [
    "a damaged registry response accompanied by 503",
    { versions: { ...outage, stdout: '["4.0.7",' } },
    /npm view picomatch versions --json failed/u,
  ],
  [
    "a missing registry package",
    { versions: { status: 1, stderr: "npm error E404 Not Found\n503 Service Unavailable" } },
    /npm view picomatch versions --json failed/u,
  ],
  [
    "a registry permission error",
    { versions: { status: 1, stderr: "npm error E401 Unauthorized" } },
    /npm view picomatch versions --json failed/u,
  ],
]) {
  test(`supply-chain check blocks ${name} even when production audit is unavailable`, async () => {
    await withFixtureRepo((root) => {
      writeValidSupplyChainFixture(root, {
        allAudit: auditReport({ picomatch: picomatchFinding }),
        productionAudit: outage,
        ...options,
      });
      const result = runCheck(root);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, diagnostic);
      assert.doesNotMatch(result.stdout, /Reviewed unpatched dev advisory active/u);
    });
  });
}

for (const [name, report, diagnostic] of [
  [
    "an independent critical root",
    auditReport({
      picomatch: picomatchFinding,
      other: { severity: "critical", via: [{ ...unreviewedRoot, name: "other", severity: "critical" }] },
    }),
    /unreviewed critical advisory .* for other/u,
  ],
  [
    "an unreviewed root on the same chain",
    auditReport({
      picomatch: { severity: "high", via: [reviewedRoot, unreviewedRoot] },
      vite: { severity: "high", via: ["picomatch"] },
    }),
    /unreviewed high advisory GHSA-xxxx-yyyy-zzzz for picomatch/u,
  ],
  [
    "a registered GHSA with a different package name",
    auditReport({
      picomatch: { severity: "high", via: [{ ...reviewedRoot, name: "other" }] },
    }),
    /other/u,
  ],
  [
    "a GHSA appearing outside the advisory URL path",
    auditReport({
      picomatch: { severity: "high", via: [{ ...reviewedRoot, url: "https://example.test/?id=GHSA-fc5q-39xc-vjpf" }] },
    }),
    /advisory URL/u,
  ],
  [
    "an unexplained high finding alongside a reviewed root",
    auditReport({
      picomatch: picomatchFinding,
      vite: { severity: "high", via: ["tinyglobby"] },
      tinyglobby: { severity: "high", via: ["vite"] },
    }),
    /no matching high root/u,
  ],
  [
    "a critical finding with only a high root",
    auditReport({
      picomatch: picomatchFinding,
      vite: { severity: "critical", via: ["picomatch"] },
    }),
    /no matching critical root/u,
  ],
  [
    "a missing transitive reference mixed with the reviewed root",
    auditReport({
      picomatch: { severity: "high", via: [reviewedRoot, "unknown"] },
    }),
    /invalid audit root or transitive reference/u,
  ],
  ["a high metadata count without a finding", auditReport({}, { high: 1, critical: 0 }), /metadata.*high/u],
]) {
  test(`supply-chain check blocks ${name}`, async () => {
    await withFixtureRepo((root) => {
      writeValidSupplyChainFixture(root, { allAudit: report });
      const result = runCheck(root);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, diagnostic);
      assert.doesNotMatch(result.stdout, /Reviewed unpatched dev advisory active/u);
    });
  });
}

for (const [name, result] of [
  [
    "HTTP 403 plus the generic audit error",
    {
      status: 1,
      stdout: JSON.stringify({ statusCode: 403, message: "403 Forbidden" }),
      stderr: "npm warn audit 403 Forbidden\nnpm error audit endpoint returned an error",
    },
  ],
  [
    "HTTP 403 mixed with transient audit messages",
    { ...outage, stderr: `${outage.stderr}\nnpm warn audit E403 Forbidden` },
  ],
  [
    "HTTP 401 plus the generic audit error",
    { ...outage, stdout: JSON.stringify({ statusCode: 401 }), stderr: "npm error audit endpoint returned an error" },
  ],
  ["an unknown audit error", { status: 1, stderr: "npm error audit endpoint returned an error" }],
  ["damaged audit JSON accompanied by 503", { ...outage, stdout: '{"auditReportVersion": 2,' }],
  ["unexpected JSON with error-like text", { ...outage, stdout: '{"unexpected":"503 Service Unavailable"}' }],
  ["a successful exit without an audit report", { status: 0, stdout: "found 0 vulnerabilities" }],
]) {
  test(`supply-chain check blocks ${name}`, async () => {
    await withFixtureRepo((root) => {
      writeValidSupplyChainFixture(root, { allAudit: result });
      const check = runCheck(root);
      assert.equal(check.status, 1, check.stdout);
      assert.match(check.stderr, /npm audit --audit-level=high --json failed/u);
      assert.doesNotMatch(check.stdout, /::warning/u);
    });
  });
}

test("supply-chain check warns when the registry lookup is temporarily unavailable", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, {
      allAudit: auditReport({ picomatch: picomatchFinding }),
      versions: { status: 1, stdout: '{"error":{"code":"EAI_AGAIN","summary":"temporary DNS failure"}}' },
    });
    const result = runCheck(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning .*npm view picomatch versions --json.*EAI_AGAIN/u);
    assert.match(result.stdout, /::warning title=Reviewed unpatched dev advisory active::.*patch lookup unavailable/u);
  });
});

test("supply-chain check rejects an expired registration using the process clock", async () => {
  await withFixtureRepo((root) => {
    writeValidSupplyChainFixture(root, { allAudit: auditReport({ picomatch: picomatchFinding }) });
    const result = runCheck(root, expiresAt + 1);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid_audit_contract:.*expired/u);
    assert.doesNotMatch(result.stdout, /Reviewed unpatched dev advisory active/u);
  });
});

function runCheck(root, now = reviewedAt) {
  const clock = `data:text/javascript,${encodeURIComponent(`Date.now = () => ${now}`)}`;
  return spawnSync(process.execPath, ["--import", clock, scriptPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.join(root, ".mock-bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
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
    version: "0.1.0",
    private: true,
    license: "AGPL-3.0-or-later",
    scripts: {
      check: "npm run typecheck && npm test && npm run harness:check-supply-chain",
      "check:pr": "npm run typecheck && npm run harness:check-supply-chain",
      "harness:check-supply-chain": "node tools/check-supply-chain.mjs",
    },
  };
  writeJson(root, "package.json", packageJson);

  const workspacePackages = {};
  for (const packagePath of [
    "packages/kernel/package.json",
    "packages/application/package.json",
    "packages/daemon/package.json",
    "packages/cli/package.json",
    "packages/gui/package.json",
  ]) {
    workspacePackages[packagePath] = {
      name: packagePath,
      version: "0.0.1",
      private: true,
      license: "AGPL-3.0-or-later",
    };
  }
  workspacePackages["packages/cli/package.json"] = {
    ...workspacePackages["packages/cli/package.json"],
    name: "@harness-anything/cli",
    version: "0.1.0",
    private: false,
    publishConfig: { access: "public" },
    repository: {
      type: "git",
      url: "git+https://github.com/FairladyZ625/harness-anything.git",
      directory: "packages/cli",
    },
    engines: { node: ">=24" },
    bin: { "harness-anything": "dist/cli/src/index.js", ha: "dist/cli/src/index.js" },
    files: ["dist", "README.md", "package.json"],
  };
  workspacePackages["packages/gui/package.json"].version = "0.0.1";
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
        license: "AGPL-3.0-or-later",
      },
      "node_modules/electron": {
        version: "42.4.0",
        resolved: "https://registry.npmjs.org/electron/-/electron-42.4.0.tgz",
        integrity: "sha512-test",
        license: "MIT",
      },
      "node_modules/example": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
        integrity: "sha512-test",
        license: "MIT",
      },
      [picomatchPath]: {
        version: "4.0.7",
        resolved: "https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz",
        integrity: "sha512-test",
        license: "MIT",
        dev: true,
      },
    },
  };
  options.lockMutator?.(lock);
  writeJson(root, "package-lock.json", lock);

  writeFile(root, ".github/dependabot.yml", options.dependabotBody ?? validDependabot());
  writeFile(root, ".github/workflows/rewrite-ci.yml", options.workflowBody ?? validWorkflow());
  writeFile(root, "README.md", validReadme());
  writeFile(root, "docs-release/release-posture.md", options.supplyDocBody ?? validSupplyDoc());
  writeMockNpm(root, options);
}

function makeDaemonPublicReady(packages) {
  packages["packages/daemon/package.json"] = {
    ...packages["packages/daemon/package.json"],
    name: "@harness-anything/daemon",
    version: "0.1.0",
    private: false,
    publishConfig: { access: "public" },
    repository: { directory: "packages/daemon" },
    engines: { node: ">=24" },
    bin: { "harness-anything-daemon": "dist/index.js" },
    files: ["dist", "README.md", "package.json"],
  };
}

function validReadme() {
  return ["# Harness Anything", "The accountability layer for AI agents."].join("\n");
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
    "Electron upgrades require security review",
  ].join("\n");
}

function validDependabot() {
  return [
    "version: 2",
    "updates:",
    '  - package-ecosystem: "npm"',
    '    directory: "/"',
    "    labels:",
    '      - "dependencies"',
    '      - "security"',
  ].join("\n");
}

function validWorkflow() {
  return [
    "name: rewrite-ci",
    "jobs:",
    "  supply-chain:",
    "    steps:",
    "      - run: npm run harness:check-supply-chain",
  ].join("\n");
}

function auditReport(vulnerabilities, counts) {
  const findings = Object.values(vulnerabilities);
  const metadata = {
    vulnerabilities: counts ?? {
      high: findings.filter(({ severity }) => severity === "high").length,
      critical: findings.filter(({ severity }) => severity === "critical").length,
    },
  };
  const status = findings.some(({ severity }) => severity === "high" || severity === "critical") ? 1 : 0;
  return { status, stdout: JSON.stringify({ auditReportVersion: 2, vulnerabilities, metadata }) };
}

function versionOutput(versions) {
  return { status: 0, stdout: JSON.stringify(versions) };
}

function writeMockNpm(root, options) {
  const sbomValue = validSbom();
  options.sbomMutator?.(sbomValue);
  const responses = {
    "audit --audit-level=high --json": options.allAudit ?? auditReport({}),
    "audit --omit=dev --audit-level=high --json": options.productionAudit ?? auditReport({}),
    "view picomatch versions --json": options.versions ?? versionOutput(["4.0.7"]),
    "sbom --sbom-format=cyclonedx --sbom-type=application": { status: 0, stdout: JSON.stringify(sbomValue) },
  };
  writeFile(
    root,
    ".mock-bin/npm",
    [
      "#!/usr/bin/env node",
      `const responses = ${JSON.stringify(responses)};`,
      "const args = process.argv.slice(2).join(' ');",
      "const response = responses[args];",
      "if (!response) {",
      "  console.error(`unexpected npm args: ${args}`);",
      "  process.exit(2);",
      "}",
      "if (response.stdout) console.log(response.stdout);",
      "if (response.stderr) console.error(response.stderr);",
      "process.exitCode = response.status;",
    ].join("\n"),
  );
  chmodSync(path.join(root, ".mock-bin/npm"), 0o755);
  if (process.platform === "win32") {
    writeFile(root, ".mock-bin/npm.cmd", '@"' + process.execPath + '" "%~dp0npm" %*\r\n');
  }
}

function validSbom() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: {
      component: {
        licenses: [{ license: { id: "AGPL-3.0-or-later" } }],
      },
    },
    components: [
      {
        name: "example",
        purl: "pkg:npm/example@1.0.0",
        hashes: [{ alg: "SHA-512", content: "test" }],
        licenses: [{ license: { id: "MIT" } }],
      },
      {
        name: "gui",
        purl: "pkg:npm/%40harness-anything/gui@0.0.0",
        licenses: [{ license: { id: "AGPL-3.0-or-later" } }],
      },
    ],
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
