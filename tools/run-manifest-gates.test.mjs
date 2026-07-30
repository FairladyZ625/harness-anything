// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManifestGatePlan,
  manifestGateCommandInvocations,
  parseManifestGateArgs,
  runManifestGatePlan
} from "./run-manifest-gates.mjs";

test("manifest gate runner appends shard args only to shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "test-integration",
        command: "npm run test:integration",
        shardable: true,
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["integration-shard"] } }
      }
    ]
  };
  const options = parseManifestGateArgs(["--workflow-job", "integration-shard", "--shard", "3"]);

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "test-integration", command: "npm run test:integration -- --shard 3", advisory: false }
  ]);
});

test("manifest gate plan preserves advisory tier as execution policy", () => {
  const manifest = {
    gates: [
      {
        id: "advisory-check",
        command: "node tools/advisory.mjs",
        tier: "pr-advisory",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } }
      },
      {
        id: "required-check",
        command: "node tools/required.mjs",
        tier: "pr-required",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } }
      }
    ]
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries"]);

  assert.deepEqual(buildManifestGatePlan(manifest, options), [
    { id: "advisory-check", command: "node tools/advisory.mjs", advisory: true },
    { id: "required-check", command: "node tools/required.mjs", advisory: false }
  ]);
});

test("manifest gate runner reports advisory failures without failing or stopping the plan", () => {
  const warnings = [];
  const seen = [];
  const result = runManifestGatePlan([
    { id: "advisory-check", command: "node tools/advisory.mjs", advisory: true },
    { id: "required-check", command: "node tools/required.mjs", advisory: false }
  ], {
    run: (id) => {
      seen.push(id);
      return id !== "advisory-check";
    },
    warn: (id) => warnings.push(id)
  });

  assert.deepEqual(result, {
    ok: true,
    advisoryFailures: ["advisory-check"],
    failedRequiredGate: null
  });
  assert.deepEqual(seen, ["advisory-check", "required-check"]);
  assert.deepEqual(warnings, ["advisory-check"]);
});

test("manifest gate runner still stops on a required gate failure", () => {
  const seen = [];
  const result = runManifestGatePlan([
    { id: "required-check", command: "node tools/required.mjs", advisory: false },
    { id: "later-check", command: "node tools/later.mjs", advisory: false }
  ], {
    run: (id) => {
      seen.push(id);
      return false;
    }
  });

  assert.deepEqual(result, {
    ok: false,
    advisoryFailures: [],
    failedRequiredGate: "required-check"
  });
  assert.deepEqual(seen, ["required-check"]);
});

test("manifest gate runner rejects --shard for non-shardable gates", () => {
  const manifest = {
    gates: [
      {
        id: "check-example",
        command: "npm run harness:check-example",
        executionSurfaces: { rewriteCi: { pullRequestJobs: ["boundaries"] } }
      }
    ]
  };
  const options = parseManifestGateArgs(["--workflow-job", "boundaries", "--shard", "1"]);

  assert.throws(
    () => buildManifestGatePlan(manifest, options),
    /manifest gate check-example is not shardable but --shard was provided/u
  );
});

test("manifest gate runner launches npm and Node commands without a POSIX shell", () => {
  const options = {
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    env: { npm_execpath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" },
    fileExists: () => true
  };

  assert.deepEqual(
    manifestGateCommandInvocations("npm run typecheck && npm run test:fast", options),
    [
      {
        command: options.execPath,
        args: [options.env.npm_execpath, "run", "typecheck"]
      },
      {
        command: options.execPath,
        args: [options.env.npm_execpath, "run", "test:fast"]
      }
    ]
  );
  assert.deepEqual(
    manifestGateCommandInvocations("node tools/check-example.mjs --env PR_BODY", options),
    [{ command: options.execPath, args: ["tools/check-example.mjs", "--env", "PR_BODY"] }]
  );
  assert.deepEqual(
    manifestGateCommandInvocations('echo "Reusing successful source validation."', options),
    [{
      command: options.execPath,
      args: ["-e", "console.log(process.argv[1])", "Reusing successful source validation."]
    }]
  );
});

test("manifest gate runner rejects shell-shaped commands outside the vetted command grammar", () => {
  assert.throws(
    () => manifestGateCommandInvocations("npm exec arbitrary-tool", { fileExists: () => true }),
    /unsupported manifest gate command without a shell/u
  );
});
