// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(ids("packages/daemon/src/index.ts").includes("check-alpha"), false);
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
