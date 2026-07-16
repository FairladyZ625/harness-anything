// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { selectLocalGateChecks, staticCheckerInvocation } from "./run-local-gates-check.mjs";

test("local gates check derives PR-required static checkers from the manifest", () => {
  const plan = selectLocalGateChecks(makeManifest(), {
    "harness:check-alpha": "node tools/check-alpha.mjs",
    "harness:scan-beta": "node tools/scan-beta.mjs",
    "harness:smoke-package": "node tools/smoke-package.mjs",
    "harness:check-main-only": "node tools/check-main-only.mjs"
  });

  assert.deepEqual(plan.map((entry) => entry.id), ["check-alpha", "scan-beta"]);
  assert.equal(plan[0].scriptCommand, "node tools/check-alpha.mjs");
  assert.deepEqual(plan[0].invocation, { command: process.execPath, args: ["tools/check-alpha.mjs"] });
  assert.deepEqual(plan[1].workflowJobs, ["supply-chain"]);
});

test("static gate child launch uses explicit Node argv without a POSIX shell", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-static-gate-launch-"));
  try {
    mkdirSync(path.join(rootDir, "tools"));
    writeFileSync(path.join(rootDir, "tools", "check-windows.mjs"), "process.stdout.write('windows-safe');\n", "utf8");
    const invocation = staticCheckerInvocation("node tools/check-windows.mjs");
    const launched = spawnSync(invocation.command, invocation.args, { cwd: rootDir, encoding: "utf8" });
    assert.equal(launched.error, undefined);
    assert.equal(launched.status, 0);
    assert.equal(launched.stdout, "windows-safe");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local gates check rejects manifest static checker gates with missing package scripts", () => {
  assert.throws(
    () => selectLocalGateChecks(makeManifest(), {
      "harness:scan-beta": "node tools/scan-beta.mjs",
      "harness:smoke-package": "node tools/smoke-package.mjs",
      "harness:check-main-only": "node tools/check-main-only.mjs"
    }),
    /manifest gate check-alpha references missing package script harness:check-alpha/u
  );
});

test("local gates check fails closed on an unknown or non-static local stop gate", () => {
  const unknown = makeManifest();
  unknown.surfaces.localStop.gateIds = ["missing"];
  assert.throws(() => selectLocalGateChecks(unknown, {}), /unknown gate missing/u);

  const nonStatic = makeManifest();
  nonStatic.surfaces.localStop.gateIds = ["test-integration"];
  assert.throws(
    () => selectLocalGateChecks(nonStatic, { "test:integration": "node tools/run-node-tests.mjs --tier integration" }),
    /not a static checker command/u
  );
});

function makeManifest() {
  return {
    surfaces: {
      localStop: {
        gateIds: ["check-alpha", "scan-beta"]
      },
      rewriteCi: {
        pullRequestGateJobs: ["boundaries", "supply-chain", "gui-build"]
      }
    },
    gates: [
      {
        id: "check-alpha",
        command: "npm run harness:check-alpha",
        category: "boundary",
        tier: "pr-required",
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["boundaries"] }
        }
      },
      {
        id: "scan-beta",
        command: "npm run harness:scan-beta",
        category: "boundary",
        tier: "pr-required",
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["supply-chain"] }
        }
      },
      {
        id: "test-integration",
        command: "npm run test:integration",
        category: "local-consistency",
        tier: "pr-required",
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["integration"] }
        }
      },
      {
        id: "smoke-package",
        command: "npm run harness:smoke-package",
        category: "smoke",
        tier: "pr-required",
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: ["gui-build"] }
        }
      },
      {
        id: "check-main-only",
        command: "npm run harness:check-main-only",
        category: "boundary",
        tier: "main-only",
        executionSurfaces: {
          rewriteCi: { pullRequestJobs: [] }
        }
      }
    ]
  };
}
