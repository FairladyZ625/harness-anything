// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  incompleteReplacementReason,
  isCompleteReplacement,
  normalizeDaemonLifecycleStatus
} from "../src/commands/daemon/control-convergence.ts";

const expectedGeneration = { machineId: "machine-installation-a", daemonGeneration: 7 };

test("generation-aware replacement convergence requires the same machine and a strictly newer generation", () => {
  const newer = normalizeDaemonLifecycleStatus(status("machine-installation-a", 8));
  const same = normalizeDaemonLifecycleStatus(status("machine-installation-a", 7));
  const wrongMachine = normalizeDaemonLifecycleStatus(status("machine-installation-b", 8));
  assert.ok(newer && same && wrongMachine);

  assert.equal(isCompleteReplacement(newer, 42, "control-restart", undefined, expectedGeneration), true);
  assert.equal(isCompleteReplacement(same, 42, "control-restart", undefined, expectedGeneration), false);
  assert.equal(isCompleteReplacement(wrongMachine, 42, "control-restart", undefined, expectedGeneration), false);
  assert.match(
    incompleteReplacementReason(same, 42, "control-restart", undefined, expectedGeneration),
    /daemon generation did not strictly advance beyond 7: observed=7/u
  );
  assert.match(
    incompleteReplacementReason(wrongMachine, 42, "control-restart", undefined, expectedGeneration),
    /machine identity did not converge/u
  );
});

test("legacy replacement convergence retains the pre-generation criteria", () => {
  const legacy = normalizeDaemonLifecycleStatus(status(undefined, undefined));
  assert.ok(legacy);
  assert.equal(isCompleteReplacement(legacy, 42, "control-restart", undefined), true);
});

function status(machineId: string | undefined, daemonGeneration: number | undefined): Record<string, unknown> {
  return {
    schema: "daemon-status/v2",
    service: {
      started: true,
      pid: 84,
      build: { loadedIdentity: "sha256:a", installedIdentity: "sha256:a" },
      activeControl: null,
      ...(machineId ? { machineId } : {}),
      ...(daemonGeneration ? { daemonGeneration } : {})
    }
  };
}
