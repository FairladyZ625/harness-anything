import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessRuntimeReleaseReadiness,
  validateRuntimeReleaseReadiness,
  type RuntimeReleaseReadinessPolicy
} from "../src/index.ts";

test("runtime release readiness policy covers source, check, package smoke and GUI build", () => {
  const result = validateRuntimeReleaseReadiness(harnessRuntimeReleaseReadiness);
  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(harnessRuntimeReleaseReadiness.currentStatus, "source-checkout-and-package-smoke-only");
  assert.deepEqual(harnessRuntimeReleaseReadiness.supportedNodeMajors, [24, 26]);
  assert.deepEqual(
    harnessRuntimeReleaseReadiness.commands.map((command) => command.surface).sort(),
    ["full-check", "gui-build", "package-smoke", "pr-check", "source-run"]
  );
  assert.deepEqual(
    Object.fromEntries(harnessRuntimeReleaseReadiness.commands.map((command) => [command.surface, command.command])),
    {
      "source-run": "node packages/cli/src/index.ts --json doctor",
      "full-check": "npm run check",
      "pr-check": "npm run check:pr",
      "package-smoke": "npm run harness:smoke-cli-package",
      "gui-build": "npm run -w @harness-anything/gui build"
    }
  );
  assert.deepEqual(harnessRuntimeReleaseReadiness.releaseBoundary, {
    packagesPrivateExceptCli: true,
    privateWorkspaceVersion: "0.0.0",
    cliPublishDryRunVersion: "0.1.0",
    npmReleaseClaimed: false,
    signedInstallersShipped: false,
    notarizedBuildsShipped: false,
    autoUpdateShipped: false,
    releaseFeedsShipped: false,
    releaseArtifactsPublished: false
  });
});

test("runtime release readiness rejects missing Node 26 coverage", () => {
  const policy = clonePolicy();
  policy.supportedNodeMajors = [24, 24] as unknown as RuntimeReleaseReadinessPolicy["supportedNodeMajors"];

  assert.deepEqual(validateRuntimeReleaseReadiness(policy).errors.map((error) => error.code), ["missing_node_coverage"]);
});

test("runtime release readiness rejects shipped release artifacts before release work", () => {
  const policy = clonePolicy();
  policy.releaseBoundary = {
    ...policy.releaseBoundary,
    signedInstallersShipped: true
  } as RuntimeReleaseReadinessPolicy["releaseBoundary"];

  assert.deepEqual(validateRuntimeReleaseReadiness(policy).errors.map((error) => error.code), ["invalid_release_boundary"]);
});

function clonePolicy(): RuntimeReleaseReadinessPolicy & {
  supportedNodeMajors: RuntimeReleaseReadinessPolicy["supportedNodeMajors"];
  releaseBoundary: RuntimeReleaseReadinessPolicy["releaseBoundary"];
} {
  return structuredClone(harnessRuntimeReleaseReadiness);
}
