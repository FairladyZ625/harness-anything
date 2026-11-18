// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { commitAll, makeRepo, writeRepoFile } from "./gates/test/helpers.mjs";
import { selectLocalGateChecks, staticGateExclusion } from "./run-local-gates-check.mjs";

const PR_JOBS = new Set(["boundaries", "package-policy", "supply-chain"]);

test("static gate selection keeps deterministic PR-visible checkers and reports why others are left to CI", () => {
  const plan = selectLocalGateChecks(makeManifest());

  assert.deepEqual(
    plan.map((entry) => entry.id),
    ["check-alpha", "scan-beta", "check-unscoped", "check-docs"],
  );
  assert.deepEqual(plan[1].workflowJobs, ["supply-chain"]);
});

test("static gate selection never selects a gate that cannot pass without external inputs", () => {
  // The historical false red: check-github-required-contexts is deterministic:false because it
  // reads GitHub branch rules with a token, and selecting it made a clean worktree fail with
  // "repository must be provided as owner/name".
  const manifest = makeManifest();
  const plan = selectLocalGateChecks(manifest);
  assert.equal(
    plan.some((entry) => entry.id === "check-github-required-contexts"),
    false,
  );
  const gate = manifest.gates.find((entry) => entry.id === "check-github-required-contexts");
  assert.equal(staticGateExclusion(gate, PR_JOBS), "needs external inputs");
});

test("static gate selection leaves test tiers, smokes and release-policy gates to CI", () => {
  const manifest = makeManifest();
  const selected = new Set(selectLocalGateChecks(manifest).map((entry) => entry.id));

  for (const [id, reason] of [
    ["test-integration", "test tier"],
    ["test-fast", "test tier"],
    ["smoke-package", "category smoke"],
    ["package-tarball", "category release-policy"],
    ["check-main-only", "tier main-only"],
    ["check-other-lane", "not on a pull-request lane"],
  ]) {
    assert.equal(selected.has(id), false, `${id} must stay off the local static path`);
    assert.equal(
      staticGateExclusion(
        manifest.gates.find((entry) => entry.id === id),
        PR_JOBS,
      ),
      reason,
      id,
    );
  }
});

test("changed-path narrowing runs scoped gates only for the paths they declare", () => {
  const plan = selectLocalGateChecks(makeManifest(), { changedPaths: ["packages/kernel/src/index.ts"] });

  // check-alpha (packages/kernel/**) and scan-beta (packages/**) both declare this path;
  // check-docs (docs-release/**) does not.
  assert.deepEqual(
    plan.map((entry) => entry.id),
    ["check-alpha", "scan-beta", "check-unscoped"],
  );
});

test("changed-path narrowing keeps an unscoped gate because it declares no scope to narrow by", () => {
  const plan = selectLocalGateChecks(makeManifest(), { changedPaths: ["docs-release/guide.md"] });

  assert.deepEqual(
    plan.map((entry) => entry.id),
    ["check-unscoped", "check-docs"],
  );
});

test("changed-path narrowing matches the manifest glob language used by the CI runner", () => {
  const manifest = makeManifest();
  const ids = (changedPath) =>
    selectLocalGateChecks(manifest, { changedPaths: [changedPath] }).map((entry) => entry.id);

  assert.ok(ids("packages/kernel/src/deep/nested/thing.ts").includes("check-alpha"));
  assert.ok(ids("packages/kernel/README.md").includes("check-alpha"));
  assert.equal(ids("packages/daemon/src/daemon-host/index.ts").includes("check-alpha"), false);
});

test("an empty selection is an error only when no narrowing was requested", () => {
  const empty = { surfaces: { rewriteCi: { pullRequestGateJobs: ["boundaries"] } }, gates: [] };

  assert.throws(() => selectLocalGateChecks(empty), /manifest yielded no PR-visible deterministic static gates/u);
  assert.deepEqual(selectLocalGateChecks(empty, { changedPaths: ["docs-release/guide.md"] }), []);
});

function makeManifest() {
  return {
    surfaces: {
      rewriteCi: {
        pullRequestGateJobs: ["boundaries", "supply-chain", "package-policy"],
      },
    },
    gates: [
      {
        id: "check-alpha",
        command: "npm run harness:check-alpha",
        category: "boundary",
        tier: "pr-required",
        deterministic: true,
        localPathGlobs: ["packages/kernel/**"],
        executionSurfaces: {
          packageJson: { script: "harness:check-alpha" },
          rewriteCi: { pullRequestJobs: ["boundaries"] },
        },
      },
      {
        id: "scan-beta",
        command: "npm run harness:scan-beta",
        category: "boundary",
        tier: "pr-required",
        deterministic: true,
        localPathGlobs: ["packages/**"],
        executionSurfaces: {
          packageJson: { script: "harness:scan-beta" },
          rewriteCi: { pullRequestJobs: ["supply-chain"] },
        },
      },
      {
        id: "check-unscoped",
        command: "node tools/check-unscoped.mjs",
        category: "local-consistency",
        tier: "pr-required",
        deterministic: true,
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["boundaries"] },
        },
      },
      {
        id: "check-docs",
        command: "node tools/check-docs.mjs",
        category: "local-consistency",
        tier: "pr-required",
        deterministic: true,
        localPathGlobs: ["docs-release/**"],
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["boundaries"] },
        },
      },
      {
        id: "check-github-required-contexts",
        command: "npm run harness:check-github-required-contexts",
        category: "meta-governance",
        tier: "pr-required",
        deterministic: false,
        executionSurfaces: {
          packageJson: { script: "harness:check-github-required-contexts" },
          rewriteCi: { pullRequestJobs: ["boundaries"] },
        },
      },
      {
        id: "test-fast",
        command: "npm run test:fast",
        category: "local-consistency",
        tier: "pr-required",
        deterministic: true,
        executionSurfaces: {
          packageJson: { script: "test:fast" },
          rewriteCi: { pullRequestJobs: ["boundaries"] },
        },
      },
      {
        id: "test-integration",
        command: "npm run test:integration",
        category: "local-consistency",
        tier: "pr-required",
        deterministic: true,
        executionSurfaces: {
          packageJson: { script: "test:integration" },
          rewriteCi: { pullRequestJobs: ["boundaries"] },
        },
      },
      {
        id: "smoke-package",
        command: "npm run harness:smoke-package",
        category: "smoke",
        tier: "pr-required",
        deterministic: true,
        executionSurfaces: {
          packageJson: { script: "harness:smoke-package" },
          rewriteCi: { pullRequestJobs: ["package-policy"] },
        },
      },
      {
        id: "package-tarball",
        command: "npm run harness:package-tarball",
        category: "release-policy",
        tier: "pr-required",
        deterministic: true,
        executionSurfaces: {
          packageJson: { script: "harness:package-tarball" },
          rewriteCi: { pullRequestJobs: ["package-policy"] },
        },
      },
      {
        id: "check-other-lane",
        command: "node tools/check-other.mjs",
        category: "boundary",
        tier: "pr-required",
        deterministic: true,
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["integration-shard"] },
        },
      },
      {
        id: "check-main-only",
        command: "npm run harness:check-main-only",
        category: "boundary",
        tier: "main-only",
        deterministic: true,
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: [] },
        },
      },
    ],
  };
}

test("changed static plans pass the exact path set only to the durable authorization gate", () => {
  const manifest = makeManifest();
  const gate = { ...manifest.gates[0], id: "ontology-durable-action-authorization" };
  manifest.gates.unshift(gate);
  const changedPaths = ["packages/kernel/src/with spaces.ts", "packages/daemon/src/a'$(never).ts"];
  const plan = selectLocalGateChecks(manifest, { changedPaths });
  const entry = plan.find((entry) => entry.id === gate.id);
  assert.equal(entry.command, `${gate.command} --changed-files-stdin`);
  assert.deepEqual(JSON.parse(entry.input), changedPaths);
  assert.equal(plan.find((entry) => entry.id === manifest.gates[1].id).command, manifest.gates[1].command);
  assert.equal(selectLocalGateChecks(manifest).find((entry) => entry.id === gate.id).command, gate.command);
});

test("changed static CLI sends a large exact scope through the shared process launcher", () => {
  // dec_04A9211B073F29F0FC1E1CA573 CH3: local and CI entrypoints retain the same complete input.
  const files = Array.from({ length: 3000 }, (_, i) => `packages/kernel/src/路径 & 'quote'/module-${i}.ts`).sort(),
    manifest = makeManifest();
  manifest.gates = [
    { ...manifest.gates[0], id: "ontology-durable-action-authorization", command: "node tools/capture.mjs" },
  ];
  const { rootDir } = makeRepo({
    "tools/gate-manifest.json": JSON.stringify(manifest),
    "expected.json": JSON.stringify(files),
    "tools/capture.mjs": `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
assert.deepEqual(process.argv.slice(2), ["--changed-files-stdin"]);
assert.deepEqual(JSON.parse(readFileSync(0, "utf8")), JSON.parse(readFileSync("expected.json", "utf8")));
console.log("Complete static scope received");`,
  });
  for (const file of ["run-local-gates-check.mjs", "run-manifest-gates.mjs", "test-quarantine.mjs"])
    cpSync(path.join(import.meta.dirname, file), path.join(rootDir, "tools", file));
  commitAll(rootDir);
  for (const file of files) writeRepoFile(rootDir, file, "export {};\n");
  const result = spawnSync(process.execPath, ["tools/run-local-gates-check.mjs", "--changed", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Complete static scope received/u);
});
