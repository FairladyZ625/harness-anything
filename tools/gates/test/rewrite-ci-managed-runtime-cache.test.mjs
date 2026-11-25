// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  artifactManifest,
  managedRbacVersions,
} from "../../../packages/authorization/src/keycloak/managed-rbac-service.ts";

const rootDir = path.resolve(import.meta.dirname, "../../..");
const workflowText = readFileSync(path.join(rootDir, ".github/workflows/rewrite-ci.yml"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const workflow = parse(workflowText);

const SUPPORTED_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64", "win32-arm64"];
const POSTGRES_CACHE_ENV = "HARNESS_MANAGED_POSTGRES_CACHE_DIR";
const KEYCLOAK_CACHE_ENV = "HARNESS_MANAGED_KEYCLOAK_CACHE_DIR";
const POSTGRES_CACHE_PATH = "${{ runner.temp }}/harness-managed-postgres";
const KEYCLOAK_CACHE_PATH = "${{ runner.temp }}/harness-managed-keycloak";

function manifestFingerprint(artifactNames) {
  const payload = SUPPORTED_PLATFORMS.map((platform) => [
    platform,
    artifactManifest(platform).filter((artifact) => artifactNames.includes(artifact.name)),
  ]);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12);
}

const EXPECTED_POSTGRES_KEY = `managed-postgres-\${{ runner.os }}-\${{ runner.arch }}-pg${managedRbacVersions.postgres}-${manifestFingerprint(["postgres"])}`;
const EXPECTED_KEYCLOAK_KEY = `managed-keycloak-\${{ runner.os }}-\${{ runner.arch }}-kc${managedRbacVersions.keycloak}-java${managedRbacVersions.java}-${manifestFingerprint(["keycloak", "java"])}`;

function assertCacheWiring(jobId, job, requirement) {
  assert.ok(job, `rewrite-ci.yml must define ${jobId}`);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const executionIndex = steps.findIndex(
    (step) => typeof step.run === "string" && step.run.includes(requirement.testCommand),
  );
  assert.notEqual(executionIndex, -1, `${jobId} must run ${requirement.testCommand}`);

  const checkCache = ({ label, envName, expectedPath, expectedKey }) => {
    assert.equal(
      job.env?.[envName],
      expectedPath,
      `${jobId} must wire ${envName} to the exact cached path ${expectedPath}`,
    );
    const cacheIndex = steps.findIndex((step) => step.uses === "actions/cache@v4" && step.with?.path === expectedPath);
    assert.notEqual(cacheIndex, -1, `${jobId} must configure actions/cache@v4 for ${label} at ${expectedPath}`);
    assert.ok(
      cacheIndex < executionIndex,
      `${jobId} must restore the ${label} cache before running ${requirement.testCommand}`,
    );
    const cacheStep = steps[cacheIndex];
    assert.equal(
      cacheStep.with?.key,
      expectedKey,
      `${jobId} ${label} cache key must pin OS, arch, exact runtime version, and manifest digest`,
    );
    if (requirement.expectedIf !== undefined) {
      assert.equal(
        cacheStep.if,
        requirement.expectedIf,
        `${jobId} ${label} cache step must preserve the install/code guard`,
      );
    }
  };

  checkCache({
    label: "managed PostgreSQL",
    envName: POSTGRES_CACHE_ENV,
    expectedPath: POSTGRES_CACHE_PATH,
    expectedKey: EXPECTED_POSTGRES_KEY,
  });

  if (requirement.requiresKeycloak) {
    checkCache({
      label: "managed Keycloak",
      envName: KEYCLOAK_CACHE_ENV,
      expectedPath: KEYCLOAK_CACHE_PATH,
      expectedKey: EXPECTED_KEYCLOAK_KEY,
    });
  }
}

test("all rewrite-ci jobs that download managed PostgreSQL or Keycloak configure version-and-manifest-keyed caches", () => {
  const expectations = [
    {
      jobId: "integration-shard",
      testCommand: "node tools/run-manifest-gates.mjs --workflow-job integration-shard",
      requiresKeycloak: true,
      expectedIf: "needs.install.result == 'success' && needs.install.outputs.code != 'false'",
    },
    {
      jobId: "pglite-node26",
      testCommand: "node tools/run-manifest-gates.mjs --workflow-job pglite-node26",
      requiresKeycloak: false,
    },
    {
      jobId: "windows-integration-shard",
      testCommand: "node tools/run-manifest-gates.mjs --workflow-job windows-integration-shard",
      requiresKeycloak: true,
    },
    {
      jobId: "full-check",
      testCommand: "npm run check",
      requiresKeycloak: true,
    },
  ];

  for (const requirement of expectations) {
    assertCacheWiring(requirement.jobId, workflow.jobs[requirement.jobId], requirement);
  }
});

test("negative controls reject missing cache steps, stale version keys, path/env drift, and post-test cache ordering", () => {
  const requirement = {
    jobId: "integration-shard",
    testCommand: "node tools/run-manifest-gates.mjs --workflow-job integration-shard",
    requiresKeycloak: true,
    expectedIf: "needs.install.result == 'success' && needs.install.outputs.code != 'false'",
  };
  const validJob = {
    env: {
      [POSTGRES_CACHE_ENV]: POSTGRES_CACHE_PATH,
      [KEYCLOAK_CACHE_ENV]: KEYCLOAK_CACHE_PATH,
    },
    steps: [
      {
        name: "Cache managed PostgreSQL binaries",
        if: requirement.expectedIf,
        uses: "actions/cache@v4",
        with: { path: POSTGRES_CACHE_PATH, key: EXPECTED_POSTGRES_KEY },
      },
      {
        name: "Cache managed Keycloak runtime",
        if: requirement.expectedIf,
        uses: "actions/cache@v4",
        with: { path: KEYCLOAK_CACHE_PATH, key: EXPECTED_KEYCLOAK_KEY },
      },
      { run: requirement.testCommand },
    ],
  };

  assertCacheWiring(requirement.jobId, validJob, requirement);

  assert.throws(
    () =>
      assertCacheWiring(
        requirement.jobId,
        {
          ...validJob,
          steps: validJob.steps.filter((step) => step.with?.path !== KEYCLOAK_CACHE_PATH),
        },
        requirement,
      ),
    /must configure actions\/cache@v4 for managed Keycloak/u,
  );

  assert.throws(
    () =>
      assertCacheWiring(
        requirement.jobId,
        {
          ...validJob,
          steps: validJob.steps.map((step) =>
            step.with?.path === POSTGRES_CACHE_PATH
              ? { ...step, with: { ...step.with, key: "managed-postgres-stale-version" } }
              : step,
          ),
        },
        requirement,
      ),
    /must pin OS, arch, exact runtime version, and manifest digest/u,
  );

  assert.throws(
    () =>
      assertCacheWiring(
        requirement.jobId,
        {
          ...validJob,
          env: { ...validJob.env, [POSTGRES_CACHE_ENV]: "/tmp/unmatched-dir" },
        },
        requirement,
      ),
    /must wire HARNESS_MANAGED_POSTGRES_CACHE_DIR/u,
  );

  assert.throws(
    () =>
      assertCacheWiring(
        requirement.jobId,
        {
          ...validJob,
          steps: [validJob.steps[2], validJob.steps[0], validJob.steps[1]],
        },
        requirement,
      ),
    /must restore the managed PostgreSQL cache before running/u,
  );
});
